/**
 * The claim is the only thing standing between "one worker sends" and "two workers send", so it is tested
 * against a real server rather than a stub: the guarantee lives in a conditional UPDATE, and a stub would
 * only prove that the code calls one.
 */
import { noRetrieval, type DeliverySettlement } from "@omnichannel/application";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAiDraftStore } from "./ai-draft-store";
import { createDbClient, type DbClient } from "./client";
import { createDeliveryStore, recoverStaleSendingDeliveries } from "./delivery-store";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { seedWorkspace, type SeededProfile } from "./testing/fixtures";

const NOW = new Date("2026-09-19T12:00:00.000Z");

describe.skipIf(!databaseTestsEnabled())("delivery store (PostgreSQL)", () => {
  let database: TestDatabase;
  let profile: SeededProfile;
  let rival: DbClient;
  let operationSeq = 0;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    [profile] = (await seedWorkspace(database.db, "delivery")).profiles as [SeededProfile];
    // A second client, so two claims can genuinely be in flight at once.
    rival = createDbClient({ connectionString: database.url });
  }, 120_000);

  afterAll(async () => {
    await rival?.$disconnect();
    await database?.dispose();
  });

  const scope = () => ({ workspaceId: profile.context.workspaceId, businessProfileId: profile.businessProfileId });

  /** A PENDING draft with a scheduled delivery, as the policy engine would leave it. */
  const scheduleDelivery = async (): Promise<{ operationId: string; draftId: string }> => {
    operationSeq += 1;
    const operationId = `op_${String(operationSeq)}`;
    const { aiDraftId } = await createAiDraftStore(database.db).saveDraft({
      scope: { ...scope(), conversationId: profile.conversationId },
      generationKey: `key_${String(operationSeq)}`,
      trigger: "AUTOMATIC",
      anchorMessageId: profile.messageId,
      anchorStateVersion: 1,
      text: "We open at 10 on Saturday.",
      structuredOutput: { reply: "We open at 10 on Saturday." },
      confidence: 0.9,
      modelSuggestsSend: true,
      needsReview: false,
      reasonCodes: [],
      factualSourceIds: [],
      retrieval: noRetrieval("OK"),
      status: "PENDING",
      provider: "anthropic",
      model: "claude-opus-5",
      promptVersion: "reply.v1",
      schemaVersion: "ai-draft.v1",
    });
    await database.db.deliveryJobRecord.create({
      data: {
        ...scope(),
        draftId: aiDraftId,
        operationId,
        correlationId: `corr_${String(operationSeq)}`,
        status: "SCHEDULED",
        scheduledFor: NOW,
        selectedDelayMs: 60_000,
      },
    });
    return { operationId, draftId: aiDraftId };
  };

  const statusOf = async (operationId: string) =>
    (await database.db.deliveryJobRecord.findUniqueOrThrow({ where: { operationId }, select: { status: true } })).status;

  it("lets exactly one of two racing workers claim the same delivery", async () => {
    const { operationId } = await scheduleDelivery();

    const [first, second] = await Promise.all([
      createDeliveryStore(database.db).claim(operationId, NOW),
      createDeliveryStore(rival).claim(operationId, NOW),
    ]);

    const kinds = [first.kind, second.kind].sort();
    expect(kinds).toEqual(["CLAIMED", "NOT_CLAIMABLE"]);
    expect(await statusOf(operationId)).toBe("SENDING");
    // One claim, one attempt: the loser must not inflate the count it will later be judged by.
    const job = await database.db.deliveryJobRecord.findUniqueOrThrow({ where: { operationId }, select: { attemptCount: true } });
    expect(job.attemptCount).toBe(1);
  }, 120_000);

  it("refuses a second claim on an already finished delivery", async () => {
    const { operationId } = await scheduleDelivery();
    const store = createDeliveryStore(database.db);
    await store.claim(operationId, NOW);
    await store.settle(operationId, { kind: "SENT", platformMessageId: "mid_1" }, NOW);

    const again = await store.claim(operationId, NOW);

    expect(again).toEqual({ kind: "NOT_CLAIMABLE", status: "SENT" });
  }, 120_000);

  it("writes the sent message and the terminal state together", async () => {
    const { operationId, draftId } = await scheduleDelivery();
    const store = createDeliveryStore(database.db);
    await store.claim(operationId, NOW);

    await store.settle(operationId, { kind: "SENT", platformMessageId: "mid_2", providerRequestId: "req_2" }, NOW);

    const message = await database.db.message.findFirstOrThrow({ where: { ...scope(), operationId }, select: { direction: true, source: true, transportPath: true, aiDraftId: true, channelMessageId: true } });
    // A SENT row without its message would let a later run believe nothing had been sent.
    expect(message).toMatchObject({ direction: "OUT", source: "AI", transportPath: "STANDARD", aiDraftId: draftId, channelMessageId: "mid_2" });
    expect(await statusOf(operationId)).toBe("SENT");
    // Automated delivery is never the human-agent path, whatever the provider would allow.
    expect(message.transportPath).not.toBe("HUMAN_AGENT");
  }, 120_000);

  it("reports a delivery whose draft already produced a message as already sent", async () => {
    const { operationId } = await scheduleDelivery();
    const store = createDeliveryStore(database.db);
    await store.claim(operationId, NOW);
    await store.settle(operationId, { kind: "SENT", platformMessageId: "mid_3" }, NOW);

    const context = await store.loadForSend(operationId);

    expect(context?.alreadySent).toBe(true);
  }, 120_000);

  it("returns a retryable failure to the claimable state without losing the attempt count", async () => {
    const { operationId } = await scheduleDelivery();
    const store = createDeliveryStore(database.db);
    await store.claim(operationId, NOW);

    await store.settle(operationId, { kind: "RETRY", code: "RATE_LIMITED", message: "slow down" }, NOW);

    const job = await database.db.deliveryJobRecord.findUniqueOrThrow({ where: { operationId }, select: { status: true, attemptCount: true, claimedAt: true } });
    expect(job).toMatchObject({ status: "SCHEDULED", attemptCount: 1, claimedAt: null });
    // And it can be claimed again, which is what "retryable" has to mean.
    expect(await store.claim(operationId, NOW)).toEqual({ kind: "CLAIMED" });
  }, 120_000);

  it("keeps an ambiguous outcome out of reach of any retry", async () => {
    const { operationId } = await scheduleDelivery();
    const store = createDeliveryStore(database.db);
    await store.claim(operationId, NOW);

    await store.settle(operationId, { kind: "HELD", status: "HELD_AMBIGUOUS", code: "TIMEOUT", message: "no response" }, NOW);

    expect(await statusOf(operationId)).toBe("HELD_AMBIGUOUS");
    // Never claimable again: the customer may already have the reply (ADR-012).
    expect(await store.claim(operationId, NOW)).toMatchObject({ kind: "NOT_CLAIMABLE", status: "HELD_AMBIGUOUS" });
  }, 120_000);

  it("quarantines a claim left behind by a worker that died mid-send", async () => {
    const { operationId } = await scheduleDelivery();
    const claimedAt = new Date(NOW.getTime() - 10 * 60_000);
    await createDeliveryStore(database.db).claim(operationId, claimedAt);

    const recovered = await recoverStaleSendingDeliveries(database.db, 5 * 60_000, NOW);

    expect(recovered).toContain(operationId);
    // Not re-run: a claim that outlived its lease proves nothing about what the platform received.
    expect(await statusOf(operationId)).toBe("HELD_AMBIGUOUS");
    expect(await createDeliveryStore(database.db).claim(operationId, NOW)).toMatchObject({ kind: "NOT_CLAIMABLE" });
  }, 120_000);

  it("leaves a fresh claim alone", async () => {
    const { operationId } = await scheduleDelivery();
    await createDeliveryStore(database.db).claim(operationId, NOW);

    const recovered = await recoverStaleSendingDeliveries(database.db, 5 * 60_000, NOW);

    expect(recovered).not.toContain(operationId);
    expect(await statusOf(operationId)).toBe("SENDING");
  }, 120_000);

  it("notices a customer message that arrived during the delay", async () => {
    const { operationId } = await scheduleDelivery();
    const before = await createDeliveryStore(database.db).loadForSend(operationId);
    expect(before?.replyCycle).toBe("OWNED");

    await database.db.message.create({
      data: {
        ...scope(),
        channelAccountId: profile.channelAccount.id,
        conversationId: profile.conversationId,
        direction: "IN",
        source: "PARTICIPANT",
        kind: "TEXT",
        text: "actually, never mind",
        occurredAt: new Date(NOW.getTime() + 60_000),
      },
    });

    const after = await createDeliveryStore(database.db).loadForSend(operationId);
    // The whole reason the coordinator re-reads instead of trusting the schedule.
    expect(after?.replyCycle).toBe("SUPERSEDED");
  }, 120_000);

  it("reschedules without counting an attempt", async () => {
    const { operationId } = await scheduleDelivery();
    const store = createDeliveryStore(database.db);
    const later = new Date(NOW.getTime() + 3_600_000);

    await store.reschedule(operationId, later);

    const job = await database.db.deliveryJobRecord.findUniqueOrThrow({ where: { operationId }, select: { status: true, scheduledFor: true, attemptCount: true } });
    // Waiting for quiet hours is not a failure.
    expect(job).toMatchObject({ status: "SCHEDULED", attemptCount: 0 });
    expect(job.scheduledFor.toISOString()).toBe(later.toISOString());
  }, 120_000);

  it("records a cancellation with the reasons that caused it", async () => {
    const { operationId } = await scheduleDelivery();
    const settlement: DeliverySettlement = { kind: "CANCELLED", status: "CANCELLED_SUPERSEDED", reasons: ["SUPERSEDED_BY_NEWER_INBOUND"] };

    await createDeliveryStore(database.db).settle(operationId, settlement, NOW);

    const job = await database.db.deliveryJobRecord.findUniqueOrThrow({ where: { operationId }, select: { status: true, cancelReason: true, cancelledAt: true } });
    expect(job).toMatchObject({ status: "CANCELLED_SUPERSEDED", cancelReason: "SUPERSEDED_BY_NEWER_INBOUND" });
    expect(job.cancelledAt).not.toBeNull();
  }, 120_000);

  it("returns nothing for an operation that does not exist", async () => {
    expect(await createDeliveryStore(database.db).loadForSend("op_missing")).toBeUndefined();
  }, 120_000);
});
