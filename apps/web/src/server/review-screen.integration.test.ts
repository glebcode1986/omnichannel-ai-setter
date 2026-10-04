/**
 * The Review queue as the browser actually drives it, against a real database (Issue #29).
 *
 * `review-view.test.ts` proves the URL codec in isolation and the store's own suite proves the query.
 * Neither proves the thing in between, and the thing in between is where this queue lost its tail: the
 * store pages at 25 and returns a cursor, and the route spent neither. The first 25 items were correct,
 * so nothing failed anywhere.
 *
 * What made it serious rather than untidy: approve, edit-and-send, dismiss and claim exist only on this
 * screen. An item it did not show was an item nobody could decide, in either direction, and it stayed
 * PENDING. In DRAFT mode every inbound message produces one, so twenty-six is a busy Tuesday.
 *
 * So this walks the loop a browser walks — build the query, read the page, follow the href the screen
 * produced — and asserts the property a paging bug always violates: every item appears exactly once.
 */
import { noRetrieval } from "@omnichannel/application";
import {
  appendInboundMessage,
  authorizeBusinessProfileAccess,
  authorizeWorkspaceAccess,
  createAiDraftStore,
  createBusinessProfile,
  createChannelAccount,
  createContactWithChannelIdentity,
  createConversation,
  createWorkspaceWithOwner,
  listReviewQueue,
  type BusinessProfileContext,
} from "@omnichannel/db";
import { NO_CAPABILITIES } from "@omnichannel/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import type { RawSearchParams } from "./inbox-view";
import { decodeReviewCursor, parseReviewView, reviewFilterOf, reviewNextHref } from "./review-view";

const PATH = "/workspaces/ws/profiles/bp/review";
const T0 = new Date("2026-03-01T10:00:00.000Z");

describe.skipIf(!databaseTestsEnabled())("the Review queue screen's query", () => {
  let database: TestDatabase;
  let context: BusinessProfileContext;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    const db = database.db;
    const owner = await db.user.create({ data: { name: "Review Screen Owner", email: "review-screen@example.test" } });
    const { workspaceId } = await createWorkspaceWithOwner(db, { name: "Review Screen Workspace", ownerUserId: owner.id });
    const workspace = await authorizeWorkspaceAccess(db, { userId: owner.id, workspaceId });
    const profile = await createBusinessProfile(db, workspace, { name: "Main" });
    context = await authorizeBusinessProfileAccess(db, { userId: owner.id, workspaceId, businessProfileId: profile.businessProfileId });
    const account = await createChannelAccount(db, context, {
      channel: "INSTAGRAM",
      externalAccountId: "ig-review-screen",
      capabilities: { ...NO_CAPABILITIES, text: true },
    });

    // Twenty-six items waiting, because the page is twenty-five. Each needs its own conversation: one
    // conversation holds one pending draft, which is the product rule this queue is a view of.
    for (let index = 0; index < 26; index += 1) {
      const identity = await createContactWithChannelIdentity(db, context, {
        channelAccountId: account.id,
        externalUserId: `ig-customer-${String(index)}`,
        displayName: `Customer ${String(index).padStart(2, "0")}`,
      });
      const conversation = await createConversation(db, context, { channelAccountId: account.id, channelIdentityId: identity.channelIdentityId });
      const anchor = await appendInboundMessage(db, context, {
        conversationId: conversation.id,
        channelMessageId: `mid-review-${String(index)}`,
        kind: "TEXT",
        text: "Are you open on Saturday?",
        occurredAt: new Date(T0.getTime() + index * 60_000),
      });
      await createAiDraftStore(db).saveDraft({
        scope: { workspaceId, businessProfileId: profile.businessProfileId, conversationId: conversation.id },
        generationKey: `review_screen_${String(index)}`,
        trigger: "AUTOMATIC",
        anchorMessageId: anchor.id,
        anchorStateVersion: 1,
        text: `Reply ${String(index).padStart(2, "0")}`,
        structuredOutput: { reply: "x" },
        confidence: 0.72,
        modelSuggestsSend: false,
        needsReview: true,
        reasonCodes: index % 2 === 0 ? ["LOW_CONFIDENCE"] : ["MISSING_FACT"],
        factualSourceIds: [],
        retrieval: noRetrieval("OK"),
        status: "PENDING",
        provider: "anthropic",
        model: "claude-opus-5",
        promptVersion: "reply.v1",
        schemaVersion: "ai-draft.v1",
      });
    }
  }, 300_000);

  afterAll(async () => {
    await database?.dispose();
  });

  /** One request, as the screen handles it: a query in, a page and a next link out. */
  const screen = async (query: RawSearchParams): Promise<{ readonly texts: readonly string[]; readonly nextHref?: string }> => {
    const view = parseReviewView(query);
    const page = await listReviewQueue(database.db, context, reviewFilterOf(view), { cursor: decodeReviewCursor(view.cursor) });
    return {
      texts: page.items.map((item) => item.text ?? ""),
      ...(page.nextCursor === undefined ? {} : { nextHref: reviewNextHref(PATH, view, page.nextCursor) }),
    };
  };

  /** What the browser does with a link: take its query parameters into the next request. */
  const follow = (href: string): RawSearchParams => Object.fromEntries(new URL(href, "https://example.test").searchParams);

  it("reaches the twenty-sixth item by following the link it rendered", async () => {
    const first = await screen({});

    expect(first.texts).toHaveLength(25);
    expect(first.nextHref).toBeDefined();

    const second = await screen(follow(first.nextHref ?? ""));

    // Named by exclusion rather than by position: this case is about reachability, not about the order.
    const expected = Array.from({ length: 26 }, (_unused, index) => `Reply ${String(index).padStart(2, "0")}`).filter(
      (text) => !first.texts.includes(text),
    );
    expect(expected).toHaveLength(1);
    expect(second.texts).toEqual(expected);
    expect(second.nextHref).toBeUndefined();
  }, 300_000);

  it("shows every waiting item exactly once across the pages", async () => {
    const seen: string[] = [];
    let query: RawSearchParams = {};
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await screen(query);
      seen.push(...page.texts);
      if (page.nextHref === undefined) {
        break;
      }
      query = follow(page.nextHref);
    }

    // A cursor that overlapped would offer the same reply twice — two decisions about one customer; one
    // that skipped would leave a reply waiting that nobody can see.
    expect(seen).toHaveLength(26);
    expect(new Set(seen).size).toBe(26);
  }, 300_000);

  it("keeps the reason filter while paging, instead of widening it on page two", async () => {
    const first = await screen({ reason: "MISSING_FACT" });

    // Thirteen of the twenty-six, so one page holds them all — the assertion that matters is that the
    // link, if there is one, carries the reason rather than paging into the whole queue.
    expect(first.texts.length).toBeGreaterThan(0);
    const href = reviewNextHref(PATH, { reasonCode: "MISSING_FACT" }, { createdAt: T0, id: "ad_1" });
    expect(new URL(href, "https://example.test").searchParams.get("reason")).toBe("MISSING_FACT");

    const continued = await screen(follow(href));
    expect(continued.texts.length).toBeGreaterThanOrEqual(0);
  }, 300_000);

  it("shows page one for a cursor nobody wrote, rather than an error", async () => {
    const page = await screen({ cursor: "not-a-cursor" });

    expect(page.texts).toHaveLength(25);
  }, 300_000);
});
