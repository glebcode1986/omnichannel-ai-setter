/**
 * The Instagram vertical slice, end to end (#16).
 *
 * The point of this file is to prove there is exactly **one** route from a customer message to a reply, and
 * that every decision on it is made by the shared components rather than by a shortcut. So it drives the
 * real pieces — the real draft engine, the real policy engine, the real delivery coordinator, the real
 * PostgreSQL — and substitutes only the two things a test cannot have: the model and Meta's HTTP endpoint.
 *
 * What it does *not* do is re-derive any expectation. Every assertion is about durable state the system
 * actually wrote.
 */
import { noRetrieval } from "@omnichannel/application";
import { createAiDraftStore, createDeliveryStore, recoverStaleSendingDeliveries, scheduleAutomatedDelivery } from "@omnichannel/db";
import { NO_CAPABILITIES } from "@omnichannel/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDraftDisposition } from "./draft-disposition";
import { createDeliveryHandler } from "./delivery-handler";
import { createDeliveryPolicyResolver } from "./delivery-policy";
import { createEndToEndInfrastructure, endToEndTestsEnabled, type EndToEndInfrastructure } from "./testing/infrastructure";
import { createChannelAccount } from "@omnichannel/db";
import { authorizeBusinessProfileAccess, authorizeWorkspaceAccess, createBusinessProfile, createWorkspaceWithOwner } from "@omnichannel/db";
import { createContactWithChannelIdentity, createConversation, appendInboundMessage } from "@omnichannel/db";
import type { SendResult } from "@omnichannel/channel-core";

const NOW = new Date("2026-09-19T12:00:00.000Z");

/**
 * Every column the NONE branch of `conversations_takeover_state_check` requires to be null. Spelled out
 * rather than partially reset: the constraint exists precisely so a half-cleared takeover cannot persist.
 */
const RELEASED = {
  takeoverState: "NONE",
  takeoverReason: null,
  takeoverReviewMode: null,
  humanTakeoverAt: null,
  takeoverPausedUntil: null,
  takeoverActorKind: null,
  takeoverActorUserId: null,
} as const;

