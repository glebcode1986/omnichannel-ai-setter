// @vitest-environment jsdom
/**
 * The lead pipeline's two views (Issue #33).
 *
 * The cases that matter: every move carries the stage the card was drawn in — without it a stale board
 * silently overwrites whatever changed since — and the assistant's suggestion is an offer with its own
 * control rather than a move that already happened. The table is always present, because it is the
 * board's accessible fallback and the only view that lists a lead in a hidden stage.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LeadRow, StageDisplay } from "@omnichannel/db";

import { LeadBoard } from "./lead-board";
import { catalogues, type MessageKey } from "@/i18n/catalogue";
import { createTranslator } from "@/i18n/translate";

const t = createTranslator("en");
const text = (key: MessageKey) => catalogues.en[key];
const TARGET = { workspaceId: "ws_1", businessProfileId: "bp_1" };
const BASE = "/workspaces/ws_1/profiles/bp_1";

afterEach(cleanup);

const stages = (overrides: Partial<StageDisplay>[] = []): readonly StageDisplay[] =>
  (["NEW", "ENGAGED", "QUALIFIED", "WON", "LOST"] as const).map((stage, index) => ({
    stage,
    label: stage === "QUALIFIED" ? "Ready to book" : stage,
    position: index,
    hidden: false,
    isDefault: false,
    ...(overrides.find((override) => override.stage === stage) ?? {}),
  }));

const lead = (overrides: Partial<LeadRow> = {}): LeadRow => ({
  conversationId: "cv_1",
  contactName: "Ann Petrova",
  handle: "@ann",
  channel: "INSTAGRAM",
  stage: "ENGAGED",
  assignedUserId: null,
  assignedUserName: null,
  tags: [],
  note: null,
  nextAction: null,
  nextActionAt: null,
  lastMessageAt: new Date("2026-09-30T10:00:00.000Z"),
  suggestedStage: null,
  ...overrides,
});

const board = (leads: readonly LeadRow[], stageList = stages(), filtered = false) =>
  render(
    <LeadBoard t={t} leads={leads} stages={stageList} target={TARGET} basePath={BASE} filtered={filtered} moveAction={vi.fn(() => Promise.resolve())} />,
  );

describe("moving a lead", () => {
  it("carries the stage the card was drawn in", () => {
    board([lead({ stage: "ENGAGED" })]);

    // Without this a stale board silently overwrites whatever changed since the card was rendered.
    const form = document.querySelector(".lead-move") as HTMLElement;
    expect(form.querySelector('input[name="expectedStage"]')?.getAttribute("value")).toBe("ENGAGED");
    expect(form.querySelector('input[name="conversationId"]')?.getAttribute("value")).toBe("cv_1");
  });

  it("offers every stage as a destination, including hidden ones", () => {
    // Hiding a column is a display choice; a lead can still be moved into that stage deliberately.
    board([lead()], stages([{ stage: "LOST", hidden: true }]));

    const options = [...(document.querySelector(".lead-move select") as HTMLSelectElement).options].map((option) => option.value);
    expect(options).toEqual(["NEW", "ENGAGED", "QUALIFIED", "WON", "LOST"]);
  });

  it("uses the workspace's own label for a renamed stage", () => {
    board([lead({ stage: "QUALIFIED" })]);

    expect(screen.getAllByText(/Ready to book/u).length).toBeGreaterThan(0);
  });
});

describe("the assistant's suggestion", () => {
  it("is an offer with its own control, not a move that happened", () => {
    board([lead({ stage: "ENGAGED", suggestedStage: "WON" })]);

    const suggestion = document.querySelector('[data-suggestion="WON"]') as HTMLElement;
    expect(within(suggestion).getByRole("button", { name: text("leads.confirmSuggestion") })).toBeDefined();
    expect(screen.getByText(text("leads.suggestedHint"))).toBeDefined();
    // The lead is still where a person left it.
    expect(document.querySelector('.lead-column[data-stage="ENGAGED"] [data-lead="cv_1"]')).not.toBeNull();
    expect(document.querySelector('.lead-column[data-stage="WON"] [data-lead="cv_1"]')).toBeNull();
  });

  it("names the destination and carries it as the suggested stage, so the history records agreement", () => {
    board([lead({ stage: "ENGAGED", suggestedStage: "QUALIFIED" })]);

    const suggestion = document.querySelector('[data-suggestion="QUALIFIED"]') as HTMLElement;
    expect(suggestion.querySelector('input[name="toStage"]')?.getAttribute("value")).toBe("QUALIFIED");
    // Posted so the server can record `HUMAN_CONFIRMED` rather than `HUMAN_SET`.
    expect(suggestion.querySelector('input[name="suggestedStage"]')?.getAttribute("value")).toBe("QUALIFIED");
    // Scoped: the destination's label also names the board column and the move dropdown's option.
    expect(within(suggestion).getByText(/Ready to book/u)).toBeDefined();
  });

  it("says nothing when the assistant agrees with where the lead already is", () => {
    board([lead({ stage: "WON", suggestedStage: "WON" })]);

    expect(document.querySelector("[data-suggestion]")).toBeNull();
  });

  it("says nothing when the assistant has not suggested anything", () => {
    board([lead({ suggestedStage: null })]);

    expect(document.querySelector("[data-suggestion]")).toBeNull();
  });
});

describe("the board", () => {
  it("counts each column", () => {
    board([lead({ conversationId: "cv_a", stage: "NEW" }), lead({ conversationId: "cv_b", stage: "NEW" })]);

    expect(screen.getByText("NEW (2)")).toBeDefined();
  });

  it("does not draw a hidden column", () => {
    board([lead()], stages([{ stage: "LOST", hidden: true }]));

    expect(document.querySelector('.lead-column[data-stage="LOST"]')).toBeNull();
    expect(document.querySelector('.lead-column[data-stage="NEW"]')).not.toBeNull();
  });

  it("shows the owner, the tags and the next action", () => {
    board([lead({ assignedUserName: "Marina", tags: ["vip"], nextAction: "Call back", nextActionAt: new Date("2026-10-02T09:00:00.000Z") })]);

    // Scoped to the card: the owner and the next action appear in the table too, which is the point of
    // having both views and would make an unscoped query ambiguous.
    const card = document.querySelector('[data-lead="cv_1"]') as HTMLElement;
    expect(within(card).getByText(/Marina/u)).toBeDefined();
    expect(within(card).getByText("vip")).toBeDefined();
    // The action and its date are one line, so the date is asserted through the line that carries it
    // rather than as a text node of its own.
    expect(within(card).getByText(/Call back/u).textContent).toMatch(/Call back .*10\/2\/26/u);
  });

  it("says nobody owns a lead rather than leaving a gap", () => {
    board([lead({ assignedUserName: null })]);

    // In both views, because a blank owner column reads as missing data rather than as unassigned.
    const card = document.querySelector('[data-lead="cv_1"]') as HTMLElement;
    const row = document.querySelector('[data-row="cv_1"]') as HTMLElement;
    expect(within(card).getByText(new RegExp(text("leads.unassigned"), "u"))).toBeDefined();
    expect(within(row).getByText(text("leads.unassigned"))).toBeDefined();
  });
});

describe("the table, which is the board's fallback", () => {
  it("is always present", () => {
    board([lead()]);

    expect(screen.getByRole("table")).toBeDefined();
    expect(screen.getByRole("columnheader", { name: text("leads.tableHeadStage") })).toBeDefined();
  });

  it("lists a lead sitting in a hidden stage, which the board cannot show", () => {
    // Hiding a column must not be a way to lose leads.
    board([lead({ conversationId: "cv_hidden", stage: "LOST" })], stages([{ stage: "LOST", hidden: true }]));

    expect(document.querySelector('.lead-column[data-stage="LOST"]')).toBeNull();
    expect(document.querySelector('[data-row="cv_hidden"]')).not.toBeNull();
  });

  it("links each row into the conversation, because a lead is one", () => {
    board([lead()]);

    const row = document.querySelector('[data-row="cv_1"]') as HTMLElement;
    expect(within(row).getByRole("link", { name: "Ann Petrova" }).getAttribute("href")).toBe(`${BASE}/inbox/cv_1`);
  });

  it("gives each row a machine-readable timestamp", () => {
    board([lead()]);

    expect(document.querySelector('[data-row="cv_1"] time')?.getAttribute("datetime")).toBe("2026-09-30T10:00:00.000Z");
  });
});

describe("an empty pipeline", () => {
  it("says leads will arrive, on a new profile", () => {
    board([], stages(), false);

    expect(screen.getByText(text("leads.empty"))).toBeDefined();
  });

  it("says the filters matched nothing, when filters are on", () => {
    board([], stages(), true);

    expect(screen.getByText(text("leads.emptyFiltered"))).toBeDefined();
  });
});

describe("in Russian", () => {
  it("translates the chrome and leaves the customer's name alone", () => {
    render(
      <LeadBoard
        t={createTranslator("ru")}
        leads={[lead({ suggestedStage: "WON" })]}
        stages={stages()}
        target={TARGET}
        basePath={BASE}
        filtered={false}
        moveAction={vi.fn(() => Promise.resolve())}
      />,
    );

    expect(screen.getByText(catalogues.ru["leads.suggestedHint"])).toBeDefined();
    expect(screen.getAllByText("Ann Petrova").length).toBeGreaterThan(0);
  });
});
