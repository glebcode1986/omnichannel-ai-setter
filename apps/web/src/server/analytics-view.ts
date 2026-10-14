/**
 * What the analytics and audit screens are looking at, read from the URL (LEADS_ANALYTICS_UX.md, #34).
 *
 * In the URL rather than in state, for the reason every other filtered surface here does it: a reader who
 * finds something worth showing somebody can send them the link, and a reload lands on the same numbers.
 *
 * **The timezone is part of the question, and it is on screen.** There is no workspace timezone column and
 * this deliberately does not invent one by borrowing the quiet-hours zone — that says when we may message
 * customers, which is a different question with the same shape. So the zone comes from the URL, defaults
 * to UTC, and the page always states which one it used. A dashboard that silently bucketed days in UTC
 * would put a 9pm conversation in Madrid on the wrong day with nothing to explain the discrepancy.
 */
import { AUDIT_EVENT_KINDS, isAuditEventKind, isLeadStage, type AuditEventKind } from "@omnichannel/domain";
import type { MetricFilter, MetricWindow } from "@omnichannel/db";

export type RawSearchParams = Record<string, string | string[] | undefined>;

/** Ranges somebody actually asks for. A free-text date pair is a later refinement, not an MVP metric. */
export const RANGE_PRESETS = ["TODAY", "LAST_7_DAYS", "LAST_30_DAYS", "LAST_90_DAYS"] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];
const DEFAULT_RANGE: RangePreset = "LAST_7_DAYS";

/** Zones the picker offers. Any valid IANA name still works from the URL; this is the shortlist. */
export const OFFERED_TIME_ZONES = ["UTC", "Europe/Madrid", "Europe/Moscow", "Europe/London", "America/New_York", "Asia/Dubai"] as const;
export const FALLBACK_TIME_ZONE = "UTC";

export const AI_MODES = ["OFF", "DRAFT", "AUTOPILOT"] as const;
type AiMode = (typeof AI_MODES)[number];

export interface AnalyticsView {
  readonly range: RangePreset;
  readonly timeZone: string;
  readonly channelAccountId?: string;
  readonly mode?: AiMode;
  readonly leadStage?: string;
  readonly assignedUserId?: string;
  /** Audit only: the kinds a reader narrowed to, and the words they typed. */
  readonly kinds: readonly AuditEventKind[];
  readonly term?: string;
}

function one(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined || first.trim() === "" ? undefined : first.trim();
}

function many(value: string | string[] | undefined): readonly string[] {
  return (Array.isArray(value) ? value : value === undefined ? [] : [value]).flatMap((entry) => entry.split(",")).map((entry) => entry.trim());
}

/**
 * Whether this is a zone the runtime knows.
 *
 * Validated by asking `Intl` rather than against a list of our own, because the list would be wrong the
 * first time a political boundary moved. An unknown zone falls back to UTC instead of throwing: a
 * hand-edited URL should show the reader something true, not an error page.
 */
export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function parseAnalyticsView(params: RawSearchParams): AnalyticsView {
  const range = one(params["range"]);
  const zone = one(params["tz"]);
  const mode = one(params["mode"]);
  const stage = one(params["stage"]);
  // Read once each. Calling `one()` twice per field to test it and then use it was how three
  // unnecessary casts got in: the second call's type had no memory of the first one's check.
  const account = one(params["account"]);
  const owner = one(params["owner"]);
  const term = one(params["q"]);
  return {
    range: isRangePreset(range) ? range : DEFAULT_RANGE,
    timeZone: zone !== undefined && isTimeZone(zone) ? zone : FALLBACK_TIME_ZONE,
    ...(account === undefined ? {} : { channelAccountId: account }),
    ...(isAiMode(mode) ? { mode } : {}),
    // Validated against the domain's own list: a stage nobody defined is dropped rather than queried.
    ...(isLeadStage(stage) ? { leadStage: stage } : {}),
    ...(owner === undefined ? {} : { assignedUserId: owner }),
    kinds: many(params["kind"]).filter((kind) => isAuditEventKind(kind)),
    ...(term === undefined ? {} : { term }),
  };
}

