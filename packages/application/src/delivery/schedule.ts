/**
 * Choosing when a reply goes out (DELAY_ENGINE.md, and the provider-timing decision on Issue #13).
 *
 * Two rules that pull against each other, and a fixed order of precedence between them:
 *
 * - the product wants replies that do not look machine-fast, so the delay is *sampled*, not fixed;
 * - the provider decides what "too slow" means, and its budget is not a preference. On Instagram an
 *   experience classified as automated must answer within seconds, so the human-like delay must fit inside
 *   that budget or be given up entirely.
 *
 * The provider always wins. A reply that looks natural but arrives outside what the platform permits is
 * worse than one that arrives promptly, and a reply that misses the deadline is not sent late at all — it
 * goes to a person.
 */
import { toDurationRangeMs, type DurationRangeMs } from "@omnichannel/domain";

/**
 * Where the distribution peaks, as a fraction of the range. One third puts the mode near 60 s on the
 * default 30–120 s range, which is `DELAY_ENGINE.md`'s `Natural` profile: most replies cluster there and
 * the extremes stay rare rather than merely possible.
 */
export const NATURAL_MODE_FRACTION = 1 / 3;

export type DeliveryDelay =
  | { readonly kind: "DELAY"; readonly delayMs: number; readonly shortened: boolean }
  /** The provider's budget is already spent. Nothing is scheduled; a person decides what happens next. */
  | { readonly kind: "DEADLINE_MISSED" };

export interface DeliveryDelayInput {
  readonly range: DurationRangeMs;
  /** Must return a number in [0, 1). */
  readonly random: () => number;
  /**
   * Milliseconds left in the provider's own budget, measured from the customer's triggering message. Absent
   * means the channel imposes no deadline and the sampled delay stands.
   */
  readonly remainingBudgetMs?: number;
  readonly modeFraction?: number;
}

export function selectDeliveryDelayMs(input: DeliveryDelayInput): DeliveryDelay {
  const range = toDurationRangeMs(input.range.minMs, input.range.maxMs, "deliveryDelayMs");
  const sampled = triangular(range, input.random, input.modeFraction ?? NATURAL_MODE_FRACTION);

  if (input.remainingBudgetMs === undefined) {
    return { kind: "DELAY", delayMs: sampled, shortened: false };
  }
  if (input.remainingBudgetMs <= 0) {
    // Already too late to answer as an automated experience. Sending anyway to preserve "human-like
    // timing" would break the rule the timing exists to respect.
    return { kind: "DEADLINE_MISSED" };
  }
  if (sampled <= input.remainingBudgetMs) {
    return { kind: "DELAY", delayMs: sampled, shortened: false };
  }
  // Shortened rather than abandoned: there is still time to answer, just not enough to look leisurely
  // about it. `shortened` is reported so the audit trail shows the provider overrode the product.
  return { kind: "DELAY", delayMs: input.remainingBudgetMs, shortened: true };
}

/**
 * Triangular sample over `[min, max]` peaking at `min + fraction * (max - min)`.
 *
 * A uniform sample would make a 30 s reply exactly as likely as a 119 s one, which reads as a machine
 * choosing at random. The triangular shape clusters replies around the mode and leaves the extremes rare —
 * cheap to compute, no dependency, and it makes the timing distribution something a reader can picture.
 */
function triangular(range: DurationRangeMs, random: () => number, fraction: number): number {
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
    throw new RangeError("random() must return a number in [0, 1)");
  }
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
    throw new RangeError("modeFraction must be between 0 and 1");
  }
  const span = range.maxMs - range.minMs;
  if (span === 0) {
    return range.minMs;
  }
  const mode = range.minMs + fraction * span;
  const split = (mode - range.minMs) / span;
  const value =
    sample < split
      ? range.minMs + Math.sqrt(sample * span * (mode - range.minMs))
      : range.maxMs - Math.sqrt((1 - sample) * span * (range.maxMs - mode));
  // Clamped because floating-point arithmetic at the edges can land a hair outside the range.
  return Math.min(range.maxMs, Math.max(range.minMs, Math.round(value)));
}
