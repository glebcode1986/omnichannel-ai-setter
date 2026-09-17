import {
  dispatchOutbox,
  ingestWebhook,
  type DebounceScheduler,
  type InboundDebouncePayload,
  type IngestionDependencies,
  type IngestionStore,
  type LogPort,
  type WebhookIngestionResult,
} from "@omnichannel/application";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createIngestionStore } from "./index";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { createFakeChannelAdapter, fakeWebhook, FAKE_VERIFY_TOKEN, type FakeEventFixture } from "./testing/fake-channel-adapter";
import { seedWorkspace, type SeededProfile } from "./testing/fixtures";

const FOREIGN_KEY_VIOLATION = { code: "P2003" };

type TextFixture = Extract<FakeEventFixture, { kind: "text" }>;

interface LogLine {
  readonly level: "info" | "warn" | "error";
  readonly event: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

describe.skipIf(!databaseTestsEnabled())("webhook ingestion (PostgreSQL)", () => {
  let database: TestDatabase;
  /** One Workspace with two Business Profiles, each with its own Instagram account and seeded conversation. */
  let main: SeededProfile;
  let second: SeededProfile;
  /** A profile in another Workspace, for forged cross-Workspace scope. */
  let foreign: SeededProfile;
  let logs: LogLine[];
  let scheduled: { job: InboundDebouncePayload; delayMs: number }[];
  let schedulerFailure: Error | undefined;
  let normalizeCalls: number;
  let sequence = 0;
  const db = () => database.db;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    [main, second] = (await seedWorkspace(database.db, "ingest", ["main", "second"])).profiles as [SeededProfile, SeededProfile];
    [foreign] = (await seedWorkspace(database.db, "ingest-foreign")).profiles as [SeededProfile];
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
  const scope = (profile: SeededProfile) => ({ workspaceId: profile.context.workspaceId, businessProfileId: profile.businessProfileId });

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
    options: { signature?: string; correlationId?: string; channel?: string; channelAccountId?: string; profile?: SeededProfile } = {},
  ): Promise<WebhookIngestionResult> =>
    ingestWebhook(dependencies(), {
      channel: options.channel ?? "INSTAGRAM",
      channelAccountId: options.channelAccountId ?? (options.profile ?? main).channelAccount.id,
      webhook: fakeWebhook(events, options.signature === undefined ? {} : { signature: options.signature }),
      correlationId: options.correlationId ?? unique("corr"),
    });

  const text = (from: string, overrides: Partial<TextFixture> = {}): TextFixture => ({
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
    identities: await db().channelIdentity.count(),
    conversations: await db().conversation.count(),
    outbox: await db().queueOutbox.count(),
  });

  const stateVersions = async () =>
    Object.fromEntries((await db().conversation.findMany({ select: { id: true, stateVersion: true } })).map((row) => [row.id, row.stateVersion]));

  const stateVersionOf = async (conversationId: string) =>
    (await db().conversation.findUniqueOrThrow({ where: { id: conversationId }, select: { stateVersion: true } })).stateVersion;

  /** The identity and conversation of a provider user inside one Business Profile (via scope-leading keys). */
  const threadOf = async (profile: SeededProfile, externalUserId: string) => {
    const identity = await db().channelIdentity.findUniqueOrThrow({
      where: {
        workspaceId_businessProfileId_channelAccountId_externalUserId: {
          ...scope(profile),
          channelAccountId: profile.channelAccount.id,
          externalUserId,
        },
      },
    });
    const conversation = await db().conversation.findUniqueOrThrow({
      where: {
        workspaceId_businessProfileId_channelAccountId_channelIdentityId: {
          ...scope(profile),
          channelAccountId: profile.channelAccount.id,
          channelIdentityId: identity.id,
        },
      },
    });
    return { identity, conversation };
  };

  const rejectedFields = () =>
    logs.filter((line) => line.event === "ingestion.event_rejected").map((line) => [line.fields.reason, line.fields.fields]);

  it("stores a valid inbound message inside the account's Business Profile and schedules one scoped debounce", async () => {
    const event = text("ig-user-new", { name: "New Customer" });
    const started = Date.now();
    const result = await ingest([event], { correlationId: "corr-inbound-1" });
    const elapsedMs = Date.now() - started;

    expect(result).toEqual({
      kind: "ACCEPTED",
      summary: { received: 1, processed: 1, duplicates: 0, rejected: 0, debounceScheduled: 1, debounceDeferred: 0 },
    });
    const { identity, conversation } = await threadOf(main, "ig-user-new");
    expect(identity).toMatchObject({ displayName: "New Customer" });
    expect(await db().contact.findUniqueOrThrow({ where: { id: identity.contactId } })).toMatchObject({ ...scope(main), displayName: "New Customer" });
    expect(conversation).toMatchObject({
      contactId: identity.contactId,
      status: "OPEN",
      takeoverState: "NONE",
      stateVersion: 1,
      lastInboundAt: new Date(event.at),
    });
    // Nothing leaks into the sibling Business Profile of the same Workspace.
    expect(await db().channelIdentity.count({ where: { externalUserId: "ig-user-new" } })).toBe(1);

    const message = await db().message.findFirstOrThrow({ where: { conversationId: conversation.id } });
    expect(message).toMatchObject({
      ...scope(main),
      channelAccountId: main.channelAccount.id,
      direction: "IN",
      source: "PARTICIPANT",
      kind: "TEXT",
      channelMessageId: event.mid,
    });
    expect(await db().inboundEvent.findFirstOrThrow({ where: { sourceEventId: event.id } })).toMatchObject({
      ...scope(main),
      correlationId: "corr-inbound-1",
      outcome: "INBOUND_STORED",
      eventType: "INBOUND_MESSAGE",
    });
    const outbox = await db().queueOutbox.findFirstOrThrow({ where: { payload: { path: ["anchorMessageId"], equals: message.id } } });
    expect(outbox).toMatchObject({
      ...scope(main),
      dedupeKey: `inbound-debounce:${main.context.workspaceId}:${main.businessProfileId}:${conversation.id}:${message.id}`,
      correlationId: "corr-inbound-1",
      delayMs: 9_500,
      attempts: 1,
    });
    expect(outbox.dispatchedAt).not.toBeNull();

    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.job).toEqual({
      schemaVersion: 1,
      ...scope(main),
      correlationId: "corr-inbound-1",
      channelAccountId: main.channelAccount.id,
      conversationId: conversation.id,
      anchorMessageId: message.id,
      anchorInboundAt: event.at,
    });
    // The route does not wait for the 7–12 s debounce: it only schedules it.
    expect(scheduled[0]?.delayMs).toBeGreaterThan(8_000);
    expect(elapsedMs).toBeLessThan(2_000);
    expect(logs.filter((line) => line.event.startsWith("ingestion.")).every((line) => line.fields.correlationId === "corr-inbound-1")).toBe(true);
    expect(logs.find((line) => line.event === "outbox.dispatched")?.fields).toMatchObject(scope(main));
    expect(JSON.stringify(logs)).not.toContain("availability tomorrow");
  });

