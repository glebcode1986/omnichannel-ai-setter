/**
 * Reliability, against a real database (Issue #56).
 *
 * The scenarios are the outage shapes the task names, and each one is written around the property that
 * would be violated if it went wrong rather than around the code path it exercises: a send is never
 * duplicated, inbound is never lost, a reply that has become wrong is never delivered late, and nothing
 * stays unknown without a person being told.
 */
import { noRetrieval, decideBackpressure, DEFAULT_BACKLOG_THRESHOLDS, collectHealth } from "@omnichannel/application";
import {
  appendInboundMessage,
  authorizeBusinessProfileAccess,
  authorizeWorkspaceAccess,
  createAiDraftStore,
  createBusinessProfile,
  createChannelAccount,
  createContactWithChannelIdentity,
  countUnusableGenerations,
  createConversation,
  createDeliveryStore,
  createReconciliationStore,
  createSuspensionStore,
  composeHumanReply,
  findUnresolvedOperations,
  readReliabilitySnapshot,
  recoverStaleSendingDeliveries,
  scheduleAutomatedDelivery,
} from "@omnichannel/db";
import { NO_CAPABILITIES, outboundBlockedByHealth, overallHealth } from "@omnichannel/domain";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createDeliveryHandler } from "./delivery-handler";
import { createPaidWorkspace } from "./testing/paid-workspace";
import { createChannelStateResolver } from "./delivery-policy";
import { aiProviderProbe, channelAccountProbes, databaseProbe } from "./health-probes";
import { createOperationEvidencePort } from "./operation-evidence";
import { createReconcileHandler } from "./reconcile-handler";
import { createEndToEndInfrastructure, endToEndTestsEnabled, setProfileDefaultPolicy, type EndToEndInfrastructure } from "./testing/infrastructure";

const NOW = new Date("2026-09-20T12:00:00.000Z");
const GRACE_MS = 10 * 60_000;
const AFTER_GRACE = new Date(NOW.getTime() + GRACE_MS + 1_000);

