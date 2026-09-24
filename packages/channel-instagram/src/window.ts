/**
 * Messaging eligibility. Two questions that must never be conflated:
 *
 * 1. `evaluateWindow` — may automation send free-form text right now? (standard 24-hour window)
 * 2. `evaluateHumanAgentEligibility` — may a *human* still reply under the Human Agent exception?
 *
 * Both are computed locally from the last inbound message and injected durations: a live Meta call would add
 * a failure mode whose only honest answer is UNKNOWN, which fails closed and blocks legitimate sends.
 */
import type { ConversationPolicyContext, WindowDecision } from "@omnichannel/channel-core";

import type { ResolvedInstagramConfig } from "./config";

/**
 * Human Agent eligibility is deliberately NOT a WindowDecision: it must be impossible to pass it where an
 * automated-send decision is expected.
 */
export type HumanAgentEligibility =
  | { readonly state: "ELIGIBLE"; readonly expiresAt: Date }
  | { readonly state: "EXPIRED"; readonly reason: string }
  | { readonly state: "NOT_APPROVED"; readonly reason: string }
  | { readonly state: "UNKNOWN"; readonly reason: string };

export function evaluateStandardWindow(ctx: ConversationPolicyContext, config: ResolvedInstagramConfig): WindowDecision {
  if (config.connectionState !== "CONNECTED") {
    // Fail closed: we cannot know the platform state through a broken connection.
    return { state: "UNKNOWN", reason: "channel account is not connected" };
  }
  if (ctx.lastInboundAt === undefined) {
    // Official Instagram messaging is user-initiated; without an inbound message there is no conversation.
    return { state: "NOT_ELIGIBLE", reason: "no user-initiated conversation" };
  }
  const expiresAt = new Date(ctx.lastInboundAt.getTime() + config.standardWindowMs);
  return expiresAt.getTime() > ctx.now.getTime()
    ? { state: "OPEN_FREEFORM", expiresAt }
    : { state: "NOT_ELIGIBLE", reason: "standard messaging window closed" };
}

export function evaluateHumanAgentEligibility(ctx: ConversationPolicyContext, config: ResolvedInstagramConfig): HumanAgentEligibility {
  if (config.connectionState !== "CONNECTED") {
    return { state: "UNKNOWN", reason: "channel account is not connected" };
  }
  if (config.humanAgentApproval === "NOT_APPROVED") {
    return { state: "NOT_APPROVED", reason: "Human Agent feature is not approved for this app" };
  }
  if (config.humanAgentApproval === "UNKNOWN") {
    return { state: "UNKNOWN", reason: "Human Agent approval is unknown" };
  }
  if (ctx.lastInboundAt === undefined) {
    return { state: "EXPIRED", reason: "no user-initiated conversation" };
  }
  const expiresAt = new Date(ctx.lastInboundAt.getTime() + config.humanAgentWindowMs);
  return expiresAt.getTime() > ctx.now.getTime()
    ? { state: "ELIGIBLE", expiresAt }
    : { state: "EXPIRED", reason: "human agent window closed" };
}
