import {
  dispatchOutbox,
  ingestWebhook,
  type DebounceScheduler,
  type IngestionDependencies,
  type WebhookAccount,
  type WebhookIngestionResult,
} from "@omnichannel/application";
import type { ChannelAdapter, NormalizedChannelEvent, RawWebhook } from "@omnichannel/channel-core";
import {
  authorizeBusinessProfileAccess,
  authorizeWorkspaceAccess,
  createBusinessProfile,
  createChannelAccount,
  createIngestionStore,
} from "@omnichannel/db";
import { NO_CAPABILITIES } from "@omnichannel/domain";
import {
  createQueueProducer,
  createQueueWorkers,
  INBOUND_DEBOUNCE,
  inboundDebounceJobSchema,
  type InboundDebounceJob,
  type QueueProducer,
  type QueueWorkers,
} from "@omnichannel/queue";
import { Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createEndToEndInfrastructure, endToEndTestsEnabled, waitFor, type EndToEndInfrastructure } from "./testing/infrastructure";
import { createPaidWorkspace } from "./testing/paid-workspace";

interface Profile {
  readonly workspaceId: string;
  readonly businessProfileId: string;
  readonly channelAccountId: string;
}

interface InboundFixture {
  readonly id: string;
  readonly mid: string;
  readonly from: string;
  readonly at: string;
  /** Forges the event's Business Profile, as a broken or malicious adapter binding would. */
  readonly businessProfileId?: string;
}

const SIGNATURE = "e2e-valid-signature";

/** Minimal adapter bound to the resolved account, like a real channel adapter; it never sends. */
function fakeAdapter(account: WebhookAccount): ChannelAdapter {
  return {
    channel: account.channel,
    verifyWebhook: (input) =>
      Promise.resolve(input.headers["x-e2e-signature"] === SIGNATURE ? { status: "VERIFIED" } : { status: "REJECTED", reason: "invalid signature" }),
    normalizeWebhook: (input) => {
      const fixtures = JSON.parse(new TextDecoder().decode(input.rawBody)) as InboundFixture[];
      return Promise.resolve(
        fixtures.map(
          (fixture): NormalizedChannelEvent => ({
            type: "INBOUND_MESSAGE",
            workspaceId: account.workspaceId,
            businessProfileId: fixture.businessProfileId ?? account.businessProfileId,
            channel: account.channel,
            channelAccountId: account.channelAccountId,
            sourceEventId: fixture.id,
            occurredAt: new Date(fixture.at),
            senderExternalId: fixture.from,
            externalMessageId: fixture.mid,
            messageKind: "TEXT",
            text: "Hello, is the studio open on Saturday?",
            media: [],
          }),
        ),
      );
    },
    getCapabilities: () => Promise.resolve({ ...NO_CAPABILITIES, text: true }),
    evaluateWindow: () => Promise.resolve({ state: "UNKNOWN", reason: "e2e adapter" }),
    send: () => Promise.resolve({ outcome: "REJECTED", retryable: false, message: "the e2e adapter never sends" }),
  };
}

function webhook(fixtures: readonly InboundFixture[]): RawWebhook {
  return {
    method: "POST",
    headers: { "x-e2e-signature": SIGNATURE },
    query: {},
    rawBody: new TextEncoder().encode(JSON.stringify(fixtures)),
    receivedAt: new Date(),
  };
}