  it("gives each Business Profile of one Workspace its own contact, identity, conversation and debounce for the same provider user", async () => {
    const event = text("ig-user-shared", { id: "evt-shared", mid: "mid-shared" });
    const results = await Promise.all([
      ingest([event], { profile: main, correlationId: "corr-shared-main" }),
      ingest([event], { profile: second, correlationId: "corr-shared-second" }),
      ingest([event], { profile: main }),
      ingest([event], { profile: second }),
    ]);

    // Same provider event and message IDs on two accounts: one claim per Business Profile, never merged.
    const summaries = results.map((result) => (result.kind === "ACCEPTED" ? result.summary : undefined));
    expect(summaries.reduce((sum, summary) => sum + (summary?.processed ?? 0), 0)).toBe(2);
    expect(summaries.reduce((sum, summary) => sum + (summary?.duplicates ?? 0), 0)).toBe(2);
    expect(scheduled).toHaveLength(2);

    const inMain = await threadOf(main, "ig-user-shared");
    const inSecond = await threadOf(second, "ig-user-shared");
    expect(inMain.identity.contactId).not.toBe(inSecond.identity.contactId);
    expect(inMain.conversation.id).not.toBe(inSecond.conversation.id);
    expect(await db().contact.findUniqueOrThrow({ where: { id: inMain.identity.contactId } })).toMatchObject(scope(main));
    expect(await db().contact.findUniqueOrThrow({ where: { id: inSecond.identity.contactId } })).toMatchObject(scope(second));
    expect(inMain.conversation).toMatchObject({ ...scope(main), contactId: inMain.identity.contactId, stateVersion: 1 });
    expect(inSecond.conversation).toMatchObject({ ...scope(second), contactId: inSecond.identity.contactId, stateVersion: 1 });

    for (const [profile, thread] of [
      [main, inMain],
      [second, inSecond],
    ] as const) {
      expect(await db().inboundEvent.count({ where: { ...scope(profile), sourceEventId: "evt-shared" } })).toBe(1);
      const messages = await db().message.findMany({ where: { channelMessageId: "mid-shared", ...scope(profile) } });
      expect(messages).toHaveLength(1);
      expect(messages[0]?.conversationId).toBe(thread.conversation.id);
      const outbox = await db().queueOutbox.findMany({ where: { payload: { path: ["conversationId"], equals: thread.conversation.id } } });
      expect(outbox).toHaveLength(1);
      expect(outbox[0]).toMatchObject({ ...scope(profile), payload: expect.objectContaining(scope(profile)) as unknown });
      expect(scheduled.filter((entry) => entry.job.conversationId === thread.conversation.id).map((entry) => entry.job)).toEqual([
        expect.objectContaining({ ...scope(profile), channelAccountId: profile.channelAccount.id, anchorMessageId: messages[0]?.id }),
      ]);
    }

    // A participant already known in both profiles threads into the profile whose account received the message.
    const mainVersion = await stateVersionOf(main.conversationId);
    const secondVersion = await stateVersionOf(second.conversationId);
    await ingest([text("ig-user-ingest")], { profile: second });
    expect(await stateVersionOf(second.conversationId)).toBe(secondVersion + 1);
    expect(await stateVersionOf(main.conversationId)).toBe(mainVersion);
    expect(scheduled.at(-1)?.job).toMatchObject({ ...scope(second), conversationId: second.conversationId });
  });

