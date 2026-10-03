/**
 * What a URL is allowed to ask the Review queue for (Issue #29).
 *
 * The same discipline as the Inbox's view: the query string is the one part of this surface an operator
 * edits by hand, so a reason nobody defined and a view nobody defined both fall back to the whole queue
 * rather than failing. Showing more than was asked for is visible; a query built from an invented enum
 * value is a 500 on a shared link.
 */
import { REASON_CODES, type ReasonCode } from "@omnichannel/domain";
import type { ReviewCursor, ReviewQueueFilter } from "@omnichannel/db";

import type { RawSearchParams } from "./inbox-view";

export interface ReviewView {
  readonly reasonCode?: ReasonCode;
  /** Whether to show only the items a person can still act on, or only the ones already overtaken. */
  readonly view?: "answerable" | "stale";
  /** Where in the queue this page starts. Opaque, and absent for the first page. */
  readonly cursor?: string;
}

function one(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined || first === "" ? undefined : first;
}

function isReasonCode(value: string | undefined): value is ReasonCode {
  return value !== undefined && (REASON_CODES as readonly string[]).includes(value);
}

export function parseReviewView(params: RawSearchParams): ReviewView {
  const reason = one(params["reason"]);
  const view = one(params["view"]);
  const cursor = one(params["cursor"]);
  return {
    ...(isReasonCode(reason) ? { reasonCode: reason } : {}),
    ...(view === "answerable" || view === "stale" ? { view } : {}),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

export function reviewFilterOf(view: ReviewView): ReviewQueueFilter {
  return {
    ...(view.reasonCode === undefined ? {} : { reasonCode: view.reasonCode }),
    ...(view.view === "stale" ? { stale: true } : view.view === "answerable" ? { stale: false } : {}),
  };
}

/**
 * `?reason=…&view=…`, or the empty string, so `${base}${query}` is always a URL.
 *
 * **The cursor is deliberately not included.** Every link on the page that changes what the queue shows
 * goes through here, and a filter link that kept the cursor would drop the operator into the middle of a
 * list they have not seen the start of. Changing the filter means starting again; only
 * `reviewNextHref` adds a cursor, and only to the same filter.
 */
export function reviewQueryString(view: ReviewView): string {
  const params = new URLSearchParams();
  if (view.reasonCode !== undefined) {
    params.set("reason", view.reasonCode);
  }
  if (view.view !== undefined) {
    params.set("view", view.view);
  }
  const query = params.toString();
  return query === "" ? "" : `?${query}`;
}

/**
 * Not secret, only opaque: the `(createdAt, id)` tuple the store pages by, so the link survives a
 * bookmark. A cursor carries no authority — the store scopes every read to the profile in the route.
 */
export function encodeReviewCursor(cursor: ReviewCursor): string {
  return Buffer.from(`${cursor.createdAt.toISOString()}|${cursor.id}`, "utf8").toString("base64url");
}

/** `undefined` for anything this module did not write, so a hand-edited URL shows page one. */
export function decodeReviewCursor(encoded: string | undefined): ReviewCursor | undefined {
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

/** The next page of the same queue: the filters this view already carries, plus where to continue. */
export function reviewNextHref(reviewPath: string, view: ReviewView, cursor: ReviewCursor): string {
  const query = reviewQueryString(view);
  const separator = query === "" ? "?" : "&";
  return `${reviewPath}${query}${separator}cursor=${encodeReviewCursor(cursor)}`;
}

/**
 * Whether the queue is being narrowed, which decides which "nothing here" sentence is true.
 *
 * The cursor is not a filter. Page two of the whole queue is still the whole queue, and saying
 * "nothing matches that filter" there would explain an empty page with a filter nobody applied.
 */
export function isFilteredReviewView(view: ReviewView): boolean {
  return view.reasonCode !== undefined || view.view !== undefined;
}
