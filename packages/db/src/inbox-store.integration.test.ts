/**
 * Reading the unified Inbox (Issue #28).
 *
 * The cases worth writing are the ones a list view gets wrong silently: a cursor that repeats or skips a
 * row when two conversations share a timestamp, a filter that reaches into the next Business Profile, and
 * a page that comes back short because a filter was applied after paging.
 */
import { NO_CAPABILITIES } from "@omnichannel/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { listInbox } from "./inbox-store";
import { appendInboundMessage } from "./repositories/messages";
import { createChannelAccount } from "./repositories/channel-accounts";
import { createContactWithChannelIdentity } from "./repositories/contacts";
import { createConversation } from "./repositories/conversations";
import { createBusinessProfile, createWorkspaceWithOwner } from "./repositories/workspaces";
import { authorizeBusinessProfileAccess, authorizeWorkspaceAccess, type BusinessProfileContext } from "./tenancy";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";

const T0 = new Date("2026-03-01T10:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

describe.skipIf(!databaseTestsEnabled())("the unified Inbox", () => {
  let database: TestDatabase;
  let context: BusinessProfileContext;
  let neighbour: BusinessProfileContext;
  let instagramAccountId: string;
  let whatsappAccountId: string;
  let userId: string;
  let seq = 0;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    const db = database.db;
    const owner = await db.user.create({ data: { name: "Inbox Owner", email: "inbox-owner@example.test" } });
    userId = owner.id;
    const { workspaceId } = await createWorkspaceWithOwner(db, { name: "Inbox Workspace", ownerUserId: userId });
    const workspace = await authorizeWorkspaceAccess(db, { userId, workspaceId });

    const main = await createBusinessProfile(db, workspace, { name: "Main" });
    context = await authorizeBusinessProfileAccess(db, { userId, workspaceId, businessProfileId: main.businessProfileId });
    const other = await createBusinessProfile(db, workspace, { name: "Neighbour" });
    neighbour = await authorizeBusinessProfileAccess(db, { userId, workspaceId, businessProfileId: other.businessProfileId });

    // Two channels in one profile: the list must be channel-neutral, which only a mixed fixture proves.
    instagramAccountId = (
      await createChannelAccount(db, context, { channel: "INSTAGRAM", externalAccountId: "ig-inbox", capabilities: { ...NO_CAPABILITIES, text: true } })
    ).id;
    whatsappAccountId = (
      await createChannelAccount(db, context, { channel: "WHATSAPP", externalAccountId: "wa-inbox", capabilities: { ...NO_CAPABILITIES, text: true } })
    ).id;
  }, 180_000);

  afterAll(async () => {
    await database?.dispose();
  });

  const db = () => database.db;

  /** A conversation with one inbound message, so it has a preview and a last-message time. */
  const conversation = async (options: {
    readonly ctx?: BusinessProfileContext;
    readonly channelAccountId?: string;
    readonly name: string;
    readonly handle?: string;
    readonly text?: string;
    readonly occurredAt: Date;
  }) => {
    seq += 1;
    const ctx = options.ctx ?? context;
    const accountId = options.channelAccountId ?? instagramAccountId;
    const identity = await createContactWithChannelIdentity(db(), ctx, {
      channelAccountId: accountId,
      externalUserId: options.handle ?? `user-${String(seq)}`,
      ...(options.handle === undefined ? {} : { username: options.handle }),
      displayName: options.name,
    });
    const created = await createConversation(db(), ctx, { channelAccountId: accountId, channelIdentityId: identity.channelIdentityId });
    await appendInboundMessage(db(), ctx, {
      conversationId: created.id,
      kind: "TEXT",
      text: options.text ?? `Message from ${options.name}`,
      occurredAt: options.occurredAt,
    });
    return created.id;
  };

  it("lists a profile's conversations, newest first, whatever channel they came from", async () => {
    const older = await conversation({ name: "Ada", occurredAt: at(1) });
    const newer = await conversation({ name: "Grace", channelAccountId: whatsappAccountId, occurredAt: at(2) });

    const page = await listInbox(db(), context);

    expect(page.rows.map((row) => row.id)).toEqual([newer, older]);
    expect(page.rows.map((row) => row.channel)).toEqual(["WHATSAPP", "INSTAGRAM"]);
    // The preview and the handle are what make the left pane readable.
    expect(page.rows[0]?.preview).toBe("Message from Grace");
    expect(page.rows[0]?.contactName).toBe("Grace");
  }, 180_000);

  it("never shows another Business Profile's conversations", async () => {
    await conversation({ ctx: neighbour, channelAccountId: await neighbourAccount(), name: "Someone Else", occurredAt: at(3) });

    const page = await listInbox(db(), context);

    expect(page.rows.map((row) => row.contactName)).not.toContain("Someone Else");
    expect((await listInbox(db(), neighbour)).rows.map((row) => row.contactName)).toEqual(["Someone Else"]);
  }, 180_000);

  const neighbourAccount = async () => {
    const existing = await db().channelAccount.findFirst({
      where: { workspaceId: neighbour.workspaceId, businessProfileId: neighbour.businessProfileId },
      select: { id: true },
    });
    if (existing !== null) {
      return existing.id;
    }
    return (
      await createChannelAccount(db(), neighbour, {
        channel: "INSTAGRAM",
        externalAccountId: "ig-neighbour",
        capabilities: { ...NO_CAPABILITIES, text: true },
      })
    ).id;
  };

  it("pages without repeating or skipping a row", async () => {
    // Five conversations, one per minute, paged two at a time.
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      ids.push(await conversation({ name: `Paged ${String(index)}`, occurredAt: at(100 + index) }));
    }
    const expected = [...ids].reverse();

    const seen: string[] = [];
    let cursor = undefined as Awaited<ReturnType<typeof listInbox>>["nextCursor"];
    for (let round = 0; round < 10; round += 1) {
      const page = await listInbox(db(), context, { search: "Paged" }, { limit: 2, ...(cursor === undefined ? {} : { cursor }) });
      seen.push(...page.rows.map((row) => row.id));
      cursor = page.nextCursor;
      if (cursor === undefined) {
        break;
      }
    }

    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(seen.length);
  }, 180_000);

  it("keeps the cursor honest when two conversations share a timestamp", async () => {
    // The case an offset query and a timestamp-only cursor both get wrong: identical `lastMessageAt`.
    //
    // Forced with an update rather than by passing one `occurredAt` twice. `appendInboundMessage` keeps
    // the *later* of the stored time and the message's, and a conversation is created at the real current
    // time — so a fixture that only set `occurredAt` produced two rows microseconds apart and quietly
    // tested nothing. Mutation testing is how that was found.
    const sameMoment = at(200);
    const first = await conversation({ name: "Tie A", occurredAt: sameMoment });
    const second = await conversation({ name: "Tie B", occurredAt: sameMoment });
    await db().conversation.updateMany({
      where: { workspaceId: context.workspaceId, businessProfileId: context.businessProfileId, id: { in: [first, second] } },
      data: { lastMessageAt: sameMoment },
    });

    const seen: string[] = [];
    let cursor = undefined as Awaited<ReturnType<typeof listInbox>>["nextCursor"];
    for (let round = 0; round < 5; round += 1) {
      const page = await listInbox(db(), context, { search: "Tie " }, { limit: 1, ...(cursor === undefined ? {} : { cursor }) });
      seen.push(...page.rows.map((row) => row.id));
      cursor = page.nextCursor;
      if (cursor === undefined) {
        break;
      }
    }

    expect(new Set(seen).size).toBe(2);
    expect(seen).toContain(first);
    expect(seen).toContain(second);
  }, 180_000);

  it("says when there is no next page, rather than offering one that loads nothing", async () => {
    const page = await listInbox(db(), context, { search: "Tie A" }, { limit: 10 });

    expect(page.rows).toHaveLength(1);
    expect(page.nextCursor).toBeUndefined();
  }, 180_000);

  it("filters by channel account", async () => {
    const page = await listInbox(db(), context, { channelAccountId: whatsappAccountId });

    expect(page.rows.length).toBeGreaterThan(0);
    expect(page.rows.every((row) => row.channel === "WHATSAPP")).toBe(true);
  }, 180_000);

  it("searches the contact and the username, and not the message text", async () => {
    await conversation({ name: "Findable Person", handle: "findable_handle", text: "a very distinctive sentence", occurredAt: at(300) });

    expect((await listInbox(db(), context, { search: "findable per" })).rows).toHaveLength(1);
    expect((await listInbox(db(), context, { search: "FINDABLE_HANDLE" })).rows).toHaveLength(1);
    // Message text is a different feature with different privacy and indexing consequences.
    expect((await listInbox(db(), context, { search: "very distinctive sentence" })).rows).toHaveLength(0);
  }, 180_000);

  it("finds the conversations waiting for a reply, and fills the page while doing it", async () => {
    // Twelve conversations where only every fourth is awaiting a reply: a post-query filter applied
    // naively would return three rows for a page of eight.
    const awaiting: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      const id = await conversation({ name: `Waiting ${String(index)}`, occurredAt: at(400 + index) });
      if (index % 4 === 0) {
        awaiting.push(id);
      } else {
        await db().conversation.update({
          where: { workspaceId_businessProfileId_id: { workspaceId: context.workspaceId, businessProfileId: context.businessProfileId, id } },
          data: { lastOutboundAt: at(500 + index) },
        });
      }
    }

    const page = await listInbox(db(), context, { awaitingReply: true, search: "Waiting" }, { limit: 3 });

    expect(page.rows).toHaveLength(3);
    expect(page.rows.every((row) => row.awaitingReply)).toBe(true);
    expect(page.rows.map((row) => row.id).every((id) => awaiting.includes(id))).toBe(true);
  }, 180_000);

  it("filters by what a person is doing with the conversation", async () => {
    const held = await conversation({ name: "Held By Someone", occurredAt: at(600) });
    await db().conversation.update({
      where: { workspaceId_businessProfileId_id: { workspaceId: context.workspaceId, businessProfileId: context.businessProfileId, id: held } },
      data: {
        takeoverState: "HUMAN_ACTIVE",
        takeoverReason: "HUMAN_SENT_FROM_INBOX",
        humanTakeoverAt: at(600),
        takeoverActorKind: "USER",
        takeoverActorUserId: userId,
      },
    });

    expect((await listInbox(db(), context, { takeover: "HUMAN_ACTIVE" })).rows.map((row) => row.id)).toEqual([held]);
    expect((await listInbox(db(), context, { takenOverByUserId: userId })).rows.map((row) => row.id)).toEqual([held]);
    expect((await listInbox(db(), context, { takeover: "REVIEW_REQUIRED" })).rows).toHaveLength(0);
  }, 180_000);

  it("filters by lead stage", async () => {
    const qualified = await conversation({ name: "Qualified Lead", occurredAt: at(700) });
    await db().conversation.update({
      where: { workspaceId_businessProfileId_id: { workspaceId: context.workspaceId, businessProfileId: context.businessProfileId, id: qualified } },
      data: { leadStage: "QUALIFIED" },
    });

    const page = await listInbox(db(), context, { leadStage: "QUALIFIED" });

    expect(page.rows.map((row) => row.id)).toEqual([qualified]);
  }, 180_000);

  it("combines filters rather than letting the last one win", async () => {
    const page = await listInbox(db(), context, { channelAccountId: whatsappAccountId, leadStage: "QUALIFIED" });

    // The qualified lead is on Instagram, so this pair must match nothing. A filter that overwrote its
    // predecessor would return the lead and look like it worked.
    expect(page.rows).toHaveLength(0);
  }, 180_000);

  it("clamps a page size below one", async () => {
    // Zero and negative are the values a caller reaches by arithmetic rather than intent, and a `take: 0`
    // would return an empty inbox that looks like an empty inbox.
    expect((await listInbox(db(), context, {}, { limit: 0 })).rows).toHaveLength(1);
    expect((await listInbox(db(), context, {}, { limit: -5 })).rows).toHaveLength(1);
  }, 180_000);

  it("refuses a page larger than the ceiling, however large a caller asks for", async () => {
    // 101 conversations behind one search term, so the ceiling is observable. A test that asked for
    // 10,000 against thirty rows proved nothing at all — the mutation that deleted the clamp survived it.
    // This doubles as the large-list fixture the contract asks for.
    const bulkAccountId = instagramAccountId;
    const contacts = Array.from({ length: 101 }, (_, index) => ({
      workspaceId: context.workspaceId,
      businessProfileId: context.businessProfileId,
      displayName: `Bulk ${String(index).padStart(3, "0")}`,
    }));
    await db().contact.createMany({ data: contacts });
    const created = await db().contact.findMany({
      where: { workspaceId: context.workspaceId, businessProfileId: context.businessProfileId, displayName: { startsWith: "Bulk " } },
      select: { id: true, displayName: true },
    });
    await db().channelIdentity.createMany({
      data: created.map((contact) => ({
        workspaceId: context.workspaceId,
        businessProfileId: context.businessProfileId,
        contactId: contact.id,
        channelAccountId: bulkAccountId,
        externalUserId: `bulk-${contact.id}`,
      })),
    });
    const identities = await db().channelIdentity.findMany({
      where: { workspaceId: context.workspaceId, businessProfileId: context.businessProfileId, externalUserId: { startsWith: "bulk-" } },
      select: { id: true, contactId: true },
    });
    await db().conversation.createMany({
      data: identities.map((identity, index) => ({
        workspaceId: context.workspaceId,
        businessProfileId: context.businessProfileId,
        channelAccountId: bulkAccountId,
        contactId: identity.contactId,
        channelIdentityId: identity.id,
        lastMessageAt: at(1000 + index),
      })),
    });

    const page = await listInbox(db(), context, { search: "Bulk " }, { limit: 10_000 });

    expect(page.rows).toHaveLength(100);
    // And it says there is more, rather than pretending a clamped page was the whole list.
    expect(page.nextCursor).toBeDefined();
  }, 180_000);
});
