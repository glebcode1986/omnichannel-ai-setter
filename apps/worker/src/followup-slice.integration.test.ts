/**
 * A planned follow-up, from the table to a scheduled send and back into the table (#55).
 *
 * `GOALS_FOLLOWUPS.md` makes one claim about this feature that only an end-to-end test can check: "at
 * execution it asks for a reply through the path every automated send already uses. **There is no second
 * send path.**" So this file drives the real pieces — the real `follow_ups` table on a real PostgreSQL,
 * the real BullMQ queue on a real Redis, the real sweeper, the real AI-draft handler, the real policy
 * disposition and the real delivery scheduling — and substitutes only the reply model.
 *
 * It exists because of Astra's first P1 on PR #82: the store was correct and had no caller, so the whole
 * feature was unreachable. Every case here fails if any link in that chain is missing, which is what the
 * store's own tests could not tell us.
 *
 * Nothing is re-derived. Each assertion reads durable state the system wrote: a queued job, a draft row, a
 * delivery record, the follow-up's own status.
 */
import { followUpGenerationKey } from "@omnichannel/application";
import {
  appendInboundMessage,
  authorizeBusinessProfileAccess,
  createAiDraftStore,
  authorizeWorkspaceAccess,
  claimFollowUp,
  createBusinessProfile,
  createChannelAccount,
  createContactWithChannelIdentity,
  createConversation,
  createConversationOperationStore,
  createDraftContextStore,
  createWorkspaceWithOwner,
  dueFollowUps,
  planFollowUp,
  recordFollowUpSent,
  setPrimaryGoal,
  type DbClient,
} from "@omnichannel/db";
import { NO_CAPABILITIES, resolveStyleProfile } from "@omnichannel/domain";
import { AI_DRAFT_GENERATION, createQueueProducer, type AiDraftGenerationJob, type QueueProducer } from "@omnichannel/queue";
import { Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAiDraftHandler } from "./ai-draft-handler";
import { createDraftDisposition } from "./draft-disposition";
import { automatedRouteStillOpen } from "./followup-channel";
import { startFollowUpSweeper } from "./followup-sweeper";
import { createHandlers } from "./handlers";
import {
  createEndToEndInfrastructure,
  endToEndTestsEnabled,
  setProfileDefaultPolicy,
  waitFor,
  type EndToEndInfrastructure,
} from "./testing/infrastructure";

const NOW = new Date("2026-10-06T12:00:00.000Z");
/** The silence being chased: an inbound message a day old, still inside Instagram's standard window. */
const LAST_INBOUND = new Date(NOW.getTime() - 20 * 60 * 60 * 1000);
/** Due an hour ago, so a sweep at `NOW` finds it. */
const DUE = new Date(NOW.getTime() - 60 * 60 * 1000);
/** Wide open, so the business's own hours are never the reason a case refuses. */
const DAYPART = { timeZone: "UTC", startHour: 0, endHour: 23 };

