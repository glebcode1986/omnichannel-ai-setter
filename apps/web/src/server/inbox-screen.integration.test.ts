/**
 * The Inbox as the browser actually drives it, against a real database (Issue #28).
 *
 * `inbox-view.test.ts` proves the URL codec in isolation and the store's own suite proves the query.
 * Neither proves the thing in between, which is where a list view usually breaks: a cursor written into a
 * link, read back out of the next request, and turned into the page that continues exactly where the
 * last one stopped. That is the whole of "load older conversations", and every piece of it is a
 * round trip through a string.
 *
 * So this walks the real loop — parse the URL, build the filter, read the page, encode the cursor, parse
 * the next URL — and asserts the property a paging bug always violates: every conversation appears
 * exactly once.
 */
import { listInbox, readConversation, appendInboundMessage, createChannelAccount, createContactWithChannelIdentity, createConversation, createBusinessProfile, createWorkspaceWithOwner, authorizeBusinessProfileAccess, authorizeWorkspaceAccess, type BusinessProfileContext } from "@omnichannel/db";
import { NO_CAPABILITIES } from "@omnichannel/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { decodeInboxCursor, encodeInboxCursor, inboxFilterOf, parseInboxView, type RawSearchParams } from "./inbox-view";

const T0 = new Date("2026-03-01T10:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

describe.skipIf(!databaseTestsEnabled())("the Inbox screen's query", () => {
  let database: TestDatabase;
  let context: BusinessProfileContext;
  let neighbour: BusinessProfileContext;
  let instagramAccountId: string;
  let whatsappAccountId: string;
  let neighbourAccountId: string;
  let viewerUserId: string;
  let seq = 0;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    const db = database.db;
    const owner = await db.user.create({ data: { name: "Inbox Screen Owner", email: "inbox-screen@example.test" } });
    viewerUserId = owner.id;
    const { workspaceId } = await createWorkspaceWithOwner(db, { name: "Inbox Screen Workspace", ownerUserId: viewerUserId });
    const workspace = await authorizeWorkspaceAccess(db, { userId: viewerUserId, workspaceId });

    const main = await createBusinessProfile(db, workspace, { name: "Main" });
    context = await authorizeBusinessProfileAccess(db, { userId: viewerUserId, workspaceId, businessProfileId: main.businessProfileId });
    const other = await createBusinessProfile(db, workspace, { name: "Neighbour" });
    neighbour = await authorizeBusinessProfileAccess(db, { userId: viewerUserId, workspaceId, businessProfileId: other.businessProfileId });

    instagramAccountId = (
      await createChannelAccount(db, context, { channel: "INSTAGRAM", externalAccountId: "ig-screen", capabilities: { ...NO_CAPABILITIES, text: true } })
    ).id;
    whatsappAccountId = (
      await createChannelAccount(db, context, { channel: "WHATSAPP", externalAccountId: "wa-screen", capabilities: { ...NO_CAPABILITIES, text: true } })
    ).id;
    neighbourAccountId = (
      await createChannelAccount(db, neighbour, { channel: "INSTAGRAM", externalAccountId: "ig-neighbour", capabilities: { ...NO_CAPABILITIES, text: true } })
    ).id;
  }, 180_000);

  afterAll(async () => {
    await database?.dispose();
  });

  const db = () => database.db;

  const conversation = async (options: {
    readonly ctx?: BusinessProfileContext;
    readonly channelAccountId?: string;
    readonly name: string;
    readonly occurredAt: Date;
  }) => {
    seq += 1;
    const ctx = options.ctx ?? context;
    const accountId = options.channelAccountId ?? instagramAccountId;
    const identity = await createContactWithChannelIdentity(db(), ctx, {
      channelAccountId: accountId,
      externalUserId: `screen-user-${String(seq)}`,
      username: `@${options.name.toLowerCase().replace(/\s+/gu, "")}`,
      displayName: options.name,
    });
    const created = await createConversation(db(), ctx, { channelAccountId: accountId, channelIdentityId: identity.channelIdentityId });
    await appendInboundMessage(db(), ctx, {
      conversationId: created.id,
      kind: "TEXT",
      text: `Message from ${options.name}`,
      occurredAt: options.occurredAt,
    });
    // `lastMessageAt` defaults to now() and only ever moves forward, so a backdated message does not
    // move it back. Every ordering and cursor assertion below is about this column, so the fixture sets
    // it rather than hoping creation order happens to match — which is how a paging test passes while
    // proving nothing.
    await db().conversation.update({
      where: { id: created.id },
      data: { lastMessageAt: options.occurredAt, lastInboundAt: options.occurredAt },
    });
    return created.id;
  };

  /** One request: a query string in, a page and the next request's query string out. */
  const screen = async (params: RawSearchParams, ctx: BusinessProfileContext = context) => {
    const view = parseInboxView(params);
    const page = await listInbox(db(), ctx, inboxFilterOf(view, viewerUserId), { limit: 2, cursor: decodeInboxCursor(view.cursor) });
    return {
      view,
      ids: page.rows.map((row) => row.id),
      next: page.nextCursor === undefined ? undefined : encodeInboxCursor(page.nextCursor),
    };
  };

  it("pages through every conversation exactly once, following its own links", async () => {
    const created: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      created.push(await conversation({ name: `Pager ${String(index)}`, occurredAt: at(100 + index) }));
    }

    const seen: string[] = [];
    let params: RawSearchParams = { q: "Pager" };
    for (let request = 0; request < 10; request += 1) {
      const result = await screen(params);
      seen.push(...result.ids);
      if (result.next === undefined) {
        break;
      }
      params = { q: "Pager", cursor: result.next };
    }

    // Newest first, each conversation once, and the walk terminated on its own rather than on the bound.
    expect(seen).toEqual([...created].reverse());
    expect(new Set(seen).size).toBe(seen.length);
  }, 180_000);

  it("keeps a filter across the pages it pages through", async () => {
    for (let index = 0; index < 3; index += 1) {
      await conversation({ name: `Waiter ${String(index)}`, channelAccountId: whatsappAccountId, occurredAt: at(200 + index) });
    }

    const seen: string[] = [];
    let params: RawSearchParams = { q: "Waiter", filter: "awaitingReply" };
    for (let request = 0; request < 5; request += 1) {
      const result = await screen(params);
      seen.push(...result.ids);
      if (result.next === undefined) {
        break;
      }
      params = { q: "Waiter", filter: "awaitingReply", cursor: result.next };
    }

    expect(seen).toHaveLength(3);
  }, 180_000);

  /**
   * The honest form of "unread was updated".
   *
   * There is no read receipt in this product, so what the spec calls unread is "the customer spoke last".
   * Replying is what clears it, and `lastOutboundAt` is set directly here because sending a real message
   * is the delivery engine's job and would drag a transport into a query test.
   */
  it("drops a conversation out of 'awaiting reply' once the team has replied", async () => {
    const id = await conversation({ name: "Replied To", occurredAt: at(300) });

    const before = await screen({ q: "Replied To", filter: "awaitingReply" });
    expect(before.ids).toContain(id);

    await db().conversation.update({ where: { id }, data: { lastOutboundAt: at(301) } });

    const after = await screen({ q: "Replied To", filter: "awaitingReply" });
    expect(after.ids).not.toContain(id);
    // Still in the unfiltered inbox: answered is not the same as gone.
    expect((await screen({ q: "Replied To" })).ids).toContain(id);
  }, 180_000);

  it("cannot be pointed at another Business Profile by editing the URL", async () => {
    const mine = await conversation({ name: "Mine Alone", occurredAt: at(400) });
    const theirs = await conversation({ ctx: neighbour, channelAccountId: neighbourAccountId, name: "Theirs Alone", occurredAt: at(401) });

    // A cursor taken from the neighbour's inbox, replayed against this profile. The cursor is a position,
    // never an authority: the scope comes from the route's context and nothing in the query can widen it.
    const theirPage = await screen({}, neighbour);
    const replayed = await screen({ cursor: encodeInboxCursor({ lastMessageAt: at(402), id: theirs }) });

    expect(theirPage.ids).toContain(theirs);
    expect(replayed.ids).not.toContain(theirs);
    expect(replayed.ids).toContain(mine);
    expect(await readConversation(db(), context, theirs)).toBeUndefined();
  }, 180_000);

  it("narrows to one connected account, and to one lead stage, and to both at once", async () => {
    const onInstagram = await conversation({ name: "Stagey Instagram", occurredAt: at(900) });
    const onWhatsapp = await conversation({ name: "Stagey Whatsapp", channelAccountId: whatsappAccountId, occurredAt: at(901) });
    await db().conversation.update({ where: { id: onWhatsapp }, data: { leadStage: "BOOKED" } });
    await db().conversation.update({ where: { id: onInstagram }, data: { leadStage: "BOOKED" } });

    expect((await screen({ q: "Stagey", account: whatsappAccountId })).ids).toEqual([onWhatsapp]);
    expect((await screen({ q: "Stagey", stage: "BOOKED" })).ids).toEqual([onWhatsapp, onInstagram]);
    expect((await screen({ q: "Stagey", stage: "NEW" })).ids).toEqual([]);
    // Both at once, which is the case a filter implemented as a spread would silently lose.
    expect((await screen({ q: "Stagey", stage: "BOOKED", account: instagramAccountId })).ids).toEqual([onInstagram]);
  }, 180_000);

  it("ignores a lead stage the URL invented, rather than matching nothing at all", async () => {
    const id = await conversation({ name: "Invented Stage", occurredAt: at(910) });

    // A dropped filter shows more than asked for, which is visible; a filter passed through as a value
    // the enum does not have would be a query error on a hand-edited link.
    expect((await screen({ q: "Invented Stage", stage: "PLATINUM" })).ids).toEqual([id]);
  }, 180_000);

  it("reports the mode actually in force, not the conversation's empty override", async () => {
    const id = await conversation({ name: "Inherits Mode", occurredAt: at(920) });
    await db().automationPolicy.create({
      data: {
        workspaceId: context.workspaceId,
        businessProfileId: context.businessProfileId,
        channelAccountId: instagramAccountId,
        mode: "AUTOPILOT",
      },
    });

    const detail = await readConversation(db(), context, id);
    const listed = (await listInbox(db(), context, { search: "Inherits Mode" })).rows[0];

    // No override on the conversation, a policy on the account: the Inbox has to say AUTOPILOT, because
    // reading the empty override as OFF would tell an operator automation was disabled while it ran.
    expect(detail?.modeOverride).toBeNull();
    expect(detail?.effectiveMode).toBe("AUTOPILOT");
    expect(listed?.effectiveMode).toBe("AUTOPILOT");
  }, 180_000);

  it("shows the first page when the cursor in the URL is unusable", async () => {
    const id = await conversation({ name: "Stale Link", occurredAt: at(500) });

    // A truncated or hand-edited cursor is a stale bookmark, not an error page. Scoped by search rather
    // than by "is it first", so the case does not depend on what the tests around it happened to create.
    expect((await screen({ q: "Stale Link", cursor: "not-a-cursor" })).ids).toEqual([id]);
  }, 180_000);

  it("reads a conversation the list linked to, with its thread and its latest decision", async () => {
    const id = await conversation({ name: "Openable", occurredAt: at(600) });

    const detail = await readConversation(db(), context, id);

    expect(detail?.id).toBe(id);
    expect(detail?.messages.map((message) => message.text)).toEqual(["Message from Openable"]);
    expect(detail?.channel).toBe("INSTAGRAM");
  }, 180_000);
});
