// @vitest-environment jsdom
/**
 * One lead's fields, history and answers (Issue #33).
 *
 * Two things this must get right. The **stage is not in the edit form** — a stage change is an audited
 * transition carrying the stage the operator was looking at, and putting it among unrelated inputs would
 * turn a stale save into a silent overwrite. And qualification answers are **listed by source**, because
 * the assistant's reading and a person's confirmation are different claims about the same question.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssignableMember, LeadRow, QualificationAnswer, StageDisplay, StageHistoryEntry } from "@omnichannel/db";

import { LeadPanel } from "./lead-panel";
import { catalogues, type MessageKey } from "@/i18n/catalogue";
import { createTranslator } from "@/i18n/translate";

const t = createTranslator("en");
const text = (key: MessageKey) => catalogues.en[key];
const TARGET = { workspaceId: "ws_1", businessProfileId: "bp_1" };

afterEach(cleanup);

const stages: readonly StageDisplay[] = (["NEW", "ENGAGED", "QUALIFIED"] as const).map((stage, index) => ({
  stage,
  label: stage === "QUALIFIED" ? "Ready to book" : stage,
  position: index,
  hidden: false,
  isDefault: false,
}));

const members: readonly AssignableMember[] = [
  { userId: "usr_owner", name: "Marina", role: "OWNER" },
  { userId: "usr_agent", name: null, role: "AGENT" },
];

const lead = (overrides: Partial<LeadRow> = {}): LeadRow => ({
  conversationId: "cv_1",
  contactName: "Ann Petrova",
  handle: "@ann",
  channel: "INSTAGRAM",
  stage: "ENGAGED",
  assignedUserId: "usr_owner",
  assignedUserName: "Marina",
  tags: ["vip", "returning"],
  note: "Prefers mornings.",
  nextAction: "Call back",
  nextActionAt: new Date("2026-10-05T00:00:00.000Z"),
  lastMessageAt: new Date("2026-09-30T10:00:00.000Z"),
  suggestedStage: null,
  ...overrides,
});

const panel = (props: Partial<Parameters<typeof LeadPanel>[0]> = {}) =>
  render(
    <LeadPanel
      t={t}
      lead={lead()}
      stages={stages}
      members={members}
      history={[]}
      qualification={[]}
      target={TARGET}
      editAction={vi.fn(() => Promise.resolve())}
      answerAction={vi.fn(() => Promise.resolve())}
      {...props}
    />,
  );

describe("the edit form", () => {
  it("reads every field back", () => {
    panel();

    expect(screen.getByLabelText(text("leads.assignee"))).toHaveProperty("value", "usr_owner");
    expect(screen.getByLabelText(text("leads.tags"))).toHaveProperty("value", "vip\nreturning");
    expect(screen.getByLabelText(text("leads.note"))).toHaveProperty("value", "Prefers mornings.");
    expect(screen.getByLabelText(text("leads.nextAction"))).toHaveProperty("value", "Call back");
    expect(screen.getByLabelText(text("leads.nextActionAt"))).toHaveProperty("value", "2026-10-05");
  });

  it("offers nobody as a real choice, not as a missing value", () => {
    panel({ lead: lead({ assignedUserId: null, assignedUserName: null }) });

    const select = screen.getByLabelText(text("leads.assignee"));
    expect(select).toHaveProperty("value", "");
    expect(within(select).getByText(text("leads.unassigned"))).toBeDefined();
  });

  it("offers a member with no name by their id rather than a blank row", () => {
    panel();

    expect(within(screen.getByLabelText(text("leads.assignee"))).getByText("usr_agent")).toBeDefined();
  });

  it("does not put the stage in this form", () => {
    // A stage change is an audited transition carrying the stage the operator saw. Among unrelated
    // inputs, a stale save would become a silent stage overwrite.
    panel();

    const form = screen.getByLabelText(text("leads.assignee")).closest("form") as HTMLElement;
    expect(form.querySelector('[name="toStage"]')).toBeNull();
    expect(form.querySelector('[name="expectedStage"]')).toBeNull();
    expect(form.querySelector('input[name="conversationId"]')?.getAttribute("value")).toBe("cv_1");
  });

  it("leaves an empty date empty rather than inventing today", () => {
    panel({ lead: lead({ nextActionAt: null }) });

    expect(screen.getByLabelText(text("leads.nextActionAt"))).toHaveProperty("value", "");
  });
});

describe("what we know", () => {
  const answers: readonly QualificationAnswer[] = [
    { criterion: "has a budget", value: "probably", source: "AI_SUGGESTED", actorName: null, updatedAt: new Date("2026-09-30T09:00:00.000Z") },
    { criterion: "has a budget", value: "yes, 400", source: "HUMAN_CONFIRMED", actorName: "Marina", updatedAt: new Date("2026-09-30T10:00:00.000Z") },
  ];

  it("lists the assistant's reading and a person's answer side by side, not merged", () => {
    panel({ qualification: answers });

    // A reader who saw one field could not tell whether anybody had ever looked at it.
    expect(document.querySelectorAll('[data-criterion="has a budget"]')).toHaveLength(2);
    expect(screen.getByText("probably")).toBeDefined();
    expect(screen.getByText("yes, 400")).toBeDefined();
  });

  it("says whose claim each one is", () => {
    panel({ qualification: answers });

    // Scoped to the two answer rows: "Marina" is also an option in the assignee select.
    const confirmed = document.querySelector('[data-source="HUMAN_CONFIRMED"]') as HTMLElement;
    expect(screen.getByText(text("leadSource.AI_SUGGESTED"))).toBeDefined();
    expect(within(confirmed).getByText(/Marina/u)).toBeDefined();
  });

  it("marks the assistant's own reading as provisional", () => {
    panel({ qualification: answers });

    expect(document.querySelector('[data-source="AI_SUGGESTED"]')).not.toBeNull();
    expect(document.querySelector('[data-source="HUMAN_CONFIRMED"]')).not.toBeNull();
  });

  it("says nothing is recorded rather than showing an empty list", () => {
    panel({ qualification: [] });

    expect(screen.getByText(text("leads.qualificationEmpty"))).toBeDefined();
  });

  it("offers a form that needs both the question and the answer", () => {
    panel();

    expect(screen.getByLabelText(text("leads.criterion")).hasAttribute("required")).toBe(true);
    expect(screen.getByLabelText(text("leads.answer")).hasAttribute("required")).toBe(true);
  });
});

describe("the stage history", () => {
  const history: readonly StageHistoryEntry[] = [
    { id: "tr_2", fromStage: "ENGAGED", toStage: "QUALIFIED", source: "HUMAN_CONFIRMED", actorName: "Marina", changedAt: new Date("2026-09-30T10:00:00.000Z") },
    { id: "tr_1", fromStage: null, toStage: "ENGAGED", source: "HUMAN_SET", actorName: "Marina", changedAt: new Date("2026-09-29T10:00:00.000Z") },
  ];

  it("reads each move with the workspace's own labels", () => {
    panel({ history });

    expect(screen.getByText("ENGAGED to Ready to book")).toBeDefined();
  });

  it("words the first recorded entry as a setting rather than a move from nowhere", () => {
    panel({ history });

    expect(screen.getByText("Set to ENGAGED")).toBeDefined();
  });

  it("says who moved it and on what authority", () => {
    panel({ history });

    expect(screen.getByText(new RegExp(text("leadSource.HUMAN_CONFIRMED"), "u"))).toBeDefined();
    expect(document.querySelector('[data-transition="tr_2"]')?.getAttribute("data-source")).toBe("HUMAN_CONFIRMED");
  });

  it("gives each entry a machine-readable timestamp", () => {
    panel({ history });

    expect(document.querySelector('[data-transition="tr_2"] time')?.getAttribute("datetime")).toBe("2026-09-30T10:00:00.000Z");
  });

  it("says nothing is recorded rather than showing an empty list", () => {
    panel({ history: [] });

    expect(screen.getByText(text("leads.historyEmpty"))).toBeDefined();
  });

  it("does not blank an entry over a source it has never heard of", () => {
    panel({ history: [{ id: "tr_x", fromStage: "NEW", toStage: "ENGAGED", source: "IMPORTED" as never, actorName: null, changedAt: new Date() }] });

    expect(screen.getByText(/IMPORTED/u)).toBeDefined();
  });
});

describe("in Russian", () => {
  it("reads in Russian", () => {
    render(
      <LeadPanel
        t={createTranslator("ru")}
        lead={lead()}
        stages={stages}
        members={members}
        history={[]}
        qualification={[
          { criterion: "бюджет", value: "есть", source: "AI_SUGGESTED", actorName: null, updatedAt: new Date() },
        ]}
        target={TARGET}
        editAction={vi.fn(() => Promise.resolve())}
        answerAction={vi.fn(() => Promise.resolve())}
      />,
    );

    expect(screen.getByText(catalogues.ru["leadSource.AI_SUGGESTED"])).toBeDefined();
    expect(screen.getByText(catalogues.ru["leads.historyEmpty"])).toBeDefined();
  });
});
