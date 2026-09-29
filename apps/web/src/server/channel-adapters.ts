/**
 * Channel adapters available to webhook ingestion in this deployment (#16, P2-09).
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
import { readChannelCredential, type CredentialCipher, type DbClient } from "@omnichannel/db";
import type { Logger } from "@omnichannel/observability";

import type { WebEnv } from "../env";
import { loadWebEnv } from "../env";
import { getCredentialCipher } from "./credential-cipher";
import { getDb } from "./db";
import { getLogger } from "./logger";

export interface ChannelAdapterOptions {
  readonly env: Pick<WebEnv, "INSTAGRAM_APP_SECRET" | "INSTAGRAM_VERIFY_TOKEN" | "INSTAGRAM_HUMAN_AGENT_APPROVAL">;
  readonly db: DbClient;
  readonly cipher: CredentialCipher;
  readonly logger: Logger;
  /** Injectable so a test can read which account's token an adapter actually resolved. */
  readonly http?: InstagramHttpPort;
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

  // WhatsApp (Phase 4) adds itself here. Until it does, the registry answers `undefined` for every other
  // channel by itself, which is the same 404 an unknown account gets.
  return { adapterFor: (account: WebhookAccount) => instagram.adapterFor(account) };
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
