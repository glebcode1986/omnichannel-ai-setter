import { NO_CAPABILITIES } from "@omnichannel/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { authorizeBusinessProfileAccess, createBusinessProfile, createChannelAccount, createContactWithChannelIdentity } from "./index";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { createTestUser, seedWorkspace, type SeededProfile, type SeededWorkspace } from "./testing/fixtures";

const UNIQUE_VIOLATION = { code: "P2002" };
const FOREIGN_KEY_VIOLATION = { code: "P2003" };

describe.skipIf(!databaseTestsEnabled())("schema constraints (PostgreSQL)", () => {
  let database: TestDatabase;
  let a: SeededWorkspace;
  let b: SeededWorkspace;
  /** Workspace A, Business Profiles p1 and p2. */
  let a1: SeededProfile;
  let a2: SeededProfile;
  /** Workspace B, Business Profile p1. */
  let b1: SeededProfile;
  let sequence = 0;
  const db = () => database.db;
  const unique = (prefix: string) => `${prefix}-${++sequence}`;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    a = await seedWorkspace(database.db, "a", ["p1", "p2"]);
    b = await seedWorkspace(database.db, "b", ["p1"]);
    [a1, a2] = a.profiles as [SeededProfile, SeededProfile];
    [b1] = b.profiles as [SeededProfile];
  }, 120_000);

  afterAll(async () => {
    await database?.dispose();
  });

  const expectCheckViolation = (attempt: Promise<unknown>, constraint: string) => expect(attempt).rejects.toThrow(new RegExp(constraint));

  const scope = (profile: SeededProfile) => ({ workspaceId: profile.context.workspaceId, businessProfileId: profile.businessProfileId });

  const newDraft = (profile: SeededProfile, overrides: { confidence?: number; anchorStateVersion?: number } = {}) =>
    db().aiDraft.create({
      data: {
        ...scope(profile),
        conversationId: profile.conversationId,
        anchorMessageId: profile.messageId,
        anchorStateVersion: overrides.anchorStateVersion ?? 1,
        generationKey: unique("gen"),
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
    const event = (profile: SeededProfile) => ({
      ...scope(profile),
      channelAccountId: profile.channelAccount.id,
      sourceEventId: "evt-duplicate",
      eventType: "INBOUND_MESSAGE" as const,
      occurredAt: new Date(),
    });

    await db().inboundEvent.create({ data: event(a1) });
    await expect(db().inboundEvent.create({ data: event(a1) })).rejects.toMatchObject(UNIQUE_VIOLATION);
    await expect(db().inboundEvent.create({ data: event(a2) })).resolves.toBeDefined();
    await expect(db().inboundEvent.create({ data: event(b1) })).resolves.toBeDefined();
  });

  it("keeps platform message IDs unique per channel account and provider users mapped to one identity per account", async () => {
    const outbound = (channelMessageId?: string) =>
      db().message.create({
        data: {
          ...scope(a1),
          channelAccountId: a1.channelAccount.id,
          conversationId: a1.conversationId,
          channelMessageId,
          direction: "OUT",
          source: "HUMAN",
          kind: "TEXT",
          text: "Hi",
          transportPath: "STANDARD",
          occurredAt: new Date(),
        },
      });

    await expect(outbound("mid-a-p1-1")).rejects.toMatchObject(UNIQUE_VIOLATION);
    await outbound();
    await outbound();

    // Platform message IDs are unique per channel account, not globally: other profiles and Workspaces may reuse them.
    for (const profile of [a2, b1]) {
      await expect(
        db().message.create({
          data: {
            ...scope(profile),
            channelAccountId: profile.channelAccount.id,
            conversationId: profile.conversationId,
            channelMessageId: "mid-a-p1-1",
            direction: "IN",
            source: "PARTICIPANT",
            kind: "TEXT",
            occurredAt: new Date(),
          },
        }),
      ).resolves.toBeDefined();
    }

    await expect(
      createContactWithChannelIdentity(db(), a1.context, { channelAccountId: a1.channelAccount.id, externalUserId: "ig-user-a" }),
    ).rejects.toMatchObject(UNIQUE_VIOLATION);
  });

  it("allows one delivery job and one outbound message per AI draft", async () => {
    const draft = await newDraft(a1);
    const job = (operationId: string) =>
      db().deliveryJobRecord.create({
        data: {
          ...scope(a1),
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
          ...scope(a1),
          channelAccountId: a1.channelAccount.id,
          conversationId: a1.conversationId,
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

    // One logical operation is one job and one outbound message, even without a draft link.
    const secondDraft = await newDraft(a1);
    await expect(
      db().deliveryJobRecord.create({
        data: { ...scope(a1), draftId: secondDraft.id, operationId: "op-draft-1", correlationId: "c", scheduledFor: new Date(), selectedDelayMs: 0 },
      }),
    ).rejects.toMatchObject(UNIQUE_VIOLATION);
    await expect(
      db().message.create({
        data: {
          ...scope(a1),
          channelAccountId: a1.channelAccount.id,
          conversationId: a1.conversationId,
          direction: "OUT",
          source: "HUMAN",
          kind: "TEXT",
          transportPath: "STANDARD",
          operationId: "op-draft-1",
          occurredAt: new Date(),
        },
      }),
    ).rejects.toMatchObject(UNIQUE_VIOLATION);

    await expectCheckViolation(
      db().deliveryJobRecord.update({ where: { id: first.id }, data: { status: "SENT", sentAt: new Date() } }),
      "delivery_jobs_sent_check",
    );
    await expect(
      db().deliveryJobRecord.update({ where: { id: first.id }, data: { status: "SENT", sentAt: new Date(), platformMessageId: "mid-sent-1" } }),
    ).resolves.toMatchObject({ status: "SENT" });
  });

  it("rejects drafts, conversations and policies with out-of-range values", async () => {
    await expectCheckViolation(newDraft(a1, { confidence: 1.5 }), "ai_drafts_confidence_check");
    await expectCheckViolation(newDraft(a1, { anchorStateVersion: -1 }), "ai_drafts_anchor_state_version_check");
    await expectCheckViolation(
      db().conversation.update({ where: { id: a2.conversationId }, data: { stateVersion: -1 } }),
      "conversations_state_version_check",
    );

    const policy = { ...scope(b1), mandatoryReviewReasons: [] };
    await expectCheckViolation(
      db().automationPolicy.create({ data: { ...policy, debounceMinMs: 20_000, debounceMaxMs: 10_000 } }),
      "automation_policies_ranges_check",
    );
    await expectCheckViolation(db().automationPolicy.create({ data: { ...policy, confidenceThreshold: -0.1 } }), "automation_policies_ranges_check");
    await expectCheckViolation(
      db().automationPolicy.create({ data: { ...policy, quietHoursTimeZone: "Europe/Berlin" } }),
      "automation_policies_quiet_hours_check",
    );
  });

  it("keeps OWNER on ALL Business Profile scope", async () => {
    const userId = await createTestUser(db(), unique("owner-scope"));
    await expectCheckViolation(
      db().workspaceMember.create({ data: { workspaceId: a.workspaceId, userId, role: "OWNER", businessProfileScope: "SELECTED" } }),
      "workspace_members_owner_scope_check",
    );
  });

  it("keeps one default automation policy per Business Profile plus at most one override per channel account", async () => {
    const policy = (profile: SeededProfile, channelAccountId?: string) =>
      db().automationPolicy.create({ data: { ...scope(profile), channelAccountId, mandatoryReviewReasons: ["PAYMENT_DISPUTE"] } });

    await expect(policy(a1)).resolves.toMatchObject({ mode: "OFF", instagramAfterWindowPolicy: "STANDARD_ONLY" });
    await expect(policy(a1)).rejects.toMatchObject(UNIQUE_VIOLATION);
    await expect(policy(a2)).resolves.toBeDefined();
    await policy(a1, a1.channelAccount.id);
    await expect(policy(a1, a1.channelAccount.id)).rejects.toMatchObject(UNIQUE_VIOLATION);
  });

  it("routes a live platform account to exactly one Workspace + Business Profile and one live account per channel per profile", async () => {
    const connect = (profile: SeededProfile, externalAccountId: string) =>
      createChannelAccount(db(), profile.context, { channel: "WHATSAPP", externalAccountId, capabilities: NO_CAPABILITIES });

    const inA1 = await connect(a1, "wa-phone-shared");
    await expect(connect(a2, "wa-phone-shared")).rejects.toMatchObject(UNIQUE_VIOLATION);
    await expect(connect(b1, "wa-phone-shared")).rejects.toMatchObject(UNIQUE_VIOLATION);
    await expect(connect(a1, "wa-phone-second")).rejects.toMatchObject(UNIQUE_VIOLATION);

    // A disconnected row keeps history and no longer holds the live slots.
    await db().channelAccount.update({ where: { id: inA1.id }, data: { status: "DISCONNECTED" } });
    await expect(connect(b1, "wa-phone-shared")).resolves.toMatchObject({ businessProfileId: b1.businessProfileId });
    await expect(connect(a1, "wa-phone-second")).resolves.toMatchObject({ businessProfileId: a1.businessProfileId });
  });

  it("enforces takeover-state and message-direction invariants", async () => {
    const takeover = (data: Parameters<TestDatabase["db"]["conversation"]["update"]>[0]["data"]) =>
      db().conversation.update({ where: { id: a1.conversationId }, data });

    await expectCheckViolation(takeover({ takeoverReason: "HUMAN_CLAIMED" }), "conversations_takeover_state_check");
    await expectCheckViolation(takeover({ takeoverState: "HUMAN_ACTIVE", takeoverReason: "HUMAN_CLAIMED" }), "conversations_takeover_state_check");
    await expectCheckViolation(
      takeover({ takeoverState: "REVIEW_REQUIRED", takeoverReason: "MANDATORY_REVIEW", humanTakeoverAt: new Date() }),
      "conversations_takeover_state_check",
    );
    await expectCheckViolation(
      takeover({ takeoverState: "HUMAN_ACTIVE", takeoverReason: "HUMAN_CLAIMED", humanTakeoverAt: new Date(), takeoverActorKind: "USER" }),
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
          ...scope(a1),
          channelAccountId: a1.channelAccount.id,
          conversationId: a1.conversationId,
          kind: "TEXT",
          occurredAt: new Date(),
          ...data,
        },
      });

    await expectCheckViolation(message({ direction: "IN", source: "AI" }), "messages_direction_source_check");
    await expectCheckViolation(message({ direction: "OUT", source: "PARTICIPANT" }), "messages_direction_source_check");
    await expectCheckViolation(message({ direction: "OUT", source: "HUMAN", transportPath: "HUMAN_AGENT" }), "messages_human_agent_actor_check");
    await expectCheckViolation(
      message({ direction: "OUT", source: "AI", transportPath: "HUMAN_AGENT", sentByUserId: a.ownerUserId }),
      "messages_human_agent_actor_check",
    );
    await expect(message({ direction: "OUT", source: "HUMAN", transportPath: "HUMAN_AGENT", sentByUserId: a.ownerUserId })).resolves.toMatchObject({
      transportPath: "HUMAN_AGENT",
    });
  });

  it("rejects cross-Business-Profile and cross-Workspace references even when repositories are bypassed", async () => {
    const draftInA2 = await newDraft(a2);
    const credentialInB = await db().channelCredential.create({
      // A complete envelope: the schema now refuses anything that is not one (see the envelope check below).
      data: {
        workspaceId: b.workspaceId,
        keyId: "fake-key",
        algorithm: "aes-256-gcm",
        ciphertext: Buffer.from("fake"),
        nonce: Buffer.alloc(12, 1),
        authTag: Buffer.alloc(16, 2),
      },
    });
    const memberOfB = await db().workspaceMember.findFirstOrThrow({ where: { workspaceId: b.workspaceId } });
    const documentInB = await db().knowledgeDocument.create({ data: { workspaceId: b.workspaceId, title: "t", sourceType: "MANUAL" } });
    // Same profile, second account on another channel: channel/account consistency inside one profile.
    const whatsappInA1 = await db().channelAccount.create({
      // Disconnected, so it does not compete for the profile's live WhatsApp slot used by other tests.
      data: { ...scope(a1), channel: "WHATSAPP", externalAccountId: unique("wa-a1"), status: "DISCONNECTED" },
    });
    const secondIdentityInA1 = await createContactWithChannelIdentity(db(), a1.context, {
      channelAccountId: a1.channelAccount.id,
      externalUserId: unique("ig-user-second"),
    });
    const secondConversationInA1 = await db().conversation.create({
      data: {
        ...scope(a1),
        channelAccountId: a1.channelAccount.id,
        channelIdentityId: secondIdentityInA1.channelIdentityId,
        contactId: secondIdentityInA1.contactId,
      },
    });
    // A fresh identity without a conversation, so thread uniqueness cannot mask the foreign-key check.
    const freshInA1 = await createContactWithChannelIdentity(db(), a1.context, {
      channelAccountId: a1.channelAccount.id,
      externalUserId: unique("ig-user-fresh"),
    });
    const attempts: [string, () => Promise<unknown>][] = [
      [
        "channel identity -> contact of another profile",
        () =>
          db().channelIdentity.create({
            data: { ...scope(a1), contactId: a2.contactId, channelAccountId: a1.channelAccount.id, externalUserId: unique("x") },
          }),
      ],
      [
        "channel identity -> channel account of another profile",
        () =>
          db().channelIdentity.create({
            data: { ...scope(a1), contactId: a1.contactId, channelAccountId: a2.channelAccount.id, externalUserId: unique("x") },
          }),
      ],
      [
        "conversation -> channel identity of another profile",
        () =>
          db().conversation.create({
            data: { ...scope(a1), channelAccountId: a2.channelAccount.id, channelIdentityId: a2.channelIdentityId, contactId: a1.contactId },
          }),
      ],
      [
        "conversation -> contact of another profile",
        () =>
          db().conversation.create({
            data: { ...scope(a1), channelAccountId: a1.channelAccount.id, channelIdentityId: freshInA1.channelIdentityId, contactId: a2.contactId },
          }),
      ],
      [
        "message -> conversation of another profile",
        () =>
          db().message.create({
            data: {
              ...scope(a1),
              channelAccountId: a2.channelAccount.id,
              conversationId: a2.conversationId,
              direction: "IN",
              source: "PARTICIPANT",
              kind: "TEXT",
              occurredAt: new Date(),
            },
          }),
      ],
      [
        "message -> AI draft of another profile",
        () =>
          db().message.create({
            data: {
              ...scope(a1),
              channelAccountId: a1.channelAccount.id,
              conversationId: a1.conversationId,
              direction: "OUT",
              source: "AI",
              kind: "TEXT",
              aiDraftId: draftInA2.id,
              occurredAt: new Date(),
            },
          }),
      ],
      [
        "AI draft -> conversation of another profile",
        () =>
          db().aiDraft.create({
            data: {
              ...scope(a1),
              conversationId: a2.conversationId,
              anchorMessageId: a2.messageId,
              anchorStateVersion: 0,
              generationKey: unique("gen"),
              text: "x",
              structuredOutput: {},
              confidence: 0.5,
              modelSuggestsSend: false,
              needsReview: true,
              modelProvider: "fake",
              modelName: "fake",
              promptVersion: "p",
              schemaVersion: "s",
            },
          }),
      ],
      [
        "AI draft -> anchor message of another profile's conversation",
        () =>
          db().aiDraft.create({
            data: {
              ...scope(a1),
              conversationId: a1.conversationId,
              anchorMessageId: a2.messageId,
              anchorStateVersion: 0,
              generationKey: unique("gen"),
              text: "x",
              structuredOutput: {},
              confidence: 0.5,
              modelSuggestsSend: false,
              needsReview: true,
              modelProvider: "fake",
              modelName: "fake",
              promptVersion: "p",
              schemaVersion: "s",
            },
          }),
      ],
      [
        "delivery job -> draft of another profile",
        () =>
          db().deliveryJobRecord.create({
            data: { ...scope(a1), draftId: draftInA2.id, operationId: unique("op"), correlationId: "c", scheduledFor: new Date(), selectedDelayMs: 0 },
          }),
      ],
      [
        "inbound event -> channel account of another profile",
        () =>
          db().inboundEvent.create({
            data: { ...scope(a1), channelAccountId: a2.channelAccount.id, sourceEventId: unique("evt"), eventType: "INBOUND_MESSAGE", occurredAt: new Date() },
          }),
      ],
      [
        "automation policy override -> channel account of another profile",
        () => db().automationPolicy.create({ data: { ...scope(a1), channelAccountId: a2.channelAccount.id, mandatoryReviewReasons: [] } }),
      ],
      [
        "style example -> source message of another profile",
        () =>
          db().styleExample.create({
            data: { ...scope(a1), inboundContext: "q", outboundText: "a", provenance: "HUMAN_TYPED", sourceMessageId: a2.messageId },
          }),
      ],
      [
        "knowledge document -> Business Profile of another Workspace",
        () =>
          db().knowledgeDocument.create({
            data: { workspaceId: a.workspaceId, businessProfileId: b1.businessProfileId, title: "t", sourceType: "MANUAL" },
          }),
      ],
      [
        "member access -> Business Profile of another Workspace",
        () =>
          db().workspaceMember.findFirstOrThrow({ where: { workspaceId: a.workspaceId } }).then((member) =>
            db().memberBusinessProfileAccess.create({
              data: { workspaceId: a.workspaceId, workspaceMemberId: member.id, businessProfileId: b1.businessProfileId },
            }),
          ),
      ],
      [
        "contact -> Business Profile of another Workspace",
        () => db().contact.create({ data: { workspaceId: a.workspaceId, businessProfileId: b1.businessProfileId } }),
      ],
      [
        "channel account -> Business Profile of another Workspace",
        () =>
          db().channelAccount.create({
            data: { workspaceId: a.workspaceId, businessProfileId: b1.businessProfileId, channel: "WHATSAPP", externalAccountId: unique("x") },
          }),
      ],
      [
        "channel account -> encrypted credential of another Workspace",
        () =>
          db().channelAccount.create({
            data: { ...scope(a2), channel: "WHATSAPP", externalAccountId: unique("x"), credentialId: credentialInB.id },
          }),
      ],
      [
        "automation policy -> Business Profile of another Workspace",
        () => db().automationPolicy.create({ data: { workspaceId: a.workspaceId, businessProfileId: b1.businessProfileId, mandatoryReviewReasons: [] } }),
      ],
      [
        "member access -> member of another Workspace",
        () =>
          db().memberBusinessProfileAccess.create({
            data: { workspaceId: a.workspaceId, workspaceMemberId: memberOfB.id, businessProfileId: a1.businessProfileId },
          }),
      ],
      [
        "style example -> source draft of another profile",
        () =>
          db().styleExample.create({
            data: { ...scope(a1), inboundContext: "q", outboundText: "a", provenance: "HUMAN_EDITED_DRAFT", sourceDraftId: draftInA2.id },
          }),
      ],
      [
        "knowledge chunk -> document of another Workspace",
        () =>
          db().knowledgeChunk.create({
            data: { workspaceId: a.workspaceId, documentId: documentInB.id, documentVersion: 1, ordinal: 0, content: "fact" },
          }),
      ],
      [
        "conversation -> identity of another channel account in the same profile",
        () =>
          db().conversation.create({
            data: {
              ...scope(a1),
              channelAccountId: whatsappInA1.id,
              channelIdentityId: secondIdentityInA1.channelIdentityId,
              contactId: secondIdentityInA1.contactId,
            },
          }),
      ],
      [
        "message -> conversation on another channel account in the same profile",
        () =>
          db().message.create({
            data: {
              ...scope(a1),
              channelAccountId: whatsappInA1.id,
              conversationId: a1.conversationId,
              direction: "IN",
              source: "PARTICIPANT",
              kind: "TEXT",
              occurredAt: new Date(),
            },
          }),
      ],
      [
        "AI draft -> anchor message of another conversation in the same profile",
        () =>
          db().aiDraft.create({
            data: {
              ...scope(a1),
              conversationId: secondConversationInA1.id,
              anchorMessageId: a1.messageId,
              anchorStateVersion: 0,
              generationKey: unique("gen"),
              text: "x",
              structuredOutput: {},
              confidence: 0.5,
              modelSuggestsSend: false,
              needsReview: true,
              modelProvider: "fake",
              modelName: "fake",
              promptVersion: "p",
              schemaVersion: "s",
            },
          }),
      ],
    ];

    for (const [name, attempt] of attempts) {
      await expect(attempt(), name).rejects.toMatchObject(FOREIGN_KEY_VIOLATION);
    }

    // Style learned from a conversation must name its profile, or the composite source FKs would be skipped.
    await expectCheckViolation(
      db().styleExample.create({
        data: { workspaceId: a.workspaceId, inboundContext: "q", outboundText: "a", provenance: "HUMAN_TYPED", sourceMessageId: a2.messageId },
      }),
      "style_examples_source_profile_check",
    );
    await expectCheckViolation(
      db().styleExample.create({
        data: { workspaceId: a.workspaceId, inboundContext: "q", outboundText: "a", provenance: "HUMAN_EDITED_DRAFT", sourceDraftId: draftInA2.id },
      }),
      "style_examples_source_profile_check",
    );

    // Rows that other rows reference cannot move to another Business Profile (ON UPDATE RESTRICT + composite FKs).
    await expect(db().conversation.update({ where: { id: a2.conversationId }, data: { businessProfileId: a1.businessProfileId } })).rejects.toThrow();
    await expect(db().contact.update({ where: { id: a2.contactId }, data: { businessProfileId: a1.businessProfileId } })).rejects.toThrow();
    expect((await db().conversation.findUniqueOrThrow({ where: { id: a2.conversationId } })).businessProfileId).toBe(a2.businessProfileId);
  });

  it("refuses a stored credential that is not a complete AES-256-GCM envelope", async () => {
    const envelope = (overrides: Record<string, unknown> = {}) => ({
      workspaceId: a.workspaceId,
      purpose: "INSTAGRAM_ACCESS_TOKEN",
      keyId: "k1",
      algorithm: "aes-256-gcm",
      ciphertext: Buffer.from("ciphertext"),
      nonce: Buffer.alloc(12, 1),
      authTag: Buffer.alloc(16, 2),
      ...overrides,
    });

    await expect(db().channelCredential.create({ data: envelope() })).resolves.toBeDefined();
    // A row that names a weaker algorithm, drops authentication or resizes the nonce cannot exist at all.
    for (const invalid of [
      { algorithm: "aes-256-cbc" },
      { authTag: null },
      { authTag: Buffer.alloc(8, 2) },
      { nonce: Buffer.alloc(16, 1) },
      { ciphertext: Buffer.alloc(0) },
      { purpose: "" },
    ]) {
      await expectCheckViolation(db().channelCredential.create({ data: envelope(invalid) }), "channel_credentials_envelope_check");
    }
  });

  it("keeps credential lifetimes moving forward", async () => {
    const past = new Date(Date.now() - 60_000);
    const base = {
      workspaceId: a.workspaceId,
      purpose: "INSTAGRAM_ACCESS_TOKEN",
      keyId: "k1",
      algorithm: "aes-256-gcm",
      ciphertext: Buffer.from("ciphertext"),
      nonce: Buffer.alloc(12, 1),
      authTag: Buffer.alloc(16, 2),
    };

    for (const invalid of [{ expiresAt: past }, { refreshedAt: past }, { revokedAt: past }]) {
      await expectCheckViolation(db().channelCredential.create({ data: { ...base, ...invalid } }), "channel_credentials_lifetime_check");
    }
  });

  it("keeps a connect state short-lived, single-use and hash-sized", async () => {
    const state = (overrides: Record<string, unknown> = {}) => ({
      id: unique("state"),
      workspaceId: a.workspaceId,
      businessProfileId: a1.businessProfileId,
      userId: a.ownerUserId,
      channel: "INSTAGRAM" as const,
      nonceHash: Buffer.alloc(32, 9),
      requestedScopes: ["instagram_business_basic"],
      expiresAt: new Date(Date.now() + 60_000),
      ...overrides,
    });

    await expect(db().channelConnectState.create({ data: state() })).resolves.toBeDefined();
    for (const invalid of [
      { expiresAt: new Date(Date.now() - 60_000) },
      { consumedAt: new Date(Date.now() - 60_000) },
      { nonceHash: Buffer.alloc(16, 9) },
    ]) {
      await expectCheckViolation(db().channelConnectState.create({ data: state(invalid) }), "channel_connect_states_lifetime_check");
    }
    // A state cannot point at a Business Profile of another Workspace.
    await expect(
      db().channelConnectState.create({ data: state({ businessProfileId: b1.businessProfileId }) }),
    ).rejects.toMatchObject(FOREIGN_KEY_VIOLATION);
  });

  it("preserves audit history instead of cascading deletes", async () => {
    const messagesBefore = await db().message.count({ where: { conversationId: b1.conversationId } });
    await expect(db().conversation.delete({ where: { id: b1.conversationId } })).rejects.toMatchObject(FOREIGN_KEY_VIOLATION);
    await expect(db().businessProfile.delete({ where: { id: b1.businessProfileId } })).rejects.toMatchObject(FOREIGN_KEY_VIOLATION);
    await expect(db().workspace.delete({ where: { id: b.workspaceId } })).rejects.toMatchObject(FOREIGN_KEY_VIOLATION);
    await expect(db().user.delete({ where: { id: b.ownerUserId } })).rejects.toMatchObject(FOREIGN_KEY_VIOLATION);
    expect(await db().message.count({ where: { conversationId: b1.conversationId } })).toBe(messagesBefore);

    // Auth.js login plumbing and a member's access grants are the only rows removed with their parent.
    const userId = await createTestUser(db(), unique("login-only"));
    await db().session.create({ data: { sessionToken: unique("fake-session-token"), userId, expires: new Date(Date.now() + 60_000) } });
    await db().account.create({ data: { userId, type: "oidc", provider: "fake", providerAccountId: unique("fake") } });
    await db().user.delete({ where: { id: userId } });
    expect(await db().session.count({ where: { userId } })).toBe(0);
    expect(await db().account.count({ where: { userId } })).toBe(0);

    const memberUser = await createTestUser(db(), unique("granted"));
    const member = await db().workspaceMember.create({
      data: { workspaceId: a.workspaceId, userId: memberUser, role: "AGENT", businessProfileScope: "SELECTED" },
    });
    await db().memberBusinessProfileAccess.create({
      data: { workspaceId: a.workspaceId, workspaceMemberId: member.id, businessProfileId: a1.businessProfileId },
    });
    await db().workspaceMember.delete({ where: { id: member.id } });
    expect(await db().memberBusinessProfileAccess.count({ where: { workspaceMemberId: member.id } })).toBe(0);
  });

  it("does not create Business Profiles implicitly", async () => {
    const ownerOnly = await seedWorkspace(db(), "empty", []);
    expect(await db().businessProfile.count({ where: { workspaceId: ownerOnly.workspaceId } })).toBe(0);
    const { businessProfileId } = await createBusinessProfile(db(), ownerOnly.context, { name: "First" });
    await expect(
      authorizeBusinessProfileAccess(db(), { userId: ownerOnly.ownerUserId, workspaceId: ownerOnly.workspaceId, businessProfileId }),
    ).resolves.toMatchObject({ businessProfileId });
  });

  it("creates the indexes that inbox, ingestion and delivery queries rely on, and only cascades login data and grants", async () => {
    const indexes = await db().$queryRaw<{ indexname: string }[]>`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`;
    expect(indexes.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        "conversations_profile_inbox_idx",
        "conversations_channel_account_id_last_inbound_at_idx",
        "conversations_channel_identity_key",
        "channel_identities_external_user_key",
        "inbound_events_source_event_key",
        "messages_channel_message_key",
        "messages_conversation_id_occurred_at_idx",
        "messages_ai_draft_key",
        "delivery_jobs_draft_key",
        "delivery_jobs_status_scheduled_for_idx",
        "channel_accounts_live_external_account_key",
        "channel_accounts_live_profile_channel_key",
        "automation_policies_profile_default_key",
        "business_profiles_workspace_id_id_key",
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
      "member_business_profile_access_workspace_id_workspace_memb_fkey",
    ]);
    expect(rules.filter((rule) => rule.delete_rule !== "CASCADE").every((rule) => rule.delete_rule === "RESTRICT")).toBe(true);
    expect(rules.every((rule) => rule.update_rule === "RESTRICT")).toBe(true);
  });
});