  it("rejects events forged with another Business Profile, account, channel or Workspace and writes nothing for them", async () => {
    const before = await counts();
    const versions = await stateVersions();
    const at = new Date().toISOString();

    const throughMain = await ingest([
      text("ig-user-forged-bp", { businessProfileId: second.businessProfileId }),
      text("ig-user-forged-account", { channelAccountId: second.channelAccount.id }),
      text("ig-user-forged-ws", { workspaceId: foreign.context.workspaceId }),
      text("ig-user-forged-all", {
        workspaceId: foreign.context.workspaceId,
        businessProfileId: foreign.businessProfileId,
        channelAccountId: foreign.channelAccount.id,
      }),
      text("ig-user-forged-channel", { channel: "WHATSAPP" }),
      // Known participant and message of the sibling profile.
      text("ig-user-ingest", { businessProfileId: second.businessProfileId, channelAccountId: second.channelAccount.id }),
      { kind: "echo", id: unique("evt"), to: "ig-user-ingest", mid: unique("mid"), at, businessProfileId: second.businessProfileId },
      { kind: "delivered", id: unique("evt"), mid: "mid-ingest-second-1", at, businessProfileId: second.businessProfileId },
    ]);
    const throughSecond = await ingest([text("ig-user-forged-main", { businessProfileId: main.businessProfileId, channelAccountId: main.channelAccount.id })], {
      profile: second,
    });
    const throughForeign = await ingest([text("ig-user-forged-into-ws", { workspaceId: main.context.workspaceId, businessProfileId: main.businessProfileId })], {
      profile: foreign,
    });

    expect(throughMain).toEqual({
      kind: "ACCEPTED",
      summary: { received: 8, processed: 0, duplicates: 0, rejected: 8, debounceScheduled: 0, debounceDeferred: 0 },
    });
    expect(throughSecond).toMatchObject({ summary: { received: 1, processed: 0, rejected: 1 } });
    expect(throughForeign).toMatchObject({ summary: { received: 1, processed: 0, rejected: 1 } });
    expect(rejectedFields()).toEqual([
      ["SCOPE_MISMATCH", ["businessProfileId"]],
      ["SCOPE_MISMATCH", ["channelAccountId"]],
      ["SCOPE_MISMATCH", ["workspaceId"]],
      ["SCOPE_MISMATCH", ["workspaceId", "businessProfileId", "channelAccountId"]],
      ["SCOPE_MISMATCH", ["channel"]],
      ["SCOPE_MISMATCH", ["businessProfileId", "channelAccountId"]],
      ["SCOPE_MISMATCH", ["businessProfileId"]],
      ["SCOPE_MISMATCH", ["businessProfileId"]],
      ["SCOPE_MISMATCH", ["businessProfileId", "channelAccountId"]],
      ["SCOPE_MISMATCH", ["workspaceId", "businessProfileId"]],
    ]);
    expect(await counts()).toEqual(before);
    expect(await stateVersions()).toEqual(versions);
    expect(await db().message.findFirstOrThrow({ where: { channelMessageId: "mid-ingest-second-1" } })).toMatchObject({ deliveryStatus: null });
    expect(scheduled).toHaveLength(0);
  });

