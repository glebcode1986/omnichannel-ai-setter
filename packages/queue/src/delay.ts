import { toDurationRangeMs, type DurationRangeMs } from "@omnichannel/domain";

import { MAX_SCHEDULE_DELAY_MS } from "./payloads";

export interface DelayPlan {
  /** Delay chosen for this action; persisted with the job for audit. */
  readonly selectedDelayMs: number;
  /** now + selectedDelayMs. */
  readonly scheduledFor: Date;
}

/**
 * Picks a delay inside a configured range (e.g. 7–12 s debounce, 30–120 s delivery). The range comes from
 * workspace/account policy; the random source is injectable so tests are deterministic. Distribution
 * shaping beyond uniform sampling is policy configuration and is added with the Phase 2 delivery policy.
 */
export function planDelay(range: DurationRangeMs, now: Date, random: () => number = Math.random): DelayPlan {
  const { minMs, maxMs } = toDurationRangeMs(range.minMs, range.maxMs, "delayRange");
  if (maxMs > MAX_SCHEDULE_DELAY_MS) {
    throw new RangeError(`delayRange.maxMs must not exceed ${MAX_SCHEDULE_DELAY_MS}`);
  }
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
    throw new RangeError("random() must return a number in [0, 1)");
  }
  const selectedDelayMs = minMs + Math.floor(sample * (maxMs - minMs + 1));
  return { selectedDelayMs, scheduledFor: new Date(now.getTime() + selectedDelayMs) };
}
