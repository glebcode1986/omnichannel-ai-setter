import {
  dispatchOutbox,
  ingestWebhook,
  type DebounceScheduler,
  type InboundDebouncePayload,
  type IngestionDependencies,
  type LogPort,
  type WebhookIngestionResult,
} from "@omnichannel/application";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createIngestionStore } from "./index";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { createFakeChannelAdapter, fakeWebhook, FAKE_VERIFY_TOKEN, type FakeEventFixture } from "./testing/fake-channel-adapter";
import { seedWorkspace, type SeededWorkspace } from "./testing/fixtures";

interface LogLine {
  readonly level: "info" | "warn" | "error";
  readonly event: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

describe.skipIf(!databaseTestsEnabled())("webhook ingestion (PostgreSQL)", () => {
  let database: TestDatabase;
  let seeded: SeededWorkspace;
  let logs: LogLine[];
  let scheduled: { job: InboundDebouncePayload; delayMs: number }[];
  let schedulerFailure: Error | undefined;
  let normalizeCalls: number;
  let sequence = 0;
  const db = () => database.db;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    seeded = await seedWorkspace(database.db, "ingest");
  }, 120_000);

  afterAll(async () => {
    await database?.dispose();
  });

  beforeEach(() => {
    logs = [];
    scheduled = [];
    schedulerFailure = undefined;
    normalizeCalls = 0;
  });

  const unique = (prefix: string) => `${prefix}-${++sequence}`;
  const now = () => new Date();

  const dependencies = (): IngestionDependencies => {
    const scheduler: DebounceScheduler = {
      scheduleInboundDebounce: (job, { delayMs }) => {
        if (schedulerFailure !== undefined) {
          return Promise.reject(schedulerFailure);
        }
        scheduled.push({ job, delayMs });
        return Promise.resolve();
      },
    };
    const log: LogPort = {
      info: (event, fields = {}) => logs.push({ level: "info", event, fields }),
      warn: (event, fields = {}) => logs.push({ level: "warn", event, fields }),
      error: (event, fields = {}) => logs.push({ level: "error", event, fields }),
    };
    return {
      store: createIngestionStore(database.db),
      adapters: {
        adapterFor: (account) => {
          const adapter = createFakeChannelAdapter(account);
          return {
            ...adapter,
            normalizeWebhook: (input) => {
              normalizeCalls += 1;
              return adapter.normalizeWebhook(input);
            },
          };
        },
      },
      scheduler,
      log,
      now,
      random: () => 0.5,
    };
  };

  const ingest = (
    events: readonly FakeEventFixture[],
    options: { signature?: string; correlationId?: string; channel?: string; channelAccountId?: string } = {},
  ): Promise<WebhookIngestionResult> =>
    ingestWebhook(dependencies(), {
      channel: options.channel ?? "INSTAGRAM",
      channelAccountId: options.channelAccountId ?? seeded.channelAccount.id,
      webhook: fakeWebhook(events, options.signature === undefined ? {} : { signature: options.signature }),
      correlationId: options.correlationId ?? unique("corr"),
    });

  const text = (from: string, overrides: Partial<Extract<FakeEventFixture, { kind: "text" }>> = {}): FakeEventFixture => ({
    kind: "text",
    id: unique("evt"),
    from,
    mid: unique("mid"),
    text: "Hi, do you have availability tomorrow?",
    at: new Date().toISOString(),
    ...overrides,
  });

  const counts = async () => ({
    events: await db().inboundEvent.count(),
    messages: await db().message.count(),
    contacts: await db().contact.count(),
    outbox: await db().queueOutbox.count(),
  });