describe.skipIf(!endToEndTestsEnabled())("a follow-up from the table to a scheduled send", () => {
  let infra: EndToEndInfrastructure;
  let db: DbClient;
  let scope: { workspaceId: string; businessProfileId: string };
  let context: Awaited<ReturnType<typeof authorizeBusinessProfileAccess>>;
  let channelAccountId: string;
  let producer: QueueProducer;
  let draftQueue: Queue;
  let seq = 0;

  beforeAll(async () => {
    infra = await createEndToEndInfrastructure();
    db = infra.db;
    const user = await db.user.create({ data: { name: "Follow-up Owner", email: "followup-owner@example.test" } });
    const { workspaceId } = await createWorkspaceWithOwner(db, { name: "Follow-up Workspace", ownerUserId: user.id });
    const workspace = await authorizeWorkspaceAccess(db, { userId: user.id, workspaceId });
    const { businessProfileId } = await createBusinessProfile(db, workspace, { name: "Follow-up Profile" });
    context = await authorizeBusinessProfileAccess(db, { userId: user.id, workspaceId, businessProfileId });
    scope = { workspaceId, businessProfileId };

    const account = await createChannelAccount(db, context, {
      channel: "INSTAGRAM",
      externalAccountId: "ig-account-followup",
      capabilities: { ...NO_CAPABILITIES, text: true },
    });
    channelAccountId = account.id;

    // The business runs on autopilot: a follow-up's draft is sent without a person, which is the only
    // configuration in which the whole chain reaches a scheduled operation.
    await setProfileDefaultPolicy(db, scope, {
      mode: "AUTOPILOT",
      confidenceThreshold: 0.8,
      mandatoryReviewReasons: [],
      deliveryDelayMinMs: 1_000,
      deliveryDelayMaxMs: 2_000,
    });

    producer = createQueueProducer({ connection: infra.connect("producer"), logger: infra.logger, prefix: infra.prefix });
    draftQueue = new Queue(AI_DRAFT_GENERATION.queueName, { connection: infra.connect("producer"), prefix: infra.prefix });
  }, 180_000);

  afterAll(async () => {
    await draftQueue?.close().catch(() => undefined);
    await producer?.close().catch(() => undefined);
    await infra?.dispose();
  });

  /**
   * A conversation of its own per case, with a goal and one pending follow-up.
   *
   * Its own conversation on purpose: the claim re-reads the newest inbound, the takeover and the review
   * state, so one case's customer reply would decide the next case's answer.
   */
  const scenario = async () => {
    seq += 1;
    const identity = await createContactWithChannelIdentity(db, context, { channelAccountId, externalUserId: `ig-user-followup-${String(seq)}` });
    const conversation = await createConversation(db, context, { channelAccountId, channelIdentityId: identity.channelIdentityId });
    const anchor = await appendInboundMessage(db, context, {
      conversationId: conversation.id,
      kind: "TEXT",
      text: "Can I come in on Saturday?",
      occurredAt: LAST_INBOUND,
    });
    const goal = await setPrimaryGoal(db, context, { conversationId: conversation.id, kind: "BOOK_APPOINTMENT", at: LAST_INBOUND });
    const planned = await planFollowUp(db, context, {
      conversationId: conversation.id,
      goalId: goal.status === "SET" ? goal.id : "",
      dueAt: DUE,
      daypart: DAYPART,
      at: LAST_INBOUND,
    });
    if (planned.status !== "PLANNED") {
      throw new Error(`fixture could not plan a follow-up: ${planned.status}`);
    }
    return { conversationId: conversation.id, anchorMessageId: anchor.id, followUpId: planned.id };
  };

  /**
   * The real sweeper over the real store and the real queue, exactly as `main.ts` composes it, run until
   * it has taken one pass over the due work.
   *
   * The loop keeps its own schedule and `close()` only waits for a pass already running, so "one pass" is
   * made true here rather than assumed: the scan answers once and returns nothing afterwards. Fake timers
   * would be the other way to do it and are not an option — Prisma and ioredis want real ones.
   */
  const sweep = async (at: Date = NOW): Promise<void> => {
    let scanned = false;
    const loop = startFollowUpSweeper({
      intervalMs: 5,
      limit: 50,
      due: ({ now, limit }) => {
        if (scanned) {
          return Promise.resolve([]);
        }
        scanned = true;
        return dueFollowUps(db, now, limit);
      },
      // The real claim with the real window question, exactly as `main.ts` composes it.
      claim: (followUpId, now) => claimFollowUp(db, followUpId, now, { carries: automatedRouteStillOpen }),
      producer,
      logger: infra.logger,
      now: () => at,
      newCorrelationId: () => `corr-followup-${String(++seq)}`,
    });
    await waitFor(() => scanned);
    await loop.close();
  };

  /**
   * The queue job this attempt would have, looked up by the identity the registry derives.
   *
   * Recomputed from the follow-up's own identifiers rather than read from the job: an assertion that
   * fetched by whatever id the sweeper happened to use could not tell a wrong identity from a right one,
   * and the identity is what makes a re-enqueued attempt one job and a second attempt two.
   */
  const queuedFor = async (
    identity: { readonly conversationId: string; readonly anchorMessageId: string; readonly followUpId: string },
    attempt: number,
  ) =>
    draftQueue.getJob(
      AI_DRAFT_GENERATION.jobId({
        schemaVersion: 1,
        ...scope,
        correlationId: "not part of the identity",
        conversationId: identity.conversationId,
        anchorMessageId: identity.anchorMessageId,
        trigger: { kind: "FOLLOW_UP", followUpId: identity.followUpId, attempt },
      }),
    );

  /**
   * The real handler behind the real queue-to-handler bridge, with the real disposition. Only the reply
   * model is a fixture.
   *
   * It goes through `createHandlers` rather than calling the handler directly, because that bridge is
   * where a queue payload becomes a draft job — and a test that rebuilt the job itself would prove the
   * handler works on a job the worker never actually produces.
   */
  const runDraftJob = async (job: AiDraftGenerationJob): Promise<void> => {
    const handler = createAiDraftHandler({
      engine: {
        model: {
          generate: () =>
            Promise.resolve({
              output: {
                reply: "Just checking in — Saturday at 11 is still free if you'd like it.",
                confidence: 0.92,
                should_send: true,
                needs_review: false,
                reason_codes: [],
                intent: "BOOKING",
                lead_stage: "ENGAGED",
                suggested_action: null,
                factual_source_ids: [],
              },
              provider: "fixture",
              model: "followup",
              latencyMs: 7,
            }),
        },
        drafts: createAiDraftStore(db),
        log: infra.logger,
        now: () => NOW,
        newNonce: () => `nonce-${String(++seq)}`,
        promptVersion: "reply.v1",
        schemaVersion: "ai-draft.v1",
      },
      context: createDraftContextStore(db),
      recordFollowUpSent: ({ followUpId, operationId }) => recordFollowUpSent(db, followUpId, operationId, NOW),
      dispose: createDraftDisposition({ db, producer, logger: infra.logger, now: () => NOW, random: () => 0.5 }),
      retrieval: {
        knowledge: { search: () => Promise.resolve({ hits: [], diagnostics: { lexicalCandidates: 0, semanticCandidates: 0 } }) },
        style: { search: () => Promise.resolve({ hits: [], diagnostics: { lexicalCandidates: 0, semanticCandidates: 0 } }) },
        log: infra.logger,
      },
      styleProfiles: { load: () => Promise.resolve([{ persona: "Friendly studio assistant." }]) },
      platformStyleFallback: resolveStyleProfile([{ persona: "Platform default assistant." }]),
      logger: infra.logger,
    });
    const handlers = createHandlers(
      handler,
      () => Promise.reject(new Error("no delivery is processed in this slice")),
      () => Promise.reject(new Error("no debounce is processed in this slice")),
      () => Promise.reject(new Error("no reconciliation is processed in this slice")),
    );
    // The queue's own job identity and attempt number, as the worker would pass them.
    await handlers.generateAiDraft(job, { jobId: AI_DRAFT_GENERATION.jobId(job), attempt: 1, logger: infra.logger });
  };

  const followUpRow = async (followUpId: string) =>
    db.followUp.findUniqueOrThrow({
      where: { id: followUpId },
      select: { status: true, stopReason: true, attemptCount: true, deliveryOperationId: true, dueAt: true },
    });

  it("turns a due row into exactly one queued draft job, and the lease keeps the next pass off it", async () => {
    const planned = await scenario();
    const { conversationId, anchorMessageId, followUpId } = planned;

    await sweep();

    const job = await queuedFor(planned, 1);
    // The job exists, which is the whole of the blocker: before the sweeper, `dueFollowUps` and
    // `claimFollowUp` had no caller and this queue stayed empty for ever.
    expect(job?.data).toMatchObject({
      ...scope,
      conversationId,
      anchorMessageId,
      trigger: { kind: "FOLLOW_UP", followUpId, attempt: 1 },
    });
    // It is the same job the queue would build from the payload, so a re-enqueued attempt is one job.
    expect(job?.name).toBe(AI_DRAFT_GENERATION.jobName);
    expect(await followUpRow(followUpId)).toMatchObject({ status: "PENDING", attemptCount: 1 });

    // The claim moved `due_at` forward by the lease, so a second worker sweeping a second later finds
    // nothing to do rather than spending another attempt on the same silence.
    await sweep(new Date(NOW.getTime() + 1_000));
    expect(await followUpRow(followUpId)).toMatchObject({ attemptCount: 1 });
    expect(await queuedFor(planned, 2)).toBeUndefined();
  }, 180_000);

  it("ends with one draft, one scheduled operation and a follow-up that names it", async () => {
    const planned = await scenario();
    const { followUpId } = planned;

    await sweep();
    const job = await queuedFor(planned, 1);
    await runDraftJob(job?.data as AiDraftGenerationJob);

    const row = await followUpRow(followUpId);
    expect(row.status).toBe("SENT");
    expect(row.deliveryOperationId).toBeTruthy();
    // The operation is the delivery coordinator's, written by `scheduleAutomatedDelivery` — there is no
    // second send path, and the follow-up names the one that exists rather than one of its own.
    const delivery = await db.deliveryJobRecord.findUniqueOrThrow({
      where: { operationId: row.deliveryOperationId ?? "" },
      select: { draftId: true, status: true },
    });
    const draft = await db.aiDraft.findUniqueOrThrow({ where: { id: delivery.draftId ?? "" }, select: { generationKey: true, trigger: true } });
    // The draft is keyed to *this attempt*, which is what makes the crash recovery below possible: the
    // key is the durable evidence that this attempt got as far as asking the model.
    expect(draft.generationKey).toBe(
      // Derived from the fixture, not from the job: a key read back out of the thing under test would
      // agree with itself whatever it contained.
      followUpGenerationKey({ conversationId: planned.conversationId, anchorMessageId: planned.anchorMessageId, followUpId, attempt: 1 }),
    );
    expect(draft.trigger).toBe("FOLLOW_UP");
    // And the settled row is gone from the scan, so no later pass has to reason about it.
    expect((await dueFollowUps(db, new Date(NOW.getTime() + 60 * 60 * 1000))).map((candidate) => candidate.id)).not.toContain(followUpId);
  }, 180_000);

  it("records the operation a dead worker scheduled instead of chasing the customer twice", async () => {
    const planned = await scenario();
    const { followUpId } = planned;

    await sweep();
    const job = await queuedFor(planned, 1);
    await runDraftJob(job?.data as AiDraftGenerationJob);
    const scheduled = await followUpRow(followUpId);

    // The crash: the worker scheduled the delivery and died before the follow-up was recorded. The row it
    // left behind is `PENDING` with one attempt spent and a lease that has since lapsed — which is
    // exactly what the database held for the instant between those two writes.
    await db.followUp.update({
      where: { id: followUpId },
      data: { status: "PENDING", deliveryOperationId: null, settledAt: null, dueAt: DUE },
    });

    await sweep(new Date(NOW.getTime() + 10 * 60_000));

    const recovered = await followUpRow(followUpId);
    // The same operation, not a second one. Two operations would be two sends about one silence, and
    // nothing downstream could deduplicate them because their identities differ.
    expect(recovered).toMatchObject({ status: "SENT", attemptCount: 1, deliveryOperationId: scheduled.deliveryOperationId });
    // One operation for this conversation, not two. Counted through the draft, because that is where an
    // AI-composed delivery keeps its conversation — the record's own `conversation_id` is set only for a
    // reply a person wrote. And scoped to the conversation rather than the profile: every case here
    // shares one Business Profile, so a profile-wide count would be measuring its neighbours.
    expect(await db.deliveryJobRecord.count({ where: { ...scope, draft: { conversationId: planned.conversationId } } })).toBe(1);
    // And no second attempt was queued, so the model is never asked again for a message already sent.
    expect(await queuedFor(planned, 2)).toBeUndefined();
  }, 180_000);

  it("still holds an ordinary reply to the same old message, so the budget was scoped and not removed", async () => {
    const planned = await scenario();

    // The same conversation, the same twenty-hour-old message — and a draft that answers it rather than
    // chasing the silence. The provider's automated-response budget applies to this one, it ran out
    // nineteen hours ago, and the reply must become a person's decision rather than a late automated
    // send. Without this case, deleting the budget outright would pass every assertion above.
    await runDraftJob({
      schemaVersion: 1,
      ...scope,
      correlationId: "corr-ordinary-reply",
      conversationId: planned.conversationId,
      anchorMessageId: planned.anchorMessageId,
      trigger: { kind: "AUTOMATIC", reason: "DEBOUNCE_ELAPSED" },
    });

    const draft = await db.aiDraft.findFirstOrThrow({
      where: { ...scope, conversationId: planned.conversationId, trigger: "AUTOMATIC" },
      select: { id: true },
    });
    expect(await db.deliveryJobRecord.count({ where: { ...scope, draftId: draft.id } })).toBe(0);
    expect(await db.conversation.findUniqueOrThrow({
      where: { workspaceId_businessProfileId_id: { ...scope, id: planned.conversationId } },
      select: { takeoverState: true },
    })).toMatchObject({ takeoverState: "REVIEW_REQUIRED" });
  }, 180_000);

  it("queues nothing, and asks no model, once the messaging window has closed with no route left", async () => {
    const planned = await scenario();

    // Two days of silence: outside Instagram's 24-hour window, and this profile is on the conservative
    // `STANDARD_ONLY` default, so nothing could carry the message. The claim says so before spending an
    // attempt, which is the difference between declining and paying for a draft to be declined.
    await sweep(new Date(LAST_INBOUND.getTime() + 48 * 60 * 60 * 1000));

    expect(await followUpRow(planned.followUpId)).toMatchObject({
      status: "BLOCKED",
      stopReason: "CHANNEL_INELIGIBLE",
      attemptCount: 0,
    });
    expect(await queuedFor(planned, 1)).toBeUndefined();
    expect(await db.aiDraft.count({ where: { ...scope, conversationId: planned.conversationId } })).toBe(0);
  }, 180_000);

  it("queues nothing at all once the customer has written back", async () => {
    const planned = await scenario();
    const { conversationId, followUpId } = planned;

    // The real path a webhook takes, which settles the follow-up in the transaction that stores the
    // message — so the sweep below never even sees it.
    await appendInboundMessage(db, context, {
      conversationId,
      kind: "TEXT",
      text: "sorry! yes, Saturday works",
      occurredAt: new Date(NOW.getTime() - 60_000),
    });
    await sweep();

    expect(await followUpRow(followUpId)).toMatchObject({ status: "SUPERSEDED", stopReason: "NEW_INBOUND", attemptCount: 0 });
    expect(await queuedFor(planned, 1)).toBeUndefined();
  }, 180_000);

  it("queues nothing at all once a person is handling the conversation", async () => {
    const planned = await scenario();
    const { conversationId, followUpId } = planned;

    await createConversationOperationStore(db, context).takeOver({ conversationId, at: new Date(NOW.getTime() - 60_000) });
    await sweep();

    expect(await followUpRow(followUpId)).toMatchObject({ status: "CANCELLED", stopReason: "HUMAN_TAKEOVER", attemptCount: 0 });
    expect(await queuedFor(planned, 1)).toBeUndefined();
  }, 180_000);
});
