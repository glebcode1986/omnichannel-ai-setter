/**
 * Reading the unified Inbox (Issue #28).
 *
 * The cases worth writing are the ones a list view gets wrong silently: a cursor that repeats or skips a
 * row when two conversations share a timestamp, a filter that reaches into the next Business Profile, and
 * a page that comes back short because a filter was applied after paging.
 */
import { NO_CAPABILITIES } from "@omnichannel/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { composeHumanReply } from "./composer-store";
import { listInbox, readConversation } from "./inbox-store";
import { appendInboundMessage } from "./repositories/messages";
import { createChannelAccount } from "./repositories/channel-accounts";
import { createContactWithChannelIdentity } from "./repositories/contacts";
import { createConversation } from "./repositories/conversations";
import { createBusinessProfile } from "./repositories/workspaces";
import { authorizeBusinessProfileAccess, authorizeWorkspaceAccess, type BusinessProfileContext } from "./tenancy";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { createPaidWorkspace } from "./testing/fixtures";

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
    const { workspaceId } = await createPaidWorkspace(db, { name: "Inbox Workspace", ownerUserId: userId });
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
  const profileScope = () => ({ workspaceId: context.workspaceId, businessProfileId: context.businessProfileId });

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
    // `lastMessageAt` defaults to now() and `latest()` only moves it forward, so a backdated message
    // leaves it at creation time. Without this the fixture's timestamps are decoration and every
    // ordering assertion below would hold just as well for a store that ordered by creation.
    await db().conversation.update({
      where: { id: created.id },
      data: { lastMessageAt: options.occurredAt, lastInboundAt: options.occurredAt },
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

  /** A draft plus a delivery in the given state, which is what "waiting to be sent" looks like. */
  const pendingDelivery = async (conversationId: string, status: "SCHEDULED" | "SENDING", scheduledFor: Date) => {
    seq += 1;
    const draft = await db().aiDraft.create({
      data: {
        ...profileScope(),
        conversationId,
        anchorMessageId: (await db().message.findFirstOrThrow({ where: { conversationId }, select: { id: true } })).id,
        anchorStateVersion: 1,
        generationKey: `pending_${String(seq)}`,
        text: "Queued reply",
        // A usable draft carries both the text and the structured output the CHECK insists on: a reply
        // with no record of what the model actually returned cannot be audited afterwards.
        structuredOutput: { reply: "Queued reply" },
        confidence: 0.9,
        modelSuggestsSend: true,
        needsReview: false,
        status: "SCHEDULED",
        modelProvider: "anthropic",
        modelName: "claude-opus-5",
        promptVersion: "reply.v1",
        schemaVersion: "ai-draft.v1",
      },
      select: { id: true },
    });
    const operationId = `op-pending-${String(seq)}`;
    await db().deliveryJobRecord.create({
      data: {
        ...profileScope(),
        draftId: draft.id,
        operationId,
        correlationId: operationId,
        status,
        scheduledFor,
        selectedDelayMs: 60_000,
        ...(status === "SENDING" ? { claimedAt: scheduledFor } : {}),
      },
    });
    return operationId;
  };

  /**
   * The other legal origin (ADR-018 Option B): a reply a person wrote, with no draft anywhere.
   *
   * Written through `composeHumanReply` rather than by hand, because the CHECKs on `delivery_jobs` are
   * what make this origin legal and a hand-built row could satisfy the test while being impossible.
   */
  const composedDelivery = async (conversationId: string): Promise<string> => {
    seq += 1;
    const outcome = await composeHumanReply(db(), context, {
      conversationId,
      text: `A person's own reply (${String(seq)})`,
      reviewMode: "NORMAL",
      at: at(1900),
    });
    if (outcome.status !== "SCHEDULED") {
      throw new Error(`the fixture expected a queued reply, got ${outcome.status}`);
    }
    return outcome.operationId;
  };

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

  /**
   * The behaviour the whole list order exists for.
   *
   * An inbox is sorted by "when did this last move", which is not "when was it created". Every other
   * ordering test here creates conversations in the same order their timestamps run, so all of them would
   * pass just as well against a store that sorted by creation. This one cannot: the older conversation is
   * the one that has to come first.
   */
  it("moves a conversation to the top when a new message arrives in it", async () => {
    const stale = await conversation({ name: "Older Thread", occurredAt: at(310) });
    const fresh = await conversation({ name: "Newer Thread", occurredAt: at(311) });

    await appendInboundMessage(db(), context, { conversationId: stale, kind: "TEXT", text: "still here?", occurredAt: at(312) });

    const page = await listInbox(db(), context, { search: "Thread" });

    expect(page.rows.map((row) => row.id)).toEqual([stale, fresh]);
    expect(page.rows[0]?.preview).toBe("still here?");
  }, 180_000);

  it("matches the username and the platform id separately, not one standing in for the other", async () => {
    // The fixture usually sets both from the same value, which would let one `OR` branch cover for a
    // missing other. Here they differ, so each branch has to be present on its own.
    const identity = await createContactWithChannelIdentity(db(), context, {
      channelAccountId: instagramAccountId,
      externalUserId: "platform-id-9911",
      username: "public_nickname",
      displayName: "Distinct Fields",
    });
    const created = await createConversation(db(), context, { channelAccountId: instagramAccountId, channelIdentityId: identity.channelIdentityId });

    expect((await listInbox(db(), context, { search: "public_nick" })).rows.map((row) => row.id)).toEqual([created.id]);
    expect((await listInbox(db(), context, { search: "platform-id-9911" })).rows.map((row) => row.id)).toEqual([created.id]);
    expect((await listInbox(db(), context, { search: "Distinct Fie" })).rows.map((row) => row.id)).toEqual([created.id]);
  }, 180_000);

  it("offers no next page when the rows end exactly on the page boundary", async () => {
    // Off by one here is invisible until someone clicks "load older" and gets an empty list: the page is
    // full, so "is there more" cannot be inferred from its size alone.
    for (let index = 0; index < 4; index += 1) {
      await conversation({ name: `Boundary ${String(index)}`, occurredAt: at(320 + index) });
    }

    const first = await listInbox(db(), context, { search: "Boundary" }, { limit: 2 });
    expect(first.rows).toHaveLength(2);
    expect(first.nextCursor).toBeDefined();

    const second = await listInbox(db(), context, { search: "Boundary" }, { limit: 2, cursor: first.nextCursor });
    expect(second.rows).toHaveLength(2);
    expect(second.nextCursor).toBeUndefined();
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

  /**
   * The refill's own boundary, which is where a page can lose a conversation outright.
   *
   * When a post-query filter thins a batch, a later round can fill the page part-way through its window.
   * The rows after that point are real conversations that nobody has looked at yet — so a cursor has to
   * be offered even though this round's batch was not itself over-full. Deciding it from the batch size
   * alone drops everything behind the fill point, silently and permanently.
   *
   * Six conversations, the newest two already answered, and a page of three: the first page fills on the
   * second row of its second batch, and the sixth conversation is only ever reachable through the cursor
   * that fill produces.
   */
  it("keeps offering a cursor when a refilled page stopped mid-batch", async () => {
    const ids: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      ids.push(await conversation({ name: `Refill ${String(index)}`, occurredAt: at(700 + index) }));
    }
    const newestFirst = [...ids].reverse();
    // The two newest have been answered; the remaining four are still waiting on us.
    for (const answered of newestFirst.slice(0, 2)) {
      await db().conversation.update({ where: { id: answered }, data: { lastOutboundAt: at(800) } });
    }

    const first = await listInbox(db(), context, { search: "Refill", awaitingReply: true }, { limit: 3 });
    expect(first.rows.map((row) => row.id)).toEqual(newestFirst.slice(2, 5));
    expect(first.nextCursor, "the sixth conversation is only reachable through this cursor").toBeDefined();

    const second = await listInbox(db(), context, { search: "Refill", awaitingReply: true }, { limit: 3, cursor: first.nextCursor });
    expect(second.rows.map((row) => row.id)).toEqual([newestFirst[5]]);
    expect(second.nextCursor).toBeUndefined();
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

  /**
   * The mode the Inbox is allowed to show.
   *
   * Three cases, because the precedence only means something when they disagree: a conversation with no
   * override inherits the account's policy, an override beats that policy, and nothing written anywhere
   * is `OFF`. The middle one is the operator's own switch — someone turning automation off for one
   * customer — and an Inbox that displayed the policy instead would report a reply as automatic when it
   * was not going to be sent at all.
   */
  it("reports the mode in force, whichever level wrote it", async () => {
    const inherits = await conversation({ name: "Mode Inherits", occurredAt: at(600) });
    const overrides = await conversation({ name: "Mode Overrides", occurredAt: at(601) });
    const unpoliced = await conversation({ name: "Mode Unpoliced", channelAccountId: whatsappAccountId, occurredAt: at(602) });

    await db().automationPolicy.create({
      data: {
        workspaceId: context.workspaceId,
        businessProfileId: context.businessProfileId,
        channelAccountId: instagramAccountId,
        mode: "AUTOPILOT",
      },
    });
    await db().conversation.update({ where: { id: overrides }, data: { modeOverride: "OFF" } });

    const rows = new Map((await listInbox(db(), context, { search: "Mode " })).rows.map((row) => [row.id, row]));

    expect(rows.get(inherits)?.effectiveMode, "no override, so the account's policy is in force").toBe("AUTOPILOT");
    expect(rows.get(overrides)?.effectiveMode, "the conversation's own OFF beats the account's AUTOPILOT").toBe("OFF");
    expect(rows.get(unpoliced)?.effectiveMode, "no policy for this account and no profile default").toBe("OFF");
    // The override is still reported as itself, so the panel can say where the mode came from.
    expect(rows.get(inherits)?.modeOverride).toBeNull();
    expect(rows.get(overrides)?.modeOverride).toBe("OFF");

    // And the detail read has to agree with the list, including for the conversation that inherits —
    // the case where reading the override alone would answer OFF while automation was on AUTOPILOT.
    expect((await readConversation(db(), context, overrides))?.effectiveMode).toBe("OFF");
    const inherited = await readConversation(db(), context, inherits);
    expect(inherited?.effectiveMode).toBe("AUTOPILOT");
    expect(inherited?.modeOverride).toBeNull();
    expect((await readConversation(db(), context, unpoliced))?.effectiveMode).toBe("OFF");
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

  describe("one conversation in detail", () => {
    it("returns nothing for a conversation belonging to another profile", async () => {
      const theirs = await conversation({ ctx: neighbour, channelAccountId: await neighbourAccount(), name: "Not Yours", occurredAt: at(800) });

      // `undefined` rather than a thrown tenancy error: the page renders "not found", and a stack trace
      // would tell someone guessing URLs that the row exists.
      expect(await readConversation(db(), context, theirs)).toBeUndefined();
      expect(await readConversation(db(), neighbour, theirs)).toBeDefined();
    }, 180_000);

    it("returns nothing for an id that is not a conversation at all", async () => {
      expect(await readConversation(db(), context, "not-an-id")).toBeUndefined();
    }, 180_000);

    it("reads the thread oldest first, whatever order the query took", async () => {
      const id = await conversation({ name: "Threaded", occurredAt: at(900) });
      await appendInboundMessage(db(), context, { conversationId: id, kind: "TEXT", text: "second", occurredAt: at(902) });
      await appendInboundMessage(db(), context, { conversationId: id, kind: "TEXT", text: "third", occurredAt: at(903) });

      const detail = await readConversation(db(), context, id);

      expect(detail?.messages.map((message) => message.text)).toEqual(["Message from Threaded", "second", "third"]);
    }, 180_000);

    it("keeps the latest window of a long thread, not the first page of it", async () => {
      const id = await conversation({ name: "Long", occurredAt: at(1200) });
      for (let index = 0; index < 5; index += 1) {
        await appendInboundMessage(db(), context, {
          conversationId: id,
          kind: "TEXT",
          text: `turn ${String(index)}`,
          occurredAt: at(1201 + index),
        });
      }

      const detail = await readConversation(db(), context, id, { messageLimit: 2 });

      // A conversation opens where the work is. Showing the oldest two messages of a long thread would
      // be showing the least useful part of it.
      expect(detail?.messages.map((message) => message.text)).toEqual(["turn 3", "turn 4"]);
    }, 180_000);

    it("carries the source of every message, so the thread can tell them apart", async () => {
      const id = await conversation({ name: "Sourced", occurredAt: at(1300) });
      await db().message.create({
        data: {
          workspaceId: context.workspaceId,
          businessProfileId: context.businessProfileId,
          channelAccountId: instagramAccountId,
          conversationId: id,
          direction: "OUT",
          source: "AI",
          kind: "TEXT",
          text: "an assistant reply",
          occurredAt: at(1301),
          deliveryStatus: "SENT",
          transportPath: "STANDARD",
        },
      });

      const detail = await readConversation(db(), context, id);

      expect(detail?.messages.map((message) => message.source)).toEqual(["PARTICIPANT", "AI"]);
      expect(detail?.messages.at(-1)?.transportPath).toBe("STANDARD");
    }, 180_000);

    it("surfaces the latest AI decision with its reasons and its sources", async () => {
      const id = await conversation({ name: "Decided", occurredAt: at(1400) });
      const anchor = await db().message.findFirstOrThrow({
        where: { workspaceId: context.workspaceId, businessProfileId: context.businessProfileId, conversationId: id },
        select: { id: true },
      });
      await db().aiDraft.create({
        data: {
          workspaceId: context.workspaceId,
          businessProfileId: context.businessProfileId,
          conversationId: id,
          generationKey: "detail_1",
          trigger: "AUTOMATIC",
          anchorMessageId: anchor.id,
          anchorStateVersion: 1,
          text: "We open at 10.",
          structuredOutput: { reply: "We open at 10." },
          confidence: 0.42,
          modelSuggestsSend: false,
          needsReview: true,
          reasonCodes: ["LOW_CONFIDENCE", "MISSING_FACT"],
          factualSourceIds: ["chunk_hours"],
          retrieval: {},
          status: "PENDING",
          modelProvider: "fixture",
          modelName: "detail",
          promptVersion: "reply.v1",
          schemaVersion: "ai-draft.v1",
          intent: "HOURS",
        },
      });

      const detail = await readConversation(db(), context, id);

      // Why a reply was held is the difference between an operator trusting the assistant and guessing.
      expect(detail?.latestDraft?.reasonCodes).toEqual(["LOW_CONFIDENCE", "MISSING_FACT"]);
      expect(detail?.latestDraft?.citedSourceIds).toEqual(["chunk_hours"]);
      expect(detail?.latestDraft?.needsReview).toBe(true);
      expect(detail?.latestDraft?.confidence).toBeCloseTo(0.42);
      expect(detail?.latestDraft?.intent).toBe("HOURS");
    }, 180_000);

    /**
     * What is about to be sent, and whether it can still be stopped (Issue #29).
     *
     * `claimed` is the whole point. A delivery the worker has taken may be at the provider already, so the
     * UI must not offer to cancel it — and reporting it as cancellable would imply the customer did not
     * receive something they may well have.
     */
    it("reports the replies queued behind their delay, and which are past stopping", async () => {
      const id = await conversation({ name: "Has Pending", occurredAt: at(1600) });
      const queued = await pendingDelivery(id, "SCHEDULED", at(1610));
      const inFlight = await pendingDelivery(id, "SENDING", at(1605));

      const detail = await readConversation(db(), context, id);
      const sends = new Map((detail?.pendingSends ?? []).map((send) => [send.operationId, send]));

      expect(sends.get(queued)?.claimed).toBe(false);
      expect(sends.get(inFlight)?.claimed).toBe(true);
      expect(sends.get(queued)?.scheduledFor.toISOString()).toBe(at(1610).toISOString());
      expect(sends.get(queued)?.text).toBe("Queued reply");
    }, 180_000);

    it("reports a reply the person wrote themselves, which has no draft to be found through", async () => {
      // The blocking finding on PR #76. This query reached the conversation through
      // `draft.conversationId`, so a human-composed delivery was invisible here — and a queued send the
      // operator cannot see is a send they cannot stop, which is exactly what Issue #29 asks this pane
      // to offer.
      const id = await conversation({ name: "Human Composed", occurredAt: at(1900) });
      const operationId = await composedDelivery(id);

      const detail = await readConversation(db(), context, id);
      const send = (detail?.pendingSends ?? []).find((pending) => pending.operationId === operationId);

      expect(send).toBeDefined();
      expect(send?.draftId).toBeNull();
      expect(send?.text).toContain("A person's own reply");
      expect(send?.claimed).toBe(false);
      expect(send?.authority).toBe("HUMAN_APPROVED");
    }, 180_000);

    it("reports both origins together, in one pane", async () => {
      // One conversation can hold a queued AI reply and then a person's own; the pane shows the words,
      // not which table they came from.
      const id = await conversation({ name: "Both Origins", occurredAt: at(1910) });
      const fromModel = await pendingDelivery(id, "SCHEDULED", at(1911));
      const fromPerson = await composedDelivery(id);

      const sends = new Map(((await readConversation(db(), context, id))?.pendingSends ?? []).map((send) => [send.operationId, send]));

      expect(sends.get(fromModel)?.text).toBe("Queued reply");
      expect(sends.get(fromPerson)?.text).toContain("A person's own reply");
    }, 180_000);

    it("does not leak a human-composed reply into another profile's pane", async () => {
      // The direct column is matched now, so the scope filter is the only thing keeping tenants apart
      // here. It has to be enough on its own.
      const id = await conversation({ name: "Composed Isolated", occurredAt: at(1920) });
      await composedDelivery(id);

      expect(await readConversation(db(), neighbour, id)).toBeUndefined();
    }, 180_000);

    it("reports nothing pending for a conversation with nothing queued", async () => {
      const id = await conversation({ name: "Nothing Pending", occurredAt: at(1700) });

      expect((await readConversation(db(), context, id))?.pendingSends).toEqual([]);
    }, 180_000);

    it("does not report a settled delivery as pending", async () => {
      const id = await conversation({ name: "Settled Delivery", occurredAt: at(1800) });
      const operationId = await pendingDelivery(id, "SCHEDULED", at(1810));
      await db().deliveryJobRecord.update({ where: { operationId }, data: { status: "CANCELLED_POLICY", cancelledAt: at(1811) } });

      // A cancelled or sent reply is not waiting to go out, and offering to stop one would be nonsense.
      expect((await readConversation(db(), context, id))?.pendingSends).toEqual([]);
    }, 180_000);

    it("names the person holding the conversation", async () => {
      const id = await conversation({ name: "Held", occurredAt: at(1500) });
      await db().conversation.update({
        where: { workspaceId_businessProfileId_id: { workspaceId: context.workspaceId, businessProfileId: context.businessProfileId, id } },
        data: {
          takeoverState: "HUMAN_ACTIVE",
          takeoverReason: "HUMAN_SENT_FROM_INBOX",
          humanTakeoverAt: at(1500),
          takeoverActorKind: "USER",
          takeoverActorUserId: userId,
        },
      });

      const detail = await readConversation(db(), context, id);

      expect(detail?.takeoverState).toBe("HUMAN_ACTIVE");
      expect(detail?.takeoverByName).toBe("Inbox Owner");
    }, 180_000);
  });
});
