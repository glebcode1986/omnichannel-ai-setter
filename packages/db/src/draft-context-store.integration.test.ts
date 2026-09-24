import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDraftContextStore, type DraftContextStore } from "./draft-context-store";
import { appendInboundMessage } from "./repositories/messages";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { seedWorkspace, type SeededProfile } from "./testing/fixtures";

describe.skipIf(!databaseTestsEnabled())("draft context store (PostgreSQL)", () => {
  let database: TestDatabase;
  let profile: SeededProfile;
  let other: SeededProfile;
  let store: DraftContextStore;
  const db = () => database.db;
  let sequence = 0;
  const unique = (prefix: string) => `${prefix}-${++sequence}`;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    [profile] = (await seedWorkspace(database.db, "draft-ctx")).profiles as [SeededProfile];
    [other] = (await seedWorkspace(database.db, "draft-ctx-other")).profiles as [SeededProfile];
    store = createDraftContextStore(database.db);
  }, 120_000);

  afterAll(async () => {
    await database?.dispose();
  });

  const query = (overrides: Partial<Parameters<DraftContextStore["load"]>[0]> = {}) => ({
    workspaceId: profile.context.workspaceId,
    businessProfileId: profile.businessProfileId,
    conversationId: profile.conversationId,
    anchorMessageId: profile.messageId,
    ...overrides,
  });

  it("loads the conversation state and the customer burst the draft answers", async () => {
    const context = await store.load(query());

    expect(context?.snapshot).toMatchObject({
      conversationId: profile.conversationId,
      status: "OPEN",
      aiEnabled: true,
      takeoverState: "NONE",
      // No automation policy row exists for this profile, so automation is off until someone opts in.
      mode: "OFF",
      anchorSuperseded: false,
    });
    expect(context?.inbound.map((segment) => segment.provenance)).toEqual([profile.messageId]);
    expect(context?.history).toEqual([]);
  });

  it("reports an anchor the customer has already overtaken", async () => {
    const newer = await appendInboundMessage(db(), profile.context, {
      conversationId: profile.conversationId,
      channelMessageId: unique("mid"),
      kind: "TEXT",
      text: "Actually, never mind.",
      occurredAt: new Date("2026-09-18T11:00:00.000Z"),
    });

    // Drafting against the older anchor would answer a question the customer has moved on from.
    expect((await store.load(query()))?.snapshot.anchorSuperseded).toBe(true);
    expect((await store.load(query({ anchorMessageId: newer.id })))?.snapshot.anchorSuperseded).toBe(false);
    await db().message.delete({ where: { id: newer.id } });
  });

  it("separates earlier turns from the burst being answered", async () => {
    const second = await appendInboundMessage(db(), profile.context, {
      conversationId: profile.conversationId,
      channelMessageId: unique("mid"),
      kind: "TEXT",
      text: "And are you open on Sunday?",
      occurredAt: new Date("2026-09-18T09:00:00.000Z"),
    });
    await db().message.create({
      data: {
        workspaceId: profile.context.workspaceId,
        businessProfileId: profile.businessProfileId,
        channelAccountId: profile.channelAccount.id,
        conversationId: profile.conversationId,
        channelMessageId: unique("mid-out"),
        direction: "OUT",
        source: "HUMAN",
        kind: "TEXT",
        text: "Checking for you.",
        occurredAt: new Date("2026-09-18T08:30:00.000Z"),
      },
    });

    const context = await store.load(query({ anchorMessageId: second.id }));

    // The reply answers the trailing run of customer messages; everything before it is context.
    expect(context?.inbound.map((segment) => segment.text)).toEqual(["And are you open on Sunday?"]);
    expect(context?.history.at(-1)).toMatchObject({ kind: "OUTBOUND", text: "Checking for you." });
    expect(context?.history.some((segment) => segment.provenance === profile.messageId)).toBe(true);
  });

  it("prefers a conversation override, then a channel policy, then the profile default", async () => {
    await db().automationPolicy.create({
      data: {
        workspaceId: profile.context.workspaceId,
        businessProfileId: profile.businessProfileId,
        mode: "DRAFT",
        mandatoryReviewReasons: [],
      },
    });
    expect((await store.load(query()))?.snapshot.mode).toBe("DRAFT");

    await db().automationPolicy.create({
      data: {
        workspaceId: profile.context.workspaceId,
        businessProfileId: profile.businessProfileId,
        channelAccountId: profile.channelAccount.id,
        mode: "AUTOPILOT",
        mandatoryReviewReasons: [],
      },
    });
    expect((await store.load(query()))?.snapshot.mode).toBe("AUTOPILOT");

    await db().conversation.update({ where: { id: profile.conversationId }, data: { modeOverride: "OFF" } });
    // The conversation's own override wins over both policies.
    expect((await store.load(query()))?.snapshot.mode).toBe("OFF");
    await db().conversation.update({ where: { id: profile.conversationId }, data: { modeOverride: null } });
  });

  it("refuses a conversation or anchor from another tenant, or one that does not exist", async () => {
    expect(await store.load(query({ conversationId: other.conversationId }))).toBeUndefined();
    expect(await store.load(query({ anchorMessageId: other.messageId }))).toBeUndefined();
    expect(await store.load(query({ workspaceId: other.context.workspaceId }))).toBeUndefined();
    expect(await store.load(query({ conversationId: "00000000-0000-7000-8000-000000000000" }))).toBeUndefined();
  });

  it("labels a message with no text instead of dropping the turn", async () => {
    const media = await db().message.create({
      data: {
        workspaceId: profile.context.workspaceId,
        businessProfileId: profile.businessProfileId,
        channelAccountId: profile.channelAccount.id,
        conversationId: profile.conversationId,
        channelMessageId: unique("mid-media"),
        direction: "IN",
        source: "PARTICIPANT",
        kind: "IMAGE",
        occurredAt: new Date("2026-09-18T09:30:00.000Z"),
      },
    });

    const context = await store.load(query({ anchorMessageId: media.id }));

    expect(context?.inbound.at(-1)).toMatchObject({ provenance: media.id, text: "[image with no text]" });
  });
});