describe.skipIf(!endToEndTestsEnabled())("webhook ingestion → PostgreSQL → outbox → BullMQ (end to end)", () => {
  let infra: EndToEndInfrastructure;
  let producer: QueueProducer;
  let debounceQueue: Queue;
  let first: Profile;
  let second: Profile;
  let sequence = 0;
  const unique = (prefix: string) => `${prefix}-${String(++sequence)}`;

  beforeAll(async () => {
    infra = await createEndToEndInfrastructure();
    producer = createQueueProducer({ connection: infra.connect("producer"), logger: infra.logger, prefix: infra.prefix });
    debounceQueue = new Queue(INBOUND_DEBOUNCE.queueName, { connection: infra.connect("producer"), prefix: infra.prefix });

    const user = await infra.db.user.create({ data: { name: "E2E Owner", email: "e2e-owner@example.test" } });
    const { workspaceId } = await createPaidWorkspace(infra.db, { name: "E2E Workspace", ownerUserId: user.id });
    const workspace = await authorizeWorkspaceAccess(infra.db, { userId: user.id, workspaceId });
    const profile = async (label: string): Promise<Profile> => {
      const { businessProfileId } = await createBusinessProfile(infra.db, workspace, { name: `E2E ${label}` });
      const context = await authorizeBusinessProfileAccess(infra.db, { userId: user.id, workspaceId, businessProfileId });
      const account = await createChannelAccount(infra.db, context, {
        channel: "INSTAGRAM",
        externalAccountId: `ig-account-e2e-${label}`,
        capabilities: { ...NO_CAPABILITIES, text: true },
      });
      return { workspaceId, businessProfileId, channelAccountId: account.id };
    };
    first = await profile("first");
    second = await profile("second");
  }, 120_000);

  afterAll(async () => {
    await debounceQueue?.close();
    await producer?.close();
    await infra?.dispose();
  });

  const dependencies = (options: { scheduler?: DebounceScheduler; windowMs?: number } = {}): IngestionDependencies => ({
    store: createIngestionStore(infra.db),
    adapters: { adapterFor: fakeAdapter },
    scheduler: options.scheduler ?? producer,
    transcription: producer,
    log: infra.logger,
    now: () => new Date(),
    random: () => 0,
    debounceWindowMs: { minMs: options.windowMs ?? 60_000, maxMs: options.windowMs ?? 60_000 },
  });

  const ingest = (
    profile: Profile,
    fixtures: readonly InboundFixture[],
    options: { correlationId?: string; scheduler?: DebounceScheduler; windowMs?: number } = {},
  ): Promise<WebhookIngestionResult> =>
    ingestWebhook(dependencies(options), {
      channel: "INSTAGRAM",
      channelAccountId: profile.channelAccountId,
      webhook: webhook(fixtures),
      correlationId: options.correlationId ?? unique("corr-e2e"),
    });

  const inbound = (from: string, overrides: Partial<InboundFixture> = {}): InboundFixture => ({
    id: unique("evt-e2e"),
    mid: unique("mid-e2e"),
    from,
    at: new Date().toISOString(),
    ...overrides,
  });

  /** The stored outbox payload for a correlation ID, parsed with the strict queue schema. */
  const outboxJob = async (correlationId: string) => {
    const entry = await infra.db.queueOutbox.findFirstOrThrow({ where: { correlationId } });
    return { entry, job: inboundDebounceJobSchema.parse(entry.payload) };
  };

  it("persists the same provider user per Business Profile and enqueues strictly valid, profile-scoped debounce jobs", async () => {
    // Identical provider event, message and user IDs arriving on both profiles' accounts.
    const fixture = inbound("ig-user-e2e-shared", { id: "evt-e2e-shared", mid: "mid-e2e-shared" });
    const results = await Promise.all([
      ingest(first, [fixture], { correlationId: "corr-e2e-first" }),
      ingest(second, [fixture], { correlationId: "corr-e2e-second" }),
    ]);
    for (const result of results) {
      expect(result).toEqual({
        kind: "ACCEPTED",
        summary: { received: 1, processed: 1, duplicates: 0, rejected: 0, outboxDispatched: 1, outboxDeferred: 0 },
      });
    }

    const jobIds: string[] = [];
    for (const [profile, correlationId] of [
      [first, "corr-e2e-first"],
      [second, "corr-e2e-second"],
    ] as const) {
      const { entry, job } = await outboxJob(correlationId);
      const conversation = await infra.db.conversation.findFirstOrThrow({ where: { businessProfileId: profile.businessProfileId } });
      const message = await infra.db.message.findFirstOrThrow({ where: { conversationId: conversation.id } });
      expect(entry).toMatchObject({ workspaceId: profile.workspaceId, businessProfileId: profile.businessProfileId });
      expect(entry.dispatchedAt).not.toBeNull();
      expect(job).toEqual({
        schemaVersion: 1,
        workspaceId: profile.workspaceId,
        businessProfileId: profile.businessProfileId,
        correlationId,
        channelAccountId: profile.channelAccountId,
        conversationId: conversation.id,
        anchorMessageId: message.id,
        anchorInboundAt: fixture.at,
      });

      const jobId = INBOUND_DEBOUNCE.jobId(job);
      expect(jobId.split("|")).toEqual(expect.arrayContaining([profile.workspaceId, profile.businessProfileId, conversation.id, message.id]));
      const queued = await debounceQueue.getJob(jobId);
      expect(queued?.data).toEqual(job);
      expect(await queued?.getState()).toBe("delayed");
      jobIds.push(jobId);
    }
    expect(new Set(jobIds).size).toBe(2);
    expect(await infra.db.contact.count()).toBe(2);
    expect((await debounceQueue.getJobCounts("delayed")).delayed).toBe(2);

    // Redelivery to either profile starts no second job.
    await Promise.all([ingest(first, [fixture]), ingest(second, [fixture])]);
    expect((await debounceQueue.getJobCounts("delayed", "waiting")).delayed).toBe(2);

    // The same conversation and anchor IDs under another Business Profile are distinct queue work.
    const { job: firstJob } = await outboxJob("corr-e2e-first");
    const twin: InboundDebounceJob = { ...firstJob, businessProfileId: second.businessProfileId, correlationId: "corr-e2e-twin" };
    await producer.scheduleInboundDebounce(twin, { delayMs: 60_000 });
    expect(INBOUND_DEBOUNCE.jobId(twin)).not.toBe(INBOUND_DEBOUNCE.jobId(firstJob));
    expect((await debounceQueue.getJob(INBOUND_DEBOUNCE.jobId(firstJob)))?.data).toEqual(firstJob);
    expect((await debounceQueue.getJob(INBOUND_DEBOUNCE.jobId(twin)))?.data).toEqual(twin);
    await debounceQueue.remove(INBOUND_DEBOUNCE.jobId(twin));
  });

  it("rejects an event forged with the sibling Business Profile before it reaches PostgreSQL or Redis", async () => {
    const delayedBefore = (await debounceQueue.getJobCounts("delayed")).delayed;
    const eventsBefore = await infra.db.inboundEvent.count();
    const outboxBefore = await infra.db.queueOutbox.count();

    const result = await ingest(first, [inbound("ig-user-e2e-forged", { businessProfileId: second.businessProfileId })]);

    expect(result).toMatchObject({ kind: "ACCEPTED", summary: { processed: 0, rejected: 1, outboxDispatched: 0 } });
    expect(await infra.db.inboundEvent.count()).toBe(eventsBefore);
    expect(await infra.db.queueOutbox.count()).toBe(outboxBefore);
    expect(await infra.db.channelIdentity.count({ where: { externalUserId: "ig-user-e2e-forged" } })).toBe(0);
    expect((await debounceQueue.getJobCounts("delayed")).delayed).toBe(delayedBefore);
  });

  it("runs reply cycles per Business Profile and recovers an outbox entry after a Redis outage with its scope intact", async () => {
    const handled: InboundDebounceJob[] = [];
    let workers: QueueWorkers | undefined;
    try {
      // A burst in the first profile supersedes its earlier anchor; the second profile's cycle is independent.
      const early = await Promise.all([
        ingest(first, [inbound("ig-user-e2e-burst")], { correlationId: "corr-e2e-burst-first-1", windowMs: 1_500 }),
        ingest(second, [inbound("ig-user-e2e-burst")], { correlationId: "corr-e2e-burst-second", windowMs: 1_500 }),
      ]);
      const later = await ingest(first, [inbound("ig-user-e2e-burst", { at: new Date(Date.now() + 1).toISOString() })], {
        correlationId: "corr-e2e-burst-first-2",
        windowMs: 1_500,
      });
      expect([...early, later].every((result) => result.kind === "ACCEPTED")).toBe(true);

      // Redis "down" for this delivery: the message is stored and the debounce waits in the outbox.
      const failing: DebounceScheduler = { scheduleInboundDebounce: () => Promise.reject(new Error("redis unavailable")) };
      const outage = await ingest(second, [inbound("ig-user-e2e-outage")], { correlationId: "corr-e2e-outage", scheduler: failing, windowMs: 0 });
      expect(outage).toMatchObject({ summary: { processed: 1, outboxDispatched: 0, outboxDeferred: 1 } });
      const pending = await outboxJob("corr-e2e-outage");
      expect(pending.entry).toMatchObject({ businessProfileId: second.businessProfileId, dispatchedAt: null });
      expect(await debounceQueue.getJob(INBOUND_DEBOUNCE.jobId(pending.job))).toBeUndefined();

      workers = createQueueWorkers({
        connection: infra.connect("worker"),
        logger: infra.logger,
        prefix: infra.prefix,
        handlers: {
          onInboundDebounceElapsed: (job) => {
            handled.push(job);
            return Promise.resolve();
          },
          transcribeMedia: () => Promise.resolve(),
          announcePresence: () => Promise.resolve(),
          generateAiDraft: () => Promise.resolve(),
          deliver: () => Promise.resolve({ status: "NOT_CLAIMED", retryable: false, reason: "e2e" }),
          reconcile: () => Promise.resolve(),
        },
      });

      // Recovery sweep, as the worker's outbox sweeper runs it, with the real producer.
      const sweepAt = new Date(pending.entry.availableAt.getTime() + 1);
      const swept = await dispatchOutbox({ store: createIngestionStore(infra.db), scheduler: producer, transcription: producer, log: infra.logger, now: () => sweepAt });
      expect(swept).toEqual({ dispatched: 1, failed: 0 });

      const burstFirst2 = (await outboxJob("corr-e2e-burst-first-2")).job;
      const burstSecond = (await outboxJob("corr-e2e-burst-second")).job;
      const burstFirst1 = (await outboxJob("corr-e2e-burst-first-1")).job;
      await waitFor(() => handled.length >= 3);
      // Give a superseded or duplicate job the chance to (wrongly) fire before asserting.
      await new Promise((resolve) => setTimeout(resolve, 1_000));

      const byCorrelation = (correlationId: string) => handled.filter((job) => job.correlationId === correlationId);
      expect(byCorrelation("corr-e2e-burst-first-2")).toEqual([burstFirst2]);
      expect(byCorrelation("corr-e2e-burst-second")).toEqual([burstSecond]);
      expect(byCorrelation("corr-e2e-burst-first-1")).toEqual([]);
      expect(byCorrelation("corr-e2e-outage")).toEqual([pending.job]);
      expect(burstFirst1.conversationId).toBe(burstFirst2.conversationId);
      expect(burstSecond.conversationId).not.toBe(burstFirst2.conversationId);
      expect(handled).toHaveLength(3);

      const started = infra.logs.filter((line) => line.event === "queue.job_started" && line.correlationId === "corr-e2e-outage");
      expect(started[0]).toMatchObject({ workspaceId: second.workspaceId, businessProfileId: second.businessProfileId });
    } finally {
      await workers?.close({ force: true });
    }
  }, 30_000);
});
