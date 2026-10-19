/**
 * The one place delivery reaches Instagram (#16). This closes the gap named in #13.
 *
 * Everything is resolved at send time — the account's current status, its external ID, its access token —
 * because a delivery job may have been scheduled minutes ago and none of those are facts about the past. A
 * token cached when the job was created is the same mistake as a window checked when the draft was written.
 *
 * Which transport a send uses follows the authority it carries, and nothing else. Automation always takes
 * the standard path: `adapter.send` has no tag parameter, so a background job cannot produce a tagged send
 * even by mistake. The Human Agent path is reachable only for a delivery a person approved *and* approved
 * as that kind of send — the acting user and the intent are read from the delivery row, where the review
 * queue recorded them, never constructed here (ADR-014).
 *
 * The adapter still re-checks eligibility immediately before dispatch. A person's approval is what makes
 * the path available; it is not what makes it permitted, and the two are checked in different places on
 * purpose.
 */
import type { DeliverySendCommand, DeliverySendPort } from "@omnichannel/application";
import {
  createInstagramAdapterRegistry,
  createFetchHttpPort,
  isAccessTokenRejection,
  type HumanAgentApproval,
  type InstagramHttpPort,
} from "@omnichannel/channel-instagram";
import { markChannelAccountNeedsReauthorization, readChannelCredential, type CredentialCipher, type DbClient } from "@omnichannel/db";
import type { Logger } from "@omnichannel/observability";

/**
 * What the port this file implements answers with.
 *
 * Taken from the port rather than imported from `@omnichannel/channel-core` so the worker keeps one
 * runtime edge to the contract it actually serves: the normalized result is the application's shape here,
 * and the adapter's Meta vocabulary stays inside the adapter.
 */
type PortSendResult = Awaited<ReturnType<DeliverySendPort["send"]>>;

export interface InstagramSenderConfig {
  readonly db: DbClient;
  readonly cipher: CredentialCipher;
  readonly appSecret: string;
  readonly verifyToken: string;
  readonly humanAgentApproval: HumanAgentApproval;
  readonly now: () => Date;
  /** Injectable so a test can read what went on the wire; production uses the real fetch port. */
  readonly http?: InstagramHttpPort;
  readonly logger: Logger;
}

/**
 * The tagged human-support send, or nothing.
 *
 * Both halves are required: a person approved this, *and* they approved it as a human-agent send. Approving
 * an ordinary reply is not agreement to a tagged one, and automation has no actor to name at all — so
 * anything else falls through to the standard transport, which is the path that cannot carry the tag.
 */
function humanAgentSend(authority: DeliverySendCommand["authority"]): { readonly approvedByUserId: string; readonly approvedAt: Date } | undefined {
  if (authority.kind !== "HUMAN_APPROVED" || authority.reviewMode !== "HUMAN_AGENT") {
    return undefined;
  }
  return { approvedByUserId: authority.approvedByUserId, approvedAt: authority.approvedAt };
}

