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
import { catalogues, type MessageKey } from "@/i18n/catalogue";
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
});
