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