  it("treats redelivered webhooks and source events as no-ops, including concurrent duplicates", async () => {
    const event = text("ig-user-dup");
    const first = await ingest([event]);
    const before = await counts();
    const { conversation } = await threadOf(main, "ig-user-dup");
    expect(conversation.stateVersion).toBe(1);

    const again = await ingest([event]);
    const concurrent = await Promise.all([ingest([event]), ingest([event]), ingest([event])]);

    expect(first).toMatchObject({ summary: { processed: 1, debounceScheduled: 1 } });
    for (const result of [again, ...concurrent]) {
      expect(result).toMatchObject({ kind: "ACCEPTED", summary: { processed: 0, duplicates: 1, debounceScheduled: 0 } });
    }
    expect(await counts()).toEqual(before);
    expect(scheduled).toHaveLength(1);

    // The same platform message under a new provider event ID is stored once and starts no second reply cycle;
    // the refreshed display name is profile data only and does not advance the conversation state.
    const sameMessage = await ingest([{ ...event, id: unique("evt"), name: "Renamed Customer" }]);
    expect(sameMessage).toMatchObject({ summary: { processed: 1, debounceScheduled: 0 } });
    expect(await db().message.count()).toBe(before.messages);
    expect(scheduled).toHaveLength(1);
    const refreshed = await threadOf(main, "ig-user-dup");
    expect(refreshed.identity.displayName).toBe("Renamed Customer");
    expect(refreshed.conversation.stateVersion).toBe(1);
  });

  it("serializes concurrent first contacts from one new user into one identity and conversation", async () => {
    const results = await Promise.all(["a", "b", "c"].map(() => ingest([text("ig-user-race")])));

    expect(results.every((result) => result.kind === "ACCEPTED")).toBe(true);
    expect(await db().channelIdentity.count({ where: { externalUserId: "ig-user-race" } })).toBe(1);
    const { identity, conversation } = await threadOf(main, "ig-user-race");
    expect(await db().conversation.count({ where: { channelIdentityId: identity.id } })).toBe(1);
    expect(await db().contact.count({ where: { channelIdentities: { none: {} } } })).toBe(0);
    expect(await db().message.count({ where: { conversationId: conversation.id } })).toBe(3);
    expect(conversation.stateVersion).toBe(3);
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
        { channel: "INSTAGRAM", channelAccountId: main.channelAccount.id, webhook: fakeWebhook([text("x")]), correlationId: "corr-x" },
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
      channelAccountId: main.channelAccount.id,
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
      channelAccountId: main.channelAccount.id,
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
      { kind: "reaction", id: unique("evt"), mid: "mid-ingest-main-1", from: "ig-user-multi-1", at: new Date().toISOString() },
      { kind: "unknown", id: unique("evt"), at: new Date().toISOString() },
      text("ig-user-foreign", { workspaceId: foreign.context.workspaceId }),
    ]);

