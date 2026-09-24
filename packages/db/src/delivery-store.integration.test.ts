/**
 * The claim is the only thing standing between "one worker sends" and "two workers send", so it is tested
 * against a real server rather than a stub: the guarantee lives in a conditional UPDATE, and a stub would
 * only prove that the code calls one.
 */
import {
  coordinateDelivery,
  noRetrieval,
  type ClaimOutcome,
  type DeliveryCommand,
  type DeliverySendPort,
  type DeliverySettlement,
  type DeliveryStore,
} from "@omnichannel/application";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaPg } from "@prisma/adapter-pg";

import { createAiDraftStore } from "./ai-draft-store";
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
    const context = await store.loadForSend(operationId);
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

    const context = await store.loadForSend(operationId);

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

  /**
   * The gap this suite exists for: the state is read and judged, and *then* the conversation moves.
   *
   * The barrier is the store itself — the first read is allowed to finish, the change is committed, and
   * only then is the claim made. No sleeps and no timing: the race is arranged rather than hoped for.
   */
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
      limits: { confidenceThreshold: 0.8, mandatoryReviewReasons: [], afterWindow: { channel: "INSTAGRAM", policy: "STANDARD_ONLY" } },
      channelState: {
        window: { state: "OPEN_FREEFORM", expiresAt: new Date(NOW.getTime() + 3_600_000) },
        humanAgent: { state: "UNAVAILABLE", reason: "NOT_APPROVED" },
      },
      authority: { kind: "AUTOMATED" },
    });

    /** Commits `change` once, after the first read has returned and before any claim is attempted. */
    const storePausedAfterFirstRead = (change: () => Promise<unknown>): DeliveryStore => {
      const store = createDeliveryStore(database.db);
      let fired = false;
      return {
        ...store,
        async loadForSend(operationId) {
          const context = await store.loadForSend(operationId);
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
        { store: storePausedAfterFirstRead(change), sender, log: { info: () => {}, warn: () => {}, error: () => {} }, now: () => NOW },
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
      const stale = await store.loadForSend(operationId);
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
      const stale = await store.loadForSend(operationId);
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
      const stale = await store.loadForSend(operationId);
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
    ];

    for (const { what, change } of overtakenBy) {
      it(`refuses a claim overtaken by ${what}`, async () => {
        const { operationId } = await sendable();
        const store = createDeliveryStore(database.db);
        const stale = await store.loadForSend(operationId);
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
      const stale = await store.loadForSend(operationId);
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
      const stale = await store.loadForSend(operationId);
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
      const context = await store.loadForSend(operationId);
      if (context === undefined) {
        throw new Error("no delivery context");
      }
      statements.length = 0;

      const claimed = await store.claim(context, NOW);

      expect(claimed).toEqual({ kind: "CLAIMED" });
      const writes = statements.filter((statement) => statement.startsWith("UPDATE"));
      // One UPDATE carrying its own conditions. A select-then-update would put the whole race back.
      expect(writes).toHaveLength(1);
      expect(writes[0]).toContain("WHERE");
      expect(statements.filter((statement) => statement.startsWith("SELECT"))).toEqual([]);
      await logged.$disconnect();
    }, 120_000);
  });
});
