/**
 * Turning a URL into an Inbox query, and a cursor back into a URL (Issue #28).
 *
 * The view lives in the query string, so this is the one place that decides what a parameter means. Two
 * rules it holds to:
 *
 * **Unrecognised input is dropped, never guessed and never fatal.** Query strings are typed by hand,
 * kept in bookmarks and truncated by chat clients. A filter nobody defined and a cursor that no longer
 * parses both fall back to the unfiltered first page, because a 500 on a stale bookmark is a worse answer
 * than the default view.
 *
 * **The cursor is opaque but not secret.** It is the `(lastMessageAt, id)` tuple the store pages by,
 * base64url so it survives a URL intact. Encoding it is not a security measure — it carries no authority,
 * and the store scopes every read to the profile in the route regardless of what the cursor says.
 */
import type { InboxCursor, InboxFilter } from "@omnichannel/db";

import type { InboxView } from "@/ui/inbox/view";

const FILTERS = ["awaitingReply", "reviewNeeded", "humanActive", "mine"] as const;
type InboxFilterName = (typeof FILTERS)[number];

/** What Next hands a page: a value, a repeated value, or nothing. */
export type RawSearchParams = Record<string, string | string[] | undefined>;

function one(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined || first === "" ? undefined : first;
}

function isFilterName(value: string | undefined): value is InboxFilterName {
  return value !== undefined && (FILTERS as readonly string[]).includes(value);
}

export function parseInboxView(params: RawSearchParams): InboxView {
  const search = one(params["q"])?.trim();
  const filter = one(params["filter"]);
  return {
    ...(search === undefined || search === "" ? {} : { search }),
    ...(isFilterName(filter) ? { filter } : {}),
    ...(one(params["account"]) === undefined ? {} : { channelAccountId: one(params["account"]) ?? "" }),
    ...(one(params["cursor"]) === undefined ? {} : { cursor: one(params["cursor"]) ?? "" }),
  };
}

/**
 * The store filter this view asks for.
 *
 * `mine` needs the viewer, which is why the session user is a parameter rather than something read here:
 * this module has no business resolving identity, and a filter that silently meant "anyone" when the
 * caller forgot to pass it would be the sort of bug nobody notices in review.
 */
export function inboxFilterOf(view: InboxView, viewerUserId: string): InboxFilter {
  return {
    ...(view.search === undefined ? {} : { search: view.search }),
    ...(view.channelAccountId === undefined ? {} : { channelAccountId: view.channelAccountId }),
    ...(view.filter === "awaitingReply" ? { awaitingReply: true } : {}),
    ...(view.filter === "reviewNeeded" ? { takeover: "REVIEW_REQUIRED" as const } : {}),
    ...(view.filter === "humanActive" ? { takeover: "HUMAN_ACTIVE" as const } : {}),
    ...(view.filter === "mine" ? { takenOverByUserId: viewerUserId } : {}),
  };
}

export function encodeInboxCursor(cursor: InboxCursor): string {
  return Buffer.from(`${cursor.lastMessageAt.toISOString()}|${cursor.id}`, "utf8").toString("base64url");
}

/** `undefined` for anything that is not a cursor this module wrote — see the note above. */
export function decodeInboxCursor(encoded: string | undefined): InboxCursor | undefined {
  if (encoded === undefined) {
    return undefined;
  }
  const decoded = Buffer.from(encoded, "base64url").toString("utf8");
  const separator = decoded.indexOf("|");
  if (separator === -1) {
    return undefined;
  }
  const timestamp = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  if (Number.isNaN(timestamp.getTime()) || id === "") {
    return undefined;
  }
  return { lastMessageAt: timestamp, id };
}
