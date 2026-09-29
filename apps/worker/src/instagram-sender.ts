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
import { createInstagramAdapter, createFetchHttpPort, type HumanAgentApproval, type InstagramHttpPort } from "@omnichannel/channel-instagram";
import { readChannelCredential, type CredentialCipher, type DbClient } from "@omnichannel/db";
import type { Logger } from "@omnichannel/observability";

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
  const http = config.http ?? createFetchHttpPort();

  return {
    async send(command) {
      const account = await config.db.channelAccount.findFirst({
        where: { id: command.channelAccountId },
        select: { id: true, workspaceId: true, businessProfileId: true, channel: true, externalAccountId: true, status: true },
      });
      if (account === null || account.channel !== "INSTAGRAM") {
        // Not a rejection the queue should retry: no amount of waiting produces an adapter.
        return { outcome: "REJECTED", retryable: false, code: "NO_ADAPTER", message: "no Instagram account is bound to this delivery" };
      }

      const adapter = createInstagramAdapter({
        binding: {
          workspaceId: account.workspaceId,
          businessProfileId: account.businessProfileId,
          channelAccountId: account.id,
          externalAccountId: account.externalAccountId,
        },
        secrets: {
          appSecret: config.appSecret,
          verifyToken: config.verifyToken,
          // Read per send, and only when a send is actually happening: a revoked token must fail the next
          // attempt, not the one after the cache expires.
          accessToken: () => currentAccessToken(config, account.workspaceId, account.id),
        },
        http,
        // Carried from the live row: an account that needs re-auth fails closed inside the adapter too,
        // not only at the policy layer.
        connectionState: account.status === "CONNECTED" ? "CONNECTED" : "DISCONNECTED",
        humanAgentApproval: config.humanAgentApproval,
        logger: config.logger,
      });

      const outbound = {
        workspaceId: account.workspaceId,
        businessProfileId: account.businessProfileId,
        channelAccountId: account.id,
        conversationId: command.conversationId,
        recipientExternalId: command.recipientExternalId,
        content: { type: "TEXT", text: command.text },
        operationId: command.operationId,
      } as const;

      const humanAgent = humanAgentSend(command.authority);
      if (humanAgent === undefined) {
        return adapter.send(outbound);
      }

      // The conversation's own last inbound message is where the provider's clock starts, so the adapter
      // is given it rather than a time this code chose. Without it there is no window to be inside, and
      // the adapter refuses — which is the right answer, not a reason to guess one.
      const conversation = await config.db.conversation.findFirst({
        where: { workspaceId: account.workspaceId, businessProfileId: account.businessProfileId, id: command.conversationId },
        select: { lastInboundAt: true },
      });
      return adapter.sendAsHumanAgent(
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
      );
    },
  };
}

async function currentAccessToken(config: InstagramSenderConfig, workspaceId: string, channelAccountId: string): Promise<string | undefined> {
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
  return stored?.token;
}
