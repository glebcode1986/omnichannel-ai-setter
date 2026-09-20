/**
 * Backlog as a reason to stop adding work (Issue #56).
 *
 * A dependency storm is not usually caused by the first failure. It is caused by what the system does
 * next: the provider slows down, jobs pile up, retries multiply, and the queue that was meant to smooth
 * load becomes the thing generating it. The only move that reliably helps is to stop *adding* automated
 * outbound until the pile drains — which is exactly the kill switch, with the system pulling it instead
 * of a person.
 *
 * Two properties keep that from becoming its own problem:
 *
 * - **hysteresis.** A backlog hovering on a threshold would suspend, drain one job, lift, suspend again.
 *   So the level that trips it and the level that clears it are deliberately different numbers, and the
 *   clearing one is well below;
 * - **a bounded stop.** The suspension carries an `until`, so a guard that itself dies during the outage
 *   cannot leave automation switched off indefinitely. The guard renews it while the backlog persists,
 *   which makes "nothing renewed it" mean "resume", not "stay down".
 *
 * Inbound is never part of this. A backlog of customer messages waiting to be *stored* is a reason to
 * hurry, not a reason to stop: dropping those loses data that no retry can recover.
 */

export interface BacklogReading {
  /** Queue name, used only to explain the decision. */
  readonly queue: string;
  /** Jobs waiting to start. */
  readonly waiting: number;
  /** How long the oldest waiting job has been waiting. The number that says whether this is draining. */
  readonly oldestWaitingMs: number;
}

export interface BacklogThresholds {
  /** Waiting jobs at or above this level trip the guard. */
  readonly waiting: number;
  /** Or an oldest job waiting at least this long, which catches a small queue that is not moving at all. */
  readonly oldestWaitingMs: number;
  /**
   * The backlog must fall to this fraction of the tripping level before automation resumes. Below 1, and
   * meaningfully so: a clearing level equal to the tripping level is a switch that flaps.
   */
  readonly clearFraction: number;
  /** How long each automatic suspension lasts before it lapses on its own. */
  readonly suspendForMs: number;
}

export const DEFAULT_BACKLOG_THRESHOLDS: BacklogThresholds = {
  waiting: 500,
  oldestWaitingMs: 10 * 60 * 1000,
  clearFraction: 0.5,
  suspendForMs: 5 * 60 * 1000,
};

export type BackpressureDecision =
  /** Nothing to do: either the backlog is fine, or it is bad and already suspended and still renewed. */
  | { readonly kind: "NONE" }
  | { readonly kind: "SUSPEND"; readonly until: Date; readonly detail: string }
  | { readonly kind: "LIFT"; readonly detail: string };

export interface BackpressureState {
  /** Whether an automatic BACKLOG suspension is currently in force. Operator switches are not this. */
  readonly suspended: boolean;
}

/**
 * Decides what the backlog means, given what is already in force.
 *
 * Pure, and it takes `now` rather than reading a clock, because "what would this do at 03:00 with 900
 * jobs waiting" has to be answerable in a test rather than in production.
 */
export function decideBackpressure(
  readings: readonly BacklogReading[],
  thresholds: BacklogThresholds,
  state: BackpressureState,
  now: Date,
): BackpressureDecision {
  const tripping = readings.filter((reading) => reading.waiting >= thresholds.waiting || reading.oldestWaitingMs >= thresholds.oldestWaitingMs);
  if (tripping.length > 0) {
    const worst = tripping.reduce((left, right) => (right.waiting > left.waiting ? right : left));
    return {
      kind: "SUSPEND",
      until: new Date(now.getTime() + thresholds.suspendForMs),
      // Renewed rather than left alone while it persists: an automatic stop that outlives the condition
      // that justified it is indistinguishable, to the operator, from one nobody remembered to lift.
      detail: `${worst.queue} has ${String(worst.waiting)} waiting, oldest ${String(Math.round(worst.oldestWaitingMs / 1000))}s`,
    };
  }

  if (!state.suspended) {
    return { kind: "NONE" };
  }

  const clearWaiting = thresholds.waiting * thresholds.clearFraction;
  const clearAge = thresholds.oldestWaitingMs * thresholds.clearFraction;
  const stillHigh = readings.filter((reading) => reading.waiting > clearWaiting || reading.oldestWaitingMs > clearAge);
  if (stillHigh.length > 0) {
    // Draining, but not yet far enough below to be sure resuming will not simply refill it.
    return { kind: "NONE" };
  }
  return { kind: "LIFT", detail: "the backlog has drained" };
}
