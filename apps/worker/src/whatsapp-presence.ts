/**
 * The presence effect, carried to WhatsApp (#22, P4-05).
 *
 * The same shape as the media port and for the same reason: the application owns the timing and knows
 * nothing about Graph requests, the adapter owns the request and knows nothing about why it is being made.
 * Everything the call is bound to — the phone number, the messaging account, the access token, the
 * connection's state — is read per announcement, because the job was queued up to two minutes ago and
 * none of those are facts about the past.
 *
 * It cannot fail in a way that matters. `markReadAndTyping` returns a boolean by contract, every local
 * refusal returns `false`, and the handler above treats both the same: a reply is never affected by a
 * cosmetic effect.
 */
import { createFetchHttpPort, markReadAndTyping, resolveConfig, type WhatsAppHttpPort } from "@omnichannel/channel-whatsapp";
import { readChannelCredential, type CredentialCipher, type DbClient } from "@omnichannel/db";
import type { PresenceAnnouncer } from "@omnichannel/application";
import type { Logger } from "@omnichannel/observability";

export interface WhatsAppPresenceConfig {
  readonly db: DbClient;
  readonly cipher: CredentialCipher;
  readonly graphVersion: string;
  readonly http?: WhatsAppHttpPort;
  readonly logger: Logger;
}

export function createWhatsAppPresenceAnnouncer(config: WhatsAppPresenceConfig): PresenceAnnouncer {
  const http = config.http ?? createFetchHttpPort();

  return {
    async announce(input) {
      const account = await config.db.channelAccount.findFirst({
        where: { id: input.channelAccountId, workspaceId: input.workspaceId, channel: "WHATSAPP" },
        select: { id: true, workspaceId: true, businessProfileId: true, status: true, externalAccountId: true, whatsappConnection: { select: { wabaId: true } } },
      });
      const wabaId = account?.whatsappConnection?.wabaId;
      if (account === null || account === undefined || wabaId === undefined) {
        // Not a WhatsApp account, not this workspace's, or never finished onboarding. Nothing to announce
        // on, and nothing worth a warning: the handler already decided this conversation deserved presence.
        return false;
      }
      const resolved = resolveConfig({
        binding: {
          workspaceId: account.workspaceId,
          businessProfileId: account.businessProfileId,
          channelAccountId: account.id,
          phoneNumberId: account.externalAccountId,
          wabaId,
        },
        secrets: {
          // Neither is used on this path: a presence call carries a bearer token, no signature, and
          // answers no subscription handshake.
          appSecret: "",
          verifyToken: "",
          accessToken: () => currentAccessToken(config, account.workspaceId, account.id),
        },
        http,
        graphVersion: config.graphVersion,
        // Carried through rather than assumed. The adapter refuses a number that is not connected, which
        // is right: a business that removed the integration has not agreed to keep signalling to its
        // customers on its behalf.
        connectionState: account.status === "DISCONNECTED" ? "DISCONNECTED" : account.status === "NEEDS_REAUTH" ? "NEEDS_REAUTH" : "CONNECTED",
        logger: config.logger,
      });
      return markReadAndTyping(resolved, { inboundMessageId: input.inboundProviderMessageId, typing: input.typing });
    },
  };
}

async function currentAccessToken(config: WhatsAppPresenceConfig, workspaceId: string, channelAccountId: string): Promise<string | undefined> {
  // Through the relation, because that is the direction the link runs: the account names its credential,
  // and `channel_credentials` has no account column.
  const credential = await config.db.channelCredential.findFirst({
    where: { workspaceId, purpose: "WHATSAPP_BUSINESS_TOKEN", revokedAt: null, channelAccount: { id: channelAccountId } },
    select: { id: true },
    orderBy: { createdAt: "desc" },
  });
  if (credential === null) {
    return undefined;
  }
  const stored = await readChannelCredential(config.db, config.cipher, { workspaceId, credentialId: credential.id, purpose: "WHATSAPP_BUSINESS_TOKEN" });
  return stored?.token;
}
