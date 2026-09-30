// @vitest-environment jsdom
/**
 * The retrieval tester's answer (Issue #31).
 *
 * Three distinctions it has to keep, because collapsing any of them turns a useful tool into a misleading
 * one: which search mode ran, "found nothing" versus "could not look", and where each hit came from.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { KnowledgeHit } from "@omnichannel/application";

import { RetrievalResults } from "./retrieval-results";
import { catalogues, type MessageKey } from "@/i18n/catalogue";
import { createTranslator } from "@/i18n/translate";

const t = createTranslator("en");
const text = (key: MessageKey) => catalogues.en[key];

afterEach(cleanup);

const hit = (overrides: Partial<KnowledgeHit> = {}): KnowledgeHit => ({
  chunkId: "kc_1",
  documentId: "kd_1",
  documentTitle: "Opening hours",
  documentVersion: 2,
  sourceType: "MANUAL",
  scopeLevel: "BUSINESS_PROFILE",
  text: "We open at 10 on Saturday.",
  score: 0.8123,
  ...overrides,
});

const results = (props: Partial<Parameters<typeof RetrievalResults>[0]> = {}) =>
  render(<RetrievalResults t={t} mode="HYBRID" hits={[]} unavailable={false} asked={false} {...props} />);

describe("which search actually ran", () => {
  it("says when it searched by meaning and by words", () => {
    results({ mode: "HYBRID" });

    expect(screen.getByText(text("tester.modeHybrid"))).toBeDefined();
  });

  it("says when it searched by words only, and that the assistant is doing the same", () => {
    // Without this, "nothing found" on a lexical-only deployment reads as a verdict on the knowledge base.
    results({ mode: "LEXICAL_ONLY" });

    expect(screen.getByText(text("tester.modeLexical"))).toBeDefined();
    expect(document.querySelector('[data-mode="LEXICAL_ONLY"]')).not.toBeNull();
  });
});

describe("nothing found versus could not look", () => {
  it("says the assistant would find nothing, once a question has been asked", () => {
    results({ asked: true, hits: [] });

    expect(screen.getByText(text("tester.noResults"))).toBeDefined();
  });

  it("says nothing at all before a question has been asked", () => {
    // An empty tester is not a verdict about anything.
    results({ asked: false, hits: [] });

    expect(screen.queryByText(text("tester.noResults"))).toBeNull();
  });

  it("reports an outage as an outage, not as an empty result", () => {
    results({ asked: true, hits: [], unavailable: true });

    expect(screen.getByText(text("tester.unavailable"))).toBeDefined();
    expect(screen.queryByText(text("tester.noResults"))).toBeNull();
  });
});

describe("where a hit came from", () => {
  it("names the document, the version and the scope", () => {
    results({ asked: true, hits: [hit()] });

    expect(screen.getByText("We open at 10 on Saturday.")).toBeDefined();
    expect(screen.getByText(/Opening hours/u)).toBeDefined();
    expect(screen.getByText(/from version 2/u)).toBeDefined();
    expect(screen.getByText(new RegExp(text("tester.scopeProfile"), "u"))).toBeDefined();
  });

  it("marks a hit that came from knowledge shared across profiles", () => {
    // An agency needs to know whether an answer came from this client's facts or from the shared set.
    results({ asked: true, hits: [hit({ scopeLevel: "WORKSPACE" })] });

    expect(screen.getByText(new RegExp(text("tester.scopeWorkspace"), "u"))).toBeDefined();
  });

  it("keeps the order retrieval returned", () => {
    results({ asked: true, hits: [hit({ chunkId: "kc_a", text: "first" }), hit({ chunkId: "kc_b", text: "second" })] });

    expect([...document.querySelectorAll(".message-text")].map((node) => node.textContent)).toEqual(["first", "second"]);
  });

  it("shows the score rounded, rather than pretending to precision it lacks", () => {
    // A fused score is comparable within one result set and not across queries, so seven decimal places
    // would be inviting somebody to read meaning into digits that carry none.
    results({ asked: true, hits: [hit({ score: 0.8123456 })] });

    const line = [...document.querySelectorAll(".retrieval-hits .muted")].map((node) => node.textContent ?? "").join(" ");
    expect(line).toContain("0.812");
    expect(line).not.toContain("0.8123");
  });
});

describe("the boundary", () => {
  it("says it only searches, and offers nothing that could send", () => {
    results({ asked: true, hits: [hit()] });

    expect(screen.getByText(text("tester.readOnly"))).toBeDefined();
    expect(screen.queryAllByRole("button")).toEqual([]);
  });

  it("announces its results, so a screen reader hears them arrive", () => {
    results({ asked: true, hits: [hit()] });

    expect(document.querySelector('[aria-live="polite"]')).not.toBeNull();
  });

  it("reads in Russian", () => {
    render(<RetrievalResults t={createTranslator("ru")} mode="LEXICAL_ONLY" hits={[]} unavailable asked />);

    expect(screen.getByText(catalogues.ru["tester.unavailable"])).toBeDefined();
    expect(screen.getByText(catalogues.ru["tester.modeLexical"])).toBeDefined();
  });
});