describe.skipIf(!endToEndTestsEnabled())("reliability controls (end to end)", () => {
  let infra: EndToEndInfrastructure;
  let scope: { workspaceId: string; businessProfileId: string };
  let context: Awaited<ReturnType<typeof authorizeBusinessProfileAccess>>;
  let ownerUserId: string;
  let channelAccountId: string;
  let seq = 0;

  beforeAll(async () => {
    infra = await createEndToEndInfrastructure();
    const user = await infra.db.user.create({ data: { name: "Reliability Owner", email: "reliability-owner@example.test" } });
    ownerUserId = user.id;
    const { workspaceId } = await createPaidWorkspace(infra.db, { name: "Reliability Workspace", ownerUserId });
    const workspace = await authorizeWorkspaceAccess(infra.db, { userId: ownerUserId, workspaceId });
    const { businessProfileId } = await createBusinessProfile(infra.db, workspace, { name: "Reliability Profile" });
    context = await authorizeBusinessProfileAccess(infra.db, { userId: ownerUserId, workspaceId, businessProfileId });
    scope = { workspaceId, businessProfileId };

    const account = await createChannelAccount(infra.db, context, {
      channel: "INSTAGRAM",
      externalAccountId: "ig-account-reliability",
      capabilities: { ...NO_CAPABILITIES, text: true },
    });
    channelAccountId = account.id;
    await setProfileDefaultPolicy(infra.db, scope, { mode: "AUTOPILOT", confidenceThreshold: 0.8, mandatoryReviewReasons: [] });
  }, 180_000);

  afterEach(async () => {
    // Anything left suspended would silence every later scenario — the same trap a real operator hits.
    await infra.db.automationSuspension.updateMany({ where: { liftedAt: null }, data: { liftedAt: NOW, liftedByUserId: ownerUserId } });
    await infra.db.channelAccount.update({ where: { id: channelAccountId }, data: { status: "CONNECTED" } });
  });

  afterAll(async () => {
    await infra?.dispose();
  });

  async function pendingDelivery(): Promise<{ conversationId: string; operationId: string; draftId: string }> {
    seq += 1;
    const identity = await createContactWithChannelIdentity(infra.db, context, { channelAccountId, externalUserId: `ig-user-rel-${String(seq)}` });
    const conversation = await createConversation(infra.db, context, { channelAccountId, channelIdentityId: identity.channelIdentityId });
    const anchor = await appendInboundMessage(infra.db, context, { conversationId: conversation.id, kind: "TEXT", text: "Are you open?", occurredAt: NOW });
    const { aiDraftId } = await createAiDraftStore(infra.db).saveDraft({
      scope: { ...scope, conversationId: conversation.id },
      generationKey: `rel_${String(seq)}`,
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
      model: "reliability",
      promptVersion: "reply.v1",
      schemaVersion: "ai-draft.v1",
    });
    const { operationId } = await scheduleAutomatedDelivery(infra.db, {
      ...scope,
      draftId: aiDraftId,
      correlationId: `corr-rel-${String(seq)}`,
      delayMs: 0,
      now: NOW,
    });
    return { conversationId: conversation.id, operationId, draftId: aiDraftId };
  }

  const deliver = (conversationId: string, operationId: string, now = NOW) => {
    let sends = 0;
    const handler = createDeliveryHandler({
      engine: {
        store: createDeliveryStore(infra.db),
        sender: {
          send: () => {
            sends += 1;
            return Promise.resolve({ outcome: "ACCEPTED", platformMessageId: `mid-${operationId}-${String(sends)}` });
          },
        },
        channel: createChannelStateResolver(() => now),
        log: infra.logger,
        now: () => now,
      },
      logger: infra.logger,
    });
    return {
      run: () =>
        handler({
          schemaVersion: 1,
          ...scope,
          correlationId: "corr-rel",
          conversationId,
          draftId: "unused",
          deliveryJobId: operationId,
          operationId,
          scheduledFor: now.toISOString(),
          selectedDelayMs: 0,
        }),
      sends: () => sends,
    };
  };

  const reconciler = (now: Date, resume = vi.fn(() => Promise.resolve())) => ({
    resume,
    run: (input: { conversationId: string; operationId: string; reason?: "AMBIGUOUS_SEND_RESULT" | "DELIVERY_HANDLER_FAILED" | "DELIVERY_STALLED" }) =>
      createReconcileHandler({
        engine: {
          store: createReconciliationStore(infra.db),
          evidence: createOperationEvidencePort(),
          log: infra.logger,
          now: () => now,
          graceMs: GRACE_MS,
        },
        resumeDelivery: resume,
        logger: infra.logger,
      })({
        schemaVersion: 1,
        ...scope,
        correlationId: "corr-rel",
        conversationId: input.conversationId,
        deliveryJobId: input.operationId,
        operationId: input.operationId,
        reason: input.reason ?? "AMBIGUOUS_SEND_RESULT",
        detectedAt: NOW.toISOString(),
      }),
  });

  const statusOf = async (operationId: string) =>
    (await infra.db.deliveryJobRecord.findUniqueOrThrow({ where: { operationId }, select: { status: true } })).status;

  describe("an ambiguous send", () => {
    it("is never retried, and becomes a person's decision once nobody can answer it", async () => {
      const { conversationId, operationId, draftId } = await pendingDelivery();
      await infra.db.deliveryJobRecord.update({ where: { operationId }, data: { status: "HELD_AMBIGUOUS", claimedAt: NOW, attemptCount: 1 } });
      const { resume, run } = reconciler(AFTER_GRACE);

      await run({ conversationId, operationId });

      // Meta cannot resolve a send request to a message afterwards, so the honest end of this path is a
      // person — not a resend, and not a quiet assumption either way.
      expect(await statusOf(operationId)).toBe("HELD_REVIEW");
      expect(resume).not.toHaveBeenCalled();
      const draft = await infra.db.aiDraft.findUniqueOrThrow({ where: { id: draftId }, select: { status: true, needsReview: true } });
      expect(draft).toMatchObject({ status: "HELD", needsReview: true });
      const record = await infra.db.deliveryReconciliation.findUniqueOrThrow({ where: { operationId } });
      expect(record).toMatchObject({ state: "NEEDS_HUMAN", attemptCount: 1 });
      expect(record.resolvedAt).not.toBeNull();
    });

    it("waits before troubling anyone, because a late echo usually settles it", async () => {
      const { conversationId, operationId } = await pendingDelivery();
      await infra.db.deliveryJobRecord.update({ where: { operationId }, data: { status: "HELD_AMBIGUOUS", claimedAt: NOW, attemptCount: 1 } });

      await expect(reconciler(new Date(NOW.getTime() + 1_000)).run({ conversationId, operationId })).rejects.toThrow(/unresolved/);

      expect(await statusOf(operationId)).toBe("HELD_AMBIGUOUS");
      expect((await infra.db.deliveryReconciliation.findUniqueOrThrow({ where: { operationId } })).state).toBe("PENDING");
    });

    it("leaves a send that already landed exactly as it is", async () => {
      const { conversationId, operationId } = await pendingDelivery();
      const sender = deliver(conversationId, operationId);
      await sender.run();
      expect(await statusOf(operationId)).toBe("SENT");

      await reconciler(AFTER_GRACE).run({ conversationId, operationId });

      // One outbound message, however many times reconciliation looks at it.
      expect(await statusOf(operationId)).toBe("SENT");
      expect(await infra.db.message.count({ where: { operationId, direction: "OUT" } })).toBe(1);
      expect((await infra.db.deliveryReconciliation.findUniqueOrThrow({ where: { operationId } })).state).toBe("ALREADY_SETTLED");
    });
  });

  describe("a worker that died mid-flight", () => {
    it("resumes work that never reached the transport", async () => {
      const { conversationId, operationId } = await pendingDelivery();
      const { resume, run } = reconciler(AFTER_GRACE);

      await run({ conversationId, operationId, reason: "DELIVERY_HANDLER_FAILED" });

      // No claim was ever taken, so no send was attempted: this is the one provably safe resume.
      expect(resume).toHaveBeenCalledWith(operationId);
      expect((await infra.db.deliveryReconciliation.findUniqueOrThrow({ where: { operationId } })).state).toBe("RESOLVED_RESUMED");
    });

    it("quarantines a claim that outlived its lease instead of re-running it", async () => {
      const { operationId } = await pendingDelivery();
      await infra.db.deliveryJobRecord.update({
        where: { operationId },
        data: { status: "SENDING", claimedAt: new Date(NOW.getTime() - 600_000), attemptCount: 1 },
      });

      const recovered = await recoverStaleSendingDeliveries(infra.db, 120_000, NOW);

      expect(recovered).toContain(operationId);
      expect(await statusOf(operationId)).toBe("HELD_AMBIGUOUS");
    });

    it("does not race a claim that is still alive", async () => {
      const { conversationId, operationId } = await pendingDelivery();
      await infra.db.deliveryJobRecord.update({ where: { operationId }, data: { status: "SENDING", claimedAt: NOW, attemptCount: 1 } });
      const { resume, run } = reconciler(AFTER_GRACE);

      await expect(run({ conversationId, operationId })).rejects.toThrow(/unresolved/);

      expect(resume).not.toHaveBeenCalled();
      expect(await statusOf(operationId)).toBe("SENDING");
    });
  });

  describe("recovery revalidates rather than replays", () => {
    it("does not deliver a resumed reply the customer has moved past", async () => {
      const { conversationId, operationId } = await pendingDelivery();
      const { resume, run } = reconciler(AFTER_GRACE);
      await run({ conversationId, operationId, reason: "DELIVERY_HANDLER_FAILED" });
      expect(resume).toHaveBeenCalledOnce();

      // The customer speaks again during the outage. The reply that was queued now answers a question
      // that has moved on, and resuming must not put it in front of them anyway.
      await appendInboundMessage(infra.db, context, {
        conversationId,
        kind: "TEXT",
        text: "Never mind, found it",
        occurredAt: new Date(NOW.getTime() + 30_000),
      });
      const sender = deliver(conversationId, operationId, AFTER_GRACE);
      await sender.run();

      expect(sender.sends()).toBe(0);
      expect(await statusOf(operationId)).toBe("CANCELLED_SUPERSEDED");
    });
  });

  describe("when the queue loses the job", () => {
    it("finds the unresolved send again from the database alone", async () => {
      const { operationId } = await pendingDelivery();
      await infra.db.deliveryJobRecord.update({ where: { operationId }, data: { status: "HELD_AMBIGUOUS", claimedAt: NOW, attemptCount: 1 } });

      // No reconciliation record: the enqueue that should have opened one never happened, which is
      // exactly what a Redis outage looks like from here.
      const unresolved = await findUnresolvedOperations(infra.db, { retryBefore: AFTER_GRACE, limit: 50 });

      expect(unresolved.map((operation) => operation.operationId)).toContain(operationId);
      expect(unresolved.find((operation) => operation.operationId === operationId)?.correlationId).toMatch(/^corr-rel-/);
    });

    it("finds a reply a person wrote, and names the conversation it belongs to", async () => {
      // The same shape as the blocking finding on PR #76, one layer down. A human-composed delivery has
      // no draft, and this query read the conversation through `draft.conversationId` only — so the
      // sweeper raised the operation with an empty conversation id, the queue's payload schema refused
      // it, and the row was never raised at all. "We do not know whether the customer received this" is
      // the one state that must never lose its way back to a person.
      seq += 1;
      // Its own conversation, with no AI delivery in it: the composer allows one queued reply at a time,
      // so reusing a conversation that already has one would refuse before this case began.
      const identity = await createContactWithChannelIdentity(infra.db, context, { channelAccountId, externalUserId: `ig-user-composed-${String(seq)}` });
      const conversation = await createConversation(infra.db, context, { channelAccountId, channelIdentityId: identity.channelIdentityId });
      await appendInboundMessage(infra.db, context, { conversationId: conversation.id, kind: "TEXT", text: "Are you open?", occurredAt: NOW });
      const outcome = await composeHumanReply(infra.db, context, {
        conversationId: conversation.id,
        text: "I will check and come back to you.",
        reviewMode: "NORMAL",
        at: NOW,
      });
      if (outcome.status !== "SCHEDULED") {
        throw new Error(`the fixture expected a queued reply, got ${outcome.status}`);
      }
      await infra.db.deliveryJobRecord.update({
        where: { operationId: outcome.operationId },
        data: { status: "HELD_AMBIGUOUS", claimedAt: NOW, attemptCount: 1 },
      });

      const unresolved = await findUnresolvedOperations(infra.db, { retryBefore: AFTER_GRACE, limit: 50 });
      const found = unresolved.find((operation) => operation.operationId === outcome.operationId);

      expect(found).toBeDefined();
      expect(found?.conversationId).toBe(conversation.id);
      // An identifier the queue will accept, which an empty string is not.
      expect(found?.conversationId).not.toBe("");
    });

    it("raises an investigation that stalled, without restarting its clock", async () => {
      const { conversationId, operationId } = await pendingDelivery();
      await infra.db.deliveryJobRecord.update({ where: { operationId }, data: { status: "HELD_AMBIGUOUS", claimedAt: NOW, attemptCount: 1 } });
      await expect(reconciler(new Date(NOW.getTime() + 1_000)).run({ conversationId, operationId })).rejects.toThrow();

      const unresolved = await findUnresolvedOperations(infra.db, { retryBefore: AFTER_GRACE, limit: 50 });

      const found = unresolved.find((operation) => operation.operationId === operationId);
      // The grace period runs from when the ambiguity first appeared, not from the latest retry — else an
      // operation could stay unresolved forever while looking freshly detected on every sweep.
      expect(found?.detectedAt.toISOString()).toBe(NOW.toISOString());
    });
  });

  describe("a channel whose credentials failed", () => {
    it("holds the reply for that account and says a person must act", async () => {
      const { conversationId, operationId } = await pendingDelivery();
      await infra.db.channelAccount.update({ where: { id: channelAccountId }, data: { status: "NEEDS_REAUTH" } });
      const sender = deliver(conversationId, operationId);

      await sender.run();

      expect(sender.sends()).toBe(0);
      // Cancelled rather than held, and deliberately: with the account disconnected the messaging window
      // cannot be evaluated at all, and the policy engine treats a window it cannot vouch for as closed
      // with no human path (decision on PR #67). A review item here would be one nobody could act on —
      // reconnecting is what unblocks the conversation, and the Inbox shows it with that state.
      expect(await statusOf(operationId)).toBe("CANCELLED_POLICY");

      const components = await collectHealth([databaseProbe(infra.db), ...channelAccountProbes([{ id: channelAccountId, status: "NEEDS_REAUTH" }])], NOW);
      expect(overallHealth(components)).toBe("ACTION_REQUIRED");
      expect(outboundBlockedByHealth(components, channelAccountId)).toBe(true);
      // Another account is unaffected: degrade by capability, not by tenant.
      expect(outboundBlockedByHealth(components, "some-other-account")).toBe(false);
    });
  });

  describe("a model provider outage", () => {
    it("delays replies without halting what was already approved", async () => {
      const { conversationId, operationId } = await pendingDelivery();
      // A generation the provider answered badly. It is stored HELD with the reason, not FAILED: the
      // audit row of what was attempted is worth keeping, and a CHECK constraint enforces that a draft
      // without text can only be held. A metric built on FAILED would have been permanently zero.
      await infra.db.aiDraft.create({
        data: {
          ...scope,
          conversationId,
          anchorMessageId: (await infra.db.message.findFirstOrThrow({ where: { conversationId }, select: { id: true } })).id,
          anchorStateVersion: 1,
          generationKey: `rel_unusable_${String(seq)}`,
          confidence: 0,
          modelSuggestsSend: false,
          needsReview: true,
          reasonCodes: ["INVALID_MODEL_OUTPUT"],
          status: "HELD",
          modelProvider: "fixture",
          modelName: "reliability",
          promptVersion: "reply.v1",
          schemaVersion: "ai-draft.v1",
        },
      });

      const components = await collectHealth(
        // Counted from the real clock, because `updated_at` is written by the database rather than by the
        // fixed instant the rest of this suite runs at.
        [databaseProbe(infra.db), aiProviderProbe("fixture", () => countUnusableGenerations(infra.db, new Date(Date.now() - 3_600_000)), 1)],
        NOW,
      );

      expect(overallHealth(components)).toBe("SOME_FEATURES_DEGRADED");
      // Nobody can act on a provider being slow, and a halt would cancel replies a business already approved.
      expect(outboundBlockedByHealth(components, channelAccountId)).toBe(false);
      const sender = deliver(conversationId, operationId);
      await sender.run();
      expect(sender.sends()).toBe(1);
    });
  });

  describe("a queue backlog", () => {
    it("stops outbound while it grows and resumes once it drains", async () => {
      const thresholds = { ...DEFAULT_BACKLOG_THRESHOLDS, waiting: 10, oldestWaitingMs: 60_000 };
      const suspensions = createSuspensionStore(infra.db);
      const piling = decideBackpressure([{ queue: "delivery", waiting: 50, oldestWaitingMs: 0 }], thresholds, { suspended: false }, NOW);
      expect(piling.kind).toBe("SUSPEND");
      if (piling.kind === "SUSPEND") {
        await suspensions.holdSystemSuspension({ reason: "BACKLOG", note: piling.detail, until: piling.until, at: NOW });
      }

      const first = await pendingDelivery();
      const blocked = deliver(first.conversationId, first.operationId);
      await blocked.run();

      // The guard reuses the switch the policy engine already honours, rather than a second mechanism.
      expect(blocked.sends()).toBe(0);
      expect(await statusOf(first.operationId)).toBe("HELD_REVIEW");

      const drained = decideBackpressure([{ queue: "delivery", waiting: 1, oldestWaitingMs: 0 }], thresholds, { suspended: true }, NOW);
      expect(drained.kind).toBe("LIFT");
      await suspensions.endSystemSuspension("BACKLOG", new Date(NOW.getTime() + 1_000));

      const second = await pendingDelivery();
      const allowed = deliver(second.conversationId, second.operationId, new Date(NOW.getTime() + 2_000));
      await allowed.run();
      expect(allowed.sends()).toBe(1);
    });

    it("never touches a switch a person pulled", async () => {
      const suspensions = createSuspensionStore(infra.db);
      await suspensions.suspend({ scope: "GLOBAL", reason: "OPERATOR", since: NOW, byUserId: ownerUserId, note: "investigating" });

      await suspensions.endSystemSuspension("BACKLOG", new Date(NOW.getTime() + 1_000));
      await suspensions.endSystemSuspension("OPERATOR", new Date(NOW.getTime() + 1_000));

      const { conversationId, operationId } = await pendingDelivery();
      const sender = deliver(conversationId, operationId, new Date(NOW.getTime() + 2_000));
      await sender.run();

      // An automatic guard must never be able to end a pause a person decided on.
      expect(sender.sends()).toBe(0);
      expect(await statusOf(operationId)).toBe("HELD_REVIEW");
    });

    it("extends its own stop rather than replacing it", async () => {
      const suspensions = createSuspensionStore(infra.db);
      const first = new Date(NOW.getTime() + 60_000);
      const later = new Date(NOW.getTime() + 300_000);
      await suspensions.holdSystemSuspension({ reason: "BACKLOG", note: "growing", until: first, at: NOW });
      await suspensions.holdSystemSuspension({ reason: "BACKLOG", note: "still growing", until: later, at: new Date(NOW.getTime() + 1_000) });

      expect(await infra.db.automationSuspension.count({ where: { reason: "BACKLOG", liftedAt: null } })).toBe(1);
      const active = await suspensions.activeSystemSuspension("BACKLOG", new Date(NOW.getTime() + 2_000));
      expect(active?.until?.toISOString()).toBe(later.toISOString());
    });
  });

  describe("the reconciliation store's own guards", () => {
    // Exercised directly, because the decision core reaches most of these only on a race it cannot
    // reproduce on demand: between loading an operation and writing a conclusion about it, an echo or a
    // second worker may already have settled it. The guards are what make that harmless, so they are
    // worth a test that does not depend on winning a race.
    const store = () => createReconciliationStore(infra.db);
    const opened = async (input: { operationId: string; deliveryJobId: string; conversationId: string }) => {
      await store().open({ ...scope, ...input, reason: "AMBIGUOUS_SEND_RESULT", detectedAt: NOW });
    };

    it("will not mark an operation sent once something else has settled it", async () => {
      const { conversationId, operationId } = await pendingDelivery();
      const sender = deliver(conversationId, operationId);
      await sender.run();
      await opened({ operationId, deliveryJobId: operationId, conversationId });

      await store().markSent(operationId, "mid-late-echo", AFTER_GRACE);

      // One operation, one outbound message. A second one is a duplicate reply in the customer's inbox.
      expect(await infra.db.message.count({ where: { operationId, direction: "OUT" } })).toBe(1);
      const job = await infra.db.deliveryJobRecord.findUniqueOrThrow({ where: { operationId }, select: { status: true, platformMessageId: true } });
      expect(job.status).toBe("SENT");
      expect(job.platformMessageId).not.toBe("mid-late-echo");
    });

    it("writes the message and the terminal state together, or neither", async () => {
      const { conversationId, operationId } = await pendingDelivery();
      await infra.db.deliveryJobRecord.update({ where: { operationId }, data: { status: "HELD_AMBIGUOUS", claimedAt: NOW, attemptCount: 1 } });
      await opened({ operationId, deliveryJobId: operationId, conversationId });

      await store().markSent(operationId, "mid-confirmed", AFTER_GRACE);

      // A SENT delivery with no message would let a later pass conclude nothing was sent and offer to
      // send again, which is the exact duplicate ADR-012 exists to prevent.
      expect(await infra.db.message.count({ where: { operationId, direction: "OUT", channelMessageId: "mid-confirmed" } })).toBe(1);
      expect(await statusOf(operationId)).toBe("SENT");
    });

    it("makes a resumed operation claimable again, with no claim left on it", async () => {
      const { conversationId, operationId } = await pendingDelivery();
      await infra.db.deliveryJobRecord.update({ where: { operationId }, data: { status: "HELD_AMBIGUOUS", claimedAt: NOW, attemptCount: 1 } });
      await opened({ operationId, deliveryJobId: operationId, conversationId });

      await store().resume(operationId, AFTER_GRACE);

      // A stale claim left behind would make the coordinator's conditional UPDATE find nothing, and the
      // resumed reply would sit there looking scheduled and never be taken.
      const job = await infra.db.deliveryJobRecord.findUniqueOrThrow({ where: { operationId }, select: { status: true, claimedAt: true, scheduledFor: true } });
      expect(job).toMatchObject({ status: "SCHEDULED", claimedAt: null });
      expect(job.scheduledFor.toISOString()).toBe(AFTER_GRACE.toISOString());
    });

    it("never turns a completed send into a review item", async () => {
      const { conversationId, operationId } = await pendingDelivery();
      const sender = deliver(conversationId, operationId);
      await sender.run();
      await opened({ operationId, deliveryJobId: operationId, conversationId });

      await store().escalate(operationId, "we could not tell", AFTER_GRACE);

      // The customer already has this reply. Asking a person to decide about it would be asking them to
      // decide something that cannot be undone.
      expect(await statusOf(operationId)).toBe("SENT");
    });

    it("keeps the moment the ambiguity first appeared, however often it is reported", async () => {
      const { conversationId, operationId } = await pendingDelivery();
      await infra.db.deliveryJobRecord.update({ where: { operationId }, data: { status: "HELD_AMBIGUOUS", claimedAt: NOW, attemptCount: 1 } });
      await opened({ operationId, deliveryJobId: operationId, conversationId });

      await store().open({
        ...scope,
        operationId,
        deliveryJobId: operationId,
        conversationId,
        reason: "AMBIGUOUS_SEND_RESULT",
        detectedAt: AFTER_GRACE,
        providerRequestId: "req-late",
      });

      const record = await infra.db.deliveryReconciliation.findUniqueOrThrow({ where: { operationId } });
      // The grace period before a person is told runs from the first detection. Refreshing it on every
      // retry would let an operation stay unresolved forever while looking freshly detected each time.
      expect(record.detectedAt.toISOString()).toBe(NOW.toISOString());
      // A provider request id arriving on a later report is new evidence, and is kept.
      expect(record.providerRequestId).toBe("req-late");
    });
  });

  describe("the operational picture", () => {
    it("counts what is stuck, from durable state rather than from memory", async () => {
      const ambiguous = await pendingDelivery();
      await infra.db.deliveryJobRecord.update({ where: { operationId: ambiguous.operationId }, data: { status: "HELD_AMBIGUOUS", claimedAt: NOW, attemptCount: 1 } });
      const held = await pendingDelivery();
      await infra.db.aiDraft.update({ where: { id: held.draftId }, data: { status: "HELD", needsReview: true } });

      const snapshot = await readReliabilitySnapshot(infra.db, AFTER_GRACE);

      expect(snapshot.ambiguousOperations).toBeGreaterThanOrEqual(1);
      expect(snapshot.draftsAwaitingReview).toBeGreaterThanOrEqual(1);
      expect(snapshot.at.toISOString()).toBe(AFTER_GRACE.toISOString());
    });
  });
});
