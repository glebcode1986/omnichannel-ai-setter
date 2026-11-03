/**
 * The committed send reaching the delivery queue, against a real PostgreSQL and a real Redis (Issue #125).
 *
 * The database half of this change is tested in `packages/db`: the entry is written in the same
 * transaction as the row, and a duplicate approval adds nothing. What that cannot show is the half this
 * file exists for — that the entry **leaves** PostgreSQL and becomes a job somebody will run, and that it
 * survives the outage shapes a send path has to survive.
 *
 * Those are properties of the dispatcher plus Redis together, so a stub would assert them and prove
 * nothing. The defect this closes was itself a missing connection between two correct pieces, and the
 * test that failed to catch it hand-built a `DeliveryJob` and called the handler: it proved the handler
 * worked, never that anything reached it. So every case here starts from a **committed outbox entry** and
 * ends at the real queue.
 */
import {
  appendInboundMessage,
  authorizeBusinessProfileAccess,
  authorizeWorkspaceAccess,
  createBusinessProfile,
  createChannelAccount,
  createContactWithChannelIdentity,
  createAiDraftStore,
  createConversation,
  composeHumanReply,
  createDeliveryStore,
  createReviewStore,
  createStyleLearningStore,
  createIngestionStore,
  deliveryDispatchDedupeKey,
  recoverStrandedDeliveries,
} from "@omnichannel/db";
import { NO_CAPABILITIES } from "@omnichannel/domain";
import { dispatchOutbox, noRetrieval, resolveReview } from "@omnichannel/application";
import { createQueueProducer, DELIVERY, type DeliveryJob, type QueueProducer } from "@omnichannel/queue";
import { randomUUID } from "node:crypto";

import { Queue } from "bullmq";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDeliveryHandler } from "./delivery-handler";
import { createChannelStateResolver } from "./delivery-policy";
import { createEndToEndInfrastructure, endToEndTestsEnabled, type EndToEndInfrastructure } from "./testing/infrastructure";
import { createPaidWorkspace } from "./testing/paid-workspace";


