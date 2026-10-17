/**
 * The kill switch, against a real database (Issue #56).
 *
 * The property that matters most is the one an operator is relying on when they pull it: **outbound stops,
 * inbound does not.** A switch that also dropped customer messages would turn a precaution into data loss,
 * and the person pulling it is trying to prevent harm. So the test that matters here is not "does it block
 * a send" — it is "does the conversation keep working while it does".
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
  createDeliveryStore,
  createSuspensionStore,
  createWorkspaceWithOwner,
  scheduleAutomatedDelivery,
} from "@omnichannel/db";
import { NO_CAPABILITIES } from "@omnichannel/domain";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createDeliveryHandler } from "./delivery-handler";
import { createChannelStateResolver } from "./delivery-policy";
import { createEndToEndInfrastructure, endToEndTestsEnabled, setProfileDefaultPolicy, type EndToEndInfrastructure } from "./testing/infrastructure";

const NOW = new Date("2026-09-19T12:00:00.000Z");

describe.skipIf(!endToEndTestsEnabled())("automated-outbound kill switch (end to end)", () => {
  let infra: EndToEndInfrastructure;
  let scope: { workspaceId: string; businessProfileId: string };
  let context: Awaited<ReturnType<typeof authorizeBusinessProfileAccess>>;
  let ownerUserId: string;
  let channelAccountId: string;
  let seq = 0;

  beforeAll(async () => {
    infra = await createEndToEndInfrastructure();
    const user = await infra.db.user.create({ data: { name: "Switch Owner", email: "switch-owner@example.test" } });
    ownerUserId = user.id;
    const { workspaceId } = await createWorkspaceWithOwner(infra.db, { name: "Switch Workspace", ownerUserId });
    const workspace = await authorizeWorkspaceAccess(infra.db, { userId: ownerUserId, workspaceId });
    const { businessProfileId } = await createBusinessProfile(infra.db, workspace, { name: "Switch Profile" });
    context = await authorizeBusinessProfileAccess(infra.db, { userId: ownerUserId, workspaceId, businessProfileId });
    scope = { workspaceId, businessProfileId };

    const account = await createChannelAccount(infra.db, context, {
      channel: "INSTAGRAM",
      externalAccountId: "ig-account-switch",
      capabilities: { ...NO_CAPABILITIES, text: true },
    });
    channelAccountId = account.id;
    await setProfileDefaultPolicy(infra.db, scope, { mode: "AUTOPILOT", confidenceThreshold: 0.8, mandatoryReviewReasons: [] });
  }, 180_000);

  afterEach(async () => {
    // A suspension left standing would silence every later test in this profile — the same shared-fixture
    // trap that a real operator hits when they forget to lift one.
    await infra.db.automationSuspension.updateMany({ where: { liftedAt: null }, data: { liftedAt: NOW, liftedByUserId: ownerUserId } });
  });

  afterAll(async () => {
    await infra?.dispose();
  });

  async function conversationWithDraft(): Promise<{ conversationId: string; operationId: string }> {
    seq += 1;
    const identity = await createContactWithChannelIdentity(infra.db, context, { channelAccountId, externalUserId: `ig-user-switch-${String(seq)}` });
    const conversation = await createConversation(infra.db, context, { channelAccountId, channelIdentityId: identity.channelIdentityId });
    const anchor = await appendInboundMessage(infra.db, context, { conversationId: conversation.id, kind: "TEXT", text: "Are you open?", occurredAt: NOW });
    const { aiDraftId } = await createAiDraftStore(infra.db).saveDraft({
      scope: { ...scope, conversationId: conversation.id },
      generationKey: `switch_${String(seq)}`,
      trigger: "AUTOMATIC",
      anchorMessageId: anchor.id,
      anchorStateVersion: 1,
      text: "Yes — 10:00 to 18:00.",
      structuredOutput: { reply: "Yes" },
      confidence: 0.95,
      modelSuggestsSend: true,
      needsReview: false,
      reasonCodes: [],
      factualSourceIds: [],
      retrieval: noRetrieval("OK"),
      status: "PENDING",
      provider: "fixture",
      model: "switch",
      promptVersion: "reply.v1",
      schemaVersion: "ai-draft.v1",
    });
    const { operationId } = await scheduleAutomatedDelivery(infra.db, { ...scope, draftId: aiDraftId, correlationId: `corr-switch-${String(seq)}`, delayMs: 0, now: NOW });
    return { conversationId: conversation.id, operationId };
  }

  const deliver = (conversationId: string, operationId: string) => {
    let sends = 0;
    const handler = createDeliveryHandler({
      engine: {
        store: createDeliveryStore(infra.db),
        sender: {
          send: () => {
            sends += 1;
            // Unique per operation: a platform message ID is unique per channel account, and reusing one
            // across tests trips that constraint rather than testing anything.
            return Promise.resolve({ outcome: "ACCEPTED", platformMessageId: `mid-${operationId}-${String(sends)}` });
          },
        },
        channel: createChannelStateResolver(() => NOW),
        log: infra.logger,
        now: () => NOW,
      },
      logger: infra.logger,
    });
    return {
      run: () =>
        handler({
          schemaVersion: 1,
          ...scope,
          correlationId: "corr-switch",
          conversationId,
          draftId: "unused",
          deliveryJobId: operationId,
          operationId,
          scheduledFor: NOW.toISOString(),
          selectedDelayMs: 0,
        }),
      sends: () => sends,
    };
  };

  const statusOf = async (operationId: string) =>
    (await infra.db.deliveryJobRecord.findUniqueOrThrow({ where: { operationId }, select: { status: true } })).status;

  it("stops the send while the conversation keeps working", async () => {
    const { conversationId, operationId } = await conversationWithDraft();
    await createSuspensionStore(infra.db).suspend({
      scope: "BUSINESS_PROFILE",
      ...scope,
      reason: "OPERATOR",
      note: "investigating a customer report",
      since: new Date(NOW.getTime() - 1_000),
      byUserId: ownerUserId,
    });

    const attempt = deliver(conversationId, operationId);
    await attempt.run();

    // Nothing reached the adapter, and the work is held rather than discarded: the operator stopped
    // sending, they did not decide the reply was wrong.
    expect(attempt.sends()).toBe(0);
    expect(await statusOf(operationId)).toBe("HELD_REVIEW");

    // And the part that matters: a customer message arriving during the pause is still stored.
    const message = await appendInboundMessage(infra.db, context, {
      conversationId,
      kind: "TEXT",
      text: "hello? are you there?",
      occurredAt: new Date(NOW.getTime() + 60_000),
    });
    expect(message.id).toBeDefined();
    const stored = await infra.db.message.count({ where: { ...scope, conversationId, direction: "IN" } });
    expect(stored).toBe(2);
  }, 180_000);

  it("sends again once the switch is lifted, and keeps the record of who lifted it", async () => {
    const { conversationId, operationId } = await conversationWithDraft();
    const suspensions = createSuspensionStore(infra.db);
    const { id } = await suspensions.suspend({ scope: "WORKSPACE", workspaceId: scope.workspaceId, reason: "DEPENDENCY_FAILURE", since: new Date(NOW.getTime() - 1_000) });

    const blocked = deliver(conversationId, operationId);
    await blocked.run();
    expect(blocked.sends()).toBe(0);

    await suspensions.lift(id, ownerUserId, new Date(NOW.getTime() + 1_000));
    // The delivery was held, not cancelled, so it can be picked up again.
    await infra.db.deliveryJobRecord.update({ where: { operationId }, data: { status: "SCHEDULED" } });
    const resumed = deliver(conversationId, operationId);
    await resumed.run();

    expect(resumed.sends()).toBe(1);
    expect(await statusOf(operationId)).toBe("SENT");
    const row = await infra.db.automationSuspension.findUniqueOrThrow({ where: { id }, select: { liftedAt: true, liftedByUserId: true } });
    // Kept rather than deleted: after an incident the question is always who turned it back on.
    expect(row.liftedByUserId).toBe(ownerUserId);
    expect(row.liftedAt).not.toBeNull();
  }, 180_000);

  it("leaves another workspace's sends alone", async () => {
    const { conversationId, operationId } = await conversationWithDraft();
    const other = await infra.db.user.create({ data: { name: "Other", email: `other-${String(seq)}@example.test` } });
    const { workspaceId: otherWorkspaceId } = await createWorkspaceWithOwner(infra.db, { name: "Other Workspace", ownerUserId: other.id });
    await createSuspensionStore(infra.db).suspend({ scope: "WORKSPACE", workspaceId: otherWorkspaceId, reason: "OPERATOR", since: new Date(NOW.getTime() - 1_000) });

    const attempt = deliver(conversationId, operationId);
    const outcome = await attempt.run();

    // One tenant's precaution is not another tenant's outage.
    expect(outcome).toMatchObject({ status: "SEND_RESULT" });
    expect(attempt.sends()).toBe(1);
  }, 180_000);

  it("stops one account without touching the account beside it", async () => {
    const { conversationId, operationId } = await conversationWithDraft();
    // A different account of the same workspace. It needs no row of its own: this table names accounts
    // rather than referencing them, precisely so an operator can pause one before we have finished
    // deciding what is wrong with it.
    const otherAccountId = "01a0b40c-0000-7000-8000-00000000d0d0";
    const suspensions = createSuspensionStore(infra.db);
    await suspensions.suspend({
      scope: "CHANNEL_ACCOUNT",
      workspaceId: scope.workspaceId,
      channelAccountId: otherAccountId,
      reason: "CHANNEL_UNHEALTHY",
      since: new Date(NOW.getTime() - 1_000),
    });

    // The narrowest scope is the one most easily resolved against the wrong identifier, and getting it
    // wrong is silent: a switch that blocks the account nobody asked about, or none at all.
    const unaffected = deliver(conversationId, operationId);
    await unaffected.run();
    expect(unaffected.sends()).toBe(1);

    const next = await conversationWithDraft();
    await suspensions.suspend({
      scope: "CHANNEL_ACCOUNT",
      workspaceId: scope.workspaceId,
      channelAccountId,
      reason: "CHANNEL_UNHEALTHY",
      since: new Date(NOW.getTime() - 1_000),
    });
    const blocked = deliver(next.conversationId, next.operationId);
    await blocked.run();

    expect(blocked.sends()).toBe(0);
    expect(await statusOf(next.operationId)).toBe("HELD_REVIEW");
  }, 180_000);

  it("keeps the first lift, because who turned it back on is the question", async () => {
    const suspensions = createSuspensionStore(infra.db);
    const second = await infra.db.user.create({ data: { name: "Second", email: `second-${String(seq)}@example.test` } });
    await infra.db.workspaceMember.create({ data: { workspaceId: scope.workspaceId, userId: second.id, role: "ADMIN" } });
    const { id } = await suspensions.suspend({ scope: "GLOBAL", reason: "OPERATOR", since: new Date(NOW.getTime() - 1_000) });

    await suspensions.lift(id, ownerUserId, new Date(NOW.getTime() + 1_000));
    await suspensions.lift(id, second.id, new Date(NOW.getTime() + 2_000));

    // A second click must not rewrite the record of who decided the danger had passed.
    const row = await infra.db.automationSuspension.findUniqueOrThrow({ where: { id }, select: { liftedAt: true, liftedByUserId: true } });
    expect(row.liftedByUserId).toBe(ownerUserId);
    expect(row.liftedAt?.toISOString()).toBe(new Date(NOW.getTime() + 1_000).toISOString());
  }, 180_000);

  it("refuses a narrow suspension that names nothing", async () => {
    // The database enforces it too, not only the domain: a BUSINESS_PROFILE row with no profile named
    // would be a global stop wearing a contained-looking label.
    await expect(
      infra.db.automationSuspension.create({
        data: { scope: "BUSINESS_PROFILE", workspaceId: scope.workspaceId, businessProfileId: null, reason: "OPERATOR", since: NOW },
      }),
    ).rejects.toThrow(/automation_suspensions_scope_check/);
  }, 180_000);

  it("refuses a lift that records a time without a person", async () => {
    await expect(
      infra.db.automationSuspension.create({
        data: { scope: "GLOBAL", reason: "OPERATOR", since: NOW, liftedAt: NOW, liftedByUserId: null },
      }),
    ).rejects.toThrow(/automation_suspensions_lifted_check/);
  }, 180_000);
});
