/**
 * How a published legal page is derived from its draft in `docs/legal-drafts/`.
 *
 * The drafts stay the drafting record and the published text is committed beside the app, because the
 * page has to render the same words on every deployment whether or not `docs/` shipped with it. Two
 * copies invite drift, so this transformation is code and a test asserts the committed file still equals
 * `derive(draft)` — a draft edited without republishing, or a published file edited by hand, fails.
 *
 * It removes exactly four things and changes nothing else:
 *
 * 1. the `— DRAFT` suffix on the title, since the page states its own status in its own words;
 * 2. the draft banner, for the same reason, and because it points at a file no reader of the site has;
 * 3. the `**Kind** … **Effective from** …` metadata line and the rule under it, which the page renders
 *    as a dateline from the document's own record rather than as prose;
 * 4. **any table standing in the preamble, before the first `##` heading.**
 *
 * The fourth is not symmetry. The Terms draft opens with a table of the values settled so far — a note
 * to the owner, listing each placeholder beside what has been stated for it — and the first published
 * build put it on the page: the retired brand, a domain the product no longer uses, and the seller's
 * registry identifiers, in public, under a heading reading "Value for the first launch route". It is
 * identified by position rather than by its wording, which differs per language and would be edited;
 * nothing in these documents puts contract content ahead of clause 1, while the tables that *are*
 * contract content — the legal-bases table in the Privacy Policy — all sit inside a numbered clause.
 *
 * Nothing is substituted here. Every `{{PLACEHOLDER}}` survives into the published file and is resolved
 * when the page renders, so a value that depends on the deployment — the service's own URL — and a value
 * the owner has not settled are handled in one place rather than baked into the text.
 */
const TITLE_SUFFIX = /^(?<hash># .+?)\s+—\s+(?:DRAFT|ЧЕРНОВИК)\s*$/mu;

export interface DerivedDocument {
  readonly text: string;
  /** What was taken out, so a test can assert each removal happened rather than only the result. */
  readonly removed: {
    readonly titleSuffix: boolean;
    readonly banner: boolean;
    readonly metadata: boolean;
    /** False for a document whose preamble carried no table — the Privacy Policy's does not. */
    readonly preambleTable: boolean;
  };
}

export function derive(draft: string): DerivedDocument {
  const lines = draft.replaceAll("\r\n", "\n").split("\n");
  const out: string[] = [];
  const removed = { titleSuffix: false, banner: false, metadata: false, preambleTable: false };
  let seenClause = false;

  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at] ?? "";

    if (line.startsWith("## ")) {
      seenClause = true;
    }

    const title = TITLE_SUFFIX.exec(line);
    if (title?.groups !== undefined) {
      out.push(title.groups["hash"] ?? line);
      removed.titleSuffix = true;
      continue;
    }

    // The banner is the first quote block, and only the first: quotes later in the text are the
    // document's own emphasis and stay.
    if (!removed.banner && line.startsWith("> ")) {
      while (at < lines.length && (lines[at] ?? "").startsWith("> ")) {
        at += 1;
      }
      at -= 1;
      removed.banner = true;
      continue;
    }

    // A table before clause 1 is a drafting note, never a term. Stop looking once the clauses start.
    if (!seenClause && line.startsWith("|")) {
      while (at < lines.length && (lines[at] ?? "").startsWith("|")) {
        at += 1;
      }
      at -= 1;
      removed.preambleTable = true;
      continue;
    }

    // The metadata line wraps onto a second line, and in one document a rule follows it.
    if (/^\*\*(?:Kind|Вид)\*\* /u.test(line)) {
      at += 1;
      while (at + 1 < lines.length && (lines[at + 1] ?? "").trim() === "" && (lines[at + 2] ?? "").trim() === "---") {
        at += 2;
        break;
      }
      removed.metadata = true;
      continue;
    }

    out.push(line);
  }

  // Collapse the blank run the removals leave at the top, so the file opens on its title.
  const text = out.join("\n").replace(/^\n+/u, "").replace(/\n{3,}/gu, "\n\n");
  return { text, removed };
}