  it("stores a valid inbound message, opens the conversation and schedules one debounce with the correlation ID", async () => {
    const event = text("ig-user-new", { name: "New Customer" });
    const started = Date.now();
    const result = await ingest([event], { correlationId: "corr-inbound-1" });
    const elapsedMs = Date.now() - started;

    expect(result).toEqual({
      kind: "ACCEPTED",
      summary: { received: 1, processed: 1, duplicates: 0, rejected: 0, debounceScheduled: 1, debounceDeferred: 0 },
    });
    const identity = await db().contactIdentity.findFirstOrThrow({ where: { externalUserId: "ig-user-new" }, include: { contact: true } });
    expect(identity).toMatchObject({ workspaceId: seeded.context.workspaceId, displayName: "New Customer" });
    const conversation = await db().conversation.findFirstOrThrow({ where: { contactIdentityId: identity.id } });
    expect(conversation).toMatchObject({ status: "OPEN", takeoverState: "NONE", lastInboundAt: new Date(event.at) });
    const message = await db().message.findFirstOrThrow({ where: { conversationId: conversation.id } });
    expect(message).toMatchObject({ direction: "IN", source: "PARTICIPANT", kind: "TEXT", channelMessageId: event.kind === "text" ? event.mid : "" });

    expect(await db().inboundEvent.findFirstOrThrow({ where: { sourceEventId: event.id } })).toMatchObject({
      correlationId: "corr-inbound-1",
      outcome: "INBOUND_STORED",
      eventType: "INBOUND_MESSAGE",
    });
    const outbox = await db().queueOutbox.findFirstOrThrow({ where: { payload: { path: ["anchorMessageId"], equals: message.id } } });
    expect(outbox).toMatchObject({ correlationId: "corr-inbound-1", delayMs: 9_500, attempts: 1 });
    expect(outbox.dispatchedAt).not.toBeNull();

    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.job).toEqual({
      schemaVersion: 1,
      workspaceId: seeded.context.workspaceId,
      correlationId: "corr-inbound-1",
      channelAccountId: seeded.channelAccount.id,
      conversationId: conversation.id,
      anchorMessageId: message.id,
      anchorInboundAt: event.at,
    });
    // The route does not wait for the 7–12 s debounce: it only schedules it.
    expect(scheduled[0]?.delayMs).toBeGreaterThan(8_000);
    expect(elapsedMs).toBeLessThan(2_000);
    expect(logs.filter((line) => line.event.startsWith("ingestion.")).every((line) => line.fields.correlationId === "corr-inbound-1")).toBe(true);
    expect(JSON.stringify(logs)).not.toContain("availability tomorrow");
  });

  it("treats redelivered webhooks and source events as no-ops, including concurrent duplicates", async () => {
    const event = text("ig-user-dup");
    const first = await ingest([event]);
    const before = await counts();

    const again = await ingest([event]);
    const concurrent = await Promise.all([ingest([event]), ingest([event]), ingest([event])]);

    expect(first).toMatchObject({ summary: { processed: 1, debounceScheduled: 1 } });
    for (const result of [again, ...concurrent]) {
      expect(result).toMatchObject({ kind: "ACCEPTED", summary: { processed: 0, duplicates: 1, debounceScheduled: 0 } });
    }
    expect(await counts()).toEqual(before);
    expect(scheduled).toHaveLength(1);

    // The same platform message under a new provider event ID is stored once and starts no second reply cycle.
    const sameMessage = await ingest([{ ...event, id: unique("evt") }]);
    expect(sameMessage).toMatchObject({ summary: { processed: 1, debounceScheduled: 0 } });
    expect(await db().message.count()).toBe(before.messages);
    expect(scheduled).toHaveLength(1);
  });

  it("serializes concurrent first contacts from one new user into one identity and conversation", async () => {
    const results = await Promise.all(["a", "b", "c"].map(() => ingest([text("ig-user-race")])));

    expect(results.every((result) => result.kind === "ACCEPTED")).toBe(true);
    expect(await db().contactIdentity.count({ where: { externalUserId: "ig-user-race" } })).toBe(1);
    const identity = await db().contactIdentity.findFirstOrThrow({ where: { externalUserId: "ig-user-race" } });
    expect(await db().conversation.count({ where: { contactIdentityId: identity.id } })).toBe(1);
    expect(await db().contact.count({ where: { identities: { none: {} } } })).toBe(0);
    expect(await db().message.count({ where: { conversation: { contactIdentityId: identity.id } } })).toBe(3);
  });

  it("rejects failed verification, unknown accounts and unavailable adapters before normalization or persistence", async () => {
    const before = await counts();

    expect(await ingest([text("ig-user-forged")], { signature: "forged" })).toEqual({ kind: "UNAUTHORIZED" });
    expect(await ingest([text("ig-user-forged")], { channelAccountId: "00000000-0000-7000-8000-000000000000" })).toEqual({ kind: "NOT_FOUND" });
    expect(await ingest([text("ig-user-forged")], { channel: "WHATSAPP" })).toEqual({ kind: "NOT_FOUND" });
    expect(await ingest([text("ig-user-forged")], { channel: "TELEGRAM" })).toEqual({ kind: "NOT_FOUND" });
    expect(
      await ingestWebhook(
        { ...dependencies(), adapters: { adapterFor: () => undefined } },
        { channel: "INSTAGRAM", channelAccountId: seeded.channelAccount.id, webhook: fakeWebhook([text("x")]), correlationId: "corr-x" },
      ),
    ).toEqual({ kind: "ADAPTER_UNAVAILABLE" });

    expect(normalizeCalls).toBe(0);
    expect(await counts()).toEqual(before);
    expect(scheduled).toHaveLength(0);
    expect(logs.find((line) => line.event === "ingestion.verification_failed")?.fields).toMatchObject({ reason: "invalid signature" });
  });

  it("answers the subscription challenge and refuses malformed payloads without writing", async () => {
    const before = await counts();
    const challenge = await ingestWebhook(dependencies(), {
      channel: "INSTAGRAM",
      channelAccountId: seeded.channelAccount.id,
      webhook: {
        method: "GET",
        headers: {},
        query: { "hub.verify_token": FAKE_VERIFY_TOKEN, "hub.challenge": "challenge-42" },
        rawBody: new Uint8Array(),
        receivedAt: new Date(),
      },
      correlationId: "corr-challenge",
    });
    const malformed = await ingestWebhook(dependencies(), {
      channel: "INSTAGRAM",
      channelAccountId: seeded.channelAccount.id,
      webhook: fakeWebhook([], { body: "{not json" }),
      correlationId: "corr-malformed",
    });

    expect(challenge).toEqual({ kind: "CHALLENGE", responseBody: "challenge-42" });
    expect(malformed).toEqual({ kind: "INVALID_PAYLOAD" });
    expect(await counts()).toEqual(before);
  });

  it("processes a multi-event webhook, auditing unknown and foreign events without storing them", async () => {
    const before = await counts();
    const result = await ingest([
      text("ig-user-multi-1"),
      text("ig-user-multi-2"),
      { kind: "delivered", id: unique("evt"), mid: "mid-nobody-knows", at: new Date().toISOString() },
      { kind: "reaction", id: unique("evt"), mid: seeded.messageId, from: "ig-user-multi-1", at: new Date().toISOString() },
      { kind: "unknown", id: unique("evt"), at: new Date().toISOString() },
      { ...text("ig-user-foreign"), workspaceId: "another-workspace" },
    ]);

    expect(result).toEqual({
      kind: "ACCEPTED",
      summary: { received: 6, processed: 4, duplicates: 0, rejected: 2, debounceScheduled: 2, debounceDeferred: 0 },
    });
    const after = await counts();
    expect(after.events - before.events).toBe(4);
    expect(after.messages - before.messages).toBe(2);
    expect(after.outbox - before.outbox).toBe(2);
    expect((await db().inboundEvent.findMany({ where: { outcome: { in: ["STATUS_UNMATCHED", "IGNORED_UNSUPPORTED"] } } })).length).toBeGreaterThanOrEqual(2);
    expect(await db().contactIdentity.count({ where: { externalUserId: "ig-user-foreign" } })).toBe(0);
    expect(logs.filter((line) => line.event === "ingestion.event_rejected").map((line) => line.fields.reason)).toEqual([
      "INVALID_EVENT",
      "ACCOUNT_MISMATCH",
    ]);
  });

  it("applies delivery and read statuses monotonically", async () => {
    const outbound = await db().message.create({
      data: {
        workspaceId: seeded.context.workspaceId,
        channelAccountId: seeded.channelAccount.id,
        conversationId: seeded.conversationId,
        channelMessageId: "mid-app-status",
        direction: "OUT",
        source: "AI",
        kind: "TEXT",
        transportPath: "STANDARD",
        operationId: unique("op"),
        deliveryStatus: "SENT",
        occurredAt: new Date(),
      },
    });
    const status = (kind: "delivered" | "read" | "failed") =>
      ingest([
        kind === "read"
          ? { kind, id: unique("evt"), mid: "mid-app-status", reader: "ig-user-ingest", at: new Date().toISOString() }
          : { kind, id: unique("evt"), mid: "mid-app-status", at: new Date().toISOString() },
      ]);
    const stored = async () => db().message.findUniqueOrThrow({ where: { id: outbound.id } });

    await status("delivered");
    expect(await stored()).toMatchObject({ deliveryStatus: "DELIVERED" });
    expect((await stored()).deliveredAt).not.toBeNull();
    await status("read");
    expect(await stored()).toMatchObject({ deliveryStatus: "READ" });
    await status("delivered");
    await status("failed");
    expect(await stored()).toMatchObject({ deliveryStatus: "READ" });

    const outcomes = await db().inboundEvent.findMany({
      where: { eventType: { in: ["DELIVERY_STATUS", "READ_STATUS"] }, correlationId: { not: null } },
      orderBy: { receivedAt: "asc" },
      select: { outcome: true },
    });
    expect(outcomes.slice(-4).map((row) => row.outcome)).toEqual(["STATUS_APPLIED", "STATUS_APPLIED", "STATUS_UNCHANGED", "STATUS_UNCHANGED"]);
  });

  it("keeps own echoes quiet and turns unmatched echoes into a human takeover that stops debounce", async () => {
    await db().message.create({
      data: {
        workspaceId: seeded.context.workspaceId,
        channelAccountId: seeded.channelAccount.id,
        conversationId: seeded.conversationId,
        channelMessageId: "mid-own-echo",
        direction: "OUT",
        source: "AI",
        kind: "TEXT",
        transportPath: "STANDARD",
        operationId: unique("op"),
        occurredAt: new Date(),
      },
    });
    const own = await ingest([{ kind: "echo", id: unique("evt"), to: "ig-user-ingest", mid: "mid-own-echo", at: new Date().toISOString() }]);
    expect(own).toMatchObject({ summary: { processed: 1 } });
    expect(await db().conversation.findUniqueOrThrow({ where: { id: seeded.conversationId } })).toMatchObject({ takeoverState: "NONE" });

    const at = new Date();
    const human = await ingest([{ kind: "echo", id: unique("evt"), to: "ig-user-human", mid: "mid-native-app", text: "I'll handle this", at: at.toISOString() }]);
    expect(human).toMatchObject({ summary: { processed: 1 } });
    const identity = await db().contactIdentity.findFirstOrThrow({ where: { externalUserId: "ig-user-human" } });
    const conversation = await db().conversation.findFirstOrThrow({ where: { contactIdentityId: identity.id } });
    expect(conversation).toMatchObject({
      takeoverState: "HUMAN_ACTIVE",
      takeoverReason: "UNMATCHED_OUTBOUND_ECHO",
      takeoverActorKind: "NATIVE_APP",
      humanTakeoverAt: at,
      takeoverPausedUntil: new Date(at.getTime() + 6 * 60 * 60 * 1000),
      lastOutboundAt: at,
    });
    expect(await db().message.findFirstOrThrow({ where: { channelMessageId: "mid-native-app" } })).toMatchObject({
      direction: "OUT",
      source: "HUMAN",
      deliveryStatus: "SENT",
    });
    const outcomes = await db().inboundEvent.findMany({ where: { eventType: "OUTBOUND_ECHO" }, select: { outcome: true }, orderBy: { receivedAt: "asc" } });
    expect(outcomes.map((row) => row.outcome)).toEqual(["OWN_ECHO", "HUMAN_TAKEOVER"]);

    const reply = await ingest([text("ig-user-human")]);
    expect(reply).toMatchObject({ summary: { processed: 1, debounceScheduled: 0, debounceDeferred: 0 } });
    expect(scheduled).toHaveLength(0);
  });

  it("keeps the debounce in the outbox when enqueueing fails and dispatches it on recovery", async () => {
    schedulerFailure = new Error("redis unavailable");
    const event = text("ig-user-outage");
    const result = await ingest([event], { correlationId: "corr-outage" });

    expect(result).toMatchObject({ kind: "ACCEPTED", summary: { processed: 1, debounceScheduled: 0, debounceDeferred: 1 } });
    const pending = await db().queueOutbox.findFirstOrThrow({ where: { correlationId: "corr-outage" } });
    expect(pending).toMatchObject({ dispatchedAt: null, attempts: 1, lastErrorName: "Error", lockedUntil: null });
    expect(pending.availableAt.getTime()).toBeGreaterThan(Date.now());
    expect(await db().message.count({ where: { channelMessageId: event.kind === "text" ? event.mid : "" } })).toBe(1);

    // Redelivery while the entry is pending neither duplicates it nor schedules twice.
    expect(await ingest([event])).toMatchObject({ summary: { duplicates: 1 } });
    expect(await db().queueOutbox.count({ where: { correlationId: "corr-outage" } })).toBe(1);

    const sweep = (at: Date) => dispatchOutbox({ ...dependencies(), now: () => at });
    expect(await sweep(new Date())).toEqual({ dispatched: 0, failed: 0 });

    schedulerFailure = undefined;
    const later = new Date(pending.availableAt.getTime() + 1);
    expect(await sweep(later)).toEqual({ dispatched: 1, failed: 0 });
    expect(scheduled.map((entry) => entry.job.correlationId)).toEqual(["corr-outage"]);
    expect(await db().queueOutbox.findUniqueOrThrow({ where: { id: pending.id } })).toMatchObject({ attempts: 2 });
    expect((await db().queueOutbox.findUniqueOrThrow({ where: { id: pending.id } })).dispatchedAt).not.toBeNull();
    expect(await sweep(new Date(later.getTime() + 60_000))).toEqual({ dispatched: 0, failed: 0 });
  });

  it("lets only one dispatcher claim an outbox entry", async () => {
    schedulerFailure = new Error("redis unavailable");
    await ingest([text("ig-user-lease")], { correlationId: "corr-lease" });
    schedulerFailure = undefined;
    const entry = await db().queueOutbox.findFirstOrThrow({ where: { correlationId: "corr-lease" } });
    const at = new Date(entry.availableAt.getTime() + 1);
    const store = createIngestionStore(db());

    const claims = await Promise.all([1, 2, 3].map(() => store.claimOutboxEntries({ now: at, limit: 10, leaseMs: 30_000, ids: [entry.id] })));
    expect(claims.flat()).toHaveLength(1);
  });
});