export function createInstagramDeliverySender(config: InstagramSenderConfig): DeliverySendPort {
  /**
   * Which credential the adapter last used for each account.
   *
   * Written where the token is actually read — at dispatch, by the adapter — so a rejection is judged
   * against the credential Meta saw and not against whatever the row says afterwards. That ordering is the
   * whole value of it: a person who re-authorizes between the dispatch and the verdict leaves a newer mint
   * time behind, the guard in `markChannelAccountNeedsReauthorization` then fails to match, and the
   * connection they just fixed is left alone. One entry per account, overwritten per send.
   */
  const lastUsed = new Map<string, { readonly credentialId: string; readonly mintedAt: Date }>();

  // The same registry webhook ingestion binds adapters with. Two constructions of an adapter would be two
  // answers to "is this account usable right now", and they would disagree the first time one was changed.
  const registry = createInstagramAdapterRegistry({
    bindingFor: (account) => ({
      secrets: {
        appSecret: config.appSecret,
        verifyToken: config.verifyToken,
        // Read per send, and only when a send is actually happening: a revoked token must fail the next
        // attempt, not the one after the cache expires.
        accessToken: () => currentAccessToken(config, account.workspaceId, account.channelAccountId, lastUsed),
      },
      humanAgentApproval: config.humanAgentApproval,
    }),
    http: config.http ?? createFetchHttpPort(),
    logger: config.logger,
  });

  return {
    async send(command) {
      const account = await config.db.channelAccount.findFirst({
        where: { id: command.channelAccountId },
        select: { id: true, workspaceId: true, businessProfileId: true, channel: true, externalAccountId: true, status: true },
      });
      // Everything the adapter is bound to is read here, at send time — the account's status, its external
      // ID, its token — because a delivery job may have been scheduled minutes ago and none of those are
      // facts about the past.
      const adapter =
        account === null
          ? undefined
          : registry.adapterFor({
              workspaceId: account.workspaceId,
              businessProfileId: account.businessProfileId,
              channelAccountId: account.id,
              channel: account.channel,
              status: account.status,
              externalAccountId: account.externalAccountId,
            });
      if (account === null || adapter === undefined) {
        // Not a rejection the queue should retry: no amount of waiting produces an adapter.
        return { outcome: "REJECTED", retryable: false, code: "NO_ADAPTER", message: "no Instagram account is bound to this delivery" };
      }

      const outbound = {
        workspaceId: account.workspaceId,
        businessProfileId: account.businessProfileId,
        channelAccountId: account.id,
        conversationId: command.conversationId,
        recipientExternalId: command.recipientExternalId,
        content: { type: "TEXT", text: command.text },
        operationId: command.operationId,
      } as const;

      const marking = { workspaceId: account.workspaceId, businessProfileId: account.businessProfileId, channelAccountId: account.id };
      const humanAgent = humanAgentSend(command.authority);
      if (humanAgent === undefined) {
        return reportCredentialState(config, marking, lastUsed, await adapter.send(outbound));
      }

      // The conversation's own last inbound message is where the provider's clock starts, so the adapter
      // is given it rather than a time this code chose. Without it there is no window to be inside, and
      // the adapter refuses — which is the right answer, not a reason to guess one.
      const conversation = await config.db.conversation.findFirst({
        where: { workspaceId: account.workspaceId, businessProfileId: account.businessProfileId, id: command.conversationId },
        select: { lastInboundAt: true },
      });
      return reportCredentialState(
        config,
        marking,
        lastUsed,
        await adapter.sendAsHumanAgent(
          outbound,
          { userId: humanAgent.approvedByUserId, actedAt: humanAgent.approvedAt },
          {
            workspaceId: account.workspaceId,
            channelAccountId: account.id,
            conversationId: command.conversationId,
            participantExternalId: command.recipientExternalId,
            ...(conversation?.lastInboundAt === null || conversation?.lastInboundAt === undefined
              ? {}
              : { lastInboundAt: conversation.lastInboundAt }),
            now: config.now(),
          },
        ),
      );
    },
  };
}

/**
 * Turns "Meta refused this token" into a connection an operator can see is broken.
 *
 * The send result itself is returned untouched, deliberately. Whether this delivery may be retried is the
 * delivery coordinator's decision and Meta's code already answered it — code 190 is final, so the reply
 * fails and is not retried. What was missing is the other half: every later reply would fail the same way
 * while the account still read `CONNECTED`, so the Inbox, the setup checklist and the health probe all said
 * the channel was fine and nobody was ever told to reconnect. The refresh loop normally gets there first;
 * this is the path for a token the person revoked at Meta, which no refresh can anticipate.
 */
async function reportCredentialState(
  config: InstagramSenderConfig,
  account: { readonly workspaceId: string; readonly businessProfileId: string; readonly channelAccountId: string },
  lastUsed: Map<string, { readonly credentialId: string; readonly mintedAt: Date }>,
  result: PortSendResult,
): Promise<PortSendResult> {
  if (!isAccessTokenRejection(result)) {
    return result;
  }
  const used = lastUsed.get(account.channelAccountId);
  if (used === undefined) {
    // The adapter refused before it read a token (a foreign command, unsendable text). Nothing was shown
    // to Meta, so nothing has been learned about the credential.
    return result;
  }
  const marked = await markChannelAccountNeedsReauthorization(config.db, {
    workspaceId: account.workspaceId,
    channelAccountId: account.channelAccountId,
    mintedAt: used.mintedAt,
  });
  if (marked) {
    config.logger.warn("instagram.credential_rejected", {
      workspaceId: account.workspaceId,
      businessProfileId: account.businessProfileId,
      channelAccountId: account.channelAccountId,
      code: result.outcome === "REJECTED" ? result.code : undefined,
    });
  }
  return result;
}

async function currentAccessToken(
  config: InstagramSenderConfig,
  workspaceId: string,
  channelAccountId: string,
  lastUsed: Map<string, { readonly credentialId: string; readonly mintedAt: Date }>,
): Promise<string | undefined> {
  // Through the relation, because that is the direction the link runs: the account names its credential,
  // and `channel_credentials` has no account column. Prisma's generated types accept the flat spelling
  // here and its query engine rejects it, so the only thing that ever proved this was a test that ran it.
  const credential = await config.db.channelCredential.findFirst({
    where: { workspaceId, purpose: "INSTAGRAM_ACCESS_TOKEN", revokedAt: null, channelAccount: { id: channelAccountId } },
    select: { id: true },
    orderBy: { createdAt: "desc" },
  });
  if (credential === null) {
    return undefined;
  }
  const stored = await readChannelCredential(config.db, config.cipher, { workspaceId, credentialId: credential.id, purpose: "INSTAGRAM_ACCESS_TOKEN" });
  if (stored !== undefined) {
    lastUsed.set(channelAccountId, { credentialId: stored.credentialId, mintedAt: stored.mintedAt });
  }
  return stored?.token;
}
