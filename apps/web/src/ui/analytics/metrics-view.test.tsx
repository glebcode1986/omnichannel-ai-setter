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
  window: { from: new Date("2026-10-01T00:00:00.000Z"), to: new Date("2026-10-08T00:00:00.000Z"), timeZone: "Europe/Madrid" },
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
});
