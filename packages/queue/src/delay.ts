import { toDurationRangeMs, type DurationRangeMs } from "@omnichannel/domain";

import { MAX_SCHEDULE_DELAY_MS, type DeliveryJob } from "./payloads";

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


/** Why a declared schedule was refused. Callers branch on this, never on the message. */
export type ScheduleRejection =
  /** The send is further out than the queue can durably hold. */
  | "OUT_OF_RANGE"
  /** The payload's own two statements about the plan disagree. */
  | "CONTRADICTORY_METADATA";

/**
 * A declared delivery schedule the queue refuses to accept.
 *
 * A `RangeError` so it reads like the existing guards, with a `reason` so a caller can tell the two
 * refusals apart without matching on text.
 */
export class ScheduleRangeError extends RangeError {
  readonly reason: ScheduleRejection;

  constructor(reason: ScheduleRejection, message: string) {
    super(message);
    this.name = "ScheduleRangeError";
    this.reason = reason;
  }
}

/**
 * How long to wait before running a delivery that declares `scheduledFor`, or a refusal.
 *
 * **A schedule beyond the queue's reach is rejected, never shortened.** Clamping it would send a reply
 * days or weeks before the moment the payload still claims, and it would do so silently: the durable
 * record keeps saying "30 days" while the queue runs it after seven. Of the two ways to be wrong, sending
 * early is the one that reaches a customer, so this fails closed and creates no job at all.
 *
 * **A past or present `scheduledFor` runs immediately, and that is deliberate.** It is what an operation
 * resumed after an outage looks like, and running it now is not the same as running it early — the
 * coordinator re-reads the conversation and re-runs the policy engine before anything is sent, so a reply
 * that has since become wrong is discarded rather than delivered late.
 *
 * **The payload's two statements about the plan must agree.** `selectedDelayMs` is the whole delay chosen
 * when the plan was made and `scheduledFor` is that instant plus it, so the wait still remaining can never
 * exceed the delay originally chosen — enqueueing happens at or after planning, never before. A payload
 * claiming otherwise describes two different plans, and the queue does not get to pick one and quietly
 * execute it. This is arithmetic on the payload's own fields; no channel or business policy enters here.
 */
export function deliveryDelayFor(job: DeliveryJob, at: Date): number {
  const scheduledFor = Date.parse(job.scheduledFor);
  if (!Number.isFinite(scheduledFor)) {
    throw new ScheduleRangeError("CONTRADICTORY_METADATA", "scheduledFor is not a usable instant");
  }
  const delayMs = Math.max(0, scheduledFor - at.getTime());
  if (delayMs > MAX_SCHEDULE_DELAY_MS) {
    throw new ScheduleRangeError(
      "OUT_OF_RANGE",
      `scheduledFor is ${String(delayMs)} ms away, beyond the ${String(MAX_SCHEDULE_DELAY_MS)} ms this queue can hold`,
    );
  }
  if (delayMs > job.selectedDelayMs) {
    throw new ScheduleRangeError(
      "CONTRADICTORY_METADATA",
      `scheduledFor is ${String(delayMs)} ms away but selectedDelayMs declares ${String(job.selectedDelayMs)} ms`,
    );
  }
  return delayMs;
}