/** Narrowing guards, so a validated value keeps its narrowed type instead of needing a cast. */
function isRangePreset(value: string | undefined): value is RangePreset {
  return value !== undefined && RANGE_PRESETS.includes(value as RangePreset);
}

function isAiMode(value: string | undefined): value is AiMode {
  return value !== undefined && AI_MODES.includes(value as AiMode);
}

/** The days a preset covers, ending at the reader's current local day inclusive. */
export function windowOf(view: AnalyticsView, now: Date): MetricWindow {
  const days = view.range === "TODAY" ? 1 : view.range === "LAST_7_DAYS" ? 7 : view.range === "LAST_30_DAYS" ? 30 : 90;
  // Local midnights, so "last 7 days" means seven of the reader's own days rather than 168 hours ending
  // at an arbitrary moment. `to` is the *next* local midnight, exclusive, so today is included whole.
  const endOfToday = localMidnight(now, view.timeZone, 1);
  return { from: localMidnight(now, view.timeZone, 1 - days), to: endOfToday, timeZone: view.timeZone };
}

/**
 * The instant of local midnight, `offsetDays` from the local day containing `at`.
 *
 * Done by formatting in the target zone and re-reading the parts, because that is the only way to get the
 * zone's actual offset on that date — hard-coding one would be wrong twice a year in every zone that
 * changes, and wrong permanently in the ones that changed their rules.
 */
function localMidnight(at: Date, timeZone: string, offsetDays: number): Date {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const part = (type: string) => Number(parts.find((entry) => entry.type === type)?.value ?? "0");
  const localDay = Date.UTC(part("year"), part("month") - 1, part("day") + offsetDays);
  // `localDay` is that calendar date read as UTC. Subtracting the zone's offset at that moment turns it
  // into the instant local midnight actually happened.
  return new Date(localDay - offsetAt(new Date(localDay), timeZone));
}

/** The zone's offset from UTC, in milliseconds, at a given instant. */
function offsetAt(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const part = (type: string) => Number(parts.find((entry) => entry.type === type)?.value ?? "0");
  const asUtc = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour") % 24, part("minute"), part("second"));
  return asUtc - at.getTime();
}

/** The dimensions, without the audit-only fields the metric queries have no use for. */
export function metricFilterOf(view: AnalyticsView, businessProfileId: string): MetricFilter {
  return {
    businessProfileId,
    ...(view.channelAccountId === undefined ? {} : { channelAccountId: view.channelAccountId }),
    ...(view.mode === undefined ? {} : { mode: view.mode }),
    ...(view.leadStage === undefined ? {} : { leadStage: view.leadStage }),
    ...(view.assignedUserId === undefined ? {} : { assignedUserId: view.assignedUserId }),
  };
}

/** The view as a query string, so every link on the page keeps the filters the reader chose. */
export function analyticsQueryString(view: AnalyticsView, override: Partial<AnalyticsView> = {}): string {
  const merged = { ...view, ...override };
  const params = new URLSearchParams();
  if (merged.range !== DEFAULT_RANGE) {
    params.set("range", merged.range);
  }
  if (merged.timeZone !== FALLBACK_TIME_ZONE) {
    params.set("tz", merged.timeZone);
  }
  for (const [key, value] of [
    ["account", merged.channelAccountId],
    ["mode", merged.mode],
    ["stage", merged.leadStage],
    ["owner", merged.assignedUserId],
    ["q", merged.term],
  ] as const) {
    if (value !== undefined) {
      params.set(key, value);
    }
  }
  for (const kind of merged.kinds) {
    params.append("kind", kind);
  }
  const query = params.toString();
  return query === "" ? "" : `?${query}`;
}

/** Whether the reader has narrowed anything, so the page can offer to clear it only when there is something to clear. */
export function isFilteredView(view: AnalyticsView): boolean {
  return (
    view.range !== DEFAULT_RANGE ||
    view.timeZone !== FALLBACK_TIME_ZONE ||
    view.channelAccountId !== undefined ||
    view.mode !== undefined ||
    view.leadStage !== undefined ||
    view.assignedUserId !== undefined ||
    view.term !== undefined ||
    view.kinds.length > 0
  );
}

export { AUDIT_EVENT_KINDS };
