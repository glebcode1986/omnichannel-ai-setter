/**
 * Turning a Knowledge Library URL into a query, and a cursor back into a URL (Issue #31).
 *
 * The library pages at 25 and the store returns a stable cursor, but the route never read one and the list
 * never rendered a link, so a business with 26 sources could not reach the 26th at all — unless the
 * operator happened to know a word from its title. Everything after the first page was simply absent, with
 * nothing on screen to say so.
 *
 * **The next link is built from the incoming query rather than from the parsed filter.** That is the whole
 * trick: a filter re-serialized from parsed values drifts from what the person actually typed the moment
 * one parameter is added and forgotten, and the symptom is a "load more" link that silently drops the
 * search they are paging through. Carrying the query forward cannot drift, because it is the same query.
 *
 * `cursor` is replaced, and `outcome` is dropped: it is a one-shot notice about a write that already
 * happened, and repeating it on page two would announce it again.
 */
import type { KnowledgeCursor, KnowledgeFilter } from "@omnichannel/db";

import type { RawSearchParams } from "./inbox-view";

/** The values this screen accepts, offered by its own form and enforced by its own parser. */
export const KNOWLEDGE_STATUSES = ["DRAFT", "ACTIVE", "ARCHIVED"] as const;
export const KNOWLEDGE_INDEXING_STATES = ["PENDING", "INDEXED", "FAILED"] as const;
export const KNOWLEDGE_SCOPES = ["WORKSPACE", "BUSINESS_PROFILE"] as const;

export function one(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined || first === "" ? undefined : first;
}

/**
 * A filter built only from values the store recognises.
 *
 * An unknown one is dropped rather than passed through: a URL in a bookmark outlives the filter it names,
 * and "status=WITHDRAWN" should show the library rather than an error page.
 */
export function knowledgeFilterOf(query: RawSearchParams): KnowledgeFilter {
  const status = one(query["status"]);
  const indexing = one(query["indexing"]);
  const scope = one(query["scope"]);
  const search = one(query["q"]);
  return {
    ...((KNOWLEDGE_STATUSES as readonly string[]).includes(status ?? "") ? { status: status as KnowledgeFilter["status"] } : {}),
    ...((KNOWLEDGE_INDEXING_STATES as readonly string[]).includes(indexing ?? "") ? { indexingState: indexing as KnowledgeFilter["indexingState"] } : {}),
    ...((KNOWLEDGE_SCOPES as readonly string[]).includes(scope ?? "") ? { scope: scope as KnowledgeFilter["scope"] } : {}),
    ...(search === undefined ? {} : { search }),
  };
}

/** Not secret, only opaque: the `(updatedAt, id)` tuple the store pages by, so a URL survives a bookmark. */
export function encodeKnowledgeCursor(cursor: KnowledgeCursor): string {
  return Buffer.from(`${cursor.updatedAt.toISOString()}|${cursor.id}`, "utf8").toString("base64url");
}

/**
 * `undefined` for anything this module did not write.
 *
 * A cursor carries no authority: the store scopes every read to the profile in the route, so the worst a
 * forged one can do is point at a page of this profile's own library.
 */
export function decodeKnowledgeCursor(encoded: string | undefined): KnowledgeCursor | undefined {
  if (encoded === undefined || encoded === "") {
    return undefined;
  }
  const decoded = Buffer.from(encoded, "base64url").toString("utf8");
  const separator = decoded.indexOf("|");
  if (separator === -1) {
    return undefined;
  }
  const updatedAt = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  if (Number.isNaN(updatedAt.getTime()) || id === "") {
    return undefined;
  }
  return { updatedAt, id };
}

/** The same page, one cursor further on, with every filter the person is looking at still applied. */
export function knowledgeNextHref(basePath: string, query: RawSearchParams, cursor: KnowledgeCursor): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (key === "cursor" || key === "outcome") {
      continue;
    }
    const first = Array.isArray(value) ? value[0] : value;
    if (first !== undefined && first !== "") {
      params.set(key, first);
    }
  }
  params.set("cursor", encodeKnowledgeCursor(cursor));
  return `${basePath}?${params.toString()}`;
}

/**
 * The lifecycle action a source needs next, as one decision.
 *
 * It exists as a function because the branch it replaced was wrong in a way no component test could see:
 * the detail page offered Archive to *every* ACTIVE document and Publish only to DRAFTs, so a live source
 * edited into a staged version had no way to publish it. The page said "saved v2, customers are answered
 * with v1" and offered no button that would change that — the store could do it, and the operator could
 * not reach it.
 *
 * So the rule is stated once, where a test can read it: **a version that is not the published one can be
 * published, whatever the document's status.** An archived source says "use it again" instead, because
 * that is the sentence its operator is looking for; it is the same write.
 */
export type KnowledgeLifecycle = "publish" | "restore" | undefined;

export function knowledgeLifecycleOf(document: {
  readonly status: string;
  readonly version: number;
  readonly publishedVersion: number | null;
}): KnowledgeLifecycle {
  if (document.status === "ARCHIVED") {
    return "restore";
  }
  return document.version === document.publishedVersion ? undefined : "publish";
}