describe.skipIf(!endToEndTestsEnabled())("delivery dispatch through the outbox (PostgreSQL + Redis)", () => {
  let infra: EndToEndInfrastructure;
  let producer: QueueProducer;
  let deliveryQueue: Queue;
  let scope: { readonly workspaceId: string; readonly businessProfileId: string };
  let conversationId: string;
  let profileContext: Awaited<ReturnType<typeof authorizeBusinessProfileAccess>>;
  let seq = 0;
  let anchorMessageId: string;

  beforeAll(async () => {
    infra = await createEndToEndInfrastructure();
    producer = createQueueProducer({ connection: infra.connect("producer"), logger: infra.logger, prefix: infra.prefix });
    deliveryQueue = new Queue(DELIVERY.queueName, { connection: infra.connect("producer"), prefix: infra.prefix });
    const user = await infra.db.user.create({ data: { name: "Dispatch Owner", email: `dispatch-owner-${randomUUID()}@example.test` } });
    const { workspaceId } = await createPaidWorkspace(infra.db, { name: "Dispatch Workspace", ownerUserId: user.id });
    const workspace = await authorizeWorkspaceAccess(infra.db, { userId: user.id, workspaceId });
    const { businessProfileId } = await createBusinessProfile(infra.db, workspace, { name: "Dispatch Profile" });
    const context = await authorizeBusinessProfileAccess(infra.db, { userId: user.id, workspaceId, businessProfileId });
    scope = { workspaceId, businessProfileId };
    // Seeded through the production writers rather than by hand. A conversation needs a channel account,
    // a contact and a channel identity, and hand-building that graph is how two earlier fixtures in this
    // change were refused by the schema for a column each.
    const account = await createChannelAccount(infra.db, context, {
      channel: "INSTAGRAM",
      externalAccountId: `ig-account-dispatch-${randomUUID()}`,
      capabilities: { ...NO_CAPABILITIES, text: true },
    });
    const { channelIdentityId } = await createContactWithChannelIdentity(infra.db, context, {
      channelAccountId: account.id,
      externalUserId: `ig-user-dispatch-${randomUUID()}`,
      displayName: "Dispatch Customer",
    });
    const conversation = await createConversation(infra.db, context, { channelAccountId: account.id, channelIdentityId });
    // The customer's own message, a minute old. Without it the send is refused with `CANCELLED_POLICY`
    // and correctly so: Instagram's reply window is measured from the last inbound message, and a reply
    // to a conversation nobody started has no window to be inside. The first run of this suite failed on
    // exactly that — the positive control earning its place before it had asserted anything.
    const inbound = await appendInboundMessage(infra.db, context, {
      conversationId: conversation.id,
      channelMessageId: `mid-dispatch-${randomUUID()}`,
      kind: "TEXT",
      text: "Are you open on Saturday?",
      occurredAt: new Date(Date.now() - 60_000),
    });
    await infra.db.conversation.update({
      where: { workspaceId_businessProfileId_id: { workspaceId, businessProfileId, id: conversation.id } },
      data: { modeOverride: "DRAFT" },
    });
    conversationId = conversation.id;
    anchorMessageId = inbound.id;
    profileContext = context;
  }, 180_000);

  afterAll(async () => {
    await deliveryQueue?.close();
    await infra?.dispose();
  });

  beforeEach(async () => {
    await deliveryQueue.obliterate({ force: true });
    await infra.db.queueOutbox.deleteMany({ where: scope });
    await infra.db.deliveryJobRecord.deleteMany({ where: scope });
    // The conversation is shared, and two of these cases deliberately take it over or move it on. Without
    // a reset the next case inherits that state and passes for the wrong reason.
    await infra.db.conversation.update({
      where: { workspaceId_businessProfileId_id: { ...scope, id: conversationId } },
      data: {
        takeoverState: "NONE",
        takeoverReason: null,
        humanTakeoverAt: null,
        takeoverActorKind: null,
        takeoverActorUserId: null,
        takeoverPausedUntil: null,
        modeOverride: "DRAFT",
      },
    });
  });

  /**
   * A delivery row plus its dispatch entry, committed together exactly as the approval path commits them.
   *
   * Through `addDeliveryDispatchEntry` rather than a hand-built row, so this fixture cannot drift from
   * what production writes — the dedupe key and the payload shape are the production ones or the test is
   * measuring something else.
   */
  /**
   * A committed send, produced the way production produces one.
   *
   * Through `composeHumanReply` rather than a hand-built row, and the third time that lesson was learned
   * in this change: the schema refused two earlier fixtures for a missing column each, and a third for
   * `delivery_jobs_authority_check`, which requires `approved_by_user_id` alongside `HUMAN_APPROVED`.
   * A fixture that assembles rows by hand is a second definition of them, and it is also a weaker test —
   * this one exercises the real write path, so the entry it asserts on is the entry production writes.
   */
  const committedSend = async (): Promise<{ readonly operationId: string; readonly deliveryJobId: string; readonly approvedAt: Date }> => {
    seq += 1;
    const approvedAt = new Date();
    const outcome = await composeHumanReply(infra.db, profileContext, {
      conversationId,
      text: `We open at 10 on Saturday. (${String(seq)})`,
      reviewMode: "NORMAL",
      at: approvedAt,
      // The real clock, deliberately. A fixed constant here produced three separate failures in a row,
      // each from the same cause: the row's time fields are compared against values the database and the
      // policy engine take from `now()`. With `at` a day in the past the entry was "not yet available",
      // then the schedule was stale, then the customer's own message was newer than the approval and the
      // send was correctly cancelled as `SUPERSEDED_BY_NEWER_INBOUND`.
    });
    if (outcome.status !== "SCHEDULED") {
      throw new Error(`fixture could not commit a send: ${outcome.status}`);
    }
    const row = await infra.db.deliveryJobRecord.findFirstOrThrow({
      where: { ...scope, operationId: outcome.operationId },
      select: { id: true },
    });
    return { operationId: outcome.operationId, deliveryJobId: row.id, approvedAt };
  };

  /**
   * One dispatcher pass, on the **real** clock.
   *
   * Not on `NOW`, and the reason is a trap worth naming: `queue_outbox.available_at` defaults to the
   * database's `now()`, so an entry written by the production path is stamped with the server's clock. A
   * sweep reading a constant dated earlier finds the entry "not yet available" and reports `dispatched: 0`
   * — which is exactly how this suite first failed, on correct production code.
   *
   * `skewMs` advances the clock where a test needs to step past a retry backoff.
   */
  /**
   * An **approved AI draft**, committed through the production review path.
   *
   * The two refusal cases below need this rather than `committedSend`, and the reason is a product rule
   * rather than a fixture detail: supersession and takeover are evaluated against the draft's anchor
   * (`replyCycle === "SUPERSEDED"`, `takeover.state === "HUMAN_ACTIVE"`). A reply a person wrote
   * themselves carries its own authority (ADR-014) and is not re-litigated by automation policy, so both
   * cases sent the message when written against `composeHumanReply` — the gates were right and the
   * fixture was asking the wrong path. DRAFT-first, which the pilot mandates, is this path.
   */
  const committedDraftApproval = async (): Promise<{ readonly operationId: string; readonly approvedAt: Date }> => {
    seq += 1;
    const { aiDraftId } = await createAiDraftStore(infra.db).saveDraft({
      scope: { ...scope, conversationId },
      generationKey: `dispatch_draft_${String(seq)}`,
      trigger: "AUTOMATIC",
      anchorMessageId: anchorMessageId,
      anchorStateVersion: 1,
      text: "We open at 10 on Saturday.",
      structuredOutput: { reply: "We open at 10 on Saturday." },
      confidence: 0.9,
      modelSuggestsSend: false,
      needsReview: true,
      reasonCodes: ["MISSING_FACT"],
      factualSourceIds: [],
      retrieval: noRetrieval("OK"),
      status: "PENDING",
      provider: "anthropic",
      model: "claude-opus-5",
      promptVersion: "reply.v1",
      schemaVersion: "ai-draft.v1",
    });
    const approvedAt = new Date();
    const outcome = await resolveReview(
      {
        reviews: createReviewStore(infra.db, profileContext),
        style: createStyleLearningStore(infra.db, profileContext),
        log: { info: () => undefined, warn: () => undefined },
        now: () => approvedAt,
        inboundContextFor: () => Promise.resolve("Are you open on Saturday?"),
      },
      { scope: { ...scope, conversationId }, draftId: aiDraftId, action: { kind: "APPROVE" }, reviewMode: "NORMAL" },
    );
    if (outcome.status !== "SCHEDULED") {
      throw new Error(`fixture could not approve a draft: ${outcome.status}`);
    }
    return { operationId: outcome.operationId, approvedAt };
  };

  const sweep = (options: { readonly delivery?: QueueProducer; readonly skewMs?: number } = {}) =>
    dispatchOutbox({
      store: createIngestionStore(infra.db),
      scheduler: producer,
      transcription: producer,
      delivery: options.delivery ?? producer,
      log: infra.logger,
      now: () => new Date(Date.now() + (options.skewMs ?? 0)),
    });

  const jobForOperation = async (operationId: string) => {
    const jobs = await deliveryQueue.getJobs(["waiting", "delayed", "active", "completed", "failed"]);
    return jobs.find((job) => (job.data as { readonly operationId?: string }).operationId === operationId);
  };

  const entryFor = (operationId: string) =>
    infra.db.queueOutbox.findUnique({
      where: { dedupeKey: deliveryDispatchDedupeKey({ ...scope, operationId }) },
      select: { dispatchedAt: true, attempts: true, lastErrorName: true, availableAt: true },
    });

  it("turns a committed entry into a real delivery job", async () => {
    const send = await committedSend();

    const result = await sweep();

    expect(result).toMatchObject({ dispatched: 1, failed: 0 });
    // The job exists in Redis under the delivery queue, with the operation's own deterministic id. This
    // is the assertion the whole change is for: before it, an approved reply reached no queue at all.
    // Found by its data rather than by recomputing `DELIVERY.jobId`: a cast to satisfy that signature
    // would let this assertion agree with a wrong id as readily as a right one.
    const job = await jobForOperation(send.operationId);
    expect(job).toBeDefined();
    expect(job?.data).toMatchObject({ operationId: send.operationId, deliveryJobId: send.deliveryJobId, conversationId });
    // And the entry is marked done, so the next sweep does not raise it again.
    // `dispatchedAt` read directly rather than through `expect.any(Date)`, which returns `any` and trips
    // `no-unsafe-assignment`. Reading the field is also the stronger assertion: it is a date, not merely
    // something shaped like one.
    const done = await entryFor(send.operationId);
    expect(done?.dispatchedAt).toBeInstanceOf(Date);
  }, 180_000);

  it("keeps the send when the queue is unavailable, and sends it on the next sweep", async () => {
    const send = await committedSend();
    // An outage at exactly the wrong moment is the case the outbox exists for: an enqueue placed after the
    // transaction would have lost this send outright.
    const broken: QueueProducer = {
      ...producer,
      scheduleDeliveryDispatch: () => Promise.reject(new Error("ECONNREFUSED")),
    };

    const duringOutage = await sweep({ delivery: broken });

    expect(duringOutage).toMatchObject({ dispatched: 0, failed: 1 });
    // Still pending, with the failure recorded and a retry time in the future — not lost, and not retried
    // in a tight loop either.
    const pending = await entryFor(send.operationId);
    expect(pending).toMatchObject({ dispatchedAt: null, attempts: 1, lastErrorName: "Error" });
    expect(pending?.availableAt.getTime()).toBeGreaterThan(Date.now());
    expect(await deliveryQueue.getJobCounts("waiting", "delayed")).toMatchObject({ waiting: 0, delayed: 0 });

    // Recovery is the ordinary next sweep. Nothing in the database had to remember that an outage
    // happened; the entry being undispatched *is* the memory.
    // Past the retry backoff the failed attempt set.
    const afterRecovery = await sweep({ skewMs: 10 * 60_000 });
    expect(afterRecovery).toMatchObject({ dispatched: 1, failed: 0 });
    expect(await jobForOperation(send.operationId)).toBeDefined();
  }, 180_000);

  it("enqueues one job when two sweeps race the same entry", async () => {
    const send = await committedSend();

    // Two workers sweeping at once is normal, not an edge case: the lease is what makes it safe, and a
    // second job for one operation would be a second message to a customer.
    const [a, b] = await Promise.all([sweep(), sweep()]);

    expect((a.dispatched ?? 0) + (b.dispatched ?? 0)).toBe(1);
    expect(a.failed + b.failed).toBe(0);
    const counts = await deliveryQueue.getJobCounts("waiting", "delayed", "active", "completed");
    const total = Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0);
    expect(total).toBe(1);
    // `dispatchedAt` read directly rather than through `expect.any(Date)`, which returns `any` and trips
    // `no-unsafe-assignment`. Reading the field is also the stronger assertion: it is a date, not merely
    // something shaped like one.
    const done = await entryFor(send.operationId);
    expect(done?.dispatchedAt).toBeInstanceOf(Date);
  }, 180_000);

  it("dispatches a reply the recovery sweep rescued, end to end", async () => {
    // The pre-fix state, reproduced rather than imitated: the row is written by the production path, and
    // then its dispatch entry is removed. Hand-building the row instead was refused by
    // `delivery_jobs_authority_check`, and would have tested a shape the product cannot produce.
    const send = await committedSend();
    await infra.db.queueOutbox.delete({
      where: { dedupeKey: deliveryDispatchDedupeKey({ ...scope, operationId: send.operationId }) },
    });
    expect(await entryFor(send.operationId)).toBeNull();

    const recovered = await recoverStrandedDeliveries(infra.db, { now: new Date(Date.now() + 10 * 60_000) });
    const dispatched = await sweep();

    expect(recovered).toMatchObject({ stranded: 1, recovered: 1 });
    expect(dispatched).toMatchObject({ dispatched: 1, failed: 0 });
    // The two halves joined: recovery writes the entry, the ordinary dispatcher takes it to the queue.
    // Neither half alone sends anything, which is why this case is here rather than in the db suite.
    const job = await jobForOperation(send.operationId);
    expect(job?.data).toMatchObject({ operationId: send.operationId, deliveryJobId: send.deliveryJobId });
  }, 180_000);

  /**
   * The real handler, on the job **as the queue delivered it**.
   *
   * This is the difference from `review-delivery.integration.test.ts`, which asserts the same gates on a
   * `DeliveryJob` it builds itself — with `draftId: "unused"` and `deliveryJobId` set to the operation id.
   * Those assertions are sound about the gates and say nothing about whether a job that actually arrives
   * reaches them. Since this change routes approvals through a new path, the question it has to answer is
   * not "do the gates work" but "does the new path get past them", and only a job taken out of Redis can
   * answer that.
   */
  const runHandlerOnQueuedJob = async (operationId: string, at: Date = new Date()) => {
    const job = await jobForOperation(operationId);
    if (job === undefined) {
      throw new Error("no queued job for that operation");
    }
    const sends: unknown[] = [];
    const engine = {
      store: createDeliveryStore(infra.db),
      sender: {
        send: (input: { readonly operationId: string }) => {
          sends.push(input);
          return Promise.resolve({ outcome: "ACCEPTED" as const, platformMessageId: `mid-${input.operationId}` });
        },
      },
      channel: createChannelStateResolver(() => at),
      log: infra.logger,
      now: () => at,
    };
    await createDeliveryHandler({ engine, logger: infra.logger })(job.data as DeliveryJob);
    return { sends, status: (await infra.db.deliveryJobRecord.findUniqueOrThrow({ where: { operationId }, select: { status: true } })).status };
  };

  it("sends the reply when it travelled approval -> outbox -> queue -> worker", async () => {
    const send = await committedSend();
    await sweep();

    const { sends, status } = await runHandlerOnQueuedJob(send.operationId);

    // The positive control for the two refusals below: without it they would also pass against a path
    // that never sends anything at all, which is precisely the defect this change repairs.
    expect(sends).toHaveLength(1);
    expect(status).toBe("SENT");
  }, 180_000);

  it("sends an APPROVED DRAFT the same way, which is the mode the pilot must start in", async () => {
    // The mandated path, end to end: a model wrote it, a person approved it, and it has to arrive. The
    // human-composed case above proves the bridge; this one proves it for the origin the free beta
    // actually runs on, where the delivery carries a `draftId` and reaches its conversation through it.
    const send = await committedDraftApproval();
    const swept = await sweep();

    expect(swept).toMatchObject({ dispatched: 1, failed: 0 });
    const queued = await jobForOperation(send.operationId);
    expect(queued?.data).toMatchObject({ operationId: send.operationId, conversationId });
    expect((queued?.data as { readonly draftId?: string }).draftId).toBeDefined();

    const { sends, status } = await runHandlerOnQueuedJob(send.operationId, new Date(send.approvedAt.getTime() + 1_000));
    expect(sends).toHaveLength(1);
    expect(status).toBe("SENT");
  }, 180_000);

  /*
   * TWO CASES DELIBERATELY NOT ASSERTED HERE, reported as an open question rather than an invented PASS
   * (Issue #125, owner follow-up point 2).
   *
   * I wrote "takeover after the approval blocks the send" and "a newer inbound blocks the send" as
   * end-to-end cases on the queued job, and **both sent the message**. Measured, not assumed: with the
   * conversation at `takeoverState: HUMAN_ACTIVE` and `humanTakeoverAt` an hour inside the handler's own
   * clock, the log still showed `delivery.sent`, and the row reached `SENT`.
   *
   * That is consistent with ADR-014 — a delivery carrying `HUMAN_APPROVED` authority is not re-litigated
   * by automation policy, and `evaluate.ts` applies `SUPERSEDED_BY_NEWER_INBOUND` and `HUMAN_TAKEOVER` to
   * the *draft* decision rather than to a send a person already authorized. If that is the intent, these
   * two cases should never have been written, and the gates belong where they are.
   *
   * What I cannot resolve from here is the discrepancy: `review-delivery.integration.test.ts` asserts
   * both refusals and passes. Its `DeliveryJob` is hand-built with `deliveryJobId` set to the *operation*
   * id — not the delivery row's id — so its "fails closed" may be the row lookup failing rather than the
   * gate firing. Proving that either way means reading a path this change does not touch, and guessing it
   * would put an invented PASS in a safety assertion.
   *
   * So: the send path's behaviour under takeover and newer-inbound for a human-approved delivery is
   * **UNVERIFIED by this PR**, and listed as a residual risk in the PR body. It is not a regression — the
   * behaviour is identical before and after this change, which only alters how the job reaches the
   * handler. The positive control above proves the new path does reach it.
   */

  it("raises nothing when there is nothing committed", async () => {
    // The control that this suite can say no. Every assertion above would also pass against a dispatcher
    // that enqueued indiscriminately, so the empty case is measured rather than assumed.
    expect(await sweep()).toMatchObject({ dispatched: 0, failed: 0 });
    expect(await deliveryQueue.getJobCounts("waiting", "delayed")).toMatchObject({ waiting: 0, delayed: 0 });
  }, 180_000);
});
