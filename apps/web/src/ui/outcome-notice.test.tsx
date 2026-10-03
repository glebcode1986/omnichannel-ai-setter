// @vitest-environment jsdom
/**
 * The one sentence after an action (Issue #29).
 *
 * It lives in the URL rather than in client state so a refusal survives a reload, which is exactly when
 * someone re-reads one they did not expect. The cases here are about not inventing a sentence: an outcome
 * nobody defined can only come from a hand-edited URL, and rendering something for it would be the page
 * agreeing with an event that never happened.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { OutcomeNotice } from "./outcome-notice";
import { catalogues, type MessageKey } from "@/i18n/catalogue";
import { createTranslator } from "@/i18n/translate";

const t = createTranslator("en");
const text = (key: MessageKey) => catalogues.en[key];

afterEach(cleanup);

describe("the outcome notice", () => {
  it.each([
    ["SENT", "outcome.SENT"],
    ["SEND_CANCELLED", "outcome.SEND_CANCELLED"],
    ["TOO_LATE", "outcome.TOO_LATE"],
    ["STALE", "outcome.STALE"],
    ["ALREADY_RESOLVED", "outcome.ALREADY_RESOLVED"],
  ])("renders %s", (outcome, key) => {
    render(<OutcomeNotice t={t} outcome={outcome} />);

    expect(screen.getByText(text(key as MessageKey))).toBeDefined();
  });

  it("marks a refusal differently from a success", () => {
    const { rerender } = render(<OutcomeNotice t={t} outcome="TOO_LATE" />);
    expect(document.querySelector('[data-outcome="TOO_LATE"]')?.getAttribute("data-tone")).toBe("stop");

    rerender(<OutcomeNotice t={t} outcome="SENT" />);
    expect(document.querySelector('[data-outcome="SENT"]')?.getAttribute("data-tone")).toBeNull();
  });

  it("renders nothing when no action just happened", () => {
    render(<OutcomeNotice t={t} outcome={undefined} />);

    expect(document.querySelector("[data-outcome]")).toBeNull();
  });

  it("renders nothing for an outcome nobody defined", () => {
    // Only a hand-edited URL produces this, and a sentence for it would be the page agreeing with
    // something that never happened.
    render(<OutcomeNotice t={t} outcome="EVERYTHING_IS_FINE" />);

    expect(document.querySelector("[data-outcome]")).toBeNull();
  });

  it("is announced rather than only shown", () => {
    render(<OutcomeNotice t={t} outcome="SENT" />);

    expect(screen.getByRole("status").textContent).toBe(text("outcome.SENT"));
  });

  it("distinguishes a send that was stopped from one that was too late to stop", () => {
    // Both are "nothing more you can do", and only one of them means the customer did not get it.
    render(<OutcomeNotice t={createTranslator("ru")} outcome="TOO_LATE" />);

    expect(screen.getByText(catalogues.ru["outcome.TOO_LATE"])).toBeDefined();
    expect(catalogues.ru["outcome.TOO_LATE"]).not.toBe(catalogues.ru["outcome.SEND_CANCELLED"]);
  });
});