describe.skipIf(!endToEndTestsEnabled())("Instagram vertical slice (end to end)", () => {
  let infra: EndToEndInfrastructure;
  let scope: { workspaceId: string; businessProfileId: string };
  let channelAccountId: string;
  let context: Awaited<ReturnType<typeof authorizeBusinessProfileAccess>>;
  let conversationId: string;
  let anchorMessageId: string;
  let seq = 0;

  beforeAll(async () => {
    infra = await createEndToEndInfrastructure();
    const user = await infra.db.user.create({ data: { name: "Slice Owner", email: "slice-owner@example.test" } });
    const { workspaceId } = await createWorkspaceWithOwner(infra.db, { name: "Slice Workspace", ownerUserId: user.id });
    const workspace = await authorizeWorkspaceAccess(infra.db, { userId: user.id, workspaceId });
    const { businessProfileId } = await createBusinessProfile(infra.db, workspace, { name: "Slice Profile" });
    context = await authorizeBusinessProfileAccess(infra.db, { userId: user.id, workspaceId, businessProfileId });
    scope = { workspaceId, businessProfileId };

    const account = await createChannelAccount(infra.db, context, {
      channel: "INSTAGRAM",
      externalAccountId: "ig-account-slice",
      capabilities: { ...NO_CAPABILITIES, text: true },
    });
    channelAccountId = account.id;
    ({ conversationId, anchorMessageId } = await freshConversation());

    await infra.db.automationPolicy.create({
      data: { ...scope, mode: "AUTOPILOT", confidenceThreshold: 0.8, mandatoryReviewReasons: ["MISSING_FACT"], deliveryDelayMinMs: 1_000, deliveryDelayMaxMs: 2_000 },
    });
  }, 180_000);

  afterAll(async () => {
    await infra?.dispose();
  });

  /**
   * A conversation of its own for each test. Sharing one let an earlier test's "never mind" message make
   * every later delivery superseded — a shared-fixture trap, not a finding about the system.
   */
  async function freshConversation(): Promise<{ conversationId: string; anchorMessageId: string }> {
    seq += 1;
    const identity = await createContactWithChannelIdentity(infra.db, context, { channelAccountId, externalUserId: `ig-user-slice-${String(seq)}` });
    const conversation = await createConversation(infra.db, context, { channelAccountId, channelIdentityId: identity.channelIdentityId });
    const message = await appendInboundMessage(infra.db, context, { conversationId: conversation.id, kind: "TEXT", text: "Are you open Saturday?", occurredAt: NOW });
    return { conversationId: conversation.id, anchorMessageId: message.id };
  }

  const draft = async (
    overrides: { confidence?: number; needsReview?: boolean; reasonCodes?: string[]; conversationId?: string; anchorMessageId?: string } = {},
  ): Promise<string> => {
    seq += 1;
    const { aiDraftId } = await createAiDraftStore(infra.db).saveDraft({
      scope: { ...scope, conversationId: overrides.conversationId ?? conversationId },
      generationKey: `slice_${String(seq)}`,
      trigger: "AUTOMATIC",
      anchorMessageId: overrides.anchorMessageId ?? anchorMessageId,
      anchorStateVersion: 1,
      text: "Yes — we're open 10:00 to 18:00 on Saturdays.",
      structuredOutput: { reply: "Yes" },
      confidence: overrides.confidence ?? 0.9,
      modelSuggestsSend: true,
      needsReview: overrides.needsReview ?? false,
      reasonCodes: (overrides.reasonCodes ?? []) as never,
      factualSourceIds: [],
      retrieval: noRetrieval("OK"),
      status: "PENDING",
      provider: "fixture",
      model: "slice",
      promptVersion: "reply.v1",
      schemaVersion: "ai-draft.v1",
    });
    return aiDraftId;
  };

  const disposition = (random = () => 0.5) =>
    createDraftDisposition({ db: infra.db, producer: { scheduleDelivery: () => Promise.resolve({ jobId: "job" }) } as never, logger: infra.logger, now: () => NOW, random });

  const deliver = (result: SendResult) =>
    createDeliveryHandler({
      engine: {
        store: createDeliveryStore(infra.db),
        sender: { send: () => Promise.resolve(result) },
        log: infra.logger,
        now: () => NOW,
      },
      conversationPolicy: createDeliveryPolicyResolver(infra.db, () => NOW),
      logger: infra.logger,
    });

  const deliveryJob = (operationId: string, forConversationId = conversationId) => ({
    schemaVersion: 1 as const,
    ...scope,
    correlationId: "corr-slice",
    conversationId: forConversationId,
    draftId: "unused",
    deliveryJobId: operationId,
    operationId,
    scheduledFor: NOW.toISOString(),
    selectedDelayMs: 1_000,
  });

  const statusOf = async (operationId: string) =>
    (await infra.db.deliveryJobRecord.findUniqueOrThrow({ where: { operationId }, select: { status: true } })).status;

  it("carries an approved draft all the way to a sent message", async () => {
    const draftId = await draft();

    const disposed = await disposition()({ ...scope, conversationId, draftId, correlationId: "corr-slice" });
    expect(disposed.status).toBe("SCHEDULED");
    const operationId = disposed.status === "SCHEDULED" ? disposed.operationId : "";

    // The delay was chosen, persisted and bounded by the policy's configured range before anything ran.
    const job = await infra.db.deliveryJobRecord.findUniqueOrThrow({ where: { operationId }, select: { selectedDelayMs: true, scheduledFor: true } });
    expect(job.selectedDelayMs).toBeGreaterThanOrEqual(1_000);
    expect(job.selectedDelayMs).toBeLessThanOrEqual(2_000);

    const attempt = await deliver({ outcome: "ACCEPTED", platformMessageId: "mid-slice-1" })(deliveryJob(operationId));

    expect(attempt).toMatchObject({ status: "SEND_RESULT" });
    expect(await statusOf(operationId)).toBe("SENT");
    const sent = await infra.db.message.findFirstOrThrow({ where: { ...scope, operationId }, select: { direction: true, source: true, transportPath: true, channelMessageId: true } });
    // Automated delivery is always the standard path; the human-agent path is a human action.
    expect(sent).toMatchObject({ direction: "OUT", source: "AI", transportPath: "STANDARD", channelMessageId: "mid-slice-1" });
  }, 180_000);

  it("holds a low-confidence draft for a person instead of scheduling it", async () => {
    const draftId = await draft({ confidence: 0.2 });

    const disposed = await disposition()({ ...scope, conversationId, draftId, correlationId: "corr-low" });

    expect(disposed).toMatchObject({ status: "REVIEW" });
    expect(await infra.db.deliveryJobRecord.count({ where: { ...scope, draftId } })).toBe(0);
    const conversation = await infra.db.conversation.findUniqueOrThrow({ where: { workspaceId_businessProfileId_id: { ...scope, id: conversationId } }, select: { takeoverState: true } });
    expect(conversation.takeoverState).toBe("REVIEW_REQUIRED");
    // Reset for the tests that follow.
    await infra.db.conversation.update({ where: { workspaceId_businessProfileId_id: { ...scope, id: conversationId } }, data: RELEASED });
  }, 180_000);

  it("holds a draft with a mandatory-review reason, whatever its confidence", async () => {
    const draftId = await draft({ confidence: 0.99, reasonCodes: ["MISSING_FACT"] });

    const disposed = await disposition()({ ...scope, conversationId, draftId, correlationId: "corr-missing" });

    expect(disposed.status).toBe("REVIEW");
    await infra.db.conversation.update({ where: { workspaceId_businessProfileId_id: { ...scope, id: conversationId } }, data: RELEASED });
  }, 180_000);

  it("cancels a pending delivery once a human takes the conversation", async () => {
    const own = await freshConversation();
    const draftId = await draft(own);
    const { operationId } = await scheduleAutomatedDelivery(infra.db, { ...scope, draftId, correlationId: "corr-takeover", delayMs: 1_000, now: NOW });
    await infra.db.conversation.update({ where: { workspaceId_businessProfileId_id: { ...scope, id: own.conversationId } }, data: { takeoverState: "HUMAN_ACTIVE", takeoverReason: "HUMAN_SENT_FROM_INBOX", humanTakeoverAt: NOW } });

    const attempt = await deliver({ outcome: "ACCEPTED", platformMessageId: "must-not-happen" })(deliveryJob(operationId, own.conversationId));

    // Nothing reached the adapter: the coordinator settled it before claiming.
    expect(attempt).toMatchObject({ status: "SKIPPED" });
    expect(await statusOf(operationId)).toBe("CANCELLED_HUMAN_TAKEOVER");
    expect(await infra.db.message.count({ where: { ...scope, operationId } })).toBe(0);
  }, 180_000);

  it("cancels a pending delivery once the customer speaks again", async () => {
    const own = await freshConversation();
    const draftId = await draft(own);
    const { operationId } = await scheduleAutomatedDelivery(infra.db, { ...scope, draftId, correlationId: "corr-superseded", delayMs: 1_000, now: NOW });
    await infra.db.message.create({
      data: { ...scope, channelAccountId, conversationId: own.conversationId, direction: "IN", source: "PARTICIPANT", kind: "TEXT", text: "actually never mind", occurredAt: new Date(NOW.getTime() + 60_000) },
    });

    const attempt = await deliver({ outcome: "ACCEPTED", platformMessageId: "must-not-happen" })(deliveryJob(operationId, own.conversationId));

    expect(attempt).toMatchObject({ status: "SKIPPED" });
    expect(await statusOf(operationId)).toBe("CANCELLED_SUPERSEDED");
    expect(await infra.db.message.count({ where: { ...scope, operationId } })).toBe(0);
  }, 180_000);

  it("quarantines an ambiguous send and never retries it", async () => {
    const own = await freshConversation();
    const draftId = await draft(own);
    const { operationId } = await scheduleAutomatedDelivery(infra.db, { ...scope, draftId, correlationId: "corr-ambiguous", delayMs: 1_000, now: NOW });

    const attempt = await deliver({ outcome: "AMBIGUOUS", code: "TIMEOUT", message: "no response" })(deliveryJob(operationId, own.conversationId));

    expect(attempt).toMatchObject({ status: "SEND_RESULT" });
    expect(await statusOf(operationId)).toBe("HELD_AMBIGUOUS");
    // Never claimable again: the customer may already have the reply.
    expect(await createDeliveryStore(infra.db).claim(operationId, NOW)).toMatchObject({ kind: "NOT_CLAIMABLE" });
  }, 180_000);

  it("holds a definite rejection with the provider's own code", async () => {
    const own = await freshConversation();
    const draftId = await draft(own);
    const { operationId } = await scheduleAutomatedDelivery(infra.db, { ...scope, draftId, correlationId: "corr-rejected", delayMs: 1_000, now: NOW });

    await deliver({ outcome: "REJECTED", retryable: false, code: "OUTSIDE_WINDOW", message: "not allowed" })(deliveryJob(operationId, own.conversationId));

    const job = await infra.db.deliveryJobRecord.findUniqueOrThrow({ where: { operationId }, select: { status: true, lastErrorCode: true } });
    expect(job).toMatchObject({ status: "HELD_REVIEW", lastErrorCode: "OUTSIDE_WINDOW" });
  }, 180_000);

  it("cannot double-send when two workers race the same delivery", async () => {
    const own = await freshConversation();
    const draftId = await draft(own);
    const { operationId } = await scheduleAutomatedDelivery(infra.db, { ...scope, draftId, correlationId: "corr-race", delayMs: 1_000, now: NOW });
    let sends = 0;
    const racing = () =>
      createDeliveryHandler({
        engine: {
          store: createDeliveryStore(infra.db),
          sender: {
            send: () => {
              sends += 1;
              return Promise.resolve({ outcome: "ACCEPTED", platformMessageId: `mid-race-${String(sends)}` });
            },
          },
          log: infra.logger,
          now: () => NOW,
        },
        conversationPolicy: createDeliveryPolicyResolver(infra.db, () => NOW),
        logger: infra.logger,
      });

    await Promise.all([racing()(deliveryJob(operationId, own.conversationId)), racing()(deliveryJob(operationId, own.conversationId))]);

    // The claim is what makes this true, and it holds against a real server.
    expect(sends).toBe(1);
    expect(await infra.db.message.count({ where: { ...scope, operationId } })).toBe(1);
  }, 180_000);

  it("quarantines a delivery whose worker died mid-send", async () => {
    const own = await freshConversation();
    const draftId = await draft(own);
    const { operationId } = await scheduleAutomatedDelivery(infra.db, { ...scope, draftId, correlationId: "corr-stalled", delayMs: 1_000, now: NOW });
    await createDeliveryStore(infra.db).claim(operationId, new Date(NOW.getTime() - 10 * 60_000));

    const recovered = await recoverStaleSendingDeliveries(infra.db, 5 * 60_000, NOW);

    expect(recovered).toContain(operationId);
    expect(await statusOf(operationId)).toBe("HELD_AMBIGUOUS");
  }, 180_000);
});
