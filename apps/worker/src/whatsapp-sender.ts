/**
 * The one place delivery reaches WhatsApp (#24, P4-07).
 *
 * The same shape as `instagram-sender.ts`, and deliberately so: both implement one `DeliverySendPort`, so
 * the coordinator above them has no branch on channel and no second definition of what a send is. What
 * differs is below this line, inside the adapter.
 *
 * Everything is resolved at send time — the account's current status, its phone number, its messaging
 * account, its access token — because a delivery job may have been scheduled minutes ago and none of those
 * are facts about the past. A token cached when the job was created is the same mistake as a window
 * checked when the draft was written.
 *
 * **There is no human-agent path here.** That exception is Instagram's; WhatsApp's own route out of a
 * closed window is an approved template, which the draft engine does not yet propose (#20). So this sender
 * carries free-form text and nothing else, and a delivery that would need a template is refused by the
 * window gate above it rather than quietly downgraded into something else.
 */
import type { DeliverySendPort } from "@omnichannel/application";
import { createFetchHttpPort, createWhatsAppAdapterRegistry, type WhatsAppHttpPort } from "@omnichannel/channel-whatsapp";
import { readChannelCredential, type CredentialCipher, type DbClient } from "@omnichannel/db";
import type { Logger } from "@omnichannel/observability";

type PortSendResult = Awaited<ReturnType<DeliverySendPort["send"]>>;

export interface WhatsAppSenderConfig {
  readonly db: DbClient;
  readonly cipher: CredentialCipher;
  readonly appSecret: string;
  readonly verifyToken: string;
  /** Injectable so a test can read what went on the wire; production uses the real fetch port. */
  readonly http?: WhatsAppHttpPort;
  readonly logger: Logger;
}

export function createWhatsAppDeliverySender(config: WhatsAppSenderConfig): DeliverySendPort {
  const registry = createWhatsAppAdapterRegistry({
    bindingFor: (account) => {
      const wabaId = account.parentExternalAccountId;
      if (wabaId === undefined || wabaId === "") {
        return undefined;
      }
      return {
        wabaId,
        secrets: {
          appSecret: config.appSecret,
          verifyToken: config.verifyToken,
          // Read per send, and only when a send is actually happening: a revoked token must fail the next
          // attempt, not the one after a cache expires.
          accessToken: () => currentAccessToken(config, account.workspaceId, account.channelAccountId),
        },
      };
    },
    http: config.http ?? createFetchHttpPort(),
    logger: config.logger,
  });

  return {
    async send(command): Promise<PortSendResult> {
      const account = await config.db.channelAccount.findFirst({
        where: { id: command.channelAccountId, channel: "WHATSAPP" },
        select: {
          id: true,
          workspaceId: true,
          businessProfileId: true,
          channel: true,
          externalAccountId: true,
          status: true,
          whatsappConnection: { select: { wabaId: true } },
        },
      });
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
              ...(account.whatsappConnection?.wabaId === undefined ? {} : { parentExternalAccountId: account.whatsappConnection.wabaId }),
            });
      if (account === null || adapter === undefined) {
        // Not a rejection the queue should retry: no amount of waiting produces an adapter, and an
        // account whose onboarding never recorded a messaging account has nothing to send through.
        return { outcome: "REJECTED", retryable: false, code: "NO_ADAPTER", message: "no WhatsApp account is bound to this delivery" };
      }

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

async function currentAccessToken(config: WhatsAppSenderConfig, workspaceId: string, channelAccountId: string): Promise<string | undefined> {
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
