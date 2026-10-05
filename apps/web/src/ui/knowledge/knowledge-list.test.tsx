// @vitest-environment jsdom
/**
 * The Knowledge Library's list (Issue #31).
 *
 * The case that matters is the pair of states that look the same in a careless list and mean opposite
 * things: a source in use, and a source that says it is in use but never indexed. The second is the
 * dangerous one — the business believes it has told the assistant something it has not — so indexing
 * state is asserted as its own badge rather than folded into status.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { KnowledgeSummary } from "@omnichannel/db";

import { KnowledgeList } from "./knowledge-list";
import { catalogues, type MessageKey } from "@/i18n/catalogue";
import { createTranslator } from "@/i18n/translate";

const t = createTranslator("en");
const text = (key: MessageKey) => catalogues.en[key];
const BASE = "/workspaces/ws_1/profiles/bp_1/knowledge";

afterEach(cleanup);

const document_ = (overrides: Partial<KnowledgeSummary> = {}): KnowledgeSummary => ({
  id: "kd_1",
  title: "Opening hours",
  sourceType: "MANUAL",
  sourceUri: null,
  version: 2,
  publishedVersion: 2,
  status: "ACTIVE",
  scope: "BUSINESS_PROFILE",
  indexingState: "INDEXED",
  indexingError: null,
  indexedAt: new Date("2026-09-30T10:00:00.000Z"),
  chunkCount: 3,
  createdByName: "Marina",
  updatedAt: new Date("2026-09-30T11:00:00.000Z"),
  ...overrides,
});

const list = (documents: readonly KnowledgeSummary[], filtered = false) =>
  render(<KnowledgeList t={t} documents={documents} basePath={BASE} filtered={filtered} />);

describe("what a row says", () => {
  it("shows the title, the fact count, the author and when it changed", () => {
    list([document_()]);

    expect(screen.getByText("Opening hours")).toBeDefined();
    expect(screen.getByText(/3 facts/u)).toBeDefined();
    expect(screen.getByText(/Marina/u)).toBeDefined();
    expect(globalThis.document.querySelector(".knowledge-row time")?.getAttribute("datetime")).toBe("2026-09-30T11:00:00.000Z");
  });

  it("names the author as unknown rather than leaving a gap", () => {
    list([document_({ createdByName: null })]);

    expect(screen.getByText(new RegExp(text("knowledge.unknownAuthor"), "u"))).toBeDefined();
  });

  it("links each source to its own page", () => {
    list([document_()]);

    expect(screen.getByRole("link", { name: /Opening hours/u }).getAttribute("href")).toBe(`${BASE}/kd_1`);
  });

  it("says which version is in use", () => {
    list([document_({ version: 4 })]);

    expect(screen.getByText(text("knowledge.versionCurrent").replace("{version}", "4"))).toBeDefined();
  });
});

describe("status and searchability, which are different claims", () => {
  it("shows both, separately, and tones each by its own state", () => {
    const { rerender } = render(<KnowledgeList t={t} documents={[document_({ status: "ACTIVE", indexingState: "INDEXED" })]} basePath={BASE} filtered={false} />);

    expect(globalThis.document.querySelector('[data-status="ACTIVE"]')?.getAttribute("data-tone")).toBe("ok");
    expect(globalThis.document.querySelector('[data-indexing="INDEXED"]')?.getAttribute("data-tone")).toBe("ok");

    // A source out of use is not toned as if it were live, whatever its indexing state says.
    rerender(<KnowledgeList t={t} documents={[document_({ status: "ARCHIVED", indexingState: "INDEXED" })]} basePath={BASE} filtered={false} />);
    expect(globalThis.document.querySelector('[data-status="ARCHIVED"]')?.getAttribute("data-tone")).toBe("muted");
    expect(globalThis.document.querySelector('[data-indexing="INDEXED"]')?.getAttribute("data-tone")).toBe("ok");
  });

  it("marks a source that is in use but never indexed", () => {
    // The dangerous state: the business believes it has told the assistant something it has not.
    list([document_({ status: "ACTIVE", indexingState: "PENDING" })]);

    const row = globalThis.document.querySelector(".knowledge-row") as HTMLElement;
    expect(within(row).getByText(text("knowledgeStatus.ACTIVE"))).toBeDefined();
    expect(within(row).getByText(text("indexing.PENDING"))).toBeDefined();
    expect(globalThis.document.querySelector('[data-indexing="PENDING"]')?.getAttribute("data-tone")).toBe("warn");
  });

  it("marks a failed source in the strongest tone it has", () => {
    list([document_({ status: "ARCHIVED", indexingState: "FAILED", indexingError: "embedding provider refused the request" })]);

    expect(globalThis.document.querySelector('[data-indexing="FAILED"]')?.getAttribute("data-tone")).toBe("stop");
    // The error itself, so the fix is not a guess.
    expect(screen.getByText("embedding provider refused the request")).toBeDefined();
  });

  it("shows no error line for a healthy source", () => {
    list([document_()]);

    expect(globalThis.document.querySelector("[data-indexing-error]")).toBeNull();
  });

  it("does not blank a row over a state it has never heard of", () => {
    list([document_({ status: "QUARANTINED", indexingState: "REBUILDING" })]);

    expect(screen.getByText("QUARANTINED")).toBeDefined();
    expect(screen.getByText("REBUILDING")).toBeDefined();
    expect(screen.getByText("Opening hours")).toBeDefined();
  });
});

describe("scope", () => {
  it("says when a source is shared across every profile", () => {
    list([document_({ scope: "WORKSPACE" })]);

    expect(screen.getByText(text("knowledge.scopeWorkspace"))).toBeDefined();
  });

  it("says when it belongs to this profile alone", () => {
    list([document_({ scope: "BUSINESS_PROFILE" })]);

    expect(screen.getByText(text("knowledge.scopeProfile"))).toBeDefined();
  });
});

describe("the empty library", () => {
  it("says nothing has been written down, on a new profile", () => {
    list([], false);

    expect(screen.getByText(text("knowledge.empty"))).toBeDefined();
  });

  it("says the filters matched nothing, when filters are on", () => {
    // "Nothing has been written down" on a filtered view reads as a lost library.
    list([], true);

    expect(screen.getByText(text("knowledge.emptyFiltered"))).toBeDefined();
  });
});

describe("in Russian", () => {
  it("translates the states and leaves the title alone", () => {
    render(<KnowledgeList t={createTranslator("ru")} documents={[document_()]} basePath={BASE} filtered={false} />);

    expect(screen.getByText(catalogues.ru["knowledgeStatus.ACTIVE"])).toBeDefined();
    expect(screen.getByText(catalogues.ru["indexing.INDEXED"])).toBeDefined();
    expect(screen.getByText("Opening hours")).toBeDefined();
  });
});

describe("getting to the rest of the library", () => {
  it("offers the next page only when there is one", () => {
    // Without this link a business with 26 sources could reach 25 of them. The route decides whether
    // there is a next page; the list must not invent one, and must not hide one either.
    const { rerender } = render(<KnowledgeList t={t} documents={[document_()]} basePath={BASE} filtered={false} />);
    expect(screen.queryByRole("link", { name: t.t("knowledge.loadMore") })).toBeNull();

    rerender(<KnowledgeList t={t} documents={[document_()]} basePath={BASE} filtered={false} nextHref={`${BASE}?cursor=abc`} />);
    expect(screen.getByRole("link", { name: t.t("knowledge.loadMore") }).getAttribute("href")).toBe(`${BASE}?cursor=abc`);
  });
});
