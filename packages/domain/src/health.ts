/**
 * What an operator is told when something is wrong (RELIABILITY_INCIDENTS.md, Issue #56).
 *
 * The spec asks for "a simple operational health surface rather than infrastructure jargon", and the hard
 * part is not the rendering — it is deciding what one sentence should say when five things are half-broken.
 * Three rules do that work:
 *
 * - **degrade by capability, not by tenant.** One expired Instagram credential makes *that channel* need
 *   attention. It does not make a Business Profile unhealthy, and it certainly does not make the platform
 *   unhealthy. A status that goes red for everyone every time one dependency wobbles is a status nobody
 *   reads;
 * - **"action required" means a person can actually do something.** An expired token is action required.
 *   A provider being slow is not — nobody can act on it, and telling them they must is how alert fatigue
 *   starts;
 * - **health is server-observed.** Nothing here can be derived from a browser being connected.
 *
 * No component state carries a secret, a token or a message body: a health surface is one of the places
 * where detail leaks most easily, because it is written while debugging.
 */
import { literalGuard } from "./enum";

export const COMPONENT_STATES = [
  /** Working. */
  "OPERATIONAL",
  /** Working worse than usual, and nobody needs to do anything about it yet. */
  "DEGRADED",
  /** Stopped, and a person can fix it — reconnect an account, restore a key, clear a backlog. */
  "ACTION_REQUIRED",
] as const;
export type ComponentState = (typeof COMPONENT_STATES)[number];
export const isComponentState = literalGuard(COMPONENT_STATES);

export const COMPONENT_KINDS = ["DATABASE", "QUEUE", "AI_PROVIDER", "EMBEDDINGS", "CHANNEL_ACCOUNT", "TRANSCRIPTION", "INTEGRATION"] as const;
export type ComponentKind = (typeof COMPONENT_KINDS)[number];

export interface ComponentHealth {
  readonly kind: ComponentKind;
  /** Stable identifier for one instance — a channel account, a provider name. Never a secret. */
  readonly id: string;
  readonly state: ComponentState;
  /**
   * One short phrase an owner can read: "reconnect needed", "replies delayed". Not an exception message:
   * those carry paths, hosts and sometimes the very tokens this surface must not show.
   */
  readonly summary: string;
  readonly since: Date;
}

export const OVERALL_HEALTH = ["ALL_SYSTEMS_OPERATIONAL", "SOME_FEATURES_DEGRADED", "ACTION_REQUIRED"] as const;
export type OverallHealth = (typeof OVERALL_HEALTH)[number];

/**
 * The single line at the top of the screen.
 *
 * The worst component wins, because a summary that averages away one broken channel is worse than no
 * summary: it is a summary that is wrong in the one direction that matters.
 */
export function overallHealth(components: readonly ComponentHealth[]): OverallHealth {
  if (components.some((component) => component.state === "ACTION_REQUIRED")) {
    return "ACTION_REQUIRED";
  }
  return components.some((component) => component.state === "DEGRADED") ? "SOME_FEATURES_DEGRADED" : "ALL_SYSTEMS_OPERATIONAL";
}

/**
 * Whether automated outbound should stop because of component health alone.
 *
 * Deliberately narrow. Only the components whose failure makes a *send* unsafe or impossible count: the
 * database, because nothing can be claimed durably without it, and the channel itself. A failing AI
 * provider means no new drafts, which is a delay — and delay is the correct outcome there, not a halt of
 * everything already approved.
 */
export function outboundBlockedByHealth(components: readonly ComponentHealth[], channelAccountId: string): boolean {
  return components.some(
    (component) =>
      component.state === "ACTION_REQUIRED" &&
      (component.kind === "DATABASE" || (component.kind === "CHANNEL_ACCOUNT" && component.id === channelAccountId)),
  );
}
