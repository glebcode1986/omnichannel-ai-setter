// @vitest-environment jsdom
/**
 * The style test (Issue #32).
 *
 * `KNOWLEDGE_STYLE_UX.md` asks this screen for a neutral prompt with a candidate output *and* the
 * instructions and examples that influenced it. The first version rendered only the examples — a retrieval
 * browser, showing what the assistant would read and never what it would say. These assert all three
 * parts, and that the screen never lets the candidate pass for a checked fact.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PLATFORM_STYLE_FALLBACK } from "@omnichannel/domain";

import { StyleTestPanel } from "./style-test-panel";
import type { StyleCandidate, StyleTestResult } from "@/server/style-test";
import { catalogues, type MessageKey } from "@/i18n/catalogue";
import { createTranslator } from "@/i18n/translate";

const t = createTranslator("en");
const text = (key: MessageKey) => catalogues.en[key];

afterEach(cleanup);

const HIT = {
  exampleId: "ex-1",
  scopeLevel: "BUSINESS_PROFILE" as const,
  inboundContext: "are you open saturday?",
  outboundText: "Yes — 10 till 6 on Saturdays!",
  provenance: "HUMAN_TYPED" as const,
  score: 0.9,
};

const result = (overrides: Partial<StyleTestResult> = {}): StyleTestResult => ({
  effective: { ...PLATFORM_STYLE_FALLBACK, persona: "A calm neighbourhood salon", signOff: "See you soon" },
  trial: { mode: "HYBRID", hits: [HIT], unavailable: false },
  candidate: { status: "WRITTEN", text: "We're open 10 till 6 on Saturdays." },
  ...overrides,
});

/**
 * `null` rather than `undefined` for "nothing was asked".
 *
 * A default parameter is applied to an explicit `undefined` too, so `panel({}, undefined)` would quietly
 * render the default question and the assertion beneath it would be about the wrong screen.
 */
const panel = (overrides: Partial<StyleTestResult> = {}, ask: string | null = "are you open saturday?") =>
  render(<StyleTestPanel t={t} test={result(overrides)} basePath="/ws/bp/style" {...(ask === null ? {} : { ask })} />);

describe("what the style test shows", () => {
  it("shows the candidate reply, the instructions behind it and the examples behind it", () => {
    panel();

    // All three, because any one of them alone is a different screen: the candidate alone cannot be
    // explained, and the examples alone cannot be judged.
    expect(document.querySelector('[data-candidate="WRITTEN"]')?.textContent).toBe("We're open 10 till 6 on Saturdays.");
    expect(document.querySelector('[data-voice-field="persona"]')?.textContent).toContain("A calm neighbourhood salon");
    expect(document.querySelector('[data-example="ex-1"]')?.textContent).toContain("Yes — 10 till 6 on Saturdays!");
  });

  it("says, beside the candidate, that no fact was consulted to write it", () => {
    panel();

    // At the top of the page as well, but a reply that reads like an answer is exactly where somebody
    // would forget it, so it is repeated where the answer is.
    expect(document.querySelector('[data-candidate-not-factual="true"]')?.textContent).toBe(text("styleTest.candidateNotFactual"));
  });

  it("resolves the sign-off and the defaults beneath it, not only what was typed", () => {
    panel();

    expect(document.querySelector('[data-voice-field="signOff"]')?.textContent).toContain("See you soon");
    // Nobody chose these; they are what the assistant is given once the layers are merged, which is the
    // thing this section is for.
    expect(document.querySelector('[data-voice-field="replyLength"]')?.textContent).toContain(text("replyLength.SHORT"));
    expect(document.querySelector('[data-voice-field="emoji"]')?.textContent).toContain(text("emojiUsage.SPARING"));
  });

  it("states that no fixed language means the customer's own", () => {
    panel();

    // Absence with a visible consequence, so it is said rather than left blank.
    expect(document.querySelector('[data-voice-field="language"]')?.textContent).toContain(text("styleTest.anyLanguage"));
  });

  it("asks for a prompt rather than showing an empty candidate", () => {
    panel({ candidate: { status: "NO_PROMPT" } }, null);

    expect(document.querySelector('[data-candidate="NO_PROMPT"]')?.textContent).toBe(text("styleTest.candidateNoPrompt"));
  });

  it("says plainly when this deployment has no model, and still shows everything else", () => {
    panel({ candidate: { status: "NOT_CONFIGURED" } });

    // Not an error and not an empty box: the voice and the examples are still exactly what the assistant
    // would use, and only the one part that needs a provider is missing.
    expect(document.querySelector('[data-candidate="NOT_CONFIGURED"]')?.textContent).toBe(text("styleTest.candidateNotConfigured"));
    expect(document.querySelector('[data-voice-field="persona"]')).not.toBeNull();
    expect(document.querySelector('[data-example="ex-1"]')).not.toBeNull();
  });

  it("tells an unreachable model apart from a voice that produced nothing", () => {
    panel({ candidate: { status: "UNAVAILABLE" } as StyleCandidate });

    expect(document.querySelector('[data-candidate="UNAVAILABLE"]')?.textContent).toBe(text("styleTest.candidateUnavailable"));
  });

  it("says which retrieval mode found the examples", () => {
    panel({ trial: { mode: "LEXICAL_ONLY", hits: [HIT], unavailable: false } });

    // "We searched the words only" and "we searched properly" are different answers to the same list.
    expect(document.querySelector('[data-mode="LEXICAL_ONLY"]')?.textContent).toBe(text("tester.modeLexical"));
  });

  it("reports a retrieval outage as one rather than as an empty library", () => {
    panel({ trial: { mode: "HYBRID", hits: [], unavailable: true } });

    expect(document.querySelector('[data-unavailable="true"]')).not.toBeNull();
    expect(document.querySelector('[data-no-results="true"]')).toBeNull();
  });

  it("says nothing matched only once something was actually asked", () => {
    panel({ trial: { mode: "HYBRID", hits: [], unavailable: false } });
    expect(document.querySelector('[data-no-results="true"]')).not.toBeNull();

    cleanup();
    panel({ trial: { mode: "HYBRID", hits: [], unavailable: false }, candidate: { status: "NO_PROMPT" } }, null);
    // Before anybody asks, an empty list is not a finding about this library.
    expect(document.querySelector('[data-no-results="true"]')).toBeNull();
  });

  it("keeps what was asked in the box, so a reload does not lose it", () => {
    panel();

    expect(screen.getByLabelText(text("styleTest.queryLabel"))).toHaveProperty("value", "are you open saturday?");
  });
});
