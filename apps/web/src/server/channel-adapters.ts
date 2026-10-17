/**
 * Channel adapters available to webhook ingestion in this deployment (#16, P2-09, #23).
 *
 * Every Instagram webhook arrives here first. Until this was wired the provider returned
 * `adapterFor: () => undefined`, so ingestion answered `ADAPTER_UNAVAILABLE` before signature
 * verification, normalization, persistence, the outbox or debounce — the whole inbound half of the
 * product was unreachable in production while each of its parts passed its own tests.
 *
 * Two things are deliberate here:
 *
 * - The adapter is bound to the account the *route* resolved, and its credential is read through that
 *   account's own relation. Credentials are scoped by workspace, so a lookup that named only the
 *   workspace would be free to pick another account's token — a reply signed as the wrong business.
 * - Missing configuration binds no adapter at all. That is a 404 with nothing persisted and nothing
 *   enqueued, which is the safe answer: accepting a webhook this deployment cannot verify would be
 *   storing an unauthenticated payload as if it were a customer's message.
 */
import type { ChannelAdapterProvider, WebhookAccount } from "@omnichannel/application";
import { createFetchHttpPort, createInstagramAdapterRegistry, type InstagramHttpPort } from "@omnichannel/channel-instagram";
import {
  createFetchHttpPort as createWhatsAppHttpPort,
  createWhatsAppAdapterRegistry,
  type WhatsAppHttpPort,
} from "@omnichannel/channel-whatsapp";
import { readChannelCredential, type CredentialCipher, type DbClient } from "@omnichannel/db";
import type { Logger } from "@omnichannel/observability";

import type { WebEnv } from "../env";
import { loadWebEnv } from "../env";
import { getCredentialCipher } from "./credential-cipher";
import { getDb } from "./db";
import { getLogger } from "./logger";

export interface ChannelAdapterOptions {
  readonly env: Pick<
    WebEnv,
    | "INSTAGRAM_APP_SECRET"
    | "INSTAGRAM_VERIFY_TOKEN"
    | "INSTAGRAM_HUMAN_AGENT_APPROVAL"
    | "WHATSAPP_APP_SECRET"
    | "WHATSAPP_VERIFY_TOKEN"
    | "WHATSAPP_GRAPH_VERSION"
  >;
  readonly db: DbClient;
  readonly cipher: CredentialCipher;
  readonly logger: Logger;
  /** Injectable so a test can read which account's token an adapter actually resolved. */
  readonly http?: InstagramHttpPort;
  readonly whatsappHttp?: WhatsAppHttpPort;
}

export function createChannelAdapters(options: ChannelAdapterOptions): ChannelAdapterProvider {
  const { INSTAGRAM_APP_SECRET: appSecret, INSTAGRAM_VERIFY_TOKEN: verifyToken } = options.env;
  const instagram = createInstagramAdapterRegistry({
    bindingFor: (account) => {
      if (verifyToken === undefined) {
        // Stated once per webhook and without the values themselves: an operator has to be able to see
        // why Instagram is refused, and the reason must not be a place a secret can leak.
        options.logger.warn("webhook.adapter_unconfigured", { channel: "INSTAGRAM", reason: "INSTAGRAM_VERIFY_TOKEN is not configured" });
        return undefined;
      }
      return {
        secrets: {
          appSecret,
          verifyToken,
          // Read per call and only when a send actually happens: a revoked token must fail the next
          // attempt rather than the one after a cache expires.
          accessToken: () => accessTokenFor(options, account),
        },
        humanAgentApproval: options.env.INSTAGRAM_HUMAN_AGENT_APPROVAL,
      };
    },
    http: options.http ?? createFetchHttpPort(),
    logger: options.logger,
  });

  const whatsapp = createWhatsAppAdapterRegistry({
    bindingFor: (account) => {
      const appSecret = options.env.WHATSAPP_APP_SECRET;
      const whatsappVerifyToken = options.env.WHATSAPP_VERIFY_TOKEN;
      if (appSecret === undefined || whatsappVerifyToken === undefined) {
        options.logger.warn("webhook.adapter_unconfigured", { channel: "WHATSAPP", reason: "WhatsApp app credentials are not configured" });
        return undefined;
      }
      // The messaging account arrives with the account rather than being looked up: binding is
      // synchronous, and the webhook names this id in `entry.id` to prove which account it belongs to.
      const wabaId = account.parentExternalAccountId;
      if (wabaId === undefined || wabaId === "") {
        // Onboarding never finished, so there is nothing to check `entry.id` against. Refusing is the
        // same 404 an unknown account gets, which is right: a payload we cannot attribute is not ours.
        options.logger.warn("webhook.adapter_unbound", { channel: "WHATSAPP", reason: "no messaging account is recorded for this number" });
        return undefined;
      }
      return {
        wabaId,
        secrets: {
          appSecret,
          verifyToken: whatsappVerifyToken,
          accessToken: () => whatsappAccessTokenFor(options, account),
        },
      };
    },
    http: options.whatsappHttp ?? createWhatsAppHttpPort(),
    logger: options.logger,
  });

  // Each registry answers `undefined` for a channel that is not its own, so the order here is not a
  // precedence rule — it is two independent registries asked in turn.
  return { adapterFor: (account: WebhookAccount) => instagram.adapterFor(account) ?? whatsapp.adapterFor(account) };
}

async function whatsappAccessTokenFor(options: ChannelAdapterOptions, account: { readonly workspaceId: string; readonly channelAccountId: string }): Promise<string | undefined> {
  const credential = await options.db.channelCredential.findFirst({
    where: {
      workspaceId: account.workspaceId,
      purpose: "WHATSAPP_BUSINESS_TOKEN",
      revokedAt: null,
      channelAccount: { id: account.channelAccountId },
    },
    select: { id: true },
    orderBy: { createdAt: "desc" },
  });
  if (credential === null) {
    return undefined;
  }
  const stored = await readChannelCredential(options.db, options.cipher, {
    workspaceId: account.workspaceId,
    credentialId: credential.id,
    purpose: "WHATSAPP_BUSINESS_TOKEN",
  });
  return stored?.token;
}

async function accessTokenFor(options: ChannelAdapterOptions, account: WebhookAccount): Promise<string | undefined> {
  // Through the relation, because that is the direction the link runs: the account names its credential,
  // and `channel_credentials` has no account column.
  const credential = await options.db.channelCredential.findFirst({
    where: {
      workspaceId: account.workspaceId,
      purpose: "INSTAGRAM_ACCESS_TOKEN",
      revokedAt: null,
      channelAccount: { id: account.channelAccountId },
    },
    select: { id: true },
    orderBy: { createdAt: "desc" },
  });
  if (credential === null) {
    return undefined;
  }
  const stored = await readChannelCredential(options.db, options.cipher, {
    workspaceId: account.workspaceId,
    credentialId: credential.id,
    purpose: "INSTAGRAM_ACCESS_TOKEN",
  });
  return stored?.token;
}

let adapters: ChannelAdapterProvider | undefined;

/** Production composition, built on first use rather than at import/build time. */
export function getChannelAdapters(): ChannelAdapterProvider {
  adapters ??= createChannelAdapters({ env: loadWebEnv(), db: getDb(), cipher: getCredentialCipher(), logger: getLogger() });
  return adapters;
}
