/**
 * Adapter configuration. Everything the adapter needs about *this* Instagram account is injected: the
 * trusted scope binding, secrets, the HTTP port and the platform constants that Meta may change.
 *
 * Platform values re-verified 2026-09-17 (see docs/research/META_INSTAGRAM_PHASE2_VERIFICATION.md). They
 * are defaults of this package, never domain constants, so an operator can move with Meta without a
 * release of the core (INSTAGRAM_ADAPTER.md).
 */
import type { Logger } from "@omnichannel/observability";

import type { InstagramHttpPort } from "./http";

/** Instagram API with Instagram Login is served from graph.instagram.com. */
export const DEFAULT_GRAPH_HOST = "graph.instagram.com";
/**
 * The login flow spans three hosts, which is easy to get wrong: the person authorizes on www.instagram.com,
 * the code is exchanged on api.instagram.com, and everything after that (long-lived token, refresh, /me and
 * all data) is graph.instagram.com. Meta's older reference page still shows api.instagram.com/oauth/authorize
 * from the retired Basic Display API; that host does not serve this flow.
 */
export const DEFAULT_OAUTH_AUTHORIZE_HOST = "www.instagram.com";
export const DEFAULT_OAUTH_TOKEN_HOST = "api.instagram.com";
/** Current Graph API version (v26.0, released 2026-07-29). Meta deprecates versions after two years. */
export const DEFAULT_GRAPH_VERSION = "v26.0";
/** Standard automated messaging window: 24 hours from the person's last message. */
export const DEFAULT_STANDARD_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Human Agent support window: 7 days from the person's last message, for human-sent replies only. */
export const DEFAULT_HUMAN_AGENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Meta rejects message text longer than 1000 UTF-8 bytes. */
export const MAX_TEXT_BYTES = 1000;

/** Connection state of the bound channel account, mirrored from persistence (P2-02 owns transitions). */
export type InstagramConnectionState = "CONNECTED" | "NEEDS_REAUTH" | "DISCONNECTED";

/** Whether Meta approved the Human Agent feature for this app; unknown fails closed. */
export type HumanAgentApproval = "APPROVED" | "NOT_APPROVED" | "UNKNOWN";

/**
 * Trusted scope of the adapter instance. It comes from the channel account the route resolved, never from
 * a webhook payload, and every normalized event is stamped with it (DATA_MODEL.md v0.4).
 */
export interface InstagramAccountBinding {
  readonly workspaceId: string;
  readonly businessProfileId: string;
  readonly channelAccountId: string;
  /** Instagram professional account ID this adapter is bound to (the webhook's `entry.id`). */
  readonly externalAccountId: string;
}

export interface InstagramSecrets {
  /** Meta app secret; used only to verify `X-Hub-Signature-256` over the raw body. */
  readonly appSecret: string;
  /** Token echoed during the webhook subscription handshake. */
  readonly verifyToken: string;
  /** Resolved per send. `undefined` means the account currently has no usable token. */
  accessToken(): Promise<string | undefined>;
}

export interface InstagramAdapterConfig {
  readonly binding: InstagramAccountBinding;
  readonly secrets: InstagramSecrets;
  readonly http: InstagramHttpPort;
  readonly graphHost?: string;
  readonly graphVersion?: string;
  readonly standardWindowMs?: number;
  readonly humanAgentWindowMs?: number;
  readonly connectionState?: InstagramConnectionState;
  readonly humanAgentApproval?: HumanAgentApproval;
  readonly logger?: Logger;
}

/** Config with defaults applied; the adapter works only with this shape. */
export interface ResolvedInstagramConfig {
  readonly binding: InstagramAccountBinding;
  readonly secrets: InstagramSecrets;
  readonly http: InstagramHttpPort;
  readonly graphHost: string;
  readonly graphVersion: string;
  readonly standardWindowMs: number;
  readonly humanAgentWindowMs: number;
  readonly connectionState: InstagramConnectionState;
  readonly humanAgentApproval: HumanAgentApproval;
  readonly logger?: Logger;
}

export function resolveConfig(config: InstagramAdapterConfig): ResolvedInstagramConfig {
  return {
    binding: config.binding,
    secrets: config.secrets,
    http: config.http,
    graphHost: config.graphHost ?? DEFAULT_GRAPH_HOST,
    graphVersion: config.graphVersion ?? DEFAULT_GRAPH_VERSION,
    standardWindowMs: config.standardWindowMs ?? DEFAULT_STANDARD_WINDOW_MS,
    humanAgentWindowMs: config.humanAgentWindowMs ?? DEFAULT_HUMAN_AGENT_WINDOW_MS,
    connectionState: config.connectionState ?? "CONNECTED",
    // Approval is a business fact stored during onboarding (P2-02); without it the tagged path stays shut.
    humanAgentApproval: config.humanAgentApproval ?? "UNKNOWN",
    ...(config.logger === undefined ? {} : { logger: config.logger }),
  };
}
