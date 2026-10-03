/**
 * The claim is the only thing standing between "one worker sends" and "two workers send", so it is tested
 * against a real server rather than a stub: the guarantee lives in a conditional UPDATE, and a stub would
 * only prove that the code calls one.
 */
import {
  coordinateDelivery,
  noRetrieval,
  type ClaimOutcome,
  type DeliveryChannelStatePort,
  type DeliveryCommand,
  type DeliverySendPort,
  type DeliverySettlement,
  type DeliveryStore,
} from "@omnichannel/application";
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaPg } from "@prisma/adapter-pg";

import { createAiDraftStore } from "./ai-draft-store";
import { appendInboundMessage } from "./repositories/messages";
import { createDbClient, type DbClient } from "./client";
import { PrismaClient } from "./generated/prisma/client";
import { createDeliveryStore, recoverStaleSendingDeliveries } from "./delivery-store";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { seedWorkspace, type SeededProfile } from "./testing/fixtures";

const NOW = new Date("2026-09-19T12:00:00.000Z");

describe.skipIf(!databaseTestsEnabled())("delivery store (PostgreSQL)", () => {
  let database: TestDatabase;
  let profile: SeededProfile;
  let rival: DbClient;
  let ownerUserId: string;
  let operationSeq = 0;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    const seeded = await seedWorkspace(database.db, "delivery");
    [profile] = seeded.profiles as [SeededProfile];
    ownerUserId = seeded.ownerUserId;
    // A second client, so two claims can genuinely be in flight at once.
    rival = createDbClient({ connectionString: database.url });
  }, 120_000);

  afterAll(async () => {
    await rival?.$disconnect();
    await database?.dispose();
  });

  const scope = () => ({ workspaceId: profile.context.workspaceId, businessProfileId: profile.businessProfileId });

  /** A PENDING draft with a scheduled delivery, as the policy engine would leave it. */
  const scheduleDelivery = async (anchorMessageId: string = profile.messageId): Promise<{ operationId: string; draftId: string }> => {
    operationSeq += 1;
    const operationId = `op_${String(operationSeq)}`;
    const { aiDraftId } = await createAiDraftStore(database.db).saveDraft({
      scope: { ...scope(), conversationId: profile.conversationId },
      generationKey: `key_${String(operationSeq)}`,
      trigger: "AUTOMATIC",
      anchorMessageId,
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

  /** Reads the live state and claims against it, which is the only way a claim can be made. */
  const claimFresh = async (store: DeliveryStore, operationId: string, claimedAt: Date = NOW): Promise<ClaimOutcome> => {
    const context = await store.loadForSend(operationId, NOW);
    if (context === undefined) {
      throw new Error(`no delivery context for ${operationId}`);
    }
    return store.claim(context, claimedAt);
  };

  it("lets exactly one of two racing workers claim the same delivery", async () => {
    const { operationId } = await scheduleDelivery();

    const [first, second] = await Promise.all([
      claimFresh(createDeliveryStore(database.db), operationId),
      claimFresh(createDeliveryStore(rival), operationId),
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
    await claimFresh(store, operationId);
    await store.settle(operationId, { kind: "SENT", platformMessageId: "mid_1" }, NOW);

    const again = await claimFresh(store, operationId);

    expect(again).toEqual({ kind: "NOT_CLAIMABLE", status: "SENT" });
  }, 120_000);

  it("writes the sent message and the terminal state together", async () => {
    const { operationId, draftId } = await scheduleDelivery();
    const store = createDeliveryStore(database.db);
    await claimFresh(store, operationId);

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
    await claimFresh(store, operationId);
    await store.settle(operationId, { kind: "SENT", platformMessageId: "mid_3" }, NOW);

    const context = await store.loadForSend(operationId, NOW);

    expect(context?.alreadySent).toBe(true);
  }, 120_000);

  it("returns a retryable failure to the claimable state without losing the attempt count", async () => {
    const { operationId } = await scheduleDelivery();
    const store = createDeliveryStore(database.db);
    await claimFresh(store, operationId);

    await store.settle(operationId, { kind: "RETRY", code: "RATE_LIMITED", message: "slow down" }, NOW);

    const job = await database.db.deliveryJobRecord.findUniqueOrThrow({ where: { operationId }, select: { status: true, attemptCount: true, claimedAt: true } });
    expect(job).toMatchObject({ status: "SCHEDULED", attemptCount: 1, claimedAt: null });
    // And it can be claimed again, which is what "retryable" has to mean.
    expect(await claimFresh(store, operationId)).toEqual({ kind: "CLAIMED" });
  }, 120_000);

  it("keeps an ambiguous outcome out of reach of any retry", async () => {
    const { operationId } = await scheduleDelivery();
    const store = createDeliveryStore(database.db);
    await claimFresh(store, operationId);

    await store.settle(operationId, { kind: "HELD", status: "HELD_AMBIGUOUS", code: "TIMEOUT", message: "no response" }, NOW);

    expect(await statusOf(operationId)).toBe("HELD_AMBIGUOUS");
    // Never claimable again: the customer may already have the reply (ADR-012).
    expect(await claimFresh(store, operationId)).toMatchObject({ kind: "NOT_CLAIMABLE", status: "HELD_AMBIGUOUS" });
  }, 120_000);

  it("quarantines a claim left behind by a worker that died mid-send", async () => {
    const { operationId } = await scheduleDelivery();
    const claimedAt = new Date(NOW.getTime() - 10 * 60_000);
    const store = createDeliveryStore(database.db);
    await claimFresh(store, operationId, claimedAt);

    const recovered = await recoverStaleSendingDeliveries(database.db, 5 * 60_000, NOW);

    expect(recovered).toContain(operationId);
    // Not re-run: a claim that outlived its lease proves nothing about what the platform received.
    expect(await statusOf(operationId)).toBe("HELD_AMBIGUOUS");
    expect(await claimFresh(store, operationId)).toMatchObject({ kind: "NOT_CLAIMABLE" });
  }, 120_000);

  it("leaves a fresh claim alone", async () => {
    const { operationId } = await scheduleDelivery();
    await claimFresh(createDeliveryStore(database.db), operationId);

    const recovered = await recoverStaleSendingDeliveries(database.db, 5 * 60_000, NOW);

    expect(recovered).not.toContain(operationId);
    expect(await statusOf(operationId)).toBe("SENDING");
  }, 120_000);

  it("notices a customer message that arrived during the delay", async () => {
    const { operationId } = await scheduleDelivery();
    const before = await createDeliveryStore(database.db).loadForSend(operationId, NOW);
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

    const after = await createDeliveryStore(database.db).loadForSend(operationId, NOW);
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
    expect(await createDeliveryStore(database.db).loadForSend("op_missing", NOW)).toBeUndefined();
  }, 120_000);

  /**
   * The gap this suite exists for: the state is read and judged, and *then* the conversation moves.
   *
   * The barrier is the store itself — the first read is allowed to finish, the change is committed, and
   * only then is the claim made. No sleeps and no timing: the race is arranged rather than hoped for.
   */
  /**
   * A person's own reply, through the same coordinator (ADR-018 Option B, accepted 2026-09-30).
   *
   * The decision's whole promise is that there is one send path, not two. So the test is not that the
   * composer works — that is `composer-store.integration.test.ts` — but that this store, the one the
   * worker actually reads, produces a correct send context for the human origin and applies the same
   * gates to it. Anything less would mean the composer had quietly become a second route.
   */
  describe("a delivery a person composed themselves", () => {
    const composeDelivery = async (text = "I can move that to Friday."): Promise<string> => {
      const operationId = randomUUID();
      // Composed *after* the latest message, which is what actually happens: a person reads the thread
      // and then types. Anchoring at a fixed NOW would make the delivery superseded by any message an
      // earlier test left behind — the guard working correctly, against a premise that was never true.
      const latest = await database.db.message.findFirst({
        where: { ...scope(), conversationId: profile.conversationId },
        orderBy: { occurredAt: "desc" },
        select: { occurredAt: true },
      });
      const composedAt = new Date(Math.max(NOW.getTime(), (latest?.occurredAt.getTime() ?? 0) + 1_000));
      await database.db.deliveryJobRecord.create({
        data: {
          ...scope(),
          humanText: text,
          composedByUserId: profile.context.userId,
          conversationId: profile.conversationId,
          operationId,
          correlationId: operationId,
          status: "SCHEDULED",
          scheduledFor: composedAt,
          selectedDelayMs: 0,
          authority: "HUMAN_APPROVED",
          approvedByUserId: profile.context.userId,
          approvedAt: composedAt,
          approvedReviewMode: "NORMAL",
          decisionKey: `compose-${operationId}`,
        },
      });
      return operationId;
    };

    it("loads for send with the person's wording and their authority", async () => {
      const operationId = await composeDelivery();

      const context = await createDeliveryStore(database.db).loadForSend(operationId, NOW);

      expect(context?.text).toBe("I can move that to Friday.");
      // No draft id at all, rather than an invented one: the worker would otherwise reconcile against a
      // row that does not exist.
      expect(context?.draftId).toBeUndefined();
      expect(context?.authority.kind).toBe("HUMAN_APPROVED");
      // A person's own wording was never held for review; the review it needed was them writing it.
      expect(context?.draftNeedsReview).toBe(false);
      // And it reaches the same recipient the AI path would, through the same conversation.
      expect(context?.conversationId).toBe(profile.conversationId);
      expect(context?.recipientExternalId).toBeTruthy();
    }, 120_000);

    it("is claimed by the same atomic claim, once", async () => {
      const operationId = await composeDelivery("Only once.");
      const store = createDeliveryStore(database.db);

      const first = await claimFresh(store, operationId);
      const second = await claimFresh(store, operationId);

      // ADR-012's claim does not care which origin wrote the words.
      expect(first.kind).toBe("CLAIMED");
      expect(second.kind).not.toBe("CLAIMED");
    }, 120_000);

    it("refuses the claim when the wording changed after it was judged", async () => {
      const operationId = await composeDelivery("Judged wording.");
      const store = createDeliveryStore(database.db);
      const context = await store.loadForSend(operationId, NOW);
      if (context === undefined) {
        throw new Error("no delivery context");
      }

      // Edited between the judgement and the claim. The guard's whole job is to notice: sending the new
      // wording would send something nobody judged, and sending the old would send something nobody
      // wrote. Refusing is the only answer that is true.
      await database.db.deliveryJobRecord.update({ where: { operationId }, data: { humanText: "Changed underneath." } });

      expect((await store.claim(context, NOW)).kind).toBe("STATE_CHANGED");
      expect((await database.db.deliveryJobRecord.findUniqueOrThrow({ where: { operationId }, select: { status: true } })).status).toBe("SCHEDULED");
    }, 120_000);

    it("refuses a second claim after the send was already recorded", async () => {
      const operationId = await composeDelivery("Sent once already.");
      const store = createDeliveryStore(database.db);
      const context = await store.loadForSend(operationId, NOW);
      if (context === undefined) {
        throw new Error("no delivery context");
      }
      await store.claim(context, NOW);
      await store.settle(operationId, { kind: "SENT", platformMessageId: `mid-${operationId}` }, NOW);

      // ADR-012: a send whose outcome is known must never be repeated, whichever origin wrote the words.
      expect((await store.claim(context, NOW)).kind).not.toBe("CLAIMED");
    }, 120_000);

    it("carries the same account health, suspension and takeover facts the gates read", async () => {
      const operationId = await composeDelivery("Same gates.");

      const context = await createDeliveryStore(database.db).loadForSend(operationId, NOW);

      // Every fact the policy engine needs is present for this origin too. Missing any one of them would
      // mean a human-composed send skipped a check rather than passing it.
      expect(context?.account).toBeTruthy();
      expect(context?.takeover).toBeDefined();
      expect(context?.limits).toBeDefined();
      expect(context?.replyCycle).toBeDefined();
      expect(context?.guard).toBeTruthy();
    }, 120_000);

    it("is superseded by a message that arrived after it was composed", async () => {
      const operationId = await composeDelivery("Overtaken.");
      const composed = await database.db.deliveryJobRecord.findFirstOrThrow({ where: { operationId }, select: { approvedAt: true } });
      await appendInboundMessage(database.db, profile.context, {
        conversationId: profile.conversationId,
        kind: "TEXT",
        text: "actually never mind",
        // After the person composed, which is the whole point of the case.
        occurredAt: new Date((composed.approvedAt?.getTime() ?? NOW.getTime()) + 60_000),
      });

      const context = await createDeliveryStore(database.db).loadForSend(operationId, NOW);

      // The same rule as for a draft, measured from when the person composed rather than from a draft's
      // anchor: a reply to a question the customer has already replaced must not go out unexamined.
      expect(context?.replyCycle).toBe("SUPERSEDED");

      // Removed again, because this message is deliberately dated later than anything else in the file
      // and would supersede other tests' deliveries. Leaving it behind made a pre-existing case fail —
      // correctly, against a premise this test had quietly broken.
      await database.db.message.deleteMany({ where: { ...scope(), conversationId: profile.conversationId, text: "actually never mind" } });
    }, 120_000);

    it("records the outbound message as a person's, not the assistant's", async () => {
      const operationId = await composeDelivery("Mine, not the model's.");
      const store = createDeliveryStore(database.db);
      await claimFresh(store, operationId);

      await store.settle(operationId, { kind: "SENT", platformMessageId: `mid-${operationId}` }, NOW);

      const message = await database.db.message.findFirstOrThrow({ where: { operationId }, select: { source: true, sentByUserId: true, aiDraftId: true } });
      // Recording a person's words as `AI` would make the thread's own source distinction a lie.
      expect(message.source).toBe("HUMAN");
      expect(message.sentByUserId).toBe(profile.context.userId);
      expect(message.aiDraftId).toBeNull();
    }, 120_000);

    it("knows it has already been sent, so a repeat cannot double-send it", async () => {
      const operationId = await composeDelivery("Exactly once.");
      const store = createDeliveryStore(database.db);
      await claimFresh(store, operationId);
      await store.settle(operationId, { kind: "SENT", platformMessageId: `mid-${operationId}` }, NOW);

      const context = await store.loadForSend(operationId, NOW);

      // An AI delivery answers this through its draft's sent message; a human-composed one through its
      // operation id. ADR-012's rule does not depend on which origin wrote the words.
      expect(context?.alreadySent).toBe(true);
    }, 120_000);
  });

  describe("a conversation that moves after the send was judged", () => {
    /**
     * A delivery that would genuinely be sent: automation on for this conversation, no takeover, and its
     * draft anchored on a message of its own.
     *
     * The anchor matters because these tests share one conversation: a customer message committed by an
     * earlier test is older than this anchor and so is not a newer inbound for this one. Without that, the
     * suite would pass for the wrong reason from the second test onwards.
     */
    const sendable = async () => {
      anchorSeq += 1;
      const anchor = await database.db.message.create({
        data: {
          ...scope(),
          channelAccountId: profile.channelAccount.id,
          conversationId: profile.conversationId,
          direction: "IN",
          source: "PARTICIPANT",
          kind: "TEXT",
          text: "when do you open?",
          occurredAt: new Date(NOW.getTime() + anchorSeq * 60_000),
        },
      });
      const scheduled = await scheduleDelivery(anchor.id);
      // These tests share one account and one conversation, and several of them leave state behind on
      // purpose. Starting from a known-sendable row is what keeps each case about its own change.
      await database.db.channelAccount.update({ where: { id: profile.channelAccount.id }, data: { status: "CONNECTED" } });
      await database.db.conversation.update({
        where: { workspaceId_businessProfileId_id: { ...scope(), id: profile.conversationId } },
        data: {
          modeOverride: "AUTOPILOT",
          aiEnabled: true,
          status: "OPEN",
          // Cleared together: the takeover columns are constrained as one fact, not five.
          takeoverState: "NONE",
          takeoverReason: null,
          takeoverReviewMode: null,
          humanTakeoverAt: null,
          takeoverPausedUntil: null,
          takeoverActorKind: null,
          takeoverActorUserId: null,
        },
      });
      return { ...scheduled, anchoredAt: anchor.occurredAt };
    };
    let anchorSeq = 0;

    const command = (operationId: string): DeliveryCommand => ({
      operationId,
      correlationId: `corr_${operationId}`,
    });

    /** An open window, so nothing here turns on the channel's own clock. */
    const channel: DeliveryChannelStatePort = {
      stateFor: () => ({
        window: { state: "OPEN_FREEFORM", expiresAt: new Date(NOW.getTime() + 3_600_000) },
        humanAgent: { state: "UNAVAILABLE", reason: "NOT_APPROVED" },
      }),
    };

    /** Commits `change` once, after the first read has returned and before any claim is attempted. */
    const storePausedAfterFirstRead = (change: () => Promise<unknown>): DeliveryStore => {
      const store = createDeliveryStore(database.db);
      let fired = false;
      return {
        ...store,
        async loadForSend(operationId, at) {
          const context = await store.loadForSend(operationId, at);
          if (!fired) {
            fired = true;
            await change();
          }
          return context;
        },
      };
    };

    const runWithBarrier = async (operationId: string, change: () => Promise<unknown>) => {
      const sends: string[] = [];
      const sender: DeliverySendPort = {
        send: (input) => {
          sends.push(input.operationId);
          return Promise.resolve({ outcome: "ACCEPTED", platformMessageId: "mid_race" });
        },
      };
      const outcome = await coordinateDelivery(
        { store: storePausedAfterFirstRead(change), sender, channel, log: { info: () => {}, warn: () => {}, error: () => {} }, now: () => NOW },
        command(operationId),
      );
      return { outcome, sends };
    };

    /**
     * A customer message committed after this delivery's anchor.
     *
     * `bumpVersion: false` stands for a writer that inserts the message without advancing the conversation's
     * counter. The guard must still refuse: a version counter only protects what its writers remember to
     * bump, which is why the reply-cycle fact is asserted on its own terms as well.
     */
    const newInboundAfter = (anchoredAt: Date, { bumpVersion = true } = {}) => async () => {
      const occurredAt = new Date(anchoredAt.getTime() + 1_000);
      await database.db.message.create({
        data: {
          ...scope(),
          channelAccountId: profile.channelAccount.id,
          conversationId: profile.conversationId,
          direction: "IN",
          source: "PARTICIPANT",
          kind: "TEXT",
          text: "actually, never mind",
          occurredAt,
        },
      });
      if (bumpVersion) {
        // The same bump `appendInboundMessage` makes: a new customer message is conversation-level news.
        await database.db.conversation.update({
          where: { workspaceId_businessProfileId_id: { ...scope(), id: profile.conversationId } },
          data: { stateVersion: { increment: 1 }, lastInboundAt: occurredAt, lastMessageAt: occurredAt },
        });
      }
    };

    it("never reaches the adapter when the customer writes again between the judgement and the claim", async () => {
      const { operationId, anchoredAt } = await sendable();

      const { outcome, sends } = await runWithBarrier(operationId, newInboundAfter(anchoredAt));

      // The message the customer would have received answers a question they have already moved past.
      expect(sends).toEqual([]);
      expect(outcome).toMatchObject({ status: "CANCELLED", reasons: ["SUPERSEDED_BY_NEWER_INBOUND"] });
      expect(await statusOf(operationId)).toBe("CANCELLED_SUPERSEDED");
      // Never claimed, so nothing counted an attempt against it either.
      const job = await database.db.deliveryJobRecord.findUniqueOrThrow({ where: { operationId }, select: { attemptCount: true } });
      expect(job.attemptCount).toBe(0);
    }, 120_000);

    it("never reaches the adapter when a colleague takes over between the judgement and the claim", async () => {
      const { operationId } = await sendable();

      const { outcome, sends } = await runWithBarrier(operationId, () =>
        database.db.conversation.update({
          where: { workspaceId_businessProfileId_id: { ...scope(), id: profile.conversationId } },
          data: { takeoverState: "HUMAN_ACTIVE", takeoverReason: "HUMAN_SENT_FROM_INBOX", humanTakeoverAt: NOW },
        }),
      );

      expect(sends).toEqual([]);
      expect(outcome).toMatchObject({ status: "CANCELLED" });
      expect(await statusOf(operationId)).toBe("CANCELLED_HUMAN_TAKEOVER");
    }, 120_000);

    it("never reaches the adapter when automation is switched off between the judgement and the claim", async () => {
      const { operationId } = await sendable();

      const { outcome, sends } = await runWithBarrier(operationId, () =>
        database.db.conversation.update({
          where: { workspaceId_businessProfileId_id: { ...scope(), id: profile.conversationId } },
          data: { modeOverride: "OFF" },
        }),
      );

      expect(sends).toEqual([]);
      expect(outcome).toMatchObject({ status: "CANCELLED" });
      expect(await statusOf(operationId)).toBe("CANCELLED_POLICY");
    }, 120_000);

    it("refuses a claim made against a state that has since been overtaken", async () => {
      const { operationId, anchoredAt } = await sendable();
      const store = createDeliveryStore(database.db);
      const stale = await store.loadForSend(operationId, NOW);
      if (stale === undefined) {
        throw new Error("no delivery context");
      }
      await newInboundAfter(anchoredAt, { bumpVersion: false })();

      const refused = await store.claim(stale, NOW);

      // Refused, and told apart from a lost race: the delivery is still there to be judged again.
      expect(refused).toEqual({ kind: "STATE_CHANGED" });
      expect(await statusOf(operationId)).toBe("SCHEDULED");
      const job = await database.db.deliveryJobRecord.findUniqueOrThrow({ where: { operationId }, select: { attemptCount: true } });
      expect(job.attemptCount).toBe(0);
    }, 120_000);

    it("refuses a claim made against a draft whose text has been rewritten since", async () => {
      const { operationId, draftId } = await sendable();
      const store = createDeliveryStore(database.db);
      const stale = await store.loadForSend(operationId, NOW);
      if (stale === undefined) {
        throw new Error("no delivery context");
      }
      await database.db.aiDraft.update({
        where: { workspaceId_businessProfileId_id: { ...scope(), id: draftId } },
        data: { text: "We open at 11 on Saturday." },
      });

      const refused = await store.claim(stale, NOW);

      // The reply that was judged is not the reply that would now be sent, and the claim carries the
      // judged one. Sending would put text in front of the customer that nothing ever approved.
      expect(refused).toEqual({ kind: "STATE_CHANGED" });
      expect(await statusOf(operationId)).toBe("SCHEDULED");
    }, 120_000);

    it("refuses a claim when conversation state moved in a way no other predicate names", async () => {
      const { operationId } = await sendable();
      const store = createDeliveryStore(database.db);
      const stale = await store.loadForSend(operationId, NOW);
      if (stale === undefined) {
        throw new Error("no delivery context");
      }
      // Nothing this guard names by hand has changed — only the conversation's own version counter. That
      // is what it is for: a writer that touches conversation-level state this file does not know about
      // still invalidates a decision taken before it.
      await database.db.conversation.update({
        where: { workspaceId_businessProfileId_id: { ...scope(), id: profile.conversationId } },
        data: { stateVersion: { increment: 1 } },
      });

      const refused = await store.claim(stale, NOW);

      expect(refused).toEqual({ kind: "STATE_CHANGED" });
      expect(await statusOf(operationId)).toBe("SCHEDULED");
    }, 120_000);

    /**
     * Every remaining fact the approval rests on, each changed on its own after the read.
     *
     * One case per predicate in the claim: a predicate nothing here changes is a predicate nothing proves
     * is needed, and one that stops refusing is a way to send on a decision that has since been withdrawn.
     */
    const overtakenBy: readonly { readonly what: string; readonly change: () => Promise<unknown> }[] = [
      {
        what: "the account needing reauthentication",
        change: () =>
          database.db.channelAccount.update({ where: { id: profile.channelAccount.id }, data: { status: "NEEDS_REAUTH" } }),
      },
      {
        what: "the draft being marked for review",
        change: () =>
          database.db.aiDraft.updateMany({ where: { ...scope(), conversationId: profile.conversationId }, data: { needsReview: true } }),
      },
      {
        what: "AI being switched off for the conversation",
        change: () =>
          database.db.conversation.update({
            where: { workspaceId_businessProfileId_id: { ...scope(), id: profile.conversationId } },
            data: { aiEnabled: false },
          }),
      },
      {
        what: "the conversation being closed",
        change: () =>
          database.db.conversation.update({
            where: { workspaceId_businessProfileId_id: { ...scope(), id: profile.conversationId } },
            data: { status: "CLOSED" },
          }),
      },
      {
        what: "a Business Profile default policy appearing where there was none",
        change: () =>
          database.db.automationPolicy.create({ data: { ...scope(), channelAccountId: null, mode: "OFF", mandatoryReviewReasons: [] } }),
      },
      {
        // Nothing rewrites an authority today — it is granted once, when the delivery is scheduled. The
        // claim binds it anyway, so a send cannot outlive the approval it names whatever a later feature
        // decides it may edit.
        what: "the approval it names being rewritten",
        change: () =>
          database.db.deliveryJobRecord.updateMany({
            where: { ...scope() },
            data: { authority: "HUMAN_APPROVED", approvedByUserId: ownerUserId, approvedAt: NOW, approvedReviewMode: "NORMAL", decisionKey: "rewritten" },
          }),
      },
    ];

    for (const { what, change } of overtakenBy) {
      it(`refuses a claim overtaken by ${what}`, async () => {
        const { operationId } = await sendable();
        const store = createDeliveryStore(database.db);
        const stale = await store.loadForSend(operationId, NOW);
        if (stale === undefined) {
          throw new Error("no delivery context");
        }
        await change();

        const refused = await store.claim(stale, NOW);

        expect(refused).toEqual({ kind: "STATE_CHANGED" });
        expect(await statusOf(operationId)).toBe("SCHEDULED");
      }, 120_000);
    }

    it("refuses a claim on a draft that produced a message while the job was still scheduled", async () => {
      const { operationId, draftId } = await sendable();
      const store = createDeliveryStore(database.db);
      const stale = await store.loadForSend(operationId, NOW);
      if (stale === undefined) {
        throw new Error("no delivery context");
      }
      // A colleague sent this very draft from the inbox. The delivery row still says SCHEDULED, because
      // nothing told it otherwise — the draft's own message is the record that the reply already went.
      await database.db.message.create({
        data: {
          ...scope(),
          channelAccountId: profile.channelAccount.id,
          conversationId: profile.conversationId,
          direction: "OUT",
          source: "HUMAN",
          kind: "TEXT",
          text: "We open at 10 on Saturday.",
          occurredAt: NOW,
          deliveryStatus: "SENT",
          transportPath: "STANDARD",
          aiDraftId: draftId,
        },
      });

      const refused = await store.claim(stale, NOW);

      // Claiming here would put the same reply in front of the customer twice, and nothing can take the
      // first one back (ADR-012).
      expect(refused).toEqual({ kind: "STATE_CHANGED" });
      expect(await statusOf(operationId)).toBe("SCHEDULED");
    }, 120_000);

    it("refuses a claim when the conversation changed hands without changing state", async () => {
      const { operationId } = await sendable();
      // Already owned by someone when the state is read, so the state itself does not move below — only
      // who holds it. Whether an approval may send now depends on exactly that, so it has to be bound.
      const holder = {
        takeoverState: "HUMAN_ACTIVE",
        takeoverReason: "HUMAN_SENT_FROM_INBOX",
        humanTakeoverAt: NOW,
        takeoverPausedUntil: null,
        takeoverActorUserId: null,
      } as const;
      await database.db.conversation.update({
        where: { workspaceId_businessProfileId_id: { ...scope(), id: profile.conversationId } },
        data: { ...holder, takeoverActorKind: "SYSTEM" },
      });
      const store = createDeliveryStore(database.db);
      const stale = await store.loadForSend(operationId, NOW);
      if (stale === undefined) {
        throw new Error("no delivery context");
      }
      await database.db.conversation.update({
        where: { workspaceId_businessProfileId_id: { ...scope(), id: profile.conversationId } },
        data: { ...holder, takeoverActorKind: "NATIVE_APP" },
      });

      const refused = await store.claim(stale, NOW);

      expect(refused).toEqual({ kind: "STATE_CHANGED" });
      expect(await statusOf(operationId)).toBe("SCHEDULED");
    }, 120_000);

    it("refuses a claim made against a policy row that has been edited since", async () => {
      const { operationId } = await sendable();
      // The mode comes from the conversation override here, so the policy row is guarded on its own terms.
      await database.db.conversation.update({
        where: { workspaceId_businessProfileId_id: { ...scope(), id: profile.conversationId } },
        data: { modeOverride: null },
      });
      await database.db.automationPolicy.create({
        data: { ...scope(), channelAccountId: profile.channelAccount.id, mode: "AUTOPILOT", mandatoryReviewReasons: [] },
      });
      const store = createDeliveryStore(database.db);
      const stale = await store.loadForSend(operationId, NOW);
      if (stale === undefined) {
        throw new Error("no delivery context");
      }
      await database.db.automationPolicy.updateMany({
        where: { ...scope(), channelAccountId: profile.channelAccount.id },
        data: { confidenceThreshold: 0.99 },
      });

      const refused = await store.claim(stale, NOW);

      // The limits the coordinator judged against came out of that row, so editing it withdraws the
      // approval even though the mode it resolves to has not changed.
      expect(refused).toEqual({ kind: "STATE_CHANGED" });
      expect(await statusOf(operationId)).toBe("SCHEDULED");
    }, 120_000);

    /**
     * Waits until PostgreSQL itself reports a backend blocked on a lock.
     *
     * This is what makes the interleaving below deterministic rather than hopeful: the test does not sleep
     * and guess, it waits for the server to say the race is arranged, and fails if it never is.
     */
    /**
     * A client whose claim pauses once it holds the conversation's lock, so another transaction can be
     * shown to wait on it. Nothing in the store knows about this: the seam is the client it was handed.
     */
    const pausingClient = (gate: () => Promise<void>, onPause: () => void): DbClient => {
      let paused = false;
      return new Proxy(database.db, {
        get(target, property, receiver) {
          if (property !== "$transaction") {
            const value: unknown = Reflect.get(target, property, receiver);
            return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
          }
          return async (run: (tx: unknown) => Promise<unknown>, options: unknown) =>
            target.$transaction(async (tx) => {
              const gated = new Proxy(tx, {
                get(txTarget, txProperty, txReceiver) {
                  if (txProperty !== "$queryRaw") {
                    return Reflect.get(txTarget, txProperty, txReceiver) as unknown;
                  }
                  // Bound to the transaction client: Prisma's own methods carry state through `this`.
                  const raw = (Reflect.get(txTarget, txProperty, txReceiver) as (...a: unknown[]) => Promise<unknown>).bind(txTarget);
                  return async (...args: unknown[]) => {
                    const result: unknown = await raw(...args);
                    // Paused once the conversation is locked: that is the boundary the writers below
                    // take, so this is the moment at which they must be seen to wait.
                    if (!paused && JSON.stringify(args).includes("conversations")) {
                      paused = true;
                      onPause();
                      await gate();
                    }
                    return result;
                  };
                },
              });
              return run(gated);
            }, options as Parameters<typeof target.$transaction>[1]);
        },
      });
    };

    /** Waits for the in-process pause to be reached, so the other side is started only once it is. */
    const waitForClaimPaused = async (isPaused: () => boolean): Promise<void> => {
      for (let attempt = 0; attempt < 400 && !isPaused(); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (!isPaused()) {
        throw new Error("the claim never reached its pause");
      }
    };

    const waitForBlockedBackend = async (): Promise<void> => {
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const rows = await database.db.$queryRaw<{ blocked: number }[]>`
          SELECT count(*)::int AS "blocked" FROM pg_stat_activity
          WHERE datname = current_database() AND state = 'active' AND wait_event_type = 'Lock'`;
        if ((rows[0]?.blocked ?? 0) > 0) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error("no backend ever blocked on a lock: the interleaving under test did not happen");
    };

    /**
     * Runs a claim while `write` is committing, and returns what the claim decided.
     *
     * The interleaving is arranged, not hoped for: the writer signals once it holds its lock and has
     * written, the claim is started only then, and the writer commits only once PostgreSQL reports a
     * backend blocked on a lock. So the conflicting transaction is genuinely mid-flight while the claim
     * runs, which is the case a statement snapshot cannot see.
     */
    const claimAgainstAnInFlightWriter = async (
      operationId: string,
      write: (tx: Parameters<Parameters<typeof rival.$transaction>[0]>[0]) => Promise<unknown>,
    ) => {
      const store = createDeliveryStore(database.db);
      const context = await store.loadForSend(operationId, NOW);
      if (context === undefined) {
        throw new Error("no delivery context");
      }

      let release = (): void => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let acquired = (): void => {};
      const lockHeld = new Promise<void>((resolve) => {
        acquired = resolve;
      });
      const writer = rival.$transaction(
        async (tx) => {
          await write(tx);
          acquired();
          await held;
        },
        { timeout: 60_000, maxWait: 60_000 },
      );
      await lockHeld;

      const claiming = store.claim(context, NOW);
      await waitForBlockedBackend();
      release();
      await writer;
      return claiming;
    };

    const inFlightWriters: readonly {
      readonly what: string;
      readonly write: (tx: Parameters<Parameters<typeof rival.$transaction>[0]>[0], anchoredAt: Date) => Promise<unknown>;
    }[] = [
      {
        what: "a customer message",
        write: async (tx, anchoredAt) => {
          // Exactly how ingestion writes one: the conversation locked first, held to commit.
          await tx.$queryRaw`
            SELECT "id" FROM "conversations"
            WHERE "workspace_id" = ${scope().workspaceId}
              AND "business_profile_id" = ${scope().businessProfileId}
              AND "id" = ${profile.conversationId}
            FOR UPDATE`;
          await tx.message.create({
            data: {
              ...scope(),
              channelAccountId: profile.channelAccount.id,
              conversationId: profile.conversationId,
              direction: "IN",
              source: "PARTICIPANT",
              kind: "TEXT",
              text: "actually, never mind",
              occurredAt: new Date(anchoredAt.getTime() + 1_000),
            },
          });
          return tx.conversation.update({
            where: { workspaceId_businessProfileId_id: { ...scope(), id: profile.conversationId } },
            data: { stateVersion: { increment: 1 } },
          });
        },
      },
      {
        what: "a human takeover",
        write: (tx) =>
          tx.conversation.update({
            where: { workspaceId_businessProfileId_id: { ...scope(), id: profile.conversationId } },
            data: { takeoverState: "HUMAN_ACTIVE", takeoverReason: "HUMAN_SENT_FROM_INBOX", humanTakeoverAt: NOW },
          }),
      },
      {
        what: "a rewrite of the draft",
        write: (tx) =>
          tx.aiDraft.updateMany({
            where: { ...scope(), conversationId: profile.conversationId },
            data: { text: "We open at 11 on Saturday." },
          }),
      },
      {
        what: "the account losing its authorization",
        write: (tx) => tx.channelAccount.update({ where: { id: profile.channelAccount.id }, data: { status: "NEEDS_REAUTH" } }),
      },
      {
        what: "an edit to the automation policy",
        write: (tx) =>
          tx.automationPolicy.updateMany({ where: { ...scope() }, data: { confidenceThreshold: 0.95 } }),
      },
    ];

    for (const { what, write } of inFlightWriters) {
      it(`cannot claim while ${what} is being committed, and refuses once it lands`, async () => {
        const { operationId, anchoredAt } = await sendable();

        const claimed = await claimAgainstAnInFlightWriter(operationId, (tx) => write(tx, anchoredAt));

        // The conflicting state won the order and the claim saw it. Evaluated from a statement snapshot
        // this returned CLAIMED, and the reply went out behind the change.
        expect(claimed).toEqual({ kind: "STATE_CHANGED" });
        expect(await statusOf(operationId)).toBe("SCHEDULED");
      }, 120_000);
    }

    it("makes a customer message wait while a claim is in progress, so neither sees half of the other", async () => {
      const { operationId, anchoredAt } = await sendable();
      let release = (): void => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let paused = false;
      const pausing = pausingClient(
        () => held,
        () => {
          paused = true;
        },
      );

      const context = await createDeliveryStore(database.db).loadForSend(operationId, NOW);
      if (context === undefined) {
        throw new Error("no delivery context");
      }
      const claiming = createDeliveryStore(pausing).claim(context, NOW);
      await waitForClaimPaused(() => paused);

      // The customer's message now arrives, through the same boundary ingestion uses.
      const writing = rival.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT "id" FROM "conversations"
          WHERE "workspace_id" = ${scope().workspaceId}
            AND "business_profile_id" = ${scope().businessProfileId}
            AND "id" = ${profile.conversationId}
          FOR UPDATE`;
        await tx.message.create({
          data: {
            ...scope(),
            channelAccountId: profile.channelAccount.id,
            conversationId: profile.conversationId,
            direction: "IN",
            source: "PARTICIPANT",
            kind: "TEXT",
            text: "one more thing",
            occurredAt: new Date(anchoredAt.getTime() + 2_000),
          },
        });
      });
      // It blocks: the claim holds the boundary, so the message cannot land underneath a decision that
      // has already been taken against the state without it.
      await waitForBlockedBackend();
      release();

      expect(await claiming).toEqual({ kind: "CLAIMED" });
      await writing;
      // Both orders are total. This one put the claim first, and the message is simply after it.
      expect(await statusOf(operationId)).toBe("SENDING");
    }, 120_000);

    /**
     * The phantom: a policy row that did not exist when the state was read.
     *
     * No `FOR SHARE` on rows that exist can block the *creation* of one, and the claim's own predicate is
     * evaluated from a statement snapshot — so if the claim is blocked inside its UPDATE (on the delivery
     * row, say) the insert can commit underneath it and stay invisible. The interleaving below is exactly
     * that: the claim is made to block inside its UPDATE, and the insert is then attempted.
     */
    const insertWhileClaimBlocked = async (
      operationId: string,
      insert: () => Promise<unknown>,
    ): Promise<{ claimed: ClaimOutcome; insertBlocked: boolean }> => {
      const store = createDeliveryStore(database.db);
      const context = await store.loadForSend(operationId, NOW);
      if (context === undefined) {
        throw new Error("no delivery context");
      }

      // Holds the delivery row, so the claim reaches its UPDATE and stops there — snapshot taken, work
      // not finished. This is the window the review describes.
      let releaseJob = (): void => {};
      const jobHeld = new Promise<void>((resolve) => {
        releaseJob = resolve;
      });
      let jobLocked = (): void => {};
      const jobLockHeld = new Promise<void>((resolve) => {
        jobLocked = resolve;
      });
      const holder = rival.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "delivery_jobs" WHERE "operation_id" = ${operationId} FOR UPDATE`;
          jobLocked();
          await jobHeld;
        },
        { timeout: 60_000, maxWait: 60_000 },
      );
      await jobLockHeld;

      const claiming = store.claim(context, NOW);
      await waitForBlockedBackend();

      // The insert now attempts to commit while the claim is in flight.
      let settled = false;
      const inserting = insert().then((value) => {
        settled = true;
        return value;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      const insertBlocked = !settled;

      releaseJob();
      await holder;
      const claimed = await claiming;
      await inserting;
      return { claimed, insertBlocked };
    };

    it("does not let a policy override appear underneath a claim that is already in flight", async () => {
      const { operationId } = await sendable();
      await database.db.automationPolicy.deleteMany({ where: { ...scope() } });
      await database.db.automationPolicy.create({
        data: { ...scope(), channelAccountId: null, mode: "AUTOPILOT", mandatoryReviewReasons: [] },
      });

      const { claimed, insertBlocked } = await insertWhileClaimBlocked(operationId, () =>
        database.db.automationPolicy.create({
          data: { ...scope(), channelAccountId: profile.channelAccount.id, mode: "OFF", mandatoryReviewReasons: [] },
        }),
      );

      // Blocked, so the two have an order: the override is after the claim rather than invisible to it.
      // Every `automation_policies` row references the Business Profile, so its insert must take a key
      // share lock on the row this claim holds — the foreign key is what makes that true, not a
      // convention a future writer could forget.
      expect(insertBlocked).toBe(true);
      expect(claimed).toEqual({ kind: "CLAIMED" });
    }, 180_000);

    it("does not let a Business Profile default appear underneath a claim that is already in flight", async () => {
      const { operationId } = await sendable();
      // Nothing but the conversation's own override authorizes this send, so a default appearing now
      // would change the limits it was judged against.
      await database.db.automationPolicy.deleteMany({ where: { ...scope() } });

      const { claimed, insertBlocked } = await insertWhileClaimBlocked(operationId, () =>
        database.db.automationPolicy.create({
          data: { ...scope(), channelAccountId: null, mode: "OFF", confidenceThreshold: 0.99, mandatoryReviewReasons: [] },
        }),
      );

      expect(insertBlocked).toBe(true);
      expect(claimed).toEqual({ kind: "CLAIMED" });
    }, 180_000);

    it("reports a broken deadlock as a moved state rather than letting it escape", async () => {
      const { operationId } = await sendable();
      const context = await createDeliveryStore(database.db).loadForSend(operationId, NOW);
      if (context === undefined) {
        throw new Error("no delivery context");
      }
      // The server's own answer when it breaks a deadlock or loses a write conflict. Raised here rather
      // than provoked against a real server because which side is chosen as the victim is the server's
      // decision, not something a test can pin down — and what needs proving is what this store does
      // with the answer, not that PostgreSQL produces it.
      const failingWith = (error: Error): DbClient =>
        new Proxy(database.db, {
          get(target, property, receiver) {
            if (property !== "$transaction") {
              const value: unknown = Reflect.get(target, property, receiver);
              return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
            }
            return () => Promise.reject(error);
          },
        });

      const claimed = await createDeliveryStore(failingWith(Object.assign(new Error("deadlock detected"), { code: "P2034" }))).claim(context, NOW);

      // Nothing was claimed and nothing was sent, so this is a state the caller must re-read — not an
      // exception on the one path whose whole contract is that nothing unknown reaches the adapter.
      expect(claimed).toEqual({ kind: "STATE_CHANGED" });
      expect(await statusOf(operationId)).toBe("SCHEDULED");

      // And only that answer. Everything else still fails loudly: a store that reported every failure as
      // a moved state would turn a broken database into a delivery that quietly never happens.
      await expect(createDeliveryStore(failingWith(new Error("connection terminated"))).claim(context, NOW)).rejects.toThrow(
        "connection terminated",
      );
    }, 120_000);

    it("reads the limits from the same policy row its guard binds", async () => {
      const { operationId } = await sendable();
      await database.db.conversation.update({
        where: { workspaceId_businessProfileId_id: { ...scope(), id: profile.conversationId } },
        data: { modeOverride: null },
      });
      await database.db.automationPolicy.deleteMany({ where: { ...scope() } });
      await database.db.automationPolicy.create({
        data: {
          ...scope(),
          channelAccountId: profile.channelAccount.id,
          mode: "AUTOPILOT",
          confidenceThreshold: 0.42,
          mandatoryReviewReasons: ["MISSING_FACT", "not-a-reason-code"],
          quietHoursTimeZone: "Europe/Berlin",
          quietHoursStart: "22:00",
          quietHoursEnd: "08:00",
          instagramAfterWindowPolicy: "HUMAN_ASSISTED_EXTENDED",
        },
      });

      const context = await createDeliveryStore(database.db).loadForSend(operationId, NOW);

      // The limits and the mode come out of one row, read once. A caller that fetched them separately
      // could judge against one version of the business's settings while the claim bound another.
      expect(context?.mode).toBe("AUTOPILOT");
      expect(context?.limits).toEqual({
        confidenceThreshold: 0.42,
        // Narrowed by the domain's own guard: a code the engine does not know is not a gate.
        mandatoryReviewReasons: ["MISSING_FACT"],
        quietHours: { timeZone: "Europe/Berlin", start: "22:00", end: "08:00" },
        afterWindow: { channel: "INSTAGRAM", policy: "HUMAN_ASSISTED_EXTENDED" },
      });
    }, 120_000);

    it("takes the claim in a single statement, so nothing can commit between the check and the write", async () => {
      const { operationId } = await sendable();
      const statements: string[] = [];
      // Built here rather than through `createDbClient`: query logging is this test's instrument, not a
      // production option, and what is being checked is the SQL Prisma actually emits.
      const logged = new PrismaClient({
        adapter: new PrismaPg({ connectionString: database.url }),
        log: [{ emit: "event", level: "query" }],
      });
      logged.$on("query", (event) => statements.push(event.query));
      const store = createDeliveryStore(logged);
      const context = await store.loadForSend(operationId, NOW);
      if (context === undefined) {
        throw new Error("no delivery context");
      }
      statements.length = 0;

      const claimed = await store.claim(context, NOW);

      expect(claimed).toEqual({ kind: "CLAIMED" });
      // Trimmed first: a multi-line statement is still one statement.
      const trimmed = statements.map((statement) => statement.trim());
      const writes = trimmed.filter((statement) => statement.startsWith("UPDATE"));
      // One UPDATE carrying its own conditions. A select-then-update would put the whole race back.
      expect(writes).toHaveLength(1);
      expect(writes[0]).toContain("WHERE");
      // Every read before it acquires a lock and holds it to commit. An ordinary SELECT here would be a
      // fact read outside the boundary, which is the thing a concurrent writer can invalidate.
      //
      // Two statements are locking reads without saying `FOR ...`, and both are named rather than
      // excused. The advisory acquisition *is* the lock. The suspensions read is covered by it, because
      // the row that would invalidate it does not exist yet when the claim starts — a row lock cannot be
      // taken on a row nobody has inserted, which is the whole reason that key exists (#56).
      const reads = trimmed.filter((statement) => statement.startsWith("SELECT"));
      const advisory = reads.filter((read) => read.includes("pg_advisory_xact_lock_shared"));
      const suspensions = reads.filter((read) => read.includes('"automation_suspensions"'));
      expect(advisory).toHaveLength(1);
      expect(suspensions).toHaveLength(1);
      const rowReads = reads.filter((read) => !advisory.includes(read) && !suspensions.includes(read));
      expect(rowReads.length).toBeGreaterThan(0);
      expect(rowReads.every((read) => /FOR (UPDATE|SHARE)$/.test(read))).toBe(true);
      // The key is taken before any row lock, so every claim and every switch writer agree on one order,
      // and the suspensions are read after it rather than before.
      expect(reads[0]).toBe(advisory[0]);
      expect(reads.indexOf(suspensions[0] ?? "")).toBeGreaterThan(0);
      // The Business Profile is locked first of the rows — the coarsest, so two claims cannot deadlock on
      // ordering — and the conversation, the boundary an inbound writer takes, is locked before anything
      // is decided.
      expect(rowReads[0]).toContain('"business_profiles"');
      expect(rowReads.some((read) => read.includes('"conversations"') && read.includes("FOR UPDATE"))).toBe(true);
      await logged.$disconnect();
    }, 120_000);
  });
});
