/**
 * Binding accounts to adapters.
 *
 * One registry serves both directions — webhook ingestion and outbound delivery — because two registries
 * would be two answers to "is this account usable right now", and they would disagree the first time one
 * was updated. The same object that decides a webhook may be accepted decides a reply may be sent.
 *
 * It takes a resolver rather than reaching for credentials itself: this package must stay free of the
 * database, and a resolver keeps the secret lookup in the composition root where the encryption key lives.
 *
 * The return type is deliberately structural. `ChannelAdapterProvider` is declared in
 * `packages/application`, which this package may not depend on, so the shape matches and the composition
 * roots do the typing. That boundary is the reason an adapter cannot quietly acquire application behaviour.
 */
import type { ChannelAccountStatus, ChannelType } from "@omnichannel/domain";
import type { Logger } from "@omnichannel/observability";

import { createWhatsAppAdapter, type WhatsAppAdapter } from "./adapter";
import type { WhatsAppConnectionState, WhatsAppSecrets } from "./config";
import type { WhatsAppHttpPort } from "./http";

/**
 * Structurally the application's `WebhookAccount`, with the two provider identifiers WhatsApp needs.
 *
 * `externalAccountId` carries the `phone_number_id` — the sending asset, and the one the account row is
 * keyed by. `wabaId` is separate because the WABA owns the webhook subscription and the template
 * catalogue, and the verification note is explicit that the account model is evolving: keeping them apart
 * is what lets a future account model change one without the other.
 */
export interface RegistryAccount {
  readonly workspaceId: string;
  readonly businessProfileId: string;
  readonly channelAccountId: string;
  readonly channel: ChannelType;
  readonly status: ChannelAccountStatus;
  /** The `phone_number_id` this account sends from. From the resolved account row, never from a payload. */
  readonly externalAccountId: string;
}

export interface WhatsAppBinding {
  readonly secrets: WhatsAppSecrets;
  /** The WABA that owns this phone number's subscription and templates. */
  readonly wabaId: string;
}

export interface WhatsAppRegistryOptions {
  /** Resolves the binding for one account, or undefined when this deployment cannot serve it. */
  readonly bindingFor: (account: RegistryAccount) => WhatsAppBinding | undefined;
  readonly http: WhatsAppHttpPort;
  readonly logger?: Logger;
}

export function createWhatsAppAdapterRegistry(options: WhatsAppRegistryOptions): {
  adapterFor(account: RegistryAccount): WhatsAppAdapter | undefined;
} {
  return {
    adapterFor(account) {
      if (account.channel !== "WHATSAPP") {
        return undefined;
      }
      const binding = options.bindingFor(account);
      if (binding === undefined) {
        return undefined;
      }
      return createWhatsAppAdapter({
        binding: {
          workspaceId: account.workspaceId,
          businessProfileId: account.businessProfileId,
          channelAccountId: account.channelAccountId,
          // From the account, not the binding: two places to state the same ID is one place for a
          // deployment to name the wrong asset.
          phoneNumberId: account.externalAccountId,
          wabaId: binding.wabaId,
        },
        secrets: binding.secrets,
        http: options.http,
        // Carried through rather than defaulted to CONNECTED: an account that needs re-auth must fail
        // closed at the adapter, not only at the policy layer.
        connectionState: connectionStateOf(account.status),
        ...(options.logger === undefined ? {} : { logger: options.logger }),
      });
    },
  };
}

/**
 * Provider health as the transport needs it.
 *
 * **A degraded account can still send.** Holding its *unattended* replies is the policy engine's job
 * (`ACCOUNT_UNHEALTHY`); refusing here would refuse the approved ones too, so a person pressing Send on a
 * flagged number would get a retryable "account is not connected" and their reply would never leave. The
 * provider still honours the connection — that is what distinguishes `DEGRADED` from `NEEDS_REAUTH`.
 */
function connectionStateOf(status: ChannelAccountStatus): WhatsAppConnectionState {
  if (status === "CONNECTED" || status === "DEGRADED") {
    return "CONNECTED";
  }
  return status === "NEEDS_REAUTH" ? "NEEDS_REAUTH" : "DISCONNECTED";
}
