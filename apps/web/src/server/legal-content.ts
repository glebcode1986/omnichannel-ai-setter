/**
 * The published legal documents: which file a page reads, and what fills the gaps in it (#121).
 *
 * The text is committed under `src/legal/`, derived from the drafts by `legal/derive.ts`. What the text
 * does *not* carry is any value that is either the owner's own material or a decision nobody has made —
 * the seller's registered identity, the mailboxes, governing law, the forum, the liability cap, the
 * retention periods. Those arrive from configuration.
 *
 * **An unset value renders as a visible gap, never as a default.** This is the whole design. A legal
 * document is read as a statement of what is true, so a plausible-looking default here is not a
 * placeholder waiting to be improved — it is a term a reader is entitled to rely on and a court would
 * read against the party that published it. A gap is honest and it is also self-correcting: it is
 * obvious on the page, so it gets filled.
 *
 * `UNRESOLVED` lists what is still missing, so the page can say so at the top rather than leaving a
 * reader to discover it halfway down clause 15.
 */
import type { WebEnv } from "@/env";
import type { UiLocale } from "@/i18n/locales";
import type { Inline, LegalBlock } from "@/server/legal-markdown";

export const LEGAL_DOCUMENTS = ["privacy-policy", "terms-of-service"] as const;
export type LegalDocumentName = (typeof LEGAL_DOCUMENTS)[number];

/** The product's own name is a brand decision, already made, and carries nothing private. */
export const PRODUCT_NAME = "KeepSayBot";

/**
 * Every placeholder the documents contain, and the configured value that fills it.
 *
 * A test asserts this covers the documents exactly — nothing here that the text never uses, and nothing
 * in the text that is missing here. That is what stops a clause added to a draft from reaching the page
 * as a literal `{{...}}`, and it is also what noticed that `PRODUCT_DOMAIN` had no reader left once the
 * Terms' drafting table stopped being published: configuration nothing reads is a claim about the page
 * that is not true.
 */
export const PLACEHOLDER_SOURCES = {
  PRODUCT_NAME: () => PRODUCT_NAME,
  SELLER_LEGAL_NAME: (env: WebEnv) => env.LEGAL_SELLER_NAME,
  SELLER_REGISTRATION: (env: WebEnv) => env.LEGAL_SELLER_REGISTRATION,
  SELLER_ADDRESS: (env: WebEnv) => env.LEGAL_SELLER_ADDRESS,
  SELLER_JURISDICTION: (env: WebEnv) => env.LEGAL_SELLER_JURISDICTION,
  SUPPORT_EMAIL: (env: WebEnv) => env.LEGAL_SUPPORT_EMAIL,
  PRIVACY_EMAIL: (env: WebEnv) => env.LEGAL_PRIVACY_EMAIL,
  LEGAL_EMAIL: (env: WebEnv) => env.LEGAL_CONTACT_EMAIL,
  GOVERNING_LAW: (env: WebEnv) => env.LEGAL_GOVERNING_LAW,
  FORUM: (env: WebEnv) => env.LEGAL_FORUM,
  SUPERVISORY_AUTHORITY: (env: WebEnv) => env.LEGAL_SUPERVISORY_AUTHORITY,
  LIABILITY_CAP: (env: WebEnv) => env.LEGAL_LIABILITY_CAP,
  WITHDRAWAL_CLAUSE: (env: WebEnv) => env.LEGAL_WITHDRAWAL,
  MINIMUM_AGE: (env: WebEnv) => env.LEGAL_MINIMUM_AGE,
  ACCOUNT_DATA_RETENTION: (env: WebEnv) => env.LEGAL_RETENTION_ACCOUNT,
  BILLING_RECORD_RETENTION: (env: WebEnv) => env.LEGAL_RETENTION_BILLING,
  LEGAL_RECORD_RETENTION: (env: WebEnv) => env.LEGAL_RETENTION_RECORDS,
  CONVERSATION_RETENTION: (env: WebEnv) => env.LEGAL_RETENTION_CONVERSATION,
  HOSTING_REGION: (env: WebEnv) => env.LEGAL_HOSTING_REGION,
  DPO_OR_REPRESENTATIVE: (env: WebEnv) => env.LEGAL_DPO,
} as const satisfies Record<string, (env: WebEnv) => string | undefined>;

export type PlaceholderName = keyof typeof PLACEHOLDER_SOURCES;

export interface ResolvedDocument {
  readonly blocks: readonly LegalBlock[];
  /** Placeholders this document uses that configuration does not answer, in the order first met. */
  readonly unresolved: readonly PlaceholderName[];
  readonly effectiveDate: string | undefined;
  readonly version: number | undefined;
}

const PLACEHOLDER = /\{\{(?<name>[A-Z_]+)\}\}/gu;

/**
 * Replaces each `{{NAME}}` inside a run of text, splitting it so an unfilled one becomes its own node.
 *
 * It has to be a node rather than a marker string: the page styles a gap so it cannot be mistaken for
 * the document's own words, and a test asserts no gap text ever reaches the reader as plain prose.
 */
function fill(inline: Inline, env: WebEnv, missing: Set<PlaceholderName>): readonly Inline[] {
  if (inline.kind === "link") {
    return [inline];
  }
  const text = inline.value;
  if (!text.includes("{{")) {
    return [inline];
  }
  const out: Inline[] = [];
  let at = 0;
  for (const found of text.matchAll(PLACEHOLDER)) {
    const name = (found.groups?.["name"] ?? "") as PlaceholderName;
    if (found.index > at) {
      out.push({ kind: inline.kind, value: text.slice(at, found.index) });
    }
    const source = PLACEHOLDER_SOURCES[name] as ((env: WebEnv) => string | undefined) | undefined;
    const value = source?.(env);
    if (value === undefined || value === "") {
      missing.add(name);
      out.push({ kind: "gap", value: name });
    } else {
      out.push({ kind: inline.kind, value });
    }
    at = found.index + found[0].length;
  }
  if (at < text.length) {
    out.push({ kind: inline.kind, value: text.slice(at) });
  }
  return out;
}

function fillAll(content: readonly Inline[], env: WebEnv, missing: Set<PlaceholderName>): readonly Inline[] {
  return content.flatMap((inline) => fill(inline, env, missing));
}

export function resolveDocument(blocks: readonly LegalBlock[], env: WebEnv): ResolvedDocument {
  const missing = new Set<PlaceholderName>();
  const resolved = blocks.map((block): LegalBlock => {
    if (block.kind === "break") {
      return block;
    }
    // Spread the block and override only what resolution touches. Listing the fields instead is how a
    // field added later is dropped in silence: the paragraph's `sub` flag was lost exactly that way, and
    // every lettered sub-clause rendered flush with the clause above it.
    if (block.kind === "table") {
      return {
        ...block,
        head: block.head.map((cell) => fillAll(cell, env, missing)),
        rows: block.rows.map((row) => row.map((cell) => fillAll(cell, env, missing))),
      };
    }
    return { ...block, content: fillAll(block.content, env, missing) };
  });
  return {
    blocks: resolved,
    unresolved: [...missing],
    effectiveDate: env.LEGAL_EFFECTIVE_DATE,
    version: env.LEGAL_VERSION,
  };
}

/** Where a locale's copy of a document lives, relative to the application root. */
export function legalDocumentPath(name: LegalDocumentName, locale: UiLocale): string {
  return `src/legal/${locale}/${name}.md`;
}
