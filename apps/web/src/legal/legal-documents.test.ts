/**
 * The published legal documents, and the machinery between a draft and a reader (#121).
 *
 * Four things can go wrong here and none of them is visible by reading the page:
 *
 * 1. the published text drifts from the draft it was derived from, so two copies disagree about what
 *    the document says;
 * 2. a syntax nobody anticipated is dropped by the renderer, so a clause silently leaves the page;
 * 3. a placeholder added to a draft has no configured source, so `{{SOMETHING}}` reaches a reader;
 * 4. an unset value is rendered as ordinary prose, so a reader takes a gap for a term.
 *
 * Each has a test, and each test states what it would miss. The documents are read from disk rather than
 * imported so that these assertions are about the files the application actually serves.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadWebEnv } from "@/env";
import { UI_LOCALES } from "@/i18n/locales";
import {
  LEGAL_DOCUMENTS,
  PLACEHOLDER_SOURCES,
  legalDocumentPath,
  resolveDocument,
  type LegalDocumentName,
} from "@/server/legal-content";
import { parseLegalMarkdown, UnknownMarkdownError, type Inline, type LegalBlock } from "@/server/legal-markdown";
import { derive } from "./derive";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const draftRoot = path.resolve(appRoot, "..", "..", "docs", "legal-drafts");

const DRAFT_OF: Record<LegalDocumentName, string> = {
  "privacy-policy": "privacy-policy.md",
  "terms-of-service": "terms-of-service.md",
};

const baseEnv = {
  DATABASE_URL: "postgresql://user:fake-password@localhost:5432/omnichannel",
  AUTH_SECRET: "fake-auth-secret-for-tests-0123456789",
  REDIS_URL: "redis://127.0.0.1:6379",
  CHANNEL_CREDENTIAL_KEY_ID: "test-key-1",
  CHANNEL_CREDENTIAL_KEY: Buffer.alloc(32, 3).toString("base64"),
  INSTAGRAM_APP_ID: "1234567890",
  INSTAGRAM_APP_SECRET: "fake-instagram-app-secret",
  INSTAGRAM_REDIRECT_URI: "https://app.example.test/api/channels/instagram/callback",
};

const published = (name: LegalDocumentName, locale: string): string =>
  readFileSync(path.join(appRoot, legalDocumentPath(name, locale as (typeof UI_LOCALES)[number])), "utf8");

const everyDocument = UI_LOCALES.flatMap((locale) => LEGAL_DOCUMENTS.map((name) => ({ locale, name })));

function runsOf(blocks: readonly LegalBlock[]): readonly Inline[] {
  return blocks.flatMap((block) => {
    if (block.kind === "break") {
      return [];
    }
    if (block.kind === "table") {
      return [...block.head.flat(), ...block.rows.flat().flat()];
    }
    return [...block.content];
  });
}

describe("the published legal documents", () => {
  it("covers both documents in both languages, or the rest of this file proves nothing", () => {
    // The vacuity guard. Every other test here iterates `everyDocument`, and an empty list passes them
    // all without reading a single file.
    expect(everyDocument).toHaveLength(4);
  });

  it.each(everyDocument)("$locale/$name still equals what the draft derives to", ({ locale, name }) => {
    const draft = readFileSync(path.join(draftRoot, locale, DRAFT_OF[name]), "utf8");
    const { text, removed } = derive(draft);
    // The removals are asserted as well as the result: a derivation that stopped removing the draft
    // banner would still match a published file regenerated from it, and the banner would be on the site.
    // The preamble table is per-document — the Terms draft opens with one and the Privacy Policy does not.
    expect(removed).toEqual({
      titleSuffix: true,
      banner: true,
      metadata: true,
      preambleTable: name === "terms-of-service",
    });
    expect(published(name, locale)).toBe(text);
    expect(text.length).toBeGreaterThan(5_000);
  });

  it.each(everyDocument)("$locale/$name parses with nothing left over", ({ locale, name }) => {
    const blocks = parseLegalMarkdown(published(name, locale));
    expect(blocks.length).toBeGreaterThan(50);
    // Headings and prose both present: a parse that produced one enormous paragraph would also "not
    // throw", and this is a page of clauses.
    expect(blocks.filter((block) => block.kind === "heading").length).toBeGreaterThan(15);
    expect(blocks.filter((block) => block.kind === "paragraph").length).toBeGreaterThan(50);
  });

  it("translates the same document, not a different one", () => {
    // Structure rather than words: the two languages must carry the same clauses in the same order, and
    // a section dropped from one translation is otherwise invisible.
    for (const name of LEGAL_DOCUMENTS) {
      const shape = (locale: string): string =>
        parseLegalMarkdown(published(name, locale))
          .map((block) => (block.kind === "heading" ? `h${String(block.level)}` : block.kind))
          .join(",");
      expect(shape("ru"), name).toBe(shape("en"));
    }
  });

  it("has a configured source for every placeholder the text uses, and uses every source it configures", () => {
    const used = new Set<string>();
    for (const { locale, name } of everyDocument) {
      for (const found of published(name, locale).matchAll(/\{\{(?<key>[A-Z_]+)\}\}/gu)) {
        used.add(found.groups?.["key"] ?? "");
      }
    }
    expect(used.size).toBeGreaterThan(10);
    expect([...used].sort()).toEqual(Object.keys(PLACEHOLDER_SOURCES).sort());
  });

  it("renders an unsettled value as a marked gap and never as prose", () => {
    const env = loadWebEnv(baseEnv);
    const blocks = parseLegalMarkdown(published("terms-of-service", "en"));
    const resolved = resolveDocument(blocks, env);

    expect(resolved.unresolved.length).toBeGreaterThan(0);
    const runs = runsOf(resolved.blocks);
    expect(runs.filter((run) => run.kind === "gap").length).toBeGreaterThan(0);
    // Nothing survives as a literal placeholder, in a gap node or anywhere else.
    for (const run of runs) {
      if (run.kind !== "gap") {
        expect(run.value).not.toContain("{{");
      }
    }
  });

  it("uses a configured value instead of a gap once it is set", () => {
    // The success control. Without it, a resolver that marked *everything* as a gap would pass the test
    // above and the documents would read as one long row of dashes.
    const env = loadWebEnv({ ...baseEnv, LEGAL_SELLER_NAME: "Example Seller S.R.L." });
    const resolved = resolveDocument(parseLegalMarkdown(published("terms-of-service", "en")), env);
    const runs = runsOf(resolved.blocks);

    expect(resolved.unresolved).not.toContain("SELLER_LEGAL_NAME");
    expect(runs.some((run) => run.kind !== "gap" && run.value.includes("Example Seller S.R.L."))).toBe(true);
    expect(runs.some((run) => run.kind === "gap" && run.value === "SELLER_LEGAL_NAME")).toBe(false);
  });

  it("publishes no drafting note, no retired brand and no registry identifier", () => {
    // This is the test that was missing, and the first published build is why it exists. The Terms draft
    // opens with a table of the values settled so far — a note written for the owner, not a term — and it
    // went onto the live page carrying the retired brand, a domain the product no longer uses, and the
    // seller's registry identifiers in public. Structure alone would not have caught it: the table parsed
    // perfectly and rendered beautifully. Only its content was wrong.
    //
    // Named strings rather than a pattern, because what must not be published is specific: a retired
    // brand reads as a current one, and a registry identifier belongs in configuration under the owner's
    // standing direction, not in a public repository.
    const forbidden = ["Mixamart", "mixamart.com", "SOTCO", "CUI 5051", "ONRC J"];
    let scanned = 0;
    for (const { locale, name } of everyDocument) {
      const text = published(name, locale);
      scanned += text.length;
      for (const needle of forbidden) {
        expect(text, `${locale}/${name} must not publish ${needle}`).not.toContain(needle);
      }
    }
    // The control: a test that read nothing would also find nothing.
    expect(scanned).toBeGreaterThan(50_000);
    // And proof the scan read the real document rather than an empty string: the brand is a placeholder
    // in the file, resolved when the page renders, so the file must still carry the placeholder itself.
    expect(published("terms-of-service", "en")).toContain("{{PRODUCT_NAME}}");
  });

  it("gives every lettered sub-clause its own paragraph", () => {
    // These documents separate `(a)` from `(b)` by indentation alone, with no blank line, so a parser
    // that joins lines until a blank one ran the two halves of a definition together into one
    // sentence — which is how it first reached the live page.
    let subs = 0;
    for (const { locale, name } of everyDocument) {
      const blocks = parseLegalMarkdown(published(name, locale));
      const paragraphs = blocks.filter((block) => block.kind === "paragraph");
      for (const block of paragraphs) {
        if (block.kind !== "paragraph") {
          continue;
        }
        const text = block.content.map((run) => run.value).join("");
        // Both alphabets: the Russian translation uses (а)(б)(в)(г), which look Latin and are not.
        const openers = [...text.matchAll(/\((?<marker>[\p{Letter}])\)\s/gu)];
        expect(openers.length, `a paragraph in ${locale}/${name} merged sub-clauses: ${text.slice(0, 90)}`)
          .toBeLessThan(2);
        if (block.sub === true) {
          subs += 1;
          expect(text.trimStart(), `${locale}/${name}`).toMatch(/^\([\p{Letter}\p{Number}]{1,4}\)\s/u);
        }
      }
    }
    // The vacuity guard, measured: 18 markers across the four documents, so every one became its own
    // paragraph. A parser that stopped marking them would report zero and pass the loop above.
    expect(subs).toBe(18);
  });

  it("keeps the sub-clause flag through placeholder resolution", () => {
    // The flag is set by the parser and the resolver rebuilds every block. A resolver that listed the
    // fields it copies would drop this one in silence, and the page would look exactly as it did before
    // the parser was fixed.
    const env = loadWebEnv(baseEnv);
    const resolved = resolveDocument(parseLegalMarkdown(published("privacy-policy", "en")), env);
    const subs = resolved.blocks.filter((block) => block.kind === "paragraph" && block.sub === true);
    expect(subs.length).toBeGreaterThan(0);
  });

  it("refuses a syntax it does not carry rather than dropping the line", () => {
    // The reason the parser throws at all. A renderer that ignored this line would publish a document
    // with a clause missing and nothing on the page to say so.
    expect(() => parseLegalMarkdown("# Title\n\n- a list item nobody wrote a rule for\n")).toThrow(UnknownMarkdownError);
    expect(() => parseLegalMarkdown("# Title\n\n```\ncode\n```\n")).toThrow(UnknownMarkdownError);
    // A table whose divider is missing is a table that would otherwise lose its first row.
    expect(() => parseLegalMarkdown("| a | b |\n| 1 | 2 |\n")).toThrow(UnknownMarkdownError);
    // And the control: ordinary prose is not refused.
    expect(() => parseLegalMarkdown("# Title\n\n1.1. An ordinary clause.\n")).not.toThrow();
  });
});
