import { Queue, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AI_DRAFT_GENERATION,
  JobPayloadValidationError,
  NonRetryableJobError,
  createQueueProducer,
  createQueueWorkers,
  DELIVERY,
  INBOUND_DEBOUNCE,
  planDelay,
  RECONCILIATION,
  type AiDraftGenerationJob,
  type DeliveryAttemptResult,
  type DeliveryJob,
  type InboundDebounceJob,
  type QueueHandlers,
  type QueueProducer,
  type QueueWorkers,
} from "./index";
import { createTestQueueEnvironment, redisTestsEnabled, waitFor, type TestQueueEnvironment } from "./testing/redis";

const debounce = (anchorMessageId: string, anchorInboundAt: string, businessProfileId = "bp_1"): InboundDebounceJob => ({
  schemaVersion: 1,
  workspaceId: "ws_1",
  businessProfileId,
  correlationId: `corr-${anchorMessageId}`,
  channelAccountId: "ca_1",
  conversationId: "conv_1",
  anchorMessageId,
  anchorInboundAt,
});

const aiDraft: AiDraftGenerationJob = {
  schemaVersion: 1,
  workspaceId: "ws_1",
  businessProfileId: "bp_1",
  correlationId: "corr-draft",
  conversationId: "conv_1",
  anchorMessageId: "msg_2",
  trigger: "DEBOUNCE_ELAPSED",
};

const delivery = (operationId: string, scheduledFor = new Date(), selectedDelayMs = 0, businessProfileId = "bp_1"): DeliveryJob => ({
  schemaVersion: 1,
  workspaceId: "ws_1",
  businessProfileId,
  correlationId: `corr-${operationId}`,
  conversationId: "conv_1",
  draftId: `draft-${operationId}`,
  deliveryJobId: `djob-${operationId}`,
  operationId,
  scheduledFor: scheduledFor.toISOString(),
  selectedDelayMs,
});

