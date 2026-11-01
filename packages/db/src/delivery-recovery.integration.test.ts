/**
 * The recovery sweep for replies that were approved and never queued (Issue #125).
 *
 * Against a real server rather than a stub, because every property worth having here is a property of the
 * database: the dedupe key's uniqueness is what makes a second run safe, the `delivery_jobs_one_origin_check`
 * is what makes the two origins exhaustive, and the reconciliation relation is what keeps an ambiguous
 * operation out of reach. A stub would let all three be asserted and none of them be true.
 */
import { noRetrieval } from "@omnichannel/application";
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createAiDraftStore } from "./ai-draft-store";
import { createDbClient } from "./client";
import { deliveryDispatchDedupeKey } from "./delivery-dispatch";
import { DELIVERY_RECOVERY_GRACE_MS, recoverStrandedDeliveries } from "./delivery-recovery";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { seedWorkspace, type SeededProfile } from "./testing/fixtures";

const NOW = new Date("2026-11-01T12:00:00.000Z");
/** Comfortably outside the grace window, so "stranded" is not a race with the clock. */
const LONG_AGO = new Date(NOW.getTime() - DELIVERY_RECOVERY_GRACE_MS - 60_000);

describe.skipIf(!databaseTestsEnabled())("stranded delivery recovery (PostgreSQL)", () => {
  let database: TestDatabase;
  let profile: SeededProfile;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    const workspace = await seedWorkspace(database.db, "recovery");
    [profile] = workspace.profiles as [SeededProfile];
  }, 180_000);

  afterAll(async () => {
    await database?.dispose();
  });

  const scope = () => ({ workspaceId: profile.context.workspaceId, businessProfileId: profile.businessProfileId });

  beforeEach(async () => {
    await database.db.queueOutbox.deleteMany({ where: scope() });
    await database.db.deliveryReconciliation.deleteMany({ where: scope() });
    await database.db.deliveryJobRecord.deleteMany({ where: scope() });
  });

  /**
   * A delivery written the way the defect wrote them: the row, and no dispatch entry.
   *
   * `humanComposed` chooses the origin. Both are exercised because the two reach their conversation by
   * different routes — a human-composed reply names it directly, an approved draft reaches it through the
   * draft — and a recovery that selected only the direct column would silently skip every approved draft,
   * which is the larger half of the work.
   */
  const strandedDelivery = async (
    options: { readonly at?: Date; readonly humanComposed?: boolean; readonly status?: "SCHEDULED" | "HELD_AMBIGUOUS" } = {},
  ): Promise<{ readonly id: string; readonly operationId: string }> => {
    const operationId = randomUUID();
    const row = await database.db.deliveryJobRecord.create({
      data: {
        ...scope(),
        operationId,
        correlationId: operationId,
        status: options.status ?? "SCHEDULED",
        scheduledFor: options.at ?? LONG_AGO,
        selectedDelayMs: 0,
        authority: "HUMAN_APPROVED",
        approvedByUserId: profile.context.userId,
        approvedAt: options.at ?? LONG_AGO,
        approvedReviewMode: "NORMAL",
        decisionKey: `decision_${operationId}`,
        ...(options.humanComposed === true
          ? { humanText: "We open at 10 on Saturday.", composedByUserId: profile.context.userId, conversationId: profile.conversationId }
          : { draftId: await draftFor() }),
      },
      select: { id: true, operationId: true },
    });
    return row;
  };

  let seq = 0;
  /**
   * A draft built by the production writer, not by hand.
   *
   * The first version of this fixture inserted the row directly and was refused for a missing column —
   * twice, for two different columns. A fixture that hand-builds a row the product knows how to build is
   * a second definition of that row, and it drifts from the schema the moment anybody adds a field.
   */
  const draftFor = async (): Promise<string> => {
    seq += 1;
    const { aiDraftId } = await createAiDraftStore(database.db).saveDraft({
      scope: { ...scope(), conversationId: profile.conversationId },
      generationKey: `recovery_${String(seq)}`,
      trigger: "AUTOMATIC",
      anchorMessageId: profile.messageId,
      anchorStateVersion: 1,
      text: "We open at 10 on Saturday.",
      structuredOutput: { reply: "We open at 10 on Saturday." },
      confidence: 0.9,
      modelSuggestsSend: false,
      needsReview: true,
      reasonCodes: ["MISSING_FACT"],
      factualSourceIds: [],
      retrieval: noRetrieval("OK"),
      // `saveDraft` accepts only the two statuses a *generated* draft can have; the approval is what
      // moves it on, and this fixture writes the delivery row directly instead.
      status: "PENDING",
      provider: "anthropic",
      model: "claude-opus-5",
      promptVersion: "reply.v1",
      schemaVersion: "ai-draft.v1",
    });
    return aiDraftId;
  };

  const entryFor = async (operationId: string) =>
    database.db.queueOutbox.findUnique({
      where: { dedupeKey: deliveryDispatchDedupeKey({ ...scope(), operationId }) },
      select: { kind: true, payload: true, dispatchedAt: true },
    });

  it("queues an approved draft that was never enqueued, and records why", async () => {
    const row = await strandedDelivery();

    const result = await recoverStrandedDeliveries(database.db, { now: NOW });

    expect(result).toMatchObject({ stranded: 1, recovered: 1 });
    const entry = await entryFor(row.operationId);
    expect(entry).toMatchObject({ kind: "DELIVERY_DISPATCH", dispatchedAt: null });
    // The conversation came from the draft, not from the row's own column, which is null for an AI
    // delivery. A recovery that read only `conversationId` would have found nothing to send here.
    expect(entry?.payload).toMatchObject({ conversationId: profile.conversationId, deliveryJobId: row.id });

    const audit = await database.db.auditEvent.findFirstOrThrow({
      where: { ...scope(), kind: "DELIVERY_DISPATCH_RECOVERED", subjectId: row.id },
      select: { actorKind: true, detail: true, conversationId: true },
    });
    // Nobody asked for this in the moment, so the row is the system's own act (#57).
    expect(audit.actorKind).toBe("SYSTEM");
    expect(audit.conversationId).toBe(profile.conversationId);
    expect(audit.detail).toMatchObject({ operationId: row.operationId, origin: "AI_DRAFT" });
  }, 180_000);

  it("queues a reply a person wrote themselves", async () => {
    const row = await strandedDelivery({ humanComposed: true });

    const result = await recoverStrandedDeliveries(database.db, { now: NOW });

    expect(result).toMatchObject({ stranded: 1, recovered: 1 });
    expect(await entryFor(row.operationId)).toMatchObject({ kind: "DELIVERY_DISPATCH" });
    const audit = await database.db.auditEvent.findFirstOrThrow({
      where: { ...scope(), kind: "DELIVERY_DISPATCH_RECOVERED", subjectId: row.id },
      select: { detail: true },
    });
    expect(audit.detail).toMatchObject({ origin: "HUMAN_COMPOSED" });
  }, 180_000);

  it("adds nothing on a second run, and writes no second audit row", async () => {
    const row = await strandedDelivery();

    const first = await recoverStrandedDeliveries(database.db, { now: NOW });
    const second = await recoverStrandedDeliveries(database.db, { now: NOW });

    expect(first).toMatchObject({ stranded: 1, recovered: 1 });
    // Not "recovered: 1" twice. The sweep is safe to run forever because the dedupe key is unique, and
    // this is the assertion that proves the safety is real rather than intended.
    expect(second).toMatchObject({ stranded: 0, recovered: 0 });
    expect(await database.db.queueOutbox.count({ where: { ...scope(), kind: "DELIVERY_DISPATCH" } })).toBe(1);
    expect(await database.db.auditEvent.count({ where: { ...scope(), kind: "DELIVERY_DISPATCH_RECOVERED", subjectId: row.id } })).toBe(1);
  }, 180_000);

  it("refuses to touch an ambiguous send", async () => {
    const row = await strandedDelivery({ status: "HELD_AMBIGUOUS" });

    const result = await recoverStrandedDeliveries(database.db, { now: NOW });

    // ADR-012: an ambiguous outcome is quarantined and never blindly resent. "We do not know whether the
    // customer received this" is the one state where queueing it again could send a second message.
    expect(result).toMatchObject({ stranded: 0, recovered: 0 });
    expect(await entryFor(row.operationId)).toBeNull();
  }, 180_000);

  it("leaves an operation that is already under investigation alone", async () => {
    const row = await strandedDelivery();
    await database.db.deliveryReconciliation.create({
      data: {
        ...scope(),
        conversationId: profile.conversationId,
        deliveryJobId: row.id,
        operationId: row.operationId,
        reason: "DELIVERY_STALLED",
        detectedAt: LONG_AGO,
        // `UNRESOLVED` is the store's own name for this value; the column's is `PENDING`.
        state: "PENDING",
      },
    });

    const result = await recoverStrandedDeliveries(database.db, { now: NOW });

    // Belt and braces over the status filter: whatever the row says this instant, an operation with an
    // open investigation belongs to that investigation.
    expect(result).toMatchObject({ stranded: 0, recovered: 0 });
    expect(await entryFor(row.operationId)).toBeNull();
  }, 180_000);

  it("leaves a just-approved delivery to the dispatcher", async () => {
    const row = await strandedDelivery({ at: new Date(NOW.getTime() - 1_000) });

    const result = await recoverStrandedDeliveries(database.db, { now: NOW });

    // Inside the grace window. Not a correctness requirement — the entry and the row commit together, so
    // there is no window where one exists without the other — but a dispatcher briefly behind must not be
    // mistaken for a stranded row, or the sweep churns through healthy work.
    expect(result).toMatchObject({ stranded: 0, recovered: 0 });
    expect(await entryFor(row.operationId)).toBeNull();
  }, 180_000);

  it("skips a delivery the write path already covered", async () => {
    const row = await strandedDelivery();
    await database.db.queueOutbox.create({
      data: {
        ...scope(),
        kind: "DELIVERY_DISPATCH",
        dedupeKey: deliveryDispatchDedupeKey({ ...scope(), operationId: row.operationId }),
        correlationId: row.operationId,
        delayMs: 0,
        // `queue_outbox_payload_scope_check` requires the payload to name the same Workspace and
        // Business Profile as the row, so a stub payload is refused by the database — which is itself
        // worth knowing: the production writer satisfies it because it builds both from one input.
        payload: { schemaVersion: 1, ...scope() },
      },
    });

    const result = await recoverStrandedDeliveries(database.db, { now: NOW });

    // The ordinary case once this is deployed: rows are written with their entry, and the sweep finds
    // nothing to do. A sweep that counted these as stranded would log a repair every minute forever.
    expect(result).toMatchObject({ stranded: 0, recovered: 0 });
    // Scoped to this row. A profile-wide count measures what earlier tests in this file legitimately
    // recovered, which is the same mistake that once made an idempotency assertion read 9 and mean
    // nothing — the suite shares one database across its tests.
    expect(await database.db.auditEvent.count({ where: { ...scope(), kind: "DELIVERY_DISPATCH_RECOVERED", subjectId: row.id } })).toBe(0);
  }, 180_000);

  it("drains a backlog in bounded batches", async () => {
    const rows = [await strandedDelivery(), await strandedDelivery(), await strandedDelivery()];

    const first = await recoverStrandedDeliveries(database.db, { now: NOW, limit: 2 });
    const second = await recoverStrandedDeliveries(database.db, { now: NOW, limit: 2 });

    expect(first).toMatchObject({ stranded: 2, recovered: 2 });
    expect(second).toMatchObject({ stranded: 1, recovered: 1 });
    const entries = await database.db.queueOutbox.count({ where: { ...scope(), kind: "DELIVERY_DISPATCH" } });
    expect(entries).toBe(rows.length);
  }, 180_000);

  it("is a no-op on a database with nothing stranded", async () => {
    // The control that the suite can say no: every assertion above would also pass against a sweep that
    // recovered indiscriminately, so this proves the empty case is measured rather than assumed.
    expect(await recoverStrandedDeliveries(database.db, { now: NOW })).toMatchObject({ stranded: 0, recovered: 0, scanned: 0 });
    expect(await database.db.queueOutbox.count({ where: scope() })).toBe(0);
  }, 180_000);

  it("uses the same client contract the worker composes", async () => {
    // The loop in `apps/worker/src/main.ts` passes a `DbClient`, so the signature is exercised with one
    // here too: a function that only ever ran against the test's own handle could compile and still be
    // uncallable from the composition root.
    const client = createDbClient({ connectionString: database.url });
    try {
      await strandedDelivery();
      expect(await recoverStrandedDeliveries(client, { now: NOW })).toMatchObject({ stranded: 1, recovered: 1 });
    } finally {
      await client.$disconnect();
    }
  }, 180_000);
});
