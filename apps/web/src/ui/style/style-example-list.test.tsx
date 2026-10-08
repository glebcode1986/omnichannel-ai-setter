// @vitest-environment jsdom
/**
 * The style example library (Issue #32).
 *
 * The distinction this pane exists to make visible is between an example that is *in use* and one that is
 * merely *suggested*. It makes it by what it offers, not only by a badge: approve and decline on a
 * suggestion, archive on a verified example. Offering approve on something already active would invite a
 * click that does nothing; offering archive on a suggestion would imply it was ever in use.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StyleExampleView } from "@omnichannel/db";

import { StyleExampleList } from "./style-example-list";
import { catalogues, pluralCatalogues, type MessageKey } from "@/i18n/catalogue";
import { createTranslator } from "@/i18n/translate";

const t = createTranslator("en");
const text = (key: MessageKey) => catalogues.en[key];
const TARGET = { workspaceId: "ws_1", businessProfileId: "bp_1" };

afterEach(cleanup);

const actions = () => ({
  approve: vi.fn(() => Promise.resolve()),
  reject: vi.fn(() => Promise.resolve()),
  archive: vi.fn(() => Promise.resolve()),
  restore: vi.fn(() => Promise.resolve()),
});

const example = (overrides: Partial<StyleExampleView> = {}): StyleExampleView => ({
  id: "se_1",
  inboundContext: "are you open saturday?",
  outboundText: "Yes — 10 till 6 on Saturdays!",
  provenance: "HUMAN_TYPED",
  status: "ACTIVE",
  scope: "BUSINESS_PROFILE",
  language: "en",
  approvedByName: "Marina",
  sourceDraftId: null,
  sourceMessageId: null,
  createdAt: new Date("2026-09-30T10:00:00.000Z"),
  decisions: [],
  // The default is a complete lifecycle: a fixture that silently claimed events were hidden would make
  // every assertion below about the truncated case rather than the ordinary one.
  earlierDecisions: 0,
  laterDecisions: 0,
  ...overrides,
});

const list = (examples: readonly StyleExampleView[], kind: "VERIFIED" | "SUGGESTED" = "VERIFIED") =>
  render(<StyleExampleList t={t} examples={examples} target={TARGET} kind={kind} actions={actions()} />);

describe("what an example shows", () => {
  it("shows both halves, labelled, because an example is a pair", () => {
    list([example()]);

    expect(screen.getByText("are you open saturday?")).toBeDefined();
    expect(screen.getByText("Yes — 10 till 6 on Saturdays!")).toBeDefined();
    expect(screen.getByText(text("style.exampleInbound"))).toBeDefined();
    expect(screen.getByText(text("style.exampleOutbound"))).toBeDefined();
  });

  it("names who stood behind a verified example, and tones it as in use", () => {
    list([example({ approvedByName: "Marina", status: "ACTIVE" })]);

    expect(screen.getByText(/Marina/u)).toBeDefined();
    expect(document.querySelector('[data-status-badge="ACTIVE"]')?.getAttribute("data-tone")).toBe("ok");
  });

  it("does not tone a suggestion as if it were in use", () => {
    list([example({ status: "SUGGESTED", approvedByName: null })], "SUGGESTED");

    expect(document.querySelector('[data-status-badge="SUGGESTED"]')?.getAttribute("data-tone")).toBe("muted");
  });

  it("says plainly that a suggestion has nobody behind it", () => {
    // The absence of a name is information: a verified example cannot lack one, because a CHECK refuses it.
    list([example({ status: "SUGGESTED", approvedByName: null })], "SUGGESTED");

    expect(screen.getByText(text("style.notApproved"))).toBeDefined();
  });

  it("says where the wording came from", () => {
    list([example({ provenance: "HUMAN_EDITED_DRAFT" })]);

    expect(screen.getByText(text("provenance.HUMAN_EDITED_DRAFT"))).toBeDefined();
  });

  it("does not blank an example over a provenance or status it has never heard of", () => {
    list([example({ provenance: "IMPORTED", status: "QUARANTINED" })]);

    expect(screen.getByText("IMPORTED")).toBeDefined();
    expect(screen.getByText("QUARANTINED")).toBeDefined();
    expect(screen.getByText("are you open saturday?")).toBeDefined();
  });
});

describe("what each state offers", () => {
  it("offers approve and decline on a suggestion, and nothing else", () => {
    list([example({ status: "SUGGESTED", approvedByName: null })], "SUGGESTED");

    expect(screen.getByRole("button", { name: text("style.approve") })).toBeDefined();
    expect(screen.getByRole("button", { name: text("style.reject") })).toBeDefined();
    // Archiving something never in use would imply it was.
    expect(screen.queryByRole("button", { name: text("style.archive") })).toBeNull();
  });

  it("offers only archive on an example in use", () => {
    list([example({ status: "ACTIVE" })]);

    expect(screen.getByRole("button", { name: text("style.archive") })).toBeDefined();
    // Approving something already active is not an approval anybody made.
    expect(screen.queryByRole("button", { name: text("style.approve") })).toBeNull();
    expect(screen.queryByRole("button", { name: text("style.reject") })).toBeNull();
  });

  it("offers restore on one that was archived or declined", () => {
    const { rerender } = render(
      <StyleExampleList t={t} examples={[example({ status: "ARCHIVED" })]} target={TARGET} kind="VERIFIED" actions={actions()} />,
    );
    expect(screen.getByRole("button", { name: text("style.restore") })).toBeDefined();

    rerender(<StyleExampleList t={t} examples={[example({ status: "REJECTED" })]} target={TARGET} kind="VERIFIED" actions={actions()} />);
    expect(screen.getByRole("button", { name: text("style.restore") })).toBeDefined();
  });

  it("explains what a suggestion is, where it is offered", () => {
    list([example({ status: "SUGGESTED", approvedByName: null })], "SUGGESTED");

    expect(screen.getByText(text("style.suggestionExplain"))).toBeDefined();
  });

  it("does not explain suggestions on an example in use", () => {
    list([example({ status: "ACTIVE" })]);

    expect(screen.queryByText(text("style.suggestionExplain"))).toBeNull();
  });
});

describe("a mixed library", () => {
  it("offers each row the actions its own state allows", () => {
    list([example({ id: "se_a", status: "ACTIVE" }), example({ id: "se_b", status: "SUGGESTED", approvedByName: null })]);

    const active = document.querySelector('[data-example="se_a"]') as HTMLElement;
    const suggestion = document.querySelector('[data-example="se_b"]') as HTMLElement;

    expect(within(active).getByRole("button", { name: text("style.archive") })).toBeDefined();
    expect(within(suggestion).getByRole("button", { name: text("style.approve") })).toBeDefined();
    expect(within(active).queryByRole("button", { name: text("style.approve") })).toBeNull();
  });
});

describe("the empty library", () => {
  it("says what to do, on the verified list", () => {
    list([], "VERIFIED");

    expect(screen.getByText(text("style.noExamples"))).toBeDefined();
  });

  it("says nothing is waiting, on the suggestions list", () => {
    // "No examples yet" in the suggestions queue would read as a lost library.
    list([], "SUGGESTED");

    expect(screen.getByText(text("style.noSuggestions"))).toBeDefined();
  });
});

describe("in Russian", () => {
  it("translates the states and leaves the wording alone", () => {
    render(
      <StyleExampleList
        t={createTranslator("ru")}
        examples={[example({ status: "SUGGESTED", approvedByName: null })]}
        target={TARGET}
        kind="SUGGESTED"
        actions={actions()}
      />,
    );

    expect(screen.getByText(catalogues.ru["styleStatus.SUGGESTED"])).toBeDefined();
    expect(screen.getByText(catalogues.ru["style.notApproved"])).toBeDefined();
    expect(screen.getByText("Yes — 10 till 6 on Saturdays!")).toBeDefined();
  });

  it("shows what has happened to an example, in the order it happened", () => {
    render(
      <StyleExampleList
        t={t}
        examples={[
          example({
            status: "ARCHIVED",
            decisions: [
              { id: "sed_1", decision: "APPROVED", decidedByName: "Marina", decidedAt: new Date("2026-09-30T10:00:00.000Z") },
              { id: "sed_2", decision: "ARCHIVED", decidedByName: "Pavel", decidedAt: new Date("2026-10-01T10:00:00.000Z") },
            ],
          }),
        ]}
        target={TARGET}
        kind="RETIRED"
        actions={actions()}
      />,
    );

    const history = document.querySelector('[data-history="se_1"]');
    // The status says "not in use" and nothing more. Who withdrew it, and whether anybody had approved it
    // first, are two different questions and only the history answers them.
    expect(history?.querySelectorAll("li")).toHaveLength(2);
    expect(history?.querySelectorAll("li")[0]?.getAttribute("data-decision")).toBe("APPROVED");
    expect(history?.querySelectorAll("li")[1]?.getAttribute("data-decision")).toBe("ARCHIVED");
    expect(history?.textContent).toContain("Marina");
    expect(history?.textContent).toContain("Pavel");
  });

  it("names nobody rather than implying a decision was nobody's", () => {
    render(
      <StyleExampleList
        t={t}
        examples={[example({ decisions: [{ id: "sed_3", decision: "APPROVED", decidedByName: null, decidedAt: new Date("2026-09-30T10:00:00.000Z") }] })]}
        target={TARGET}
        kind="VERIFIED"
        actions={actions()}
      />,
    );

    // A member who has left still made the decision. The entry stays, with the gap stated.
    expect(document.querySelector('[data-history="se_1"]')?.textContent).toContain(text("style.historyUnknownActor"));
  });

  it("renders no history block for an example nobody has decided anything about", () => {
    render(<StyleExampleList t={t} examples={[example({ status: "SUGGESTED", approvedByName: null })]} target={TARGET} kind="SUGGESTED" actions={actions()} />);

    expect(document.querySelector('[data-history="se_1"]')).toBeNull();
  });

  it("says a history is a window, and offers the rest, rather than ending quietly", () => {
    // The R5 re-review's finding, at the only place a reader meets it. A window that cannot say it is a
    // window reads as a complete history — and that is a worse failure than an obvious gap, because
    // nobody goes looking.
    render(
      <StyleExampleList
        t={t}
        examples={[
          example({
            status: "ARCHIVED",
            decisions: [{ id: "sed_4", decision: "ARCHIVED", decidedByName: "Pavel", decidedAt: new Date("2026-10-01T10:00:00.000Z") }],
            earlierDecisions: 5,
          }),
        ]}
        target={TARGET}
        kind="RETIRED"
        actions={actions()}
        earlierHistoryHrefs={{ se_1: "/style?historyExample=se_1&historyCursor=abc" }}
      />,
    );

    expect(document.querySelector('[data-history="se_1"]')?.getAttribute("data-earlier")).toBe("5");
    expect(document.querySelector('[data-earlier-count="se_1"]')?.textContent).toBe(
      pluralCatalogues.en["style.historyEarlier"]?.other?.replace("{count}", "5"),
    );
    expect(document.querySelector('[data-example-history="se_1"]')?.getAttribute("href")).toBe("/style?historyExample=se_1&historyCursor=abc");
  });

  it("offers neither the count nor the link when the window is the whole lifecycle", () => {
    // The common case, and the one that would be noise. A link to nothing is a control that teaches a
    // reader to ignore controls.
    render(
      <StyleExampleList
        t={t}
        examples={[example({ decisions: [{ id: "sed_5", decision: "APPROVED", decidedByName: "Marina", decidedAt: new Date("2026-09-30T10:00:00.000Z") }] })]}
        target={TARGET}
        kind="VERIFIED"
        actions={actions()}
        earlierHistoryHrefs={{}}
      />,
    );

    expect(document.querySelector('[data-history="se_1"]')?.getAttribute("data-earlier")).toBe("0");
    expect(document.querySelector('[data-earlier-count="se_1"]')).toBeNull();
    expect(document.querySelector('[data-example-history="se_1"]')).toBeNull();
  });

  it("says what a page into the past hides, which is the half that explains the current state", () => {
    // The blocking finding one click later: a page read backwards necessarily hides what came after it,
    // and a history ending in "Restored" under a badge reading "Archived" is the same silent truncation
    // that was refused. The number for it was computed and thrown away before this.
    render(
      <StyleExampleList
        t={t}
        examples={[example({ id: "se_1", status: "ARCHIVED" })]}
        target={TARGET}
        kind="RETIRED"
        actions={actions()}
        lifecycle={{
          styleExampleId: "se_1",
          decisions: [{ id: "sed_old", decision: "RESTORED", decidedByName: "Olga", decidedAt: new Date("2026-09-01T10:00:00.000Z") }],
          earlierDecisions: 0,
          laterDecisions: 20,
          totalDecisions: 25,
        }}
        earlierHistoryHrefs={{}}
        latestHistoryHref="/style"
      />,
    );

    expect(document.querySelector('[data-history="se_1"]')?.getAttribute("data-later")).toBe("20");
    expect(document.querySelector('[data-later-count="se_1"]')?.textContent).toBe(
      pluralCatalogues.en["style.historyLater"]?.other?.replace("{count}", "20"),
    );
    // And where the reader is in the whole argument, which is the other thing a middle page owes them.
    expect(document.querySelector('[data-history-total="se_1"]')?.textContent).toBe(text("style.historyTotal").replace("{count}", "25"));
  });

  it("keeps the way back when a cursor lands on an empty page, rather than stranding the reader", () => {
    // A hand-edited or stale cursor can point past the oldest decision. The rows vanish; the escape must
    // not vanish with them, which it did while it lived inside the "are there any decisions" gate.
    render(
      <StyleExampleList
        t={t}
        examples={[example({ id: "se_1" })]}
        target={TARGET}
        kind="VERIFIED"
        actions={actions()}
        lifecycle={{ styleExampleId: "se_1", decisions: [], earlierDecisions: 0, laterDecisions: 4, totalDecisions: 4 }}
        earlierHistoryHrefs={{}}
        latestHistoryHref="/style"
      />,
    );

    expect(document.querySelector('[data-history="se_1"]')).not.toBeNull();
    expect(document.querySelector('[data-action="history-latest"]')?.getAttribute("href")).toBe("/style");
    expect(document.querySelector('[data-later-count="se_1"]')?.textContent).toContain("4");
  });

  it("shows the open page for the example whose history is open, and leaves the others alone", () => {
    render(
      <StyleExampleList
        t={t}
        examples={[
          example({ id: "se_1", decisions: [{ id: "sed_6", decision: "APPROVED", decidedByName: "Marina", decidedAt: new Date("2026-10-02T10:00:00.000Z") }] }),
          example({ id: "se_2", decisions: [{ id: "sed_7", decision: "ARCHIVED", decidedByName: "Pavel", decidedAt: new Date("2026-10-02T11:00:00.000Z") }] }),
        ]}
        target={TARGET}
        kind="VERIFIED"
        actions={actions()}
        lifecycle={{
          styleExampleId: "se_1",
          decisions: [{ id: "sed_8", decision: "RESTORED", decidedByName: "Olga", decidedAt: new Date("2026-09-01T10:00:00.000Z") }],
          earlierDecisions: 0,
          laterDecisions: 0,
          totalDecisions: 9,
        }}
        earlierHistoryHrefs={{}}
        latestHistoryHref="/style"
      />,
    );

    // The open example shows the page that was asked for.
    expect(document.querySelector('[data-history="se_1"] li')?.getAttribute("data-decision")).toBe("RESTORED");
    // And the other example is untouched, which is why the history has parameters of its own.
    expect(document.querySelector('[data-history="se_2"] li')?.getAttribute("data-decision")).toBe("ARCHIVED");
    // The way back is offered once, on the example it belongs to.
    expect(document.querySelectorAll('[data-action="history-latest"]')).toHaveLength(1);
  });
});
