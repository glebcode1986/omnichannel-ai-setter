/**
 * Reading the analytics question out of the URL (Issue #34).
 *
 * The window arithmetic gets the most attention here, because it is the part that can be quietly wrong.
 * A range that is off by an hour twice a year produces a dashboard that disagrees with the Inbox on two
 * days a year — which is exactly the kind of defect nobody reports and everybody stops trusting.
 */
import { describe, expect, it } from "vitest";

import {
  analyticsQueryString,
  isFilteredView,
  isTimeZone,
  metricFilterOf,
  parseAnalyticsView,
  windowOf,
  type AnalyticsView,
} from "./analytics-view";

const view = (params: Record<string, string | string[] | undefined> = {}): AnalyticsView => parseAnalyticsView(params);

describe("the analytics view", () => {
  it("defaults to the last seven days in UTC", () => {
    expect(view()).toMatchObject({ range: "LAST_7_DAYS", timeZone: "UTC", kinds: [] });
  });

  it("keeps a valid zone and falls back rather than throwing on a hand-edited one", () => {
    expect(view({ tz: "Europe/Madrid" }).timeZone).toBe("Europe/Madrid");
    // A hand-edited URL should show the reader something true, not an error page.
    expect(view({ tz: "Middle/Earth" }).timeZone).toBe("UTC");
    expect(view({ tz: "" }).timeZone).toBe("UTC");
  });

  it("asks the runtime what a zone is rather than keeping a list of its own", () => {
    // A list here would be wrong the first time a political boundary moved.
    expect(isTimeZone("Europe/Kyiv")).toBe(true);
    expect(isTimeZone("America/Argentina/Ushuaia")).toBe(true);
    expect(isTimeZone("Not/AZone")).toBe(false);
  });

  it("drops a mode, stage or range nobody defined instead of querying it", () => {
    const hostile = view({ mode: "SUPERPILOT", stage: "DEFINITELY_BUYING", range: "ALL_TIME", kind: "DELETE_EVERYTHING" });

    expect(hostile.mode).toBeUndefined();
    expect(hostile.leadStage).toBeUndefined();
    expect(hostile.range).toBe("LAST_7_DAYS");
    expect(hostile.kinds).toEqual([]);
  });

  it("accepts the kinds that do exist, however they were listed", () => {
    expect(view({ kind: "MODE_CHANGED,POLICY_CHANGED" }).kinds).toEqual(["MODE_CHANGED", "POLICY_CHANGED"]);
    expect(view({ kind: ["MODE_CHANGED", "TAKEOVER_STARTED"] }).kinds).toEqual(["MODE_CHANGED", "TAKEOVER_STARTED"]);
  });

  describe("the window", () => {
    it("covers today whole, from local midnight to the next one", () => {
      // 09:00 in Madrid on the 3rd. The day being reported is the 3rd, all of it, not the nine hours so far.
      const now = new Date("2026-10-03T07:00:00.000Z");

      const window = windowOf(view({ range: "TODAY", tz: "Europe/Madrid" }), now);

      expect(window.from.toISOString()).toBe("2026-10-02T22:00:00.000Z");
      expect(window.to.toISOString()).toBe("2026-10-03T22:00:00.000Z");
      expect(window.timeZone).toBe("Europe/Madrid");
    });

    it("counts the reader's own days, not a fixed number of hours", () => {
      const now = new Date("2026-10-03T07:00:00.000Z");

      const week = windowOf(view({ range: "LAST_7_DAYS", tz: "Europe/Madrid" }), now);

      // Seven local days ending with today, so the first is the 27th at local midnight.
      expect(week.from.toISOString()).toBe("2026-09-26T22:00:00.000Z");
      expect(week.to.toISOString()).toBe("2026-10-03T22:00:00.000Z");
    });

    it("gets the offset right across a clock change", () => {
      // Madrid leaves summer time on 2026-10-25. A range spanning it has a different offset at each end,
      // and a hard-coded one would make a 25-hour day look like a 24-hour one.
      const now = new Date("2026-10-27T10:00:00.000Z");

      const window = windowOf(view({ range: "LAST_7_DAYS", tz: "Europe/Madrid" }), now);

      // Start is still summer time (UTC+2), end is winter (UTC+1). Both are local midnight.
      expect(window.from.toISOString()).toBe("2026-10-20T22:00:00.000Z");
      expect(window.to.toISOString()).toBe("2026-10-27T23:00:00.000Z");
    });

    it("puts a late-evening instant on the following local day", () => {
      // 23:30 UTC on the 3rd is 01:30 on the 4th in Madrid, so "today" is the 4th.
      const now = new Date("2026-10-03T23:30:00.000Z");

      const window = windowOf(view({ range: "TODAY", tz: "Europe/Madrid" }), now);

      expect(window.from.toISOString()).toBe("2026-10-03T22:00:00.000Z");
      expect(window.to.toISOString()).toBe("2026-10-04T22:00:00.000Z");
    });

    it("works west of UTC as well, where the local day starts after the UTC one", () => {
      const now = new Date("2026-10-03T12:00:00.000Z");

      const window = windowOf(view({ range: "TODAY", tz: "America/New_York" }), now);

      expect(window.from.toISOString()).toBe("2026-10-03T04:00:00.000Z");
      expect(window.to.toISOString()).toBe("2026-10-04T04:00:00.000Z");
    });

    it("gives every preset a window that ends after it starts and contains its own days", () => {
      const now = new Date("2026-10-03T12:00:00.000Z");

      for (const [range, days] of [["TODAY", 1], ["LAST_7_DAYS", 7], ["LAST_30_DAYS", 30], ["LAST_90_DAYS", 90]] as const) {
        const window = windowOf(view({ range, tz: "UTC" }), now);
        expect(window.to.getTime()).toBeGreaterThan(window.from.getTime());
        expect((window.to.getTime() - window.from.getTime()) / 86_400_000).toBe(days);
      }
    });
  });

  describe("the query string", () => {
    it("leaves the defaults out, so an unfiltered link is clean", () => {
      expect(analyticsQueryString(view())).toBe("");
    });

    it("round-trips everything a reader chose", () => {
      const chosen = view({ range: "LAST_30_DAYS", tz: "Europe/Madrid", account: "acc-1", mode: "DRAFT", stage: "QUALIFIED", owner: "user-1", q: "mode", kind: "MODE_CHANGED" });

      const reparsed = parseAnalyticsView(Object.fromEntries(new URLSearchParams(analyticsQueryString(chosen).slice(1)).entries()));

      // A link somebody sends a colleague has to land on the same numbers.
      expect(reparsed).toMatchObject({
        range: "LAST_30_DAYS",
        timeZone: "Europe/Madrid",
        channelAccountId: "acc-1",
        mode: "DRAFT",
        leadStage: "QUALIFIED",
        assignedUserId: "user-1",
        term: "mode",
      });
    });

    it("carries several kinds rather than the last one", () => {
      const query = analyticsQueryString(view({ kind: ["MODE_CHANGED", "POLICY_CHANGED"] }));

      expect(new URLSearchParams(query.slice(1)).getAll("kind")).toEqual(["MODE_CHANGED", "POLICY_CHANGED"]);
    });

    it("applies an override without losing the rest", () => {
      const chosen = view({ tz: "Europe/Madrid", account: "acc-1" });

      const query = analyticsQueryString(chosen, { range: "LAST_90_DAYS" });

      expect(query).toContain("range=LAST_90_DAYS");
      expect(query).toContain("account=acc-1");
      expect(query).toContain("tz=Europe%2FMadrid");
    });
  });

  it("says whether anything is narrowed, so the page offers to clear only when there is something to clear", () => {
    expect(isFilteredView(view())).toBe(false);
    expect(isFilteredView(view({ tz: "Europe/Madrid" }))).toBe(true);
    expect(isFilteredView(view({ mode: "DRAFT" }))).toBe(true);
    expect(isFilteredView(view({ kind: "MODE_CHANGED" }))).toBe(true);
  });

  it("always scopes the metric filter to one Business Profile", () => {
    // The page is profile-scoped even though the store is workspace-scoped, and the id comes from the
    // route rather than from the query string a reader could edit.
    expect(metricFilterOf(view({ mode: "DRAFT" }), "profile-1")).toEqual({ businessProfileId: "profile-1", mode: "DRAFT" });
    expect(metricFilterOf(view(), "profile-1")).toEqual({ businessProfileId: "profile-1" });
  });
});
