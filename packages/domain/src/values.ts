import { DomainValidationError } from "./errors";

declare const confidenceBrand: unique symbol;

/** Model confidence in the closed interval [0, 1]. */
export type Confidence = number & { readonly [confidenceBrand]: true };

export function toConfidence(value: number, field = "confidence"): Confidence {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new DomainValidationError(field, "must be a finite number between 0 and 1");
  }
  return value as Confidence;
}

/** Inclusive millisecond range used for debounce and human-like delivery delays. */
export interface DurationRangeMs {
  readonly minMs: number;
  readonly maxMs: number;
}

export function toDurationRangeMs(minMs: number, maxMs: number, field: string): DurationRangeMs {
  if (!Number.isSafeInteger(minMs) || !Number.isSafeInteger(maxMs) || minMs < 0 || maxMs < 0) {
    throw new DomainValidationError(field, "bounds must be non-negative integer milliseconds");
  }
  if (minMs > maxMs) {
    throw new DomainValidationError(field, "minMs must not exceed maxMs");
  }
  return { minMs, maxMs };
}

/** Initial configurable targets from PROJECT_CONTEXT.md; workspaces may configure within product bounds. */
export const DEFAULT_DEBOUNCE_WINDOW_MS: DurationRangeMs = { minMs: 7_000, maxMs: 12_000 };
export const DEFAULT_DELIVERY_DELAY_MS: DurationRangeMs = { minMs: 30_000, maxMs: 120_000 };

/** Wall-clock time of day as HH:MM (24-hour). */
export type TimeOfDay = `${number}:${number}`;

export interface QuietHours {
  /** IANA time zone, e.g. "Europe/Berlin". */
  readonly timeZone: string;
  /** Start of the quiet period; may be later than `end` when the period spans midnight. */
  readonly start: TimeOfDay;
  readonly end: TimeOfDay;
}

const TIME_OF_DAY = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function toQuietHours(timeZone: string, start: string, end: string): QuietHours {
  if (!isValidTimeZone(timeZone)) {
    throw new DomainValidationError("quietHours.timeZone", "must be a valid IANA time zone");
  }
  if (!TIME_OF_DAY.test(start) || !TIME_OF_DAY.test(end)) {
    throw new DomainValidationError("quietHours", "start and end must be HH:MM (00:00-23:59)");
  }
  if (start === end) {
    throw new DomainValidationError("quietHours", "start and end must differ");
  }
  return { timeZone, start: start as TimeOfDay, end: end as TimeOfDay };
}

/**
 * Whether an instant falls inside a quiet period, in the period's own time zone.
 *
 * The comparison happens on the wall clock a person in that zone would read, not on UTC: "no automated
 * messages after 22:00" is a statement about the customer's evening, and a UTC comparison would drift by
 * the offset and break twice a year at daylight-saving boundaries.
 *
 * A period whose start is later than its end spans midnight (22:00-07:00), which is the common case for
 * quiet hours and the reason this is not a simple range check. `start` is inclusive and `end` exclusive, so
 * a period can never swallow the whole day and a send at exactly `end` is allowed.
 */
export function isWithinQuietHours(quietHours: QuietHours, now: Date): boolean {
  const minutes = minutesOfDayIn(quietHours.timeZone, now);
  const start = minutesOfDay(quietHours.start);
  const end = minutesOfDay(quietHours.end);
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

function minutesOfDay(time: TimeOfDay): number {
  const [hours, mins] = time.split(":");
  return Number(hours) * 60 + Number(mins);
}

/** The wall-clock minute-of-day in a given IANA zone. `hourCycle: "h23"` keeps midnight at 00, not 24. */
function minutesOfDayIn(timeZone: string, now: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const value = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return value("hour") * 60 + value("minute");
}

/**
 * The next instant at which a quiet period ends, at or after `now`.
 *
 * Computed in the period's own time zone and returned as an instant, so a caller can compare it against a
 * provider deadline without re-deriving anything. When `now` is already outside the period the answer is
 * the *next* end, which is the same value a caller inside the period would get one tick earlier — so the
 * function is total and never has to be guarded by a separate "is it quiet" check.
 *
 * Deliberately built by walking minute-of-day arithmetic rather than by constructing a local date: a zone
 * offset can change between `now` and the boundary (a daylight-saving transition inside the quiet period is
 * the common case for an overnight one), and a naive local-date construction lands on the wrong instant
 * exactly then.
 */
export function nextQuietHoursEnd(quietHours: QuietHours, now: Date): Date {
  const minutesNow = minutesOfDayIn(quietHours.timeZone, now);
  const end = minutesOfDay(quietHours.end);
  const minutesAhead = end > minutesNow ? end - minutesNow : end - minutesNow + MINUTES_PER_DAY;
  const candidate = new Date(now.getTime() + minutesAhead * 60_000);
  // One correction pass: if the offset shifted across the boundary, the wall clock at `candidate` is not
  // `end`, and the difference is exactly the shift.
  const drift = minutesOfDayIn(quietHours.timeZone, candidate) - end;
  const corrected = new Date(candidate.getTime() - normalizeDrift(drift) * 60_000);
  return corrected.getTime() > now.getTime() ? corrected : candidate;
}

const MINUTES_PER_DAY = 24 * 60;

/** A drift of +23h59m is really -1m; fold it into the nearest direction. */
function normalizeDrift(drift: number): number {
  if (drift > MINUTES_PER_DAY / 2) {
    return drift - MINUTES_PER_DAY;
  }
  return drift < -MINUTES_PER_DAY / 2 ? drift + MINUTES_PER_DAY : drift;
}