describe.skipIf(!redisTestsEnabled())("queue primitives (Redis)", () => {
  let env: TestQueueEnvironment;
  let producer: QueueProducer;
  const workers: QueueWorkers[] = [];
  const inspectors: Queue[] = [];

  const inspect = (queueName: string, connection?: Redis): Queue => {
    const queue = new Queue(queueName, { connection: connection ?? env.connect("producer"), prefix: env.prefix });
    inspectors.push(queue);
    return queue;
  };

  const handlers = (overrides: Partial<QueueHandlers> = {}): QueueHandlers => ({
    onInboundDebounceElapsed: vi.fn(() => Promise.resolve()),
    generateAiDraft: vi.fn(() => Promise.resolve()),
    deliver: vi.fn(
      (): Promise<DeliveryAttemptResult> =>
        Promise.resolve({ status: "SEND_RESULT", result: { outcome: "ACCEPTED", platformMessageId: "mid-1" } }),
    ),
    reconcile: vi.fn(() => Promise.resolve()),
    ...overrides,
  });

  const startWorkers = (queueHandlers: QueueHandlers, timings: { lockDurationMs?: number; stalledIntervalMs?: number } = {}) => {
    const started = createQueueWorkers({
      connection: env.connect("worker"),
      logger: env.logger,
      prefix: env.prefix,
      handlers: queueHandlers,
      ...timings,
    });
    workers.push(started);
    return started;
  };

  const settled = async (queue: Queue, jobId: string): Promise<Job> => {
    let job: Job | undefined;
    await waitFor(async () => {
      job = await queue.getJob(jobId);
      const state = job === undefined ? "missing" : await job.getState();
      return state === "completed" || state === "failed";
    });
    return (await queue.getJob(jobId)) as Job;
  };

  beforeEach(() => {
    env = createTestQueueEnvironment();
    producer = createQueueProducer({ connection: env.connect("producer"), logger: env.logger, prefix: env.prefix });
  });

  afterEach(async () => {
    await Promise.all(workers.splice(0).map((started) => started.close({ force: true })));
    await Promise.all(inspectors.splice(0).map((queue) => queue.close()));
    await producer.close();
    await env.dispose();
  });

  it("rejects malformed payloads at enqueue and in the worker without retrying or calling handlers", async () => {
    await expect(producer.scheduleDelivery({ ...delivery("op-bad"), operationId: "" })).rejects.toThrow(/Invalid delivery\.v1/);
    const deliveryQueue = inspect(DELIVERY.queueName);
    expect(await deliveryQueue.getJobCounts("delayed", "waiting")).toMatchObject({ delayed: 0, waiting: 0 });

    const deliver = vi.fn(() => Promise.resolve<DeliveryAttemptResult>({ status: "SKIPPED", reason: "unused" }));
    startWorkers(handlers({ deliver }));
    const bogus = await deliveryQueue.add(DELIVERY.jobName, { operationId: "op-raw", text: "secret text" }, { attempts: 3, jobId: "raw-1" });
    const unknownVersion = await deliveryQueue.add("delivery.v9", delivery("op-v9"), { attempts: 3, jobId: "raw-2" });

    for (const job of [bogus, unknownVersion]) {
      const finished = await settled(deliveryQueue, job.id ?? "");
      expect(await finished.getState()).toBe("failed");
      expect(finished.attemptsMade).toBe(1);
    }
    expect(deliver).not.toHaveBeenCalled();
    const rejected = env.logs.filter((entry) => entry.event === "queue.job_rejected");
    expect(rejected.map((entry) => entry.reason)).toEqual(["INVALID_PAYLOAD", "UNKNOWN_JOB_NAME"]);
    expect(JSON.stringify(env.logs)).not.toContain("secret text");
  });

  it("creates one job for duplicate enqueues of the same logical work", async () => {
    const scheduledFor = new Date(Date.now() + 60_000);
    await producer.scheduleDelivery(delivery("op-dup", scheduledFor, 60_000));
    await producer.scheduleDelivery(delivery("op-dup", scheduledFor, 60_000));
    await producer.scheduleDelivery(delivery("op-other", scheduledFor, 60_000));
    await producer.enqueueAiDraftGeneration(aiDraft);
    await producer.enqueueAiDraftGeneration({ ...aiDraft, correlationId: "corr-retry" });
    const first = await producer.scheduleInboundDebounce(debounce("msg_1", "2026-09-17T10:00:00.000Z"), { delayMs: 60_000 });
    const again = await producer.scheduleInboundDebounce(debounce("msg_1", "2026-09-17T10:00:00.000Z"), { delayMs: 60_000 });

    expect(await inspect(DELIVERY.queueName).getJobCounts("delayed")).toMatchObject({ delayed: 2 });
    expect(await inspect(AI_DRAFT_GENERATION.queueName).getJobCounts("waiting")).toMatchObject({ waiting: 1 });
    expect(await inspect(INBOUND_DEBOUNCE.queueName).getJobCounts("delayed")).toMatchObject({ delayed: 1 });
    expect(again).toEqual(first);
  });

  it("keeps identical conversation, anchor and operation IDs in different Business Profiles independent", async () => {
    const scheduledFor = new Date(Date.now() + 60_000);
    const deliveries = await Promise.all(["bp_1", "bp_2"].map((bp) => producer.scheduleDelivery(delivery("op-shared", scheduledFor, 60_000, bp))));
    const drafts = await Promise.all(["bp_1", "bp_2"].map((bp) => producer.enqueueAiDraftGeneration({ ...aiDraft, businessProfileId: bp })));
    expect(new Set(deliveries.map((job) => job.jobId)).size).toBe(2);
    expect(new Set(drafts.map((job) => job.jobId)).size).toBe(2);
    expect(await inspect(DELIVERY.queueName).getJobCounts("delayed")).toMatchObject({ delayed: 2 });
    expect(await inspect(AI_DRAFT_GENERATION.queueName).getJobCounts("waiting")).toMatchObject({ waiting: 2 });

    // Same conversation ID, different anchors in other profiles: a newer inbound in BP2 must not supersede
    // BP1's reply cycle, and an older inbound in BP3 is not stale relative to BP1 or BP2.
    const inBp1 = await producer.scheduleInboundDebounce(debounce("msg_1", "2026-09-17T10:00:00.000Z", "bp_1"), { delayMs: 60_000 });
    const inBp2 = await producer.scheduleInboundDebounce(debounce("msg_2", "2026-09-17T10:00:05.000Z", "bp_2"), { delayMs: 60_000 });
    const inBp3 = await producer.scheduleInboundDebounce(debounce("msg_0", "2026-09-17T09:59:59.000Z", "bp_3"), { delayMs: 60_000 });
    for (const result of [inBp1, inBp2, inBp3]) {
      expect(result).toMatchObject({ status: "SCHEDULED" });
      expect(result).not.toHaveProperty("supersededJobId");
    }
    const debounceQueue = inspect(INBOUND_DEBOUNCE.queueName);
    expect(await debounceQueue.getJobCounts("delayed")).toMatchObject({ delayed: 3 });

    const handledProfiles: string[] = [];
    const onInboundDebounceElapsed = vi.fn((job: InboundDebounceJob) => {
      handledProfiles.push(job.businessProfileId);
      return Promise.resolve();
    });
    startWorkers(handlers({ onInboundDebounceElapsed }));
    for (const result of [inBp1, inBp2, inBp3]) {
      const jobId = result.status === "SCHEDULED" ? result.job.jobId : "";
      await (await debounceQueue.getJob(jobId))?.promote();
      expect((await settled(debounceQueue, jobId)).returnvalue).toEqual({ outcome: "HANDLED" });
    }
    expect(handledProfiles.sort()).toEqual(["bp_1", "bp_2", "bp_3"]);
  });

  it("supersedes older debounce work, ignores late older inbound and neutralises stale wake-ups", async () => {
    const debounceQueue = inspect(INBOUND_DEBOUNCE.queueName);
    const first = await producer.scheduleInboundDebounce(debounce("msg_1", "2026-09-17T10:00:00.000Z"), { delayMs: 60_000 });
    const second = await producer.scheduleInboundDebounce(debounce("msg_2", "2026-09-17T10:00:05.000Z"), { delayMs: 60_000 });
    const late = await producer.scheduleInboundDebounce(debounce("msg_0", "2026-09-17T09:59:59.000Z"), { delayMs: 60_000 });

    expect(first.status).toBe("SCHEDULED");
    expect(second).toMatchObject({ status: "SCHEDULED", supersededJobId: first.status === "SCHEDULED" ? first.job.jobId : "" });
    expect(late).toEqual({ status: "STALE", currentAnchorMessageId: "msg_2" });
    expect(await debounceQueue.getJobCounts("delayed", "waiting")).toMatchObject({ delayed: 1, waiting: 0 });

    // Cancellation is best effort: simulate a superseded job that was not removed and still wakes up.
    const staleId = INBOUND_DEBOUNCE.jobId(debounce("msg_1", "2026-09-17T10:00:00.000Z"));
    await debounceQueue.add(INBOUND_DEBOUNCE.jobName, debounce("msg_1", "2026-09-17T10:00:00.000Z"), { jobId: staleId });
    const onInboundDebounceElapsed = vi.fn(() => Promise.resolve());
    startWorkers(handlers({ onInboundDebounceElapsed }));
    const currentId = second.status === "SCHEDULED" ? second.job.jobId : "";
    await (await debounceQueue.getJob(currentId))?.promote();

    expect((await settled(debounceQueue, staleId)).returnvalue).toEqual({ outcome: "SUPERSEDED" });
    expect((await settled(debounceQueue, currentId)).returnvalue).toEqual({ outcome: "HANDLED" });
    expect(onInboundDebounceElapsed).toHaveBeenCalledTimes(1);
    expect(onInboundDebounceElapsed).toHaveBeenCalledWith(expect.objectContaining({ anchorMessageId: "msg_2" }), expect.anything());
  });

  it("schedules delivery durably with an auditable delay that survives a producer/worker restart", async () => {
    const plan = planDelay({ minMs: 1_000, maxMs: 1_000 }, new Date());
    const job = await producer.scheduleDelivery(delivery("op-delayed", plan.scheduledFor, plan.selectedDelayMs));
    expect(job.delayMs).toBeGreaterThan(800);
    await producer.close();

    // A fresh connection (as after a restart) still sees the same delayed job with its schedule.
    const restarted = inspect(DELIVERY.queueName, env.connect("producer"));
    const stored = await restarted.getJob(job.jobId);
    expect(await stored?.getState()).toBe("delayed");
    expect(stored?.data).toMatchObject({ scheduledFor: plan.scheduledFor.toISOString(), selectedDelayMs: 1_000 });

    const deliver = vi.fn(() =>
      Promise.resolve<DeliveryAttemptResult>({ status: "SEND_RESULT", result: { outcome: "ACCEPTED", platformMessageId: "mid-1" } }),
    );
    startWorkers(handlers({ deliver }));
    const finished = await settled(restarted, job.jobId);
    expect(finished.returnvalue).toEqual({ outcome: "SENT" });
    expect(finished.processedOn ?? 0).toBeGreaterThanOrEqual(plan.scheduledFor.getTime() - 50);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("retries safe work with the same job identity across worker restarts", async () => {
    let calls = 0;
    const seen: { jobId: string; attempt: number; correlationId: string }[] = [];
    const generateAiDraft = vi.fn((job: AiDraftGenerationJob, context: { jobId: string; attempt: number }) => {
      calls += 1;
      seen.push({ jobId: context.jobId, attempt: context.attempt, correlationId: job.correlationId });
      return calls === 1 ? Promise.reject(new Error("transient provider timeout")) : Promise.resolve();
    });
    const draftQueue = inspect(AI_DRAFT_GENERATION.queueName);
    const { jobId } = await producer.enqueueAiDraftGeneration(aiDraft);

    const firstWorker = startWorkers(handlers({ generateAiDraft }));
    await waitFor(async () => (await (await draftQueue.getJob(jobId))?.getState()) === "delayed");
    await firstWorker.close();

    startWorkers(handlers({ generateAiDraft }));
    await (await draftQueue.getJob(jobId))?.promote();
    const finished = await settled(draftQueue, jobId);

    expect(finished.returnvalue).toEqual({ outcome: "HANDLED" });
    expect(seen).toEqual([
      { jobId, attempt: 1, correlationId: "corr-draft" },
      { jobId, attempt: 2, correlationId: "corr-draft" },
    ]);
  });

  it("never retries an ambiguous send and hands it to reconciliation instead", async () => {
    const deliver = vi.fn(
      (job: DeliveryJob): Promise<DeliveryAttemptResult> =>
        job.operationId === "op-crash"
          ? Promise.reject(new Error("socket hang up after write"))
          : Promise.resolve({
              status: "SEND_RESULT",
              result: { outcome: "AMBIGUOUS", providerRequestId: "req-1", code: "ETIMEDOUT", message: "timeout" },
            }),
    );
    const reconcile = vi.fn(() => Promise.resolve());
    startWorkers(handlers({ deliver, reconcile }));
    const deliveryQueue = inspect(DELIVERY.queueName);
    const reconciliationQueue = inspect(RECONCILIATION.queueName);

    const ambiguous = await producer.scheduleDelivery(delivery("op-ambiguous"));
    const crashed = await producer.scheduleDelivery(delivery("op-crash"));

    const ambiguousJob = await settled(deliveryQueue, ambiguous.jobId);
    const crashedJob = await settled(deliveryQueue, crashed.jobId);
    expect(ambiguousJob.returnvalue).toEqual({ outcome: "QUARANTINED" });
    expect(await crashedJob.getState()).toBe("failed");
    expect(crashedJob.attemptsMade).toBe(1);

    const reconciliationIds = ["op-ambiguous", "op-crash"].map((operationId) =>
      RECONCILIATION.jobId({ ...reconciliationFor(operationId), operationId }),
    );
    for (const id of reconciliationIds) {
      await settled(reconciliationQueue, id);
    }
    expect((await reconciliationQueue.getJob(reconciliationIds[0] ?? ""))?.data).toMatchObject({
      workspaceId: "ws_1",
      businessProfileId: "bp_1",
      correlationId: "corr-op-ambiguous",
      reason: "AMBIGUOUS_SEND_RESULT",
      providerRequestId: "req-1",
      providerCode: "ETIMEDOUT",
    });
    expect((await reconciliationQueue.getJob(reconciliationIds[1] ?? ""))?.data).toMatchObject({ reason: "DELIVERY_HANDLER_FAILED" });

    // Give BullMQ time to (wrongly) retry, then prove each send was attempted exactly once.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(await deliveryQueue.getJobCounts("waiting", "delayed", "active")).toMatchObject({ waiting: 0, delayed: 0, active: 0 });
  });

  it("never retries non-retryable rejections, declined claims or non-retryable handler errors", async () => {
    const outcomes: Record<string, DeliveryAttemptResult> = {
      "op-permanent": { status: "SEND_RESULT", result: { outcome: "REJECTED", retryable: false, code: "INVALID_RECIPIENT", message: "no" } },
      "op-declined": { status: "NOT_CLAIMED", retryable: false, reason: "human takeover" },
    };
    const deliver = vi.fn((job: DeliveryJob): Promise<DeliveryAttemptResult> => {
      const outcome = outcomes[job.operationId];
      return outcome === undefined ? Promise.reject(new Error("unexpected operation")) : Promise.resolve(outcome);
    });
    const generateAiDraft = vi.fn(() => Promise.reject(new NonRetryableJobError("not implemented")));
    startWorkers(handlers({ deliver, generateAiDraft }));
    const deliveryQueue = inspect(DELIVERY.queueName);

    const permanent = await settled(deliveryQueue, (await producer.scheduleDelivery(delivery("op-permanent"))).jobId);
    const declined = await settled(deliveryQueue, (await producer.scheduleDelivery(delivery("op-declined"))).jobId);
    expect(permanent.returnvalue).toEqual({ outcome: "REJECTED" });
    expect(declined.returnvalue).toEqual({ outcome: "NOT_CLAIMED" });

    const draftQueue = inspect(AI_DRAFT_GENERATION.queueName);
    const failedDraft = await settled(draftQueue, (await producer.enqueueAiDraftGeneration(aiDraft)).jobId);
    expect(await failedDraft.getState()).toBe("failed");
    expect(failedDraft.attemptsMade).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(generateAiDraft).toHaveBeenCalledTimes(1);
    expect(await deliveryQueue.getJobCounts("delayed", "waiting")).toMatchObject({ delayed: 0, waiting: 0 });
    expect(await draftQueue.getJobCounts("delayed", "waiting")).toMatchObject({ delayed: 0, waiting: 0 });
  });

  it("retries a delivery that was not claimed only when the coordinator marks it retryable", async () => {
    let calls = 0;
    const deliver = vi.fn((): Promise<DeliveryAttemptResult> => {
      calls += 1;
      return Promise.resolve(
        calls === 1 ? { status: "NOT_CLAIMED", retryable: true, reason: "database busy" } : { status: "SKIPPED", reason: "superseded" },
      );
    });
    startWorkers(handlers({ deliver }));
    const deliveryQueue = inspect(DELIVERY.queueName);
    const { jobId } = await producer.scheduleDelivery(delivery("op-not-claimed"));

    await waitFor(async () => (await (await deliveryQueue.getJob(jobId))?.getState()) === "delayed");
    await (await deliveryQueue.getJob(jobId))?.promote();
    expect((await settled(deliveryQueue, jobId)).returnvalue).toEqual({ outcome: "SKIPPED" });
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("rejects Business Profile-less work at enqueue without creating jobs or reply cycles", async () => {
    const connection = env.connect("producer");
    const { businessProfileId: _debounceProfile, ...debounceWithoutProfile } = debounce("msg_no_bp", "2026-09-17T10:00:00.000Z");
    const { businessProfileId: _draftProfile, ...draftWithoutProfile } = aiDraft;
    const attempts: Promise<unknown>[] = [
      producer.scheduleInboundDebounce(debounceWithoutProfile as InboundDebounceJob, { delayMs: 0 }),
      producer.enqueueAiDraftGeneration(draftWithoutProfile as AiDraftGenerationJob),
      producer.scheduleDelivery({ ...delivery("op-no-bp"), businessProfileId: "bp 1" }),
      producer.enqueueReconciliation({ ...reconciliationFor("op-no-bp"), businessProfileId: "" }),
    ];
    for (const attempt of attempts) {
      await expect(attempt).rejects.toBeInstanceOf(JobPayloadValidationError);
    }
    expect(await connection.keys(`${env.prefix}:*`)).toEqual([]);
  });

  it("retries only explicit not-sent outcomes", async () => {
    let calls = 0;
    const deliver = vi.fn((): Promise<DeliveryAttemptResult> => {
      calls += 1;
      return Promise.resolve(
        calls === 1
          ? { status: "SEND_RESULT", result: { outcome: "REJECTED", retryable: true, code: "RATE_LIMIT", message: "throttled" } }
          : { status: "SEND_RESULT", result: { outcome: "ACCEPTED", platformMessageId: "mid-2" } },
      );
    });
    startWorkers(handlers({ deliver }));
    const deliveryQueue = inspect(DELIVERY.queueName);
    const { jobId } = await producer.scheduleDelivery(delivery("op-retry"));

    await waitFor(async () => (await (await deliveryQueue.getJob(jobId))?.getState()) === "delayed");
    await (await deliveryQueue.getJob(jobId))?.promote();
    const finished = await settled(deliveryQueue, jobId);
    expect(finished.returnvalue).toEqual({ outcome: "SENT" });
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("fails a delivery whose worker died mid-run instead of re-running it", async () => {
    let release: () => void = () => undefined;
    const deliver = vi.fn(
      () =>
        new Promise<DeliveryAttemptResult>((resolve) => {
          release = () => resolve({ status: "SKIPPED", reason: "test released" });
        }),
    );
    const timings = { lockDurationMs: 1_000, stalledIntervalMs: 500 };
    const crashed = startWorkers(handlers({ deliver }), timings);
    const deliveryQueue = inspect(DELIVERY.queueName);
    const { jobId } = await producer.scheduleDelivery(delivery("op-stalled"));
    await waitFor(() => deliver.mock.calls.length === 1);

    await crashed.close({ force: true });
    startWorkers(handlers({ deliver }), timings);
    const finished = await settled(deliveryQueue, jobId);
    release();

    expect(await finished.getState()).toBe("failed");
    expect(finished.failedReason).toMatch(/stalled/);
    expect(deliver).toHaveBeenCalledTimes(1);
    const reconciliationQueue = inspect(RECONCILIATION.queueName);
    const reconciliationId = RECONCILIATION.jobId({ ...reconciliationFor("op-stalled"), operationId: "op-stalled" });
    await waitFor(async () => (await reconciliationQueue.getJob(reconciliationId)) !== undefined);
    expect((await reconciliationQueue.getJob(reconciliationId))?.data).toMatchObject({ reason: "DELIVERY_STALLED" });
  }, 20_000);

  it("waits for running jobs on graceful close and logs correlation ids end to end", async () => {
    let finishedHandler = false;
    const generateAiDraft = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      finishedHandler = true;
    });
    // Enqueue before the worker starts, so the enqueue log deterministically precedes processing.
    const { jobId } = await producer.enqueueAiDraftGeneration(aiDraft);
    const started = startWorkers(handlers({ generateAiDraft }));
    await waitFor(() => generateAiDraft.mock.calls.length === 1);

    await started.close();
    expect(finishedHandler).toBe(true);
    expect(await (await inspect(AI_DRAFT_GENERATION.queueName).getJob(jobId))?.getState()).toBe("completed");

    const forJob = env.logs.filter((entry) => entry.jobId === jobId).map((entry) => [entry.event, entry.correlationId]);
    expect(forJob).toEqual([
      ["queue.enqueued", "corr-draft"],
      ["queue.job_started", "corr-draft"],
      ["queue.job_completed", "corr-draft"],
    ]);
  });
});

function reconciliationFor(operationId: string) {
  return {
    schemaVersion: 1 as const,
    workspaceId: "ws_1",
    businessProfileId: "bp_1",
    correlationId: `corr-${operationId}`,
    conversationId: "conv_1",
    deliveryJobId: `djob-${operationId}`,
    operationId,
    reason: "AMBIGUOUS_SEND_RESULT" as const,
    detectedAt: new Date().toISOString(),
  };
}