    expect(result).toEqual({
      kind: "ACCEPTED",
      summary: { received: 6, processed: 4, duplicates: 0, rejected: 2, debounceScheduled: 2, debounceDeferred: 0 },
    });
    const after = await counts();
    expect(after.events - before.events).toBe(4);
    expect(after.messages - before.messages).toBe(2);
    expect(after.outbox - before.outbox).toBe(2);
    expect(await db().inboundEvent.count({ where: { ...scope(main), outcome: { in: ["STATUS_UNMATCHED", "IGNORED_UNSUPPORTED"] } } })).toBeGreaterThanOrEqual(2);
    expect(await db().channelIdentity.count({ where: { externalUserId: "ig-user-foreign" } })).toBe(0);
    expect(rejectedFields()).toEqual([
      ["INVALID_EVENT", undefined],
      ["SCOPE_MISMATCH", ["workspaceId"]],
    ]);
  });

  it("applies delivery and read statuses monotonically and only inside the account's Business Profile", async () => {
    const outbound = (profile: SeededProfile) =>
      db().message.create({
        data: {
          ...scope(profile),
          channelAccountId: profile.channelAccount.id,
          conversationId: profile.conversationId,
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
    const inMain = await outbound(main);
    const inSecond = await outbound(second);
    const versions = await stateVersions();
    const status = (kind: "delivered" | "read" | "failed") =>
      ingest([
        kind === "read"
          ? { kind, id: unique("evt"), mid: "mid-app-status", reader: "ig-user-ingest", at: new Date().toISOString() }
          : { kind, id: unique("evt"), mid: "mid-app-status", at: new Date().toISOString() },
      ]);
    const stored = async (id: string) => db().message.findUniqueOrThrow({ where: { id } });

    await status("delivered");
    expect(await stored(inMain.id)).toMatchObject({ deliveryStatus: "DELIVERED" });
    expect((await stored(inMain.id)).deliveredAt).not.toBeNull();
    await status("read");
    expect(await stored(inMain.id)).toMatchObject({ deliveryStatus: "READ" });
    await status("delivered");
    await status("failed");
    expect(await stored(inMain.id)).toMatchObject({ deliveryStatus: "READ" });

    // Same platform message ID in the sibling profile is untouched; statuses never advance conversation state.
    expect(await stored(inSecond.id)).toMatchObject({ deliveryStatus: "SENT", deliveredAt: null, readAt: null });
    expect(await stateVersions()).toEqual(versions);

    const outcomes = await db().inboundEvent.findMany({
      where: { ...scope(main), eventType: { in: ["DELIVERY_STATUS", "READ_STATUS"] }, correlationId: { not: null } },
      orderBy: { receivedAt: "asc" },
      select: { outcome: true },
    });
    expect(outcomes.slice(-4).map((row) => row.outcome)).toEqual(["STATUS_APPLIED", "STATUS_APPLIED", "STATUS_UNCHANGED", "STATUS_UNCHANGED"]);
  });

  it.each([
    ["delivered", "read", "READ"],
    ["failed", "delivered", "DELIVERED"],
  ] as const)(
    "serializes overlapping status webhooks for one message (%s held open while %s arrives) so status never moves backwards",
    async (first, second, expected) => {
      const mid = unique("mid-status-race");
      const message = await db().message.create({
        data: {
          ...scope(main),
          channelAccountId: main.channelAccount.id,
          conversationId: main.conversationId,
          channelMessageId: mid,
          direction: "OUT",
          source: "AI",
          kind: "TEXT",
          transportPath: "STANDARD",
          operationId: unique("op"),
          deliveryStatus: "SENT",
          occurredAt: new Date(),
        },
      });
      const statusEvent = (kind: "delivered" | "read" | "failed"): FakeEventFixture =>
        kind === "read"
          ? { kind, id: unique("evt"), mid, reader: "ig-user-ingest", at: new Date().toISOString() }
          : { kind, id: unique("evt"), mid, at: new Date().toISOString() };

      // The first event pauses inside its transaction right after reading the stored status.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let markRead!: () => void;
      const firstHasRead = new Promise<void>((resolve) => (markRead = resolve));
      const base = createIngestionStore(db());
      const pausingStore: IngestionStore = {
        ...base,
        transaction: (work) =>
          base.transaction((tx) =>
            work({
              ...tx,
              findMessageByPlatformId: async (input) => {
                const found = await tx.findMessageByPlatformId(input);
                markRead();
                await gate;
                return found;
              },
            }),
          ),
      };
      const firstEvent = statusEvent(first);
      const firstResult = ingestWebhook(
        { ...dependencies(), store: pausingStore },
        { channel: "INSTAGRAM", channelAccountId: main.channelAccount.id, webhook: fakeWebhook([firstEvent]), correlationId: unique("corr") },
      );
      await firstHasRead;

      let secondFinished = false;
      const secondEvent = statusEvent(second);
      const secondResult = ingest([secondEvent]).then((result) => {
        secondFinished = true;
        return result;
      });
      // The second event must wait for the first transaction instead of overwriting it afterwards.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(secondFinished).toBe(false);
      release();

      expect(await firstResult).toMatchObject({ summary: { processed: 1 } });
      expect(await secondResult).toMatchObject({ summary: { processed: 1 } });
      expect((await db().message.findUniqueOrThrow({ where: { id: message.id } })).deliveryStatus).toBe(expected);
      const outcomes = await db().inboundEvent.findMany({
        where: { sourceEventId: { in: [firstEvent.id, secondEvent.id] } },
        select: { sourceEventId: true, outcome: true },
      });
      expect(Object.fromEntries(outcomes.map((row) => [row.sourceEventId, row.outcome]))).toEqual({
        [firstEvent.id]: "STATUS_APPLIED",
        [secondEvent.id]: "STATUS_APPLIED",
      });
    },
  );

  it("keeps own echoes quiet and turns unmatched echoes, including sends from a sibling profile, into a human takeover", async () => {
    const appSend = (profile: SeededProfile, channelMessageId: string) =>
      db().message.create({
        data: {
          ...scope(profile),
          channelAccountId: profile.channelAccount.id,
          conversationId: profile.conversationId,
          channelMessageId,
          direction: "OUT",
          source: "AI",
          kind: "TEXT",
          transportPath: "STANDARD",
          operationId: unique("op"),
          occurredAt: new Date(),
        },
      });
    const deliveryJob = async (profile: SeededProfile, platformMessageId: string) => {
      const draft = await db().aiDraft.create({
        data: {
          ...scope(profile),
          conversationId: profile.conversationId,
          anchorMessageId: profile.messageId,
          anchorStateVersion: await stateVersionOf(profile.conversationId),
          text: "See you tomorrow at 10.",
          structuredOutput: {},
          confidence: 0.9,
          modelSuggestsSend: true,
          needsReview: false,
          modelProvider: "fake-provider",
          modelName: "fake-model",
          promptVersion: "prompt-v1",
          schemaVersion: "schema-v1",
        },
      });
      // The send result is recorded on the delivery job before any outbound message row exists.
      await db().deliveryJobRecord.create({
        data: {
          ...scope(profile),
          draftId: draft.id,
          operationId: unique("op"),
          correlationId: unique("corr"),
          status: "SENT",
          scheduledFor: new Date(),
          selectedDelayMs: 0,
          sentAt: new Date(),
          platformMessageId,
        },
      });
    };
    const echo = (to: string, mid: string, at = new Date()) => ingest([{ kind: "echo", id: unique("evt"), to, mid, text: "I'll handle this", at: at.toISOString() }]);

    await appSend(main, "mid-own-echo");
    await deliveryJob(main, "mid-own-job-echo");
    await appSend(second, "mid-sibling-send");
    await deliveryJob(second, "mid-sibling-job");
    const mainVersion = await stateVersionOf(main.conversationId);

    expect(await echo("ig-user-ingest", "mid-own-echo")).toMatchObject({ summary: { processed: 1 } });
    expect(await echo("ig-user-ingest", "mid-own-job-echo")).toMatchObject({ summary: { processed: 1 } });
    expect(await db().conversation.findUniqueOrThrow({ where: { id: main.conversationId } })).toMatchObject({
      takeoverState: "NONE",
      stateVersion: mainVersion,
    });

    const at = new Date();
    expect(await echo("ig-user-human", "mid-native-app", at)).toMatchObject({ summary: { processed: 1 } });
    const { conversation } = await threadOf(main, "ig-user-human");
    expect(conversation).toMatchObject({
      takeoverState: "HUMAN_ACTIVE",
      takeoverReason: "UNMATCHED_OUTBOUND_ECHO",
      takeoverActorKind: "NATIVE_APP",
      humanTakeoverAt: at,
      takeoverPausedUntil: new Date(at.getTime() + 6 * 60 * 60 * 1000),
      lastOutboundAt: at,
      stateVersion: 1,
    });
    expect(await db().message.findFirstOrThrow({ where: { channelMessageId: "mid-native-app" } })).toMatchObject({
      ...scope(main),
      direction: "OUT",
      source: "HUMAN",
      deliveryStatus: "SENT",
    });

    // App sends of the sibling profile are not "ours" for this account's Business Profile.
    await echo("ig-user-human-2", "mid-sibling-send");
    await echo("ig-user-human-3", "mid-sibling-job");
    for (const participant of ["ig-user-human-2", "ig-user-human-3"]) {
      expect((await threadOf(main, participant)).conversation).toMatchObject({ takeoverState: "HUMAN_ACTIVE", stateVersion: 1 });
    }

    // A further manual reply extends the takeover (state advances once more); a redelivered echo changes nothing.
    await echo("ig-user-human", "mid-native-app-2");
    expect(await stateVersionOf(conversation.id)).toBe(2);
    await echo("ig-user-human", "mid-native-app-2");
    expect(await stateVersionOf(conversation.id)).toBe(2);

    const outcomes = await db().inboundEvent.findMany({
      where: { ...scope(main), eventType: "OUTBOUND_ECHO" },
      select: { outcome: true },
      orderBy: { receivedAt: "asc" },
    });
    expect(outcomes.map((row) => row.outcome)).toEqual([
      "OWN_ECHO",
      "OWN_ECHO",
      "HUMAN_TAKEOVER",
      "HUMAN_TAKEOVER",
      "HUMAN_TAKEOVER",
      "HUMAN_TAKEOVER",
      "OUTBOUND_DUPLICATE_MESSAGE",
    ]);

    const reply = await ingest([text("ig-user-human")]);
    expect(reply).toMatchObject({ summary: { processed: 1, debounceScheduled: 0, debounceDeferred: 0 } });
    expect(await stateVersionOf(conversation.id)).toBe(3);
    expect(scheduled).toHaveLength(0);
  });

  it("keeps the debounce in the outbox when enqueueing fails and dispatches it on recovery with its Business Profile scope", async () => {
    schedulerFailure = new Error("redis unavailable");
    const event = text("ig-user-outage");
    const result = await ingest([event], { correlationId: "corr-outage", profile: second });

    expect(result).toMatchObject({ kind: "ACCEPTED", summary: { processed: 1, debounceScheduled: 0, debounceDeferred: 1 } });
    const pending = await db().queueOutbox.findFirstOrThrow({ where: { correlationId: "corr-outage" } });
    expect(pending).toMatchObject({ ...scope(second), dispatchedAt: null, attempts: 1, lastErrorName: "Error", lockedUntil: null });
    expect(pending.availableAt.getTime()).toBeGreaterThan(Date.now());
    expect(await db().message.count({ where: { ...scope(second), channelMessageId: event.mid } })).toBe(1);

    // Redelivery while the entry is pending neither duplicates it nor schedules twice.
    expect(await ingest([event], { profile: second })).toMatchObject({ summary: { duplicates: 1 } });
    expect(await db().queueOutbox.count({ where: { correlationId: "corr-outage" } })).toBe(1);

    const store = createIngestionStore(db());
    const sweep = (at: Date) => dispatchOutbox({ ...dependencies(), now: () => at });
    expect(await sweep(new Date())).toEqual({ dispatched: 0, failed: 0 });

    schedulerFailure = undefined;
    const later = new Date(pending.availableAt.getTime() + 1);
    expect(await sweep(later)).toEqual({ dispatched: 1, failed: 0 });
    const { conversation } = await threadOf(second, "ig-user-outage");
    expect(scheduled.map((entry) => entry.job)).toEqual([
      {
        schemaVersion: 1,
        ...scope(second),
        correlationId: "corr-outage",
        channelAccountId: second.channelAccount.id,
        conversationId: conversation.id,
        anchorMessageId: (await db().message.findFirstOrThrow({ where: { ...scope(second), channelMessageId: event.mid } })).id,
        anchorInboundAt: event.at,
      },
    ]);
    expect(await db().queueOutbox.findUniqueOrThrow({ where: { id: pending.id } })).toMatchObject({ attempts: 2 });
    expect((await db().queueOutbox.findUniqueOrThrow({ where: { id: pending.id } })).dispatchedAt).not.toBeNull();
    expect(await sweep(new Date(later.getTime() + 60_000))).toEqual({ dispatched: 0, failed: 0 });
    expect(await store.claimOutboxEntries({ now: new Date(later.getTime() + 60_000), limit: 10, leaseMs: 1, ids: [pending.id] })).toEqual([]);
  });

  it("lets only one dispatcher claim an outbox entry and returns its Business Profile scope", async () => {
    schedulerFailure = new Error("redis unavailable");
    await ingest([text("ig-user-lease")], { correlationId: "corr-lease", profile: second });
    schedulerFailure = undefined;
    const entry = await db().queueOutbox.findFirstOrThrow({ where: { correlationId: "corr-lease" } });
    const at = new Date(entry.availableAt.getTime() + 1);
    const store = createIngestionStore(db());

    const claims = await Promise.all([1, 2, 3].map(() => store.claimOutboxEntries({ now: at, limit: 10, leaseMs: 30_000, ids: [entry.id] })));
    expect(claims.flat()).toEqual([
      expect.objectContaining({ id: entry.id, ...scope(second), correlationId: "corr-lease", payload: expect.objectContaining(scope(second)) as unknown }),
    ]);
  });

  it("scopes every ingestion store port by Business Profile, even when handed IDs from another profile", async () => {
    const store = createIngestionStore(db());
    const occurredAt = new Date();
    // Rows of the sibling profile addressed with this profile's scope (a bug or forged caller, not a webhook).
    const crossed = { ...scope(main), channelAccountId: second.channelAccount.id };
    const snapshot = async () => ({
      counts: await counts(),
      versions: await stateVersions(),
      second: await db().conversation.findUniqueOrThrow({ where: { id: second.conversationId } }),
      message: await db().message.findUniqueOrThrow({ where: { id: second.messageId } }),
    });
    const before = await snapshot();
    const inTransaction = <T>(work: Parameters<typeof store.transaction<T>>[0]) => store.transaction(work);

    await expect(
      inTransaction((tx) => tx.recordActivity({ ...scope(main), conversationId: second.conversationId, direction: "IN", occurredAt })),
    ).rejects.toThrow(/expected one conversation/);
    await expect(
      inTransaction((tx) => tx.recordActivity({ ...scope(main), conversationId: second.conversationId, direction: "OUT", occurredAt })),
    ).rejects.toThrow(/expected one conversation/);
    await expect(
      inTransaction((tx) =>
        tx.startHumanTakeover({ ...scope(main), conversationId: second.conversationId, since: occurredAt, pausedUntil: new Date(occurredAt.getTime() + 60_000) }),
      ),
    ).rejects.toThrow(/expected one conversation/);
    await expect(
      inTransaction((tx) =>
        tx.updateMessageDeliveryStatus({ ...scope(main), messageId: second.messageId, deliveryStatus: "READ", occurredAt }),
      ),
    ).rejects.toThrow();
    expect(
      await inTransaction((tx) =>
        tx.findMessageByPlatformId({ ...scope(main), channelAccountId: second.channelAccount.id, platformMessageId: "mid-ingest-second-1" }),
      ),
    ).toBeUndefined();
    expect(
      await inTransaction((tx) =>
        tx.findMessageByPlatformId({ ...scope(second), channelAccountId: second.channelAccount.id, platformMessageId: "mid-ingest-second-1" }),
      ),
    ).toEqual({ messageId: second.messageId, deliveryStatus: null });

    // An app send of the sibling profile is not "ours", even when its account is named.
    expect(
      await inTransaction((tx) =>
        tx.isAppOriginatedMessage({ ...scope(main), channelAccountId: second.channelAccount.id, platformMessageId: "mid-sibling-send" }),
      ),
    ).toBe(false);
    expect(
      await inTransaction((tx) =>
        tx.isAppOriginatedMessage({ ...scope(second), channelAccountId: second.channelAccount.id, platformMessageId: "mid-sibling-send" }),
      ),
    ).toBe(true);
    expect(
      await inTransaction((tx) =>
        tx.isAppOriginatedMessage({ ...scope(main), channelAccountId: second.channelAccount.id, platformMessageId: "mid-sibling-job" }),
      ),
    ).toBe(false);

    // Writes that would attach rows to an account, identity or contact of another profile fail in the database.
    await expect(
      inTransaction((tx) =>
        tx.claimSourceEvent({ ...crossed, sourceEventId: unique("evt"), eventType: "INBOUND_MESSAGE", occurredAt, correlationId: "corr-crossed" }),
      ),
    ).rejects.toMatchObject(FOREIGN_KEY_VIOLATION);
    await expect(inTransaction((tx) => tx.ensureChannelIdentity({ ...crossed, externalUserId: "ig-user-crossed" }))).rejects.toMatchObject(
      FOREIGN_KEY_VIOLATION,
    );
    await expect(
      inTransaction((tx) =>
        tx.ensureConversation({
          ...scope(main),
          channelAccountId: main.channelAccount.id,
          channelIdentityId: second.channelIdentityId,
          contactId: second.contactId,
        }),
      ),
    ).rejects.toMatchObject(FOREIGN_KEY_VIOLATION);
    await expect(
      inTransaction((tx) =>
        tx.insertMessage({
          ...scope(main),
          channelAccountId: main.channelAccount.id,
          conversationId: second.conversationId,
          direction: "IN",
          source: "PARTICIPANT",
          channelMessageId: unique("mid"),
          kind: "TEXT",
          media: [],
          occurredAt,
        }),
      ),
    ).rejects.toMatchObject(FOREIGN_KEY_VIOLATION);

    expect(await snapshot()).toEqual(before);
  });

  it("refuses raw outbox and inbound event rows whose Business Profile scope does not line up", async () => {
    const payload = (profile: SeededProfile): Record<string, string | number> => ({
      schemaVersion: 1,
      ...scope(profile),
      correlationId: "corr-raw",
      channelAccountId: profile.channelAccount.id,
      conversationId: profile.conversationId,
      anchorMessageId: profile.messageId,
      anchorInboundAt: new Date().toISOString(),
    });
    // Rows are created already dispatched so no sweep in this suite picks them up.
    const outboxRow = (row: { workspaceId: string; businessProfileId: string }, body: Record<string, string | number>) =>
      db().queueOutbox.create({
        data: { ...row, kind: "INBOUND_DEBOUNCE", dedupeKey: unique("raw"), correlationId: "corr-raw", payload: body, delayMs: 0, dispatchedAt: new Date() },
      });
    const payloadCheck = /queue_outbox_payload_scope_check/;

    await expect(outboxRow(scope(main), payload(main))).resolves.toBeDefined();
    await expect(
      outboxRow({ workspaceId: main.context.workspaceId, businessProfileId: foreign.businessProfileId }, {
        ...payload(main),
        businessProfileId: foreign.businessProfileId,
      }),
    ).rejects.toMatchObject(FOREIGN_KEY_VIOLATION);
    await expect(outboxRow(scope(main), payload(second))).rejects.toThrow(payloadCheck);
    await expect(outboxRow(scope(main), { ...payload(main), workspaceId: foreign.context.workspaceId })).rejects.toThrow(payloadCheck);
    const withoutProfile = payload(main);
    delete withoutProfile.businessProfileId;
    await expect(outboxRow(scope(main), withoutProfile)).rejects.toThrow(payloadCheck);
    const existing = await outboxRow(scope(second), payload(second));
    await expect(db().queueOutbox.update({ where: { id: existing.id }, data: { businessProfileId: main.businessProfileId } })).rejects.toThrow(payloadCheck);

    // An inbound event must name the Business Profile (and Workspace) that owns its channel account.
    const inboundEvent = (row: { workspaceId: string; businessProfileId: string }, channelAccountId: string) =>
      db().inboundEvent.create({
        data: { ...row, channelAccountId, sourceEventId: unique("evt-raw"), eventType: "INBOUND_MESSAGE", occurredAt: new Date() },
      });
    await expect(inboundEvent(scope(main), main.channelAccount.id)).resolves.toBeDefined();
    await expect(inboundEvent(scope(main), second.channelAccount.id)).rejects.toMatchObject(FOREIGN_KEY_VIOLATION);
    await expect(
      inboundEvent({ workspaceId: main.context.workspaceId, businessProfileId: foreign.businessProfileId }, foreign.channelAccount.id),
    ).rejects.toMatchObject(FOREIGN_KEY_VIOLATION);
  });
});
