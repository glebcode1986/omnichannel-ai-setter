/**
 * Provider timing facts, exposed as data for the delivery coordinator (ADR-014, INSTAGRAM_ADAPTER.md v0.3).
 *
 * Meta's policy expects an experience classified as *automated* to answer a person within a fixed budget.
 * That budget wins over the product's generic human-like delays: the coordinator must fit debounce,
 * generation and any artificial delay inside it, shortening or dropping the delay when necessary, and hold
 * for review instead of sending late.
 *
 * The adapter only reports the numbers and the time left; it schedules nothing and decides nothing. The
 * values are configuration with verified defaults, never domain constants — when Meta changes the rule, the
 * configuration changes and domain semantics do not.
 */

/** Verified 2026-09-17: 30 seconds for an automated response. Re-verify at App Review and before production. */
export const DEFAULT_AUTOMATED_RESPONSE_BUDGET_MS = 30_000;
/** Operational target, deliberately inside the cap so a slow model or queue does not push us past it. */
export const DEFAULT_AUTOMATED_DISPATCH_TARGET_MS = 25_000;

export interface InstagramTimingPolicy {
  /** Hard provider cap, measured from the person's triggering message. */
  readonly automatedResponseBudgetMs: number;
  /** Target the coordinator aims for; the margin absorbs generation and queue latency. */
  readonly automatedDispatchTargetMs: number;
}

export function instagramTimingPolicy(overrides: Partial<InstagramTimingPolicy> = {}): InstagramTimingPolicy {
  const budget = overrides.automatedResponseBudgetMs ?? DEFAULT_AUTOMATED_RESPONSE_BUDGET_MS;
  const target = overrides.automatedDispatchTargetMs ?? DEFAULT_AUTOMATED_DISPATCH_TARGET_MS;
  if (!Number.isSafeInteger(budget) || budget <= 0 || !Number.isSafeInteger(target) || target <= 0) {
    throw new RangeError("instagram timing policy values must be positive integer milliseconds");
  }
  // A target at or beyond the cap would defeat its purpose; clamp rather than silently allowing it.
  return { automatedResponseBudgetMs: budget, automatedDispatchTargetMs: Math.min(target, budget) };
}

/**
 * Milliseconds left before an automated reply would miss the target, counted from the person's message.
 * Negative means the deadline has passed: the caller must hold or review rather than send late.
 */
export function remainingAutomatedDispatchMs(
  triggeringInboundAt: Date,
  now: Date,
  policy: InstagramTimingPolicy = instagramTimingPolicy(),
): number {
  return triggeringInboundAt.getTime() + policy.automatedDispatchTargetMs - now.getTime();
}
