/**
 * The markdown subset the published legal documents are written in.
 *
 * A legal document is the one kind of page where a renderer that silently drops what it does not
 * understand is unacceptable: the missing clause still binds somebody, and nothing on the page says it is
 * missing. So this parser has no pass-through. Every line is matched by a rule or the parse **throws**,
 * and a test runs all four published documents through it — a syntax nobody anticipated fails the build
 * rather than disappearing from the page.
 *
 * The subset is not a guess either. It is what the documents measurably contain: two heading levels,
 * paragraphs (including the indented continuation lines that carry lettered sub-clauses), block quotes,
 * pipe tables, thematic breaks, and inline bold, code and links. No bullet lists and no numbered lists —
 * the clause numbering is written into the text, because a renumbering renderer is exactly what a legal
 * document must not have.
 */

export interface InlineText {
  readonly kind: "text" | "bold" | "code";
  readonly value: string;
}

/**
 * A value the published text leaves to configuration that configuration has not answered.
 *
 * The parser never produces one — `legal-content.ts` does, when it resolves `{{NAME}}` and finds
 * nothing. It is a node rather than a marker string so the page can style it as plainly not part of the
 * document's own words, and so a test can assert that none of them is rendered as ordinary prose.
 * `value` is the placeholder's name, which is what tells a reader *what* is missing.
 */
export interface InlineGap {
  readonly kind: "gap";
  readonly value: string;
}

export interface InlineLink {
  readonly kind: "link";
  readonly value: string;
  readonly href: string;
}

export type Inline = InlineText | InlineLink | InlineGap;

export type LegalBlock =
  | { readonly kind: "heading"; readonly level: 1 | 2; readonly content: readonly Inline[] }
  | { readonly kind: "paragraph"; readonly content: readonly Inline[] }
  | { readonly kind: "quote"; readonly content: readonly Inline[] }
  | { readonly kind: "break" }
  | { readonly kind: "table"; readonly head: readonly (readonly Inline[])[]; readonly rows: readonly (readonly (readonly Inline[])[])[] };

/** A line the parser does not recognise, named so the failure says which line and what it said. */
export class UnknownMarkdownError extends Error {
  constructor(line: number, text: string) {
    super(`legal markdown: line ${String(line)} is not in the supported subset: ${JSON.stringify(text)}`);
    this.name = "UnknownMarkdownError";
  }
}

const HEADING = /^(?<hashes>#{1,2}) +(?<text>\S.*)$/u;
const TABLE_DIVIDER = /^\|(?: *:?-{2,}:? *\|)+$/u;
/** `**bold**`, `` `code` ``, `[text](href)` — longest-first so a link inside bold is not split wrongly. */
const INLINE = /\*\*(?<bold>[^*]+)\*\*|`(?<code>[^`]+)`|\[(?<text>[^\]]+)\]\((?<href>[^)]+)\)/gu;

/** Splits one line of prose into its runs. Anything not matched by `INLINE` stays plain text. */
export function parseInline(text: string): readonly Inline[] {
  const out: Inline[] = [];
  let at = 0;
  for (const found of text.matchAll(INLINE)) {
    const groups = found.groups ?? {};
    if (found.index > at) {
      out.push({ kind: "text", value: text.slice(at, found.index) });
    }
    if (groups["bold"] !== undefined) {
      out.push({ kind: "bold", value: groups["bold"] });
    } else if (groups["code"] !== undefined) {
      out.push({ kind: "code", value: groups["code"] });
    } else {
      out.push({ kind: "link", value: groups["text"] ?? "", href: groups["href"] ?? "" });
    }
    at = found.index + found[0].length;
  }
  if (at < text.length) {
    out.push({ kind: "text", value: text.slice(at) });
  }
  return out;
}

function cells(row: string): readonly (readonly Inline[])[] {
  // A pipe table row is bounded by pipes; splitting keeps an empty field at each end.
  return row
    .trim()
    .replace(/^\|/u, "")
    .replace(/\|$/u, "")
    .split("|")
    .map((cell) => parseInline(cell.trim()));
}

export function parseLegalMarkdown(source: string): readonly LegalBlock[] {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const blocks: LegalBlock[] = [];
  let paragraph: string[] = [];

  const flush = (): void => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", content: parseInline(paragraph.join(" ")) });
      paragraph = [];
    }
  };

  for (let at = 0; at < lines.length; at += 1) {
    const raw = lines[at] ?? "";
    const line = raw.trimEnd();
    const number = at + 1;

    if (line.trim() === "") {
      flush();
      continue;
    }

    const heading = HEADING.exec(line.trim());
    if (heading?.groups !== undefined) {
      flush();
      blocks.push({
        kind: "heading",
        level: heading.groups["hashes"]?.length === 1 ? 1 : 2,
        content: parseInline(heading.groups["text"] ?? ""),
      });
      continue;
    }

    if (/^-{3,}$/u.test(line.trim())) {
      flush();
      blocks.push({ kind: "break" });
      continue;
    }

    if (line.trim().startsWith("> ")) {
      flush();
      const quoted: string[] = [];
      while (at < lines.length && (lines[at] ?? "").trim().startsWith("> ")) {
        quoted.push((lines[at] ?? "").trim().slice(2).trim());
        at += 1;
      }
      at -= 1;
      blocks.push({ kind: "quote", content: parseInline(quoted.join(" ")) });
      continue;
    }

    if (line.trim().startsWith("|")) {
      flush();
      const head = cells(line);
      const divider = (lines[at + 1] ?? "").trim();
      if (!TABLE_DIVIDER.test(divider)) {
        throw new UnknownMarkdownError(number + 1, divider);
      }
      at += 2;
      const rows: (readonly (readonly Inline[])[])[] = [];
      while (at < lines.length && (lines[at] ?? "").trim().startsWith("|")) {
        rows.push(cells(lines[at] ?? ""));
        at += 1;
      }
      at -= 1;
      blocks.push({ kind: "table", head, rows });
      continue;
    }

    // Prose. A line that opens with a marker this subset does not carry is a syntax the author expected
    // to mean something, and guessing is how a clause goes missing.
    if (/^ {0,3}(?:[-*+] |\d+\) |#{3,} |```)/u.test(line)) {
      throw new UnknownMarkdownError(number, line);
    }
    paragraph.push(line.trim());
  }

  flush();
  return blocks;
}
