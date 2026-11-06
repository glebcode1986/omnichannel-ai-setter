// @vitest-environment jsdom
/**
 * The analytics dashboard (Issue #34).
 *
 * Two cases carry the task's hard invariant, and they are the reason this file exists: the provider's
 * numbers must never appear in the same table as ours, and a metric with nothing to measure must say so
 * rather than say zero. The rest is ordinary rendering.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { OperationalSnapshot } from "@omnichannel/db";

import { MetricsView } from "./metrics-view";
import { catalogues, type MessageKey } from "@/i18n/catalogue";
import { createTranslator } from "@/i18n/translate";

const t = createTranslator("en");
const text = (key: MessageKey) => catalogues.en[key];

afterEach(cleanup);

const snapshot = (overrides: Partial<OperationalSnapshot> = {}): OperationalSnapshot => ({
  // Madrid local midnights, which is what `windowOf` produces and the only kind of window the product
  // can ask for. UTC midnights with a Madrid zone would straddle eight local days and draw eight columns
  // for a seven-day range — correct for that window, and a window no screen can reach.
  window: { from: new Date("2026-09-30T22:00:00.000Z"), to: new Date("2026-10-07T22:00:00.000Z"), timeZone: "Europe/Madrid" },
  volume: [{ day: "2026-10-01", inboundMessages: 12, inboundConversations: 4 }],
  responseTimes: { samples: 3, medianSeconds: 42, p90Seconds: 120 },
  drafts: { generated: 10, autoSent: 4, humanApprovedSent: 3, awaitingReview: 2, heldAmbiguous: 1, dismissed: 0, superseded: 0, failed: 0 },
  reviewReasons: [
    { reason: "MISSING_FACT", drafts: 2 },
    { reason: "LOW_CONFIDENCE", drafts: 1 },
  ],
  missingFacts: { drafts: 2, share: 0.2 },
  takeover: { conversationsWithInbound: 8, takenOver: 2, rate: 0.25 },
  delivery: {
    application: { scheduled: 1, heldForReview: 2, heldAmbiguous: 1, handedToProvider: 7, cancelled: 1, failedAfterRetries: 0 },
    provider: { awaitingReport: 7, reportedSent: 0, reportedDelivered: 0, reportedRead: 0, reportedFailed: 0 },
    ambiguous: { open: 1, resolved: 2 },
  },
  leads: {
    movements: [
      { toStage: "ENGAGED", transitions: 5, conversations: 4 },
      { toStage: "QUALIFIED", transitions: 2, conversations: 2 },
    ],
    qualified: 2,
    engaged: 4,
    qualificationRate: 0.5,
  },
  usage: [{ provider: "anthropic", model: "claude-opus-5", generations: 10, inputTokens: 9000, outputTokens: 1200, cacheReadTokens: 500, cacheWriteTokens: 100, medianLatencyMs: 820 }],
  ...overrides,
});

const labels = { NEW: "New", ENGAGED: "Engaged", QUALIFIED: "Ready to book", WON: "Won", LOST: "Lost" };

describe("the analytics dashboard", () => {
  it("keeps what we decided and what the provider said in separate panels", () => {
    render(<MetricsView t={t} snapshot={snapshot()} stageLabels={labels} />);

    const ours = document.querySelector('[data-panel="application-state"]') as HTMLElement;
    const theirs = document.querySelector('[data-panel="provider-state"]') as HTMLElement;

    // Two panels, each with its own caption saying whose claim it is. A single table mixing them would
    // let somebody tell a customer their message arrived on our word alone.
    expect(within(ours).getByText(text("analytics.handedToProvider"))).toBeDefined();
    expect(within(theirs).getByText(text("analytics.reportedDelivered"))).toBeDefined();
    expect(within(ours).queryByText(text("analytics.reportedDelivered"))).toBeNull();
    expect(within(theirs).queryByText(text("analytics.handedToProvider"))).toBeNull();
    expect(within(theirs).getByText(text("analytics.providerHint"))).toBeDefined();
  });

  it("shows seven handed over and nothing delivered, without reconciling the two", () => {
    render(<MetricsView t={t} snapshot={snapshot()} stageLabels={labels} />);

    const ours = document.querySelector('[data-panel="application-state"]') as HTMLElement;
    const theirs = document.querySelector('[data-panel="provider-state"]') as HTMLElement;

    // The fixture is the honest case: we handed over seven and the provider has said nothing about any
    // of them. The page must render that as seven and zero, with "no report yet" accounting for them.
    expect(within(ours).getByText("7")).toBeDefined();
    expect(within(theirs).getByText(text("analytics.awaitingReport"))).toBeDefined();
    expect(within(theirs).getAllByText("7")).toHaveLength(1);
  });

  it("says a metric was not measured rather than reporting zero", () => {
    render(
      <MetricsView
        t={t}
        snapshot={snapshot({
          responseTimes: { samples: 0, medianSeconds: null, p90Seconds: null },
          takeover: { conversationsWithInbound: 0, takenOver: 0, rate: null },
          missingFacts: { drafts: 0, share: null },
        })}
        stageLabels={labels}
      />,
    );

    // "0s median" for a quiet week is the best-looking number on the page and a complete fiction.
    expect(screen.getAllByText(text("analytics.notMeasured")).length).toBeGreaterThanOrEqual(3);
    expect(screen.queryByText("0s")).toBeNull();
    expect(screen.queryByText("0%")).toBeNull();
  });

  it("says a whole sentence under a figure it could not measure, rather than putting the words in the number's slot", () => {
    render(
      <MetricsView
        t={t}
        snapshot={snapshot({
          drafts: { generated: 0, autoSent: 0, humanApprovedSent: 0, awaitingReview: 0, heldAmbiguous: 0, dismissed: 0, superseded: 0, failed: 0 },
          reviewReasons: [],
          missingFacts: { drafts: 0, share: null },
        })}
        stageLabels={labels}
      />,
    );

    // The defect this replaces: the caption interpolated the share, and with no share to interpolate it
    // put "Not measured" where the number goes — "Not measured of drafts were missing a fact", a
    // sentence with its subject swapped out. A reader saw it on every quiet week.
    const tile = document.querySelector('[data-panel="missing-facts"]') as HTMLElement;
    const caption = tile.querySelector("p.muted") as HTMLElement;
    expect(caption.textContent).toBe("0 of 0 drafts");
    expect(caption.textContent).not.toContain(text("analytics.notMeasured"));

    // And the figure itself still says it. Both halves matter: a caption that reads properly above a
    // figure claiming 0% would be the worse of the two defects.
    expect(within(tile).getByText(text("analytics.notMeasured"))).toBeTruthy();
  });

  it("gives every tile a caption, so no percentage is published without its denominator", () => {
    render(<MetricsView t={t} snapshot={snapshot()} stageLabels={labels} />);

    const tiles = [...document.querySelectorAll(".metric-tile")];
    expect(tiles.length, "the four figures this page leads with").toBe(4);
    for (const tile of tiles) {
      expect(tile.querySelector("h2")?.textContent, `${tile.getAttribute("data-panel") ?? "?"} needs a label`).toBeTruthy();
      expect(tile.querySelector(".metric-figure")?.textContent, "and a figure").toBeTruthy();
      // "20%" of what? A share with no counts under it cannot be checked against anything.
      expect(tile.querySelector("p.muted")?.textContent, "and the counts it came from").toBeTruthy();
    }
  });

  it("renders a measured value when there is one", () => {
    render(<MetricsView t={t} snapshot={snapshot()} stageLabels={labels} />);

    // Otherwise the case above passes because everything says "not measured".
    expect(screen.getByText("42s")).toBeDefined();
    expect(screen.getByText("120s")).toBeDefined();
    expect(screen.getByText("25%")).toBeDefined();
  });

  it("warns that review reasons overlap, rather than leaving somebody to add the column up", () => {
    render(<MetricsView t={t} snapshot={snapshot()} stageLabels={labels} />);

    const reasons = document.querySelector('[data-panel="reasons"]') as HTMLElement;
    expect(within(reasons).getByText(text("analytics.reasonsOverlap"))).toBeDefined();
  });

  it("uses the Workspace's own stage labels, so this table and the board agree", () => {
    render(<MetricsView t={t} snapshot={snapshot()} stageLabels={labels} />);

    const leads = document.querySelector('[data-panel="leads"]') as HTMLElement;
    expect(within(leads).getByText("Ready to book")).toBeDefined();
    expect(within(leads).queryByText("QUALIFIED")).toBeNull();
  });

  it("falls back to the internal stage id rather than rendering nothing", () => {
    render(<MetricsView t={t} snapshot={snapshot()} stageLabels={{}} />);

    // A stage with no label is a configuration gap, not a reason to show a blank row.
    const leads = document.querySelector('[data-panel="leads"]') as HTMLElement;
    expect(within(leads).getByText("QUALIFIED")).toBeDefined();
  });

  it("names no currency anywhere, and says why", () => {
    render(<MetricsView t={t} snapshot={snapshot()} stageLabels={labels} />);

    const usage = document.querySelector('[data-panel="usage"]') as HTMLElement;
    expect(within(usage).getByText(text("analytics.usageNoCost"))).toBeDefined();
    // A currency figure would be a guess rendered to two decimal places.
    expect(document.body.textContent ?? "").not.toMatch(/[$€£]|\bUSD\b|\bEUR\b/u);
  });

  it("says nothing happened rather than rendering an empty table", () => {
    render(
      <MetricsView
        t={t}
        snapshot={snapshot({ volume: [], reviewReasons: [], usage: [], leads: { movements: [], qualified: 0, engaged: 0, qualificationRate: null } })}
        stageLabels={labels}
      />,
    );

    expect(screen.getAllByText(text("analytics.noData")).length).toBeGreaterThanOrEqual(4);
  });

  it("counts messages and conversations as separate columns", () => {
    render(<MetricsView t={t} snapshot={snapshot()} stageLabels={labels} />);

    const volume = document.querySelector('[data-panel="volume"]') as HTMLElement;
    expect(within(volume).getByText("12")).toBeDefined();
    expect(within(volume).getByText("4")).toBeDefined();
  });

  it("draws the volume chart over the window the page measured, not over the rows it got back", () => {
    // The fixture window is seven days and the fixture has one busy day. Six empty slots is a quiet
    // week; one column is a one-day week, and the store cannot tell the difference because it has no row
    // to return for a day with no inbound message.
    render(<MetricsView t={t} snapshot={snapshot()} stageLabels={labels} />);

    const volume = document.querySelector('[data-panel="volume"]') as HTMLElement;
    expect(volume.querySelectorAll(".chart-days > li").length).toBe(7);
    expect(volume.querySelectorAll(".chart-column").length, "one day of data, two series").toBe(2);
    // And the table is still there underneath it, which is what lets the drawing stay a drawing.
    expect(within(volume).getByText(text("analytics.day"))).toBeDefined();
  });

  it("accounts for every draft it says was generated, and labels the ones with no outcome yet", () => {
    // The store counts outcomes by status, and the statuses it names do not cover every draft: one
    // waiting to send unattended is PENDING without needing review. Six of ten drafts in none of the
    // seven buckets would otherwise leave the same unexplained gap in every bar on the panel.
    render(
      <MetricsView
        t={t}
        snapshot={snapshot({
          drafts: { generated: 10, autoSent: 4, humanApprovedSent: 0, awaitingReview: 0, heldAmbiguous: 0, dismissed: 0, superseded: 0, failed: 0 },
        })}
        stageLabels={labels}
      />,
    );

    const drafts = document.querySelector('[data-panel="drafts"]') as HTMLElement;
    expect(within(drafts).getByText("Of 10 drafts generated in this period")).toBeDefined();
    const open = drafts.querySelector('[data-row="open"]') as HTMLElement;
    expect(within(open).getByText(text("analytics.draftsNoOutcome")), "the six with no outcome are named").toBeDefined();
    expect(open.querySelector(".bar-value")?.textContent).toBe("6");
    // Shares of the generated count, so the four sent unattended are four tenths of their track.
    expect((drafts.querySelector('[data-row="autoSent"] .bar-fill') as HTMLElement).style.getPropertyValue("--bar")).toBe("40.00%");
  });

  it("adds no such row when the outcomes already account for everything", () => {
    // The fixture's seven outcomes sum to its ten generated drafts. A row of zero "no outcome yet" would
    // be a category this window has nothing in.
    render(<MetricsView t={t} snapshot={snapshot()} stageLabels={labels} />);

    expect(document.querySelector('[data-panel="drafts"] [data-row="open"]')).toBeNull();
  });

  it("measures the reasons against each other and never against the drafts they came from", () => {
    // Two drafts for the commonest reason out of ten generated. Drawn as shares of the drafts the bar
    // would be a fifth of its track and the panel's own caption — a draft is counted under every reason
    // it waited for — would make the column add up past the whole.
    render(<MetricsView t={t} snapshot={snapshot()} stageLabels={labels} />);

    const reasons = document.querySelector('[data-panel="reasons"]') as HTMLElement;
    expect(reasons.querySelector(".bar-rows")?.getAttribute("data-scale")).toBe("largest");
    expect((reasons.querySelector('[data-row="MISSING_FACT"] .bar-fill') as HTMLElement).style.getPropertyValue("--bar")).toBe("100.00%");
    expect((reasons.querySelector('[data-row="LOW_CONFIDENCE"] .bar-fill') as HTMLElement).style.getPropertyValue("--bar")).toBe("50.00%");
  });

  it("draws our own delivery record and deliberately does not draw the provider's", () => {
    // Not an omission. Two bar charts side by side are an invitation to read one against the other, and
    // reconciling what we handed over with what the platform reported is the one thing this page refuses
    // to do — a reader doing it by eye would reach a conclusion the numbers do not support.
    render(<MetricsView t={t} snapshot={snapshot()} stageLabels={labels} />);

    expect(document.querySelector('[data-panel="application-state"] .bar-rows')).not.toBeNull();
    const theirs = document.querySelector('[data-panel="provider-state"]') as HTMLElement;
    expect(theirs.querySelector(".bar-rows"), "no bars added beside the list").toBeNull();
    // Asked positively as well, and not only as an absence: a panel whose list was *replaced* by bars
    // would satisfy "there are no extra bars here" while being exactly the change this pins down. So the
    // plain list has to still be the thing rendering the provider's figures.
    const list = theirs.querySelector("dl");
    expect(list, "the provider's figures are a list").not.toBeNull();
    expect(list?.classList.contains("bar-rows")).toBe(false);
    expect(list?.querySelectorAll("dt").length, "all five of the provider's figures").toBe(5);
    expect(within(theirs).getByText(text("analytics.awaitingReport"))).toBeDefined();
    expect(list?.querySelector("dd")?.textContent).toBe("7");
  });

  it("keeps every number a bar stands for printed as text", () => {
    // The whole reason the drawings are allowed to be `aria-hidden`: nothing on this page is reachable
    // only by looking at it. Four handed to the provider, as a number, in our own panel.
    render(<MetricsView t={t} snapshot={snapshot()} stageLabels={labels} />);

    const ours = document.querySelector('[data-panel="application-state"]') as HTMLElement;
    const handed = ours.querySelector('[data-row="handedToProvider"]') as HTMLElement;
    expect(handed.querySelector(".bar-value")?.textContent).toBe("7");
    expect(handed.querySelector(".bar-plot")?.getAttribute("aria-hidden")).toBe("true");
  });
});
