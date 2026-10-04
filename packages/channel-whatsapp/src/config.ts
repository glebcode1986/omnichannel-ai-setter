/**
 * Adapter configuration. Everything the adapter needs about *this* WhatsApp connection is injected: the
 * trusted scope binding, the provider asset identifiers, secrets, the HTTP port and the platform constants
 * Meta may change.
 *
 * Platform values re-verified 2026-09-16 (see docs/research/META_WHATSAPP_PHASE4_VERIFICATION.md). They are
 * defaults of this package, never domain constants, so an operator can move with Meta without a release of
 * the core (WHATSAPP_ADAPTER.md).
 */
import type { Logger } from "@omnichannel/observability";

import type { WhatsAppHttpPort } from "./http";

/** The Cloud API is served from the Graph host, unlike Instagram Login's own graph.instagram.com. */
export const DEFAULT_GRAPH_HOST = "graph.facebook.com";
/**
 * Current Graph API version, re-verified 2026-10-04 against Meta's Graph API changelog: v26.0, released
 * 2026-07-29, and the version Meta's own Cloud API examples now use. Versions are deprecated after two
 * years, so this is a default of this package rather than a constant anybody can rely on forever.
 */
export const DEFAULT_GRAPH_VERSION = "v26.0";
/**
 * The customer-service window: 24 hours from the customer's last message.
 *
 * It is the whole reason this adapter reports four window states rather than two. Inside it, supported
 * free-form customer care is permitted; outside it, an approved template is the business-initiated route,
 * and a free-form send is refused by Meta rather than queued.
 */
export const DEFAULT_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Cloud API rejects a text body longer than this; refusing locally keeps the failure explainable. */
export const MAX_TEXT_LENGTH = 4096;

/** Connection state of the bound channel account, mirrored from persistence (P4-02 owns transitions). */
export type WhatsAppConnectionState = "CONNECTED" | "NEEDS_REAUTH" | "DISCONNECTED";

/**
 * Trusted scope and provider identity of the adapter instance.
 *
 * It comes from the channel account the route resolved, never from a webhook payload, and every normalized
 * event is stamped with it (DATA_MODEL.md v0.4).
 *
 * Two provider identifiers, because WhatsApp has two and they are not interchangeable. `phoneNumberId` is
 * the sending asset and the webhook's `metadata.phone_number_id`; `wabaId` owns the subscription and the
 * template catalogue and is the webhook's `entry.id`. The display phone number is deliberately **not** an
 * identity here: it is a human-readable string a payload can claim, and the verification note is explicit
 * that it must not be a tenant or idempotency key.
 */
export interface WhatsAppAccountBinding {
  readonly workspaceId: string;
  readonly businessProfileId: string;
  readonly channelAccountId: string;
  /** `phone_number_id`: the asset messages are sent from and webhooks are delivered for. */
  readonly phoneNumberId: string;
  /** `WABA_ID`: owns the webhook subscription and the approved template catalogue. */
  readonly wabaId: string;
}

export interface WhatsAppSecrets {
  /** Meta app secret; used only to verify `X-Hub-Signature-256` over the raw body. */
  readonly appSecret: string;
  /** Token echoed during the webhook subscription handshake. */
  readonly verifyToken: string;
  /** Resolved per send. `undefined` means the account currently has no usable token. */
  accessToken(): Promise<string | undefined>;
}

export interface WhatsAppAdapterConfig {
  readonly binding: WhatsAppAccountBinding;
  readonly secrets: WhatsAppSecrets;
  readonly http: WhatsAppHttpPort;
  readonly graphHost?: string;
  readonly graphVersion?: string;
  readonly serviceWindowMs?: number;
  readonly connectionState?: WhatsAppConnectionState;
  readonly logger?: Logger;
}

/** Config with defaults applied; the adapter works only with this shape. */
export interface ResolvedWhatsAppConfig {
  readonly binding: WhatsAppAccountBinding;
  readonly secrets: WhatsAppSecrets;
  readonly http: WhatsAppHttpPort;
  readonly graphHost: string;
  readonly graphVersion: string;
  readonly serviceWindowMs: number;
  readonly connectionState: WhatsAppConnectionState;
  readonly logger?: Logger;
}

export function resolveConfig(config: WhatsAppAdapterConfig): ResolvedWhatsAppConfig {
  return {
    binding: config.binding,
    secrets: config.secrets,
    http: config.http,
    graphHost: config.graphHost ?? DEFAULT_GRAPH_HOST,
    graphVersion: config.graphVersion ?? DEFAULT_GRAPH_VERSION,
    serviceWindowMs: config.serviceWindowMs ?? DEFAULT_SERVICE_WINDOW_MS,
    connectionState: config.connectionState ?? "CONNECTED",
    ...(config.logger === undefined ? {} : { logger: config.logger }),
  };
}

/** `https://graph.facebook.com/v23.0/<phone_number_id>/messages` — the one endpoint this adapter writes to. */
export function messagesUrl(config: ResolvedWhatsAppConfig): string {
  return `https://${config.graphHost}/${config.graphVersion}/${config.binding.phoneNumberId}/messages`;
}
