/**
 * What a URL is allowed to ask the Inbox for (Issue #28).
 *
 * The query string is the one piece of this feature an operator can edit by hand, and the one piece a
 * chat client can truncate. So the cases here are mostly hostile: a filter nobody defined, a cursor that
 * is not base64, a cursor that decodes to an impossible date. Each has to produce the default view rather
 * than an exception, because the alternative is a 500 on a colleague's shared link.
 */
import { describe, expect, it } from "vitest";

import { decodeInboxCursor, encodeInboxCursor, inboxFilterOf, parseInboxView } from "./inbox-view";

const VIEWER = "usr_01JABCDEF0000000000000001";

describe("parsing an Inbox URL", () => {
  it("reads the search, the filter, the account and the cursor", () => {
    expect(parseInboxView({ q: "ann", filter: "awaitingReply", account: "ca_1", cursor: "abc" })).toEqual({
      search: "ann",
      filter: "awaitingReply",
      channelAccountId: "ca_1",
      cursor: "abc",
    });
  });

  it("drops a filter nobody defined rather than guessing at it", () => {
    // A view that fell back to *some* filter would quietly show a subset and look like the whole inbox.
    expect(parseInboxView({ filter: "assignedToMeAndUrgent" })).toEqual({});
  });

  it("treats blank and whitespace-only search as no search", () => {
    expect(parseInboxView({ q: "" })).toEqual({});
    expect(parseInboxView({ q: "   " })).toEqual({});
  });

  it("trims the search, so a copied name with a trailing space still matches", () => {
    expect(parseInboxView({ q: "  ann  " }).search).toBe("ann");
  });

  it("takes the first value when a parameter is repeated", () => {
    // `?filter=mine&filter=humanActive` is not a view; picking one beats rendering neither.
    expect(parseInboxView({ filter: ["mine", "humanActive"] }).filter).toBe("mine");
  });
});

describe("the store filter a view asks for", () => {
  it("asks for conversations awaiting a reply", () => {
    expect(inboxFilterOf({ filter: "awaitingReply" }, VIEWER)).toEqual({ awaitingReply: true });
  });

  it("maps the review and human-active filters onto takeover state", () => {
    expect(inboxFilterOf({ filter: "reviewNeeded" }, VIEWER)).toEqual({ takeover: "REVIEW_REQUIRED" });
    expect(inboxFilterOf({ filter: "humanActive" }, VIEWER)).toEqual({ takeover: "HUMAN_ACTIVE" });
  });

  it("scopes 'Mine' to the viewer, and to nobody else", () => {
    expect(inboxFilterOf({ filter: "mine" }, VIEWER)).toEqual({ takenOverByUserId: VIEWER });
  });

  it("keeps the search and the account alongside a filter", () => {
    expect(inboxFilterOf({ search: "ann", channelAccountId: "ca_1", filter: "mine" }, VIEWER)).toEqual({
      search: "ann",
      channelAccountId: "ca_1",
      takenOverByUserId: VIEWER,
    });
  });

  it("asks for nothing at all when the URL asked for nothing", () => {
    expect(inboxFilterOf({}, VIEWER)).toEqual({});
  });
});

describe("the Inbox cursor", () => {
  it("survives a round trip through a URL", () => {
    const cursor = { lastMessageAt: new Date("2026-09-30T11:22:33.444Z"), id: "cv_01JABCDEF0000000000000009" };
    const decoded = decodeInboxCursor(encodeInboxCursor(cursor));

    // Millisecond precision matters: the tuple comparison is what keeps paging from repeating a row.
    expect(decoded?.lastMessageAt.toISOString()).toBe("2026-09-30T11:22:33.444Z");
    expect(decoded?.id).toBe(cursor.id);
  });

  it("carries an id containing the separator without losing part of it", () => {
    // The id is taken after the *first* separator, so a pipe inside it is data rather than a delimiter.
    const decoded = decodeInboxCursor(encodeInboxCursor({ lastMessageAt: new Date(0), id: "cv|weird" }));

    expect(decoded?.id).toBe("cv|weird");
  });

  it.each([
    ["nothing at all", undefined],
    ["a value that is not a cursor", "hello"],
    ["a cursor with no id", Buffer.from("2026-09-30T00:00:00.000Z|", "utf8").toString("base64url")],
    ["a cursor whose date is not a date", Buffer.from("last-tuesday|cv_1", "utf8").toString("base64url")],
  ])("ignores %s instead of throwing", (_case, value) => {
    expect(decodeInboxCursor(value)).toBeUndefined();
  });

  it("produces a value that is safe in a URL", () => {
    const encoded = encodeInboxCursor({ lastMessageAt: new Date("2026-09-30T11:22:33.444Z"), id: "cv_1" });

    // base64url, so no `+`, `/` or `=` to be re-encoded, mangled or truncated on the way through.
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(encoded).toBe(encodeURIComponent(encoded));
  });
});
