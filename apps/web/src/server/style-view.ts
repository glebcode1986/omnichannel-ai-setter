/**
 * Turning a Style Training URL into two queries, and two cursors back into a URL (Issue #32).
 *
 * This page shows two lists at once — the verified library and the queue of suggestions — and each pages
 * independently. That is the one thing it does not share with the Inbox, the Knowledge Library or the
 * Review queue, and it is the thing worth getting right: a single `cursor` parameter would make "show more
 * suggestions" also advance the verified list, so an operator paging one would silently lose their place
 * in the other. They get a parameter each.
 *
 * Before this, neither list had a cursor at all. The store paged both at 25 and returned a cursor for each;
 * the route called it twice with no page argument and no component offered a link, so a business with more
 * than 25 suggestions could see 25 of them — and a suggestion nobody can reach is one nobody can approve
 * or reject, so it stays SUGGESTED.
 */
import type { StyleDecisionCursor, StyleExampleCursor } from "@omnichannel/db";

import type { RawSearchParams } from "./inbox-view";

/** Which list a cursor belongs to. The parameter name is part of the contract, so it lives here. */
/**
 * The three lists the screen renders, and therefore the three cursors it may carry.
 *
 * `retired` is the archived-and-rejected list. It needs its own parameter for the reason the other two
 * do: one shared cursor would make "show more retired" also advance the verified library, so an operator
 * paging one would lose their place in the other — a bug that reads as data disappearing.
 */
export type StyleList = "verified" | "suggested" | "retired";

const PARAM: Readonly<Record<StyleList, string>> = { verified: "verifiedCursor", suggested: "suggestedCursor", retired: "retiredCursor" };

export function one(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined || first === "" ? undefined : first;
}

/** Not secret, only opaque: the `(createdAt, id)` tuple the store pages by, so a link survives a bookmark. */
export function encodeStyleCursor(cursor: StyleExampleCursor): string {
  return Buffer.from(`${cursor.createdAt.toISOString()}|${cursor.id}`, "utf8").toString("base64url");
}

/**
 * `undefined` for anything this module did not write.
 *
 * A cursor carries no authority: the store scopes every read to the profile in the route, so the worst a
 * forged one can do is point at a page of this profile's own examples.
 */
export function decodeStyleCursor(encoded: string | undefined): StyleExampleCursor | undefined {
  if (encoded === undefined || encoded === "") {
    return undefined;
  }
  const decoded = Buffer.from(encoded, "base64url").toString("utf8");
  const separator = decoded.indexOf("|");
  if (separator === -1) {
    return undefined;
  }
  const createdAt = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  if (Number.isNaN(createdAt.getTime()) || id === "") {
    return undefined;
  }
  return { createdAt, id };
}

/**
 * The two parameters that open one example's complete lifecycle (R5 re-review).
 *
 * Two rather than one, and for the same reason the three lists get a parameter each: the example decides
 * *whose* history is open and the cursor decides *where in it*, so going back a page cannot accidentally
 * open a different example's history, and dropping the cursor alone returns to the most recent events.
 */
const HISTORY_EXAMPLE_PARAM = "historyExample";
const HISTORY_CURSOR_PARAM = "historyCursor";

/** Not secret, only opaque: the `(decidedAt, id)` tuple the lifecycle pages by. */
export function encodeDecisionCursor(cursor: StyleDecisionCursor): string {
  return Buffer.from(`${cursor.decidedAt.toISOString()}|${cursor.id}`, "utf8").toString("base64url");
}

export function decodeDecisionCursor(encoded: string | undefined): StyleDecisionCursor | undefined {
  if (encoded === undefined || encoded === "") {
    return undefined;
  }
  const decoded = Buffer.from(encoded, "base64url").toString("utf8");
  const separator = decoded.indexOf("|");
  if (separator === -1) {
    return undefined;
  }
  const decidedAt = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  if (Number.isNaN(decidedAt.getTime()) || id === "") {
    return undefined;
  }
  return { decidedAt, id };
}

/** Which example's lifecycle this request has open, and where in it. */
export function styleHistoryRequest(query: RawSearchParams): { readonly styleExampleId?: string; readonly before?: StyleDecisionCursor } {
  const styleExampleId = one(query[HISTORY_EXAMPLE_PARAM]);
  const before = decodeDecisionCursor(one(query[HISTORY_CURSOR_PARAM]));
  // A cursor with no example names no history, and is dropped rather than guessed at: the alternative is
  // applying one example's cursor to whichever example happened to be first.
  return { ...(styleExampleId === undefined ? {} : { styleExampleId }), ...(styleExampleId === undefined || before === undefined ? {} : { before }) };
}

/**
 * The same page with one example's lifecycle opened at a point in the past, and everything else as it was.
 *
 * Built from the incoming query for the reason `styleNextHref` gives: a URL rebuilt from parsed values
 * drifts the moment a parameter is added and forgotten, and here that would mean opening a history and
 * silently resetting the list the example is in to its first page.
 *
 * A `cursor` of `undefined` is the link back to the most recent events.
 */
export function styleHistoryHref(
  basePath: string,
  query: RawSearchParams,
  styleExampleId: string | undefined,
  cursor: StyleDecisionCursor | undefined,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (key === HISTORY_EXAMPLE_PARAM || key === HISTORY_CURSOR_PARAM || key === "outcome") {
      continue;
    }
    const first = Array.isArray(value) ? value[0] : value;
    if (first !== undefined && first !== "") {
      params.set(key, first);
    }
  }
  if (styleExampleId !== undefined) {
    params.set(HISTORY_EXAMPLE_PARAM, styleExampleId);
  }
  if (cursor !== undefined) {
    params.set(HISTORY_CURSOR_PARAM, encodeDecisionCursor(cursor));
  }
  const query_ = params.toString();
  return query_ === "" ? basePath : `${basePath}?${query_}`;
}

/** The cursor this request carries for one of the two lists. */
export function styleCursorOf(query: RawSearchParams, list: StyleList): StyleExampleCursor | undefined {
  return decodeStyleCursor(one(query[PARAM[list]]));
}

/**
 * The same page with one list advanced, and everything else exactly as it was.
 *
 * Built from the incoming query rather than from parsed values, for the reason the Knowledge Library
 * learned: a URL rebuilt from a parsed view drifts the moment a parameter is added and forgotten. Here
 * that would mean paging the suggestions and dropping the retrieval question the operator had typed, or —
 * worse — resetting the other list to its first page without saying so.
 */
export function styleNextHref(basePath: string, query: RawSearchParams, list: StyleList, cursor: StyleExampleCursor): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    // `outcome` announces a write that already happened; repeating it on the next page would announce it
    // again. This list's own cursor is replaced, and the other list's is carried through untouched.
    //
    // The open history goes too, for the reason the Inbox drops its cursor when a filter changes: a new
    // page of a list is a new set of rows, and an example whose history is open is very likely not on it.
    // Carrying the parameters forward produced a URL that loaded a lifecycle no list rendered, and took
    // the link back to the newest events with it.
    if (key === PARAM[list] || key === "outcome" || key === HISTORY_EXAMPLE_PARAM || key === HISTORY_CURSOR_PARAM) {
      continue;
    }
    const first = Array.isArray(value) ? value[0] : value;
    if (first !== undefined && first !== "") {
      params.set(key, first);
    }
  }
  params.set(PARAM[list], encodeStyleCursor(cursor));
  return `${basePath}?${params.toString()}`;
}
