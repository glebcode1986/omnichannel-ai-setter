/**
 * Binding accounts to adapters (P2-09).
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
 * roots do the typing. That boundary is the reason an adapter cannot quietly acquire application
 * behaviour.
 */
import type { ChannelAccountStatus, ChannelType } from "@omnichannel/domain";
import type { Logger } from "@omnichannel/observability";

import { createInstagramAdapter, type InstagramAdapter } from "./adapter";
import type { HumanAgentApproval, InstagramConnectionState, InstagramSecrets } from "./config";
import type { InstagramHttpPort } from "./http";

/** Structurally the application's `WebhookAccount`; see the note above on why it is not imported. */
export interface RegistryAccount {
  readonly workspaceId: string;
  readonly businessProfileId: string;
  readonly channelAccountId: string;
  readonly channel: ChannelType;
  readonly status: ChannelAccountStatus;
  /** Instagram's own ID for this account. Taken from the resolved account row, never from a payload. */
  readonly externalAccountId: string;
}

export interface InstagramBinding {
  readonly secrets: InstagramSecrets;
  /**
   * Whether Meta has approved this app for the Human Agent exception. Read from live configuration rather
   * than a stored flag on the account: a boolean written months ago is exactly the stale evidence ADR-014
   * warns against, and `UNKNOWN` fails closed.
   */
  readonly humanAgentApproval?: HumanAgentApproval;
}

export interface InstagramRegistryOptions {
  /** Resolves the binding for one account, or undefined when this deployment cannot serve it. */
  readonly bindingFor: (account: RegistryAccount) => InstagramBinding | undefined;
  readonly http: InstagramHttpPort;
  readonly logger?: Logger;
}

export function createInstagramAdapterRegistry(options: InstagramRegistryOptions): {
  adapterFor(account: RegistryAccount): InstagramAdapter | undefined;
} {
  return {
    adapterFor(account) {
      if (account.channel !== "INSTAGRAM") {
        return undefined;
      }
      const binding = options.bindingFor(account);
      if (binding === undefined) {
        return undefined;
      }
      return createInstagramAdapter({
        binding: {
          workspaceId: account.workspaceId,
          businessProfileId: account.businessProfileId,
          channelAccountId: account.channelAccountId,
          // From the account, not the binding: two places to state the same ID is one place for a
          // deployment to name the wrong account.
          externalAccountId: account.externalAccountId,
        },
        secrets: binding.secrets,
        http: options.http,
        // Carried through rather than defaulted to CONNECTED: an account that needs re-auth must fail
        // closed at the adapter, not only at the policy layer.
        connectionState: connectionStateOf(account.status),
        humanAgentApproval: binding.humanAgentApproval ?? "UNKNOWN",
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
 * flagged account would get a retryable "account is not connected" and their reply would never leave. The
 * provider still honours the connection — that is what distinguishes `DEGRADED` from `NEEDS_REAUTH`.
 */
function connectionStateOf(status: ChannelAccountStatus): InstagramConnectionState {
  if (status === "CONNECTED" || status === "DEGRADED") {
    return "CONNECTED";
  }
  return status === "NEEDS_REAUTH" ? "NEEDS_REAUTH" : "DISCONNECTED";
}
