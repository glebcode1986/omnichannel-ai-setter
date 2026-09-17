import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createChannelAccount, createContactWithIdentity } from "./index";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { createTestUser, seedWorkspace, type SeededWorkspace } from "./testing/fixtures";

const UNIQUE_VIOLATION = { code: "P2002" };
const FOREIGN_KEY_VIOLATION = { code: "P2003" };

describe.skipIf(!databaseTestsEnabled())("schema constraints (PostgreSQL)", () => {
  let database: TestDatabase;
  let a: SeededWorkspace;
  let b: SeededWorkspace;
  const db = () => database.db;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    a = await seedWorkspace(database.db, "a");
    b = await seedWorkspace(database.db, "b");
  }, 120_000);

  afterAll(async () => {
    await database?.dispose();
  });

  const expectCheckViolation = (attempt: Promise<unknown>, constraint: string) =>
    expect(attempt).rejects.toThrow(new RegExp(constraint));

  const newDraft = (seed: SeededWorkspace, overrides: { confidence?: number } = {}) =>
    db().aiDraft.create({
      data: {
        workspaceId: seed.context.workspaceId,
        conversationId: seed.conversationId,
        anchorMessageId: seed.messageId,
        text: "Thanks! Our studio opens at 9.",
        structuredOutput: {},
        confidence: overrides.confidence ?? 0.9,
        modelSuggestsSend: true,
        needsReview: false,
        modelProvider: "fake-provider",
        modelName: "fake-model",
        promptVersion: "prompt-v1",
        schemaVersion: "schema-v1",
      },
    });

  it("deduplicates inbound provider events per channel account", async () => {
    const event = (seed: SeededWorkspace) => ({
      workspaceId: seed.context.workspaceId,
      channelAccountId: seed.channelAccount.id,
      sourceEventId: "evt-duplicate",
      eventType: "INBOUND_MESSAGE" as const,
      occurredAt: new Date(),
    });

    await db().inboundEvent.create({ data: event(a) });
    await expect(db().inboundEvent.create({ data: event(a) })).rejects.toMatchObject(UNIQUE_VIOLATION);
    await expect(db().inboundEvent.create({ data: event(b) })).resolves.toBeDefined();
  });

  it("keeps platform message ids unique per channel account and external users mapped to one identity", async () => {
    const outbound = (channelMessageId?: string) =>
      db().message.create({
        data: {
          workspaceId: a.context.workspaceId,
          channelAccountId: a.channelAccount.id,
          conversationId: a.conversationId,
          channelMessageId,
          direction: "OUT",
          source: "HUMAN",
          kind: "TEXT",
          text: "Hi",
          transportPath: "STANDARD",
          occurredAt: new Date(),
        },
      });

    await expect(outbound("mid-a-1")).rejects.toMatchObject(UNIQUE_VIOLATION);
    await outbound();
    await outbound();

    await expect(
      createContactWithIdentity(db(), a.context, { channelAccountId: a.channelAccount.id, externalUserId: "ig-user-a" }),
    ).rejects.toMatchObject(UNIQUE_VIOLATION);
  });

  it("allows one delivery job and one outbound message per AI draft", async () => {
    const draft = await newDraft(a);
    const job = (operationId: string) =>
      db().deliveryJobRecord.create({
        data: {
          workspaceId: a.context.workspaceId,
          draftId: draft.id,
          operationId,
          correlationId: `corr-${operationId}`,
          scheduledFor: new Date(),
          selectedDelayMs: 45_000,
        },
      });
    const send = (operationId: string) =>
      db().message.create({
        data: {
          workspaceId: a.context.workspaceId,
          channelAccountId: a.channelAccount.id,
          conversationId: a.conversationId,
          direction: "OUT",
          source: "AI",
          kind: "TEXT",
          text: draft.text,
          transportPath: "STANDARD",
          aiDraftId: draft.id,
          operationId,
          occurredAt: new Date(),
        },
      });

    const first = await job("op-draft-1");
    await expect(job("op-draft-1-retry")).rejects.toMatchObject(UNIQUE_VIOLATION);
    await send("op-draft-1");
    await expect(send("op-draft-1-again")).rejects.toMatchObject(UNIQUE_VIOLATION);

    await expectCheckViolation(
      db().deliveryJobRecord.update({ where: { id: first.id }, data: { status: "SENT", sentAt: new Date() } }),
      "delivery_jobs_sent_check",
    );
    await expect(
      db().deliveryJobRecord.update({
        where: { id: first.id },
        data: { status: "SENT", sentAt: new Date(), platformMessageId: "mid-sent-1" },
      }),
    ).resolves.toMatchObject({ status: "SENT" });
  });

  it("rejects drafts, jobs and policies with out-of-range values", async () => {
    await expectCheckViolation(newDraft(a, { confidence: 1.5 }), "ai_drafts_confidence_check");

    const policy = { workspaceId: b.context.workspaceId, mandatoryReviewReasons: [] };
    await expectCheckViolation(
      db().automationPolicy.create({ data: { ...policy, debounceMinMs: 20_000, debounceMaxMs: 10_000 } }),
      "automation_policies_ranges_check",
    );
    await expectCheckViolation(
      db().automationPolicy.create({ data: { ...policy, confidenceThreshold: -0.1 } }),
      "automation_policies_ranges_check",
    );
    await expectCheckViolation(
      db().automationPolicy.create({ data: { ...policy, quietHoursTimeZone: "Europe/Berlin" } }),
      "automation_policies_quiet_hours_check",
    );
  });

  it("keeps one default automation policy per workspace plus at most one override per channel account", async () => {
    const policy = (channelAccountId?: string) =>
      db().automationPolicy.create({
        data: { workspaceId: a.context.workspaceId, channelAccountId, mandatoryReviewReasons: ["PAYMENT_DISPUTE"] },
      });

    await expect(policy()).resolves.toMatchObject({ mode: "OFF", instagramAfterWindowPolicy: "STANDARD_ONLY" });
    await expect(policy()).rejects.toMatchObject(UNIQUE_VIOLATION);
    await policy(a.channelAccount.id);
    await expect(policy(a.channelAccount.id)).rejects.toMatchObject(UNIQUE_VIOLATION);
    await expect(policy(b.channelAccount.id)).rejects.toMatchObject(FOREIGN_KEY_VIOLATION);
  });

  it("routes a live platform account to exactly one workspace", async () => {
    const connect = (seed: SeededWorkspace) =>
      createChannelAccount(db(), seed.context, {
        channel: "WHATSAPP",
        externalAccountId: "wa-phone-shared",
        capabilities: seed.channelAccount.capabilities as never,
      });

    const inA = await connect(a);
    await expect(connect(b)).rejects.toMatchObject(UNIQUE_VIOLATION);
    await db().channelAccount.update({ where: { id: inA.id }, data: { status: "DISCONNECTED" } });
    await expect(connect(b)).resolves.toMatchObject({ workspaceId: b.context.workspaceId });
  });

  it("enforces takeover-state and message-direction invariants", async () => {
    const takeover = (data: Parameters<TestDatabase["db"]["conversation"]["update"]>[0]["data"]) =>
      db().conversation.update({ where: { id: a.conversationId }, data });

    await expectCheckViolation(takeover({ takeoverReason: "HUMAN_CLAIMED" }), "conversations_takeover_state_check");
    await expectCheckViolation(
      takeover({ takeoverState: "HUMAN_ACTIVE", takeoverReason: "HUMAN_CLAIMED" }),
      "conversations_takeover_state_check",
    );
    await expectCheckViolation(
      takeover({ takeoverState: "REVIEW_REQUIRED", takeoverReason: "MANDATORY_REVIEW", humanTakeoverAt: new Date() }),
      "conversations_takeover_state_check",
    );
    await expectCheckViolation(
      takeover({
        takeoverState: "HUMAN_ACTIVE",
        takeoverReason: "HUMAN_CLAIMED",
        humanTakeoverAt: new Date(),
        takeoverActorKind: "USER",
      }),
      "conversations_takeover_actor_user_check",
    );
    await expect(
      takeover({
        takeoverState: "HUMAN_ACTIVE",
        takeoverReason: "HUMAN_CLAIMED",
        humanTakeoverAt: new Date(),
        takeoverActorKind: "USER",
        takeoverActorUserId: a.ownerUserId,
      }),
    ).resolves.toMatchObject({ takeoverState: "HUMAN_ACTIVE" });

    const message = (data: { direction: "IN" | "OUT"; source: "PARTICIPANT" | "AI" | "HUMAN"; transportPath?: "HUMAN_AGENT"; sentByUserId?: string }) =>
      db().message.create({
        data: {
          workspaceId: a.context.workspaceId,
          channelAccountId: a.channelAccount.id,
          conversationId: a.conversationId,
          kind: "TEXT",
          occurredAt: new Date(),
          ...data,
        },
      });

    await expectCheckViolation(message({ direction: "IN", source: "AI" }), "messages_direction_source_check");
    await expectCheckViolation(message({ direction: "OUT", source: "PARTICIPANT" }), "messages_direction_source_check");
    await expectCheckViolation(
      message({ direction: "OUT", source: "HUMAN", transportPath: "HUMAN_AGENT" }),
      "messages_human_agent_actor_check",
    );
    await expectCheckViolation(
      message({ direction: "OUT", source: "AI", transportPath: "HUMAN_AGENT", sentByUserId: a.ownerUserId }),
      "messages_human_agent_actor_check",
    );
    await expect(
      message({ direction: "OUT", source: "HUMAN", transportPath: "HUMAN_AGENT", sentByUserId: a.ownerUserId }),
    ).resolves.toMatchObject({ transportPath: "HUMAN_AGENT" });
  });

  it("preserves audit history instead of cascading deletes", async () => {
    await expect(db().conversation.delete({ where: { id: b.conversationId } })).rejects.toMatchObject(FOREIGN_KEY_VIOLATION);
    await expect(db().workspace.delete({ where: { id: b.context.workspaceId } })).rejects.toMatchObject(FOREIGN_KEY_VIOLATION);
    await expect(db().user.delete({ where: { id: b.ownerUserId } })).rejects.toMatchObject(FOREIGN_KEY_VIOLATION);
    expect(await db().message.count({ where: { conversationId: b.conversationId } })).toBe(1);

    // Auth.js login plumbing (sessions, linked accounts) is the only data removed with its user.
    const userId = await createTestUser(db(), "login-only");
    await db().session.create({ data: { sessionToken: "fake-session-token", userId, expires: new Date(Date.now() + 60_000) } });
    await db().account.create({ data: { userId, type: "oidc", provider: "fake", providerAccountId: "fake-1" } });
    await db().user.delete({ where: { id: userId } });
    expect(await db().session.count({ where: { userId } })).toBe(0);
    expect(await db().account.count({ where: { userId } })).toBe(0);
  });

  it("creates the indexes that inbox, ingestion and delivery queries rely on, and only cascades login data", async () => {
    const indexes = await db().$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`;
    expect(indexes.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        "conversations_workspace_id_status_last_message_at_idx",
        "conversations_channel_account_id_last_inbound_at_idx",
        "conversations_contact_identity_key",
        "contact_identities_external_user_key",
        "inbound_events_source_event_key",
        "messages_channel_message_key",
        "messages_conversation_id_occurred_at_idx",
        "messages_workspace_id_ai_draft_id_key",
        "delivery_jobs_workspace_id_draft_id_key",
        "delivery_jobs_status_scheduled_for_idx",
        "channel_accounts_live_external_account_key",
        "automation_policies_workspace_default_key",
      ]),
    );

    const rules = await db().$queryRaw<{ constraint_name: string; delete_rule: string; update_rule: string }[]>`
      SELECT constraint_name, delete_rule, update_rule
      FROM information_schema.referential_constraints
      WHERE constraint_schema = 'public'
      ORDER BY constraint_name`;
    expect(rules.filter((rule) => rule.delete_rule === "CASCADE").map((rule) => rule.constraint_name)).toEqual([
      "auth_accounts_user_id_fkey",
      "auth_sessions_user_id_fkey",
    ]);
    expect(rules.filter((rule) => rule.delete_rule !== "CASCADE").every((rule) => rule.delete_rule === "RESTRICT")).toBe(true);
    expect(rules.every((rule) => rule.update_rule === "RESTRICT")).toBe(true);
  });
});
