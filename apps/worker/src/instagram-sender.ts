/**
 * The one place delivery reaches Instagram (#16). This closes the gap named in #13.
 *
 * Everything is resolved at send time — the account's current status, its external ID, its access token —
 * because a delivery job may have been scheduled minutes ago and none of those are facts about the past. A
 * token cached when the job was created is the same mistake as a window checked when the draft was written.
 *
 * Automated delivery always uses the standard transport. The Human Agent path is a human action and is
 * unreachable from here: `adapter.send` has no tag parameter, and `sendAsHumanAgent` demands an acting
 * user this code has none of.
 */
import type { DeliverySendPort } from "@omnichannel/application";
import { createInstagramAdapter, createFetchHttpPort, type HumanAgentApproval } from "@omnichannel/channel-instagram";
import { readChannelCredential, type CredentialCipher, type DbClient } from "@omnichannel/db";
import type { Logger } from "@omnichannel/observability";

export interface InstagramSenderConfig {
  readonly db: DbClient;
  readonly cipher: CredentialCipher;
  readonly appSecret: string;
  readonly verifyToken: string;
  readonly humanAgentApproval: HumanAgentApproval;
  readonly logger: Logger;
}

export function createInstagramDeliverySender(config: InstagramSenderConfig): DeliverySendPort {
  const http = createFetchHttpPort();

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

      return adapter.send({
        workspaceId: account.workspaceId,
        businessProfileId: account.businessProfileId,
        channelAccountId: account.id,
        conversationId: command.conversationId,
        recipientExternalId: command.recipientExternalId,
        content: { type: "TEXT", text: command.text },
        operationId: command.operationId,
      });
    },
  };
}

async function currentAccessToken(config: InstagramSenderConfig, workspaceId: string, channelAccountId: string): Promise<string | undefined> {
  const credential = await config.db.channelCredential.findFirst({
    where: { workspaceId, channelAccountId, purpose: "INSTAGRAM_ACCESS_TOKEN", revokedAt: null },
    select: { id: true },
    orderBy: { createdAt: "desc" },
  });
  if (credential === null) {
    return undefined;
  }
  const stored = await readChannelCredential(config.db, config.cipher, { workspaceId, credentialId: credential.id, purpose: "INSTAGRAM_ACCESS_TOKEN" });
  return stored?.token;
}
