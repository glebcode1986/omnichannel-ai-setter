/**
 * The arithmetic a chart needs, kept out of the components that draw.
 *
 * Separated because these are the parts that can be wrong without looking wrong. A column two pixels
 * short reads as a column; a day silently missing from the axis reads as a shorter week. So the axis
 * ceiling, the day list and the share are functions with their own tests, and the components below are
 * only geometry.
 */

/** The window a chart's x axis covers. Structurally the store's `MetricWindow`, without the import. */
export interface DayWindow {
  readonly from: Date;
  readonly to: Date;
  readonly timeZone: string;
}

/**
 * No window this product offers is longer than 90 days, so a loop that reaches four hundred is a bug
 * rather than a long report, and stopping is better than hanging the page while it draws.
 */
const MAX_DAYS = 400;

/** `YYYY-MM-DD` in the given zone, assembled from the parts rather than from a locale's own ordering. */
function dayIn(at: Date, format: Intl.DateTimeFormat): string {
  const parts = format.formatToParts(at);
  const part = (type: string): string => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/**
 * Every local calendar day the window covers, in order, as `YYYY-MM-DD`.
 *
 * This exists because the store returns **only days that had something on them**: `GROUP BY day` cannot
 * emit a row for a day with no inbound message. A chart drawn straight from that array would put Monday
 * next to Thursday at equal width and call it a week — the quiet days would vanish rather than read as
 * quiet, which is the opposite of what somebody opens a volume chart to see.
 *
 * The walk is calendar arithmetic on the `YYYY-MM-DD` triple, not repeated addition of 24 hours. A day
 * is 23 or 25 hours long twice a year in most of the zones this product offers, and stepping by a fixed
 * duration drifts across those boundaries and eventually skips or repeats a date. Incrementing the date
 * itself cannot: `Date.UTC` normalises the 32nd of October without knowing anything about zones, and the
 * result is never converted back.
 *
 * `to` is exclusive, so the last day the window covers is the one containing the moment before it.
 */
export function localDays({ from, to, timeZone }: DayWindow): readonly string[] {
  if (to <= from) {
    return [];
  }
  // `en-CA` for Latin digits; the parts are reassembled by name, so the locale's own order is not relied
  // on. The zone is the whole point of the formatter.
  const format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const last = dayIn(new Date(to.getTime() - 1), format);
  const days: string[] = [];
  let cursor = dayIn(from, format);
  // Zero-padded ISO dates sort lexicographically, which is the only reason a string comparison is a date
  // comparison here.
  for (let guard = 0; guard < MAX_DAYS && cursor <= last; guard += 1) {
    days.push(cursor);
    cursor = nextDay(cursor);
  }
  return days;
}

/** The calendar day after `day`, both `YYYY-MM-DD`. */
function nextDay(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  const next = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, (date ?? 1) + 1));
  return next.toISOString().slice(0, 10);
}

/**
 * A clean number at or above `max`, for the top of an axis.
 *
 * One, two or five times a power of ten. The alternative — scaling to the largest value itself — makes
 * the tallest column full height in every window, so a week with four messages and a week with four
 * hundred draw the same picture and only the caption differs.
 *
 * Returns 0 for a maximum of 0, which the callers read as "nothing to draw" rather than dividing by it.
 */
export function niceTop(max: number): number {
  if (!Number.isFinite(max) || max <= 0) {
    return 0;
  }
  const magnitude = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 5]) {
    if (step * magnitude >= max) {
      return step * magnitude;
    }
  }
  return 10 * magnitude;
}

/**
 * `value` as a percentage of `top`, for a CSS length.
 *
 * Clamped at both ends: a share above 100% would draw outside its track, and a negative one would draw
 * backwards. Neither should reach here, and both are a wrong picture rather than an error if they do.
 *
 * A **zero** value returns exactly `0%` and the stylesheet floors everything else at two pixels, so
 * "none" and "almost none" stay distinguishable. That floor belongs in CSS rather than here: it is a
 * minimum *mark size*, not a claim about the number, and putting it in the arithmetic would mean the
 * percentages this function returns no longer describe the data.
 */
export function sharePercent(value: number, top: number): string {
  if (!Number.isFinite(value) || !Number.isFinite(top) || top <= 0 || value <= 0) {
    return "0%";
  }
  const share = Math.min(1, value / top);
  // Two decimals: enough that a 1-in-5000 column differs from an empty one, short enough to read in dev
  // tools.
  return `${(share * 100).toFixed(2)}%`;
}
