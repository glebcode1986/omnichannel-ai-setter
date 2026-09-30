/**
 * Follow-ups, and the gate each one has to pass twice (Issue #55).
 *
 * The issue's Tests section is a list of ways a follow-up must *not* go out, and that is how this file is
 * organised. Each case plans a follow-up that is perfectly valid, changes one thing about the world, and
 * asserts the claim refuses with the reason that names what changed.
 *
 * The positive control matters as much as any of them: without `claims a follow-up nothing is wrong with`,
 * every refusal below would pass just as happily if the gate refused everything.
 */
import { isWithinDaypart } from "@omnichannel/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  cancelFollowUp,
  cancelPendingFollowUps,
  claimFollowUp,
  dueFollowUps,
  hourIn,
  isSuppressed,
  liftSuppression,
  nextOpening,
  planFollowUp,
  readFollowUps,
  recordFollowUpSent,
  suppressFollowUps,
} from "./followup-store";
import { closeGoal, setPrimaryGoal, suggestGoal } from "./goal-store";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { seedWorkspace, type SeededProfile, type SeededWorkspace } from "./testing/fixtures";

const NOW = new Date("2026-10-05T10:00:00.000Z");
const DUE = new Date("2026-10-06T10:00:00.000Z");
/** Wide open, so the daypart is never the reason a case refuses unless it is testing the daypart. */
const DAYPART = { timeZone: "UTC", startHour: 0, endHour: 23 };

describe.skipIf(!databaseTestsEnabled())("follow-ups", () => {
  let database: TestDatabase;
  let seq = 0;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
  }, 180_000);

  afterAll(async () => {
    await database?.dispose();
  });

  const db = () => database.db;

  /**
   * A fresh workspace, profile, goal and pending follow-up.
   *
   * Its own workspace per case on purpose: a follow-up's gate reads the conversation, the goal, the
   * suppression list and the account, and a neighbouring test's stray message would change the answer.
   */
  const scenario = async (
    options: { readonly maxAttempts?: number; readonly daypart?: typeof DAYPART; readonly dueAt?: Date } = {},
  ) => {
    seq += 1;
    const workspace: SeededWorkspace = await seedWorkspace(db(), `followup-${String(seq)}`);
    const [profile] = workspace.profiles as [SeededProfile];
    const goal = await setPrimaryGoal(db(), profile.context, { conversationId: profile.conversationId, kind: "BOOK_APPOINTMENT", at: NOW });
    const goalId = goal.status === "SET" ? goal.id : "";
    const planned = await planFollowUp(db(), profile.context, {
      conversationId: profile.conversationId,
      goalId,
      dueAt: options.dueAt ?? DUE,
      ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
      daypart: options.daypart ?? DAYPART,
      at: NOW,
    });
    return {
      workspace,
      profile,
      goalId,
      followUpId: planned.status === "PLANNED" ? planned.id : "",
      planned,
      scope: { workspaceId: profile.context.workspaceId, businessProfileId: profile.businessProfileId },
    };
  };

  const inbound = async (profile: SeededProfile, at: Date) => {
    seq += 1;
    return db().message.create({
      data: {
        workspaceId: profile.context.workspaceId,
        businessProfileId: profile.businessProfileId,
        channelAccountId: profile.channelAccount.id,
        conversationId: profile.conversationId,
        direction: "IN",
        source: "PARTICIPANT",
        kind: "TEXT",
        text: `customer wrote again ${String(seq)}`,
        occurredAt: at,
      },
      select: { id: true },
    });
  };

  describe("planning", () => {
    it("plans a follow-up against the newest state, for a goal a person set", async () => {
      const { planned, followUpId, profile, goalId } = await scenario();

      expect(planned.status).toBe("PLANNED");
      const rows = await readFollowUps(db(), profile.context, profile.conversationId);
      expect(rows[0]).toMatchObject({ id: followUpId, goalId, status: "PENDING", attemptCount: 0, maxAttempts: 3 });
      expect(rows[0]?.anchorMessageId).toBe(profile.messageId);
    }, 180_000);

    it("anchors to the newest message, not the first one", async () => {
      seq += 1;
      const workspace = await seedWorkspace(db(), `followup-anchor-${String(seq)}`);
      const [profile] = workspace.profiles as [SeededProfile];
      // A second message, so newest and oldest are different rows. With one message the two are the same
      // and an anchor read from either end would look correct.
      const newest = await inbound(profile, new Date(NOW.getTime() - 1000));
      const goal = await setPrimaryGoal(db(), profile.context, { conversationId: profile.conversationId, kind: "BOOK_APPOINTMENT", at: NOW });

      await planFollowUp(db(), profile.context, {
        conversationId: profile.conversationId,
        goalId: goal.status === "SET" ? goal.id : "",
        dueAt: DUE,
        daypart: DAYPART,
        at: NOW,
      });

      // Anchored to the oldest message, every later one would look like a new inbound and the follow-up
      // would stop immediately, every time.
      const rows = await readFollowUps(db(), profile.context, profile.conversationId);
      expect(rows[0]?.anchorMessageId).toBe(newest.id);
      expect(rows[0]?.anchorMessageId).not.toBe(profile.messageId);
    }, 180_000);

    it("refuses to plan against a closed conversation", async () => {
      const { profile, goalId, scope, followUpId } = await scenario();
      await cancelFollowUp(db(), profile.context, followUpId, NOW);
      await db().conversation.update({ where: { workspaceId_businessProfileId_id: { ...scope, id: profile.conversationId } }, data: { status: "CLOSED" } });

      const refused = await planFollowUp(db(), profile.context, { conversationId: profile.conversationId, goalId, dueAt: DUE, daypart: DAYPART, at: NOW });

      expect(refused).toEqual({ status: "REFUSED", reason: "this conversation is not open" });
    }, 180_000);

    it("refuses a second pending follow-up on the same conversation", async () => {
      const { profile, goalId, followUpId } = await scenario();

      const again = await planFollowUp(db(), profile.context, {
        conversationId: profile.conversationId,
        goalId,
        dueAt: new Date(DUE.getTime() + 3_600_000),
        daypart: DAYPART,
        at: NOW,
      });

      // Two pending follow-ups is two messages about the same silence.
      expect(again).toEqual({ status: "ALREADY_PENDING", id: followUpId });
    }, 180_000);

    it("refuses the duplicate at the database too, not only in the store", async () => {
      const { profile, goalId, scope } = await scenario();

      // The race the store's read cannot see: two workers planning at the same moment. Written directly,
      // because that is the only way to reach the index without the store's own check first.
      await expect(
        db().followUp.create({
          data: {
            ...scope,
            conversationId: profile.conversationId,
            goalId,
            status: "PENDING",
            dueAt: DUE,
            anchorMessageId: profile.messageId,
            anchorStateVersion: 1,
            maxAttempts: 3,
            daypartTimeZone: "UTC",
            daypartStartHour: 9,
            daypartEndHour: 18,
          },
        }),
      ).rejects.toThrow(/follow_ups_pending_conversation_key|Unique constraint/u);
    }, 180_000);

    it("refuses a due time in the past", async () => {
      const { profile, goalId } = await scenario();

      const past = await planFollowUp(db(), profile.context, {
        conversationId: profile.conversationId,
        goalId,
        dueAt: new Date(NOW.getTime() - 1000),
        daypart: DAYPART,
        at: NOW,
      });

      // It would fire on the next scan with no wait at all: an immediate unattended message wearing a
      // schedule's clothes.
      expect(past).toEqual({ status: "REFUSED", reason: "a follow-up is due in the future" });
    }, 180_000);

    it("refuses a model's suggestion as justification", async () => {
      seq += 1;
      const workspace = await seedWorkspace(db(), `followup-ai-${String(seq)}`);
      const [profile] = workspace.profiles as [SeededProfile];
      const draft = await db().aiDraft.create({
        data: {
          workspaceId: profile.context.workspaceId,
          businessProfileId: profile.businessProfileId,
          conversationId: profile.conversationId,
          anchorMessageId: profile.messageId,
          anchorStateVersion: 1,
          generationKey: `followup-goal-${String(seq)}`,
          trigger: "AUTOMATIC",
          text: "Shall I book you in?",
          structuredOutput: { reply: "x" },
          confidence: 0.9,
          modelSuggestsSend: true,
          needsReview: false,
          status: "PENDING",
          modelProvider: "anthropic",
          modelName: "claude-opus-5",
          promptVersion: "reply.v1",
          schemaVersion: "ai-draft.v1",
        },
        select: { id: true },
      });
      const suggested = await suggestGoal(db(), profile.context, {
        conversationId: profile.conversationId,
        kind: "BOOK_APPOINTMENT",
        sourceDraftId: draft.id,
      });

      const refused = await planFollowUp(db(), profile.context, {
        conversationId: profile.conversationId,
        goalId: suggested.status === "SUGGESTED" ? suggested.id : "",
        dueAt: DUE,
        daypart: DAYPART,
        at: NOW,
      });

      // A model's reading of what a conversation is for cannot justify messaging somebody.
      expect(refused).toEqual({ status: "REFUSED", reason: "a follow-up needs an active primary goal somebody set" });
    }, 180_000);

    it("refuses a goal of NONE, which says there is nothing further", async () => {
      seq += 1;
      const workspace = await seedWorkspace(db(), `followup-none-${String(seq)}`);
      const [profile] = workspace.profiles as [SeededProfile];
      const goal = await setPrimaryGoal(db(), profile.context, { conversationId: profile.conversationId, kind: "NONE", at: NOW });

      const refused = await planFollowUp(db(), profile.context, {
        conversationId: profile.conversationId,
        goalId: goal.status === "SET" ? goal.id : "",
        dueAt: DUE,
        daypart: DAYPART,
        at: NOW,
      });

      expect(refused).toEqual({ status: "REFUSED", reason: "this conversation's goal is that nothing further happens" });
    }, 180_000);

    it("refuses a customer who asked not to be chased", async () => {
      seq += 1;
      const workspace = await seedWorkspace(db(), `followup-optout-${String(seq)}`);
      const [profile] = workspace.profiles as [SeededProfile];
      const goal = await setPrimaryGoal(db(), profile.context, { conversationId: profile.conversationId, kind: "QUALIFY_LEAD", at: NOW });
      await suppressFollowUps(db(), profile.context, { contactId: profile.contactId, reason: "Said please stop messaging me" });

      const refused = await planFollowUp(db(), profile.context, {
        conversationId: profile.conversationId,
        goalId: goal.status === "SET" ? goal.id : "",
        dueAt: DUE,
        daypart: DAYPART,
        at: NOW,
      });

      expect(refused).toEqual({ status: "REFUSED", reason: "this customer asked not to be followed up" });
    }, 180_000);

    it("refuses a sending window of zero hours", async () => {
      const { profile, goalId } = await scenario();

      const refused = await planFollowUp(db(), profile.context, {
        conversationId: profile.conversationId,
        goalId,
        dueAt: DUE,
        daypart: { timeZone: "UTC", startHour: 9, endHour: 9 },
        at: NOW,
      });

      // Either it sends nothing or it sends around the clock depending on how it is read, and the second
      // is unforgivable.
      expect(refused).toEqual({ status: "REFUSED", reason: "a sending window of zero hours sends nothing" });
    }, 180_000);

    it("clamps a caller asking for unlimited attempts, and the database refuses more", async () => {
      const { profile } = await scenario({ maxAttempts: 99 });

      const rows = await readFollowUps(db(), profile.context, profile.conversationId);
      // Five is the ceiling. Past that, the difference between following up and harassing somebody is a
      // matter of opinion, and this product does not get to hold the opinion.
      expect(rows[0]?.maxAttempts).toBe(5);
      await expect(db().followUp.update({ where: { id: rows[0]?.id }, data: { maxAttempts: 12 } })).rejects.toThrow(/follow_ups_attempts_check/u);
    }, 180_000);
  });

  describe("the gate, asked again at execution", () => {
    it("claims a follow-up nothing is wrong with", async () => {
      const { followUpId, goalId } = await scenario();

      const claim = await claimFollowUp(db(), followUpId, DUE);

      // The positive control. Without it every refusal below would pass if the gate refused everything.
      expect(claim.status).toBe("READY");
      expect(claim).toMatchObject({ followUpId, goalKind: "BOOK_APPOINTMENT", attempt: 1, maxAttempts: 3 });
      expect(goalId).not.toBe("");
    }, 180_000);

    it("stops when the customer has written back", async () => {
      const { followUpId, profile } = await scenario();
      await inbound(profile, new Date(DUE.getTime() - 1000));

      const claim = await claimFollowUp(db(), followUpId, DUE);

      // The follow-up answers a question that has moved on.
      expect(claim).toEqual({ status: "STOPPED", followUpId, reason: "NEW_INBOUND" });
      expect((await readFollowUps(db(), profile.context, profile.conversationId))[0]?.status).toBe("SUPERSEDED");
    }, 180_000);

    it("stops when a person has taken the conversation over", async () => {
      const { followUpId, profile, scope } = await scenario();
      await db().conversation.update({
        where: { workspaceId_businessProfileId_id: { ...scope, id: profile.conversationId } },
        data: {
          takeoverState: "HUMAN_ACTIVE",
          takeoverReason: "HUMAN_CLAIMED",
          humanTakeoverAt: NOW,
          takeoverActorKind: "USER",
          takeoverActorUserId: profile.context.userId,
        },
      });

      const claim = await claimFollowUp(db(), followUpId, DUE);

      // Automation does not interrupt somebody who is already handling it.
      expect(claim).toEqual({ status: "STOPPED", followUpId, reason: "HUMAN_TAKEOVER" });
    }, 180_000);

    it("stops when a draft is waiting for somebody", async () => {
      const { followUpId, profile } = await scenario();
      seq += 1;
      await db().aiDraft.create({
        data: {
          workspaceId: profile.context.workspaceId,
          businessProfileId: profile.businessProfileId,
          conversationId: profile.conversationId,
          anchorMessageId: profile.messageId,
          anchorStateVersion: 1,
          generationKey: `followup-review-${String(seq)}`,
          trigger: "AUTOMATIC",
          text: "Needs a person",
          structuredOutput: { reply: "x" },
          confidence: 0.3,
          modelSuggestsSend: false,
          needsReview: true,
          status: "HELD",
          modelProvider: "anthropic",
          modelName: "claude-opus-5",
          promptVersion: "reply.v1",
          schemaVersion: "ai-draft.v1",
        },
      });

      const claim = await claimFollowUp(db(), followUpId, DUE);

      // A second outbound would pre-empt the decision somebody is about to make.
      expect(claim).toEqual({ status: "STOPPED", followUpId, reason: "REVIEW_PENDING" });
    }, 180_000);

    it("stops when the customer opted out after it was planned", async () => {
      const { followUpId, profile } = await scenario();
      await suppressFollowUps(db(), profile.context, { contactId: profile.contactId, reason: "Replied STOP" });

      const claim = await claimFollowUp(db(), followUpId, DUE);

      expect(claim).toEqual({ status: "STOPPED", followUpId, reason: "OPTED_OUT" });
    }, 180_000);

    it("stops when automated outbound is suspended for the profile", async () => {
      const { followUpId, profile } = await scenario();
      await db().automationSuspension.create({
        data: {
          scope: "BUSINESS_PROFILE",
          workspaceId: profile.context.workspaceId,
          businessProfileId: profile.businessProfileId,
          reason: "OPERATOR",
          since: NOW,
        },
      });

      const claim = await claimFollowUp(db(), followUpId, DUE);

      // A suspension is an opt-out at the scope level, and a follow-up is automated outbound.
      expect(claim).toEqual({ status: "STOPPED", followUpId, reason: "OPTED_OUT" });
    }, 180_000);

    it("stops when the goal was achieved", async () => {
      const { followUpId, goalId, profile } = await scenario();

      await closeGoal(db(), profile.context, goalId, "ACHIEVED", NOW);

      // Cancelled the moment the outcome was recorded, not when the next scan noticed.
      expect((await readFollowUps(db(), profile.context, profile.conversationId))[0]).toMatchObject({ status: "CANCELLED", stopReason: "GOAL_TERMINAL" });
      expect(await claimFollowUp(db(), followUpId, DUE)).toEqual({ status: "MISSED", followUpId });
    }, 180_000);

    it("stops on a terminal goal even if the follow-up was left pending", async () => {
      const { followUpId, goalId, profile } = await scenario();
      // The status changed without going through `closeGoal`, which would have cancelled the follow-up
      // itself. This is the case the claim's own goal check exists for: a row left pending by a crash
      // between the two writes, or by a future path that forgets.
      await db().conversationGoal.update({ where: { id: goalId }, data: { status: "ACHIEVED", achievedAt: NOW } });

      const claim = await claimFollowUp(db(), followUpId, DUE);

      expect(claim).toEqual({ status: "STOPPED", followUpId, reason: "GOAL_TERMINAL" });
      expect((await readFollowUps(db(), profile.context, profile.conversationId))[0]?.stopReason).toBe("GOAL_TERMINAL");
    }, 180_000);

    it("stops when the goal became NONE, which says nothing further", async () => {
      const { followUpId, goalId } = await scenario();
      await db().conversationGoal.update({ where: { id: goalId }, data: { kind: "NONE" } });

      expect(await claimFollowUp(db(), followUpId, DUE)).toEqual({ status: "STOPPED", followUpId, reason: "GOAL_TERMINAL" });
    }, 180_000);

    it("waits for a concurrent inbound message rather than sending behind it", async () => {
      const { followUpId, profile, scope } = await scenario();

      // The race the conversation lock exists for. A transaction holds the conversation, then writes an
      // inbound message and commits; the claim starts while that lock is held.
      //
      // Without the lock the claim reads its own snapshot, sees no new message, and the customer gets a
      // follow-up moments after writing in. With it, the claim waits and then sees the message.
      let settled = false;
      let begin: () => void = () => undefined;
      const started = new Promise<void>((resolve) => {
        begin = resolve;
      });
      // Started outside the transaction on purpose. Awaiting it inside would deadlock by construction:
      // the transaction would wait for the claim, and the claim for the transaction's lock.
      const claiming = started.then(async () => {
        const result = await claimFollowUp(db(), followUpId, DUE);
        settled = true;
        return result;
      });

      await db().$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "conversations" WHERE "workspace_id" = ${scope.workspaceId} AND "business_profile_id" = ${scope.businessProfileId} AND "id" = ${profile.conversationId} FOR UPDATE`;
        begin();
        await tx.message.create({
          data: {
            ...scope,
            channelAccountId: profile.channelAccount.id,
            conversationId: profile.conversationId,
            direction: "IN",
            source: "PARTICIPANT",
            kind: "TEXT",
            text: "actually never mind",
            occurredAt: new Date(DUE.getTime() - 500),
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 300));
        // Blocked on the lock this transaction holds. Without the lock the claim would have finished
        // here, on a snapshot with no inbound message in it, and gone ahead.
        expect(settled).toBe(false);
      });

      expect(await claiming).toEqual({ status: "STOPPED", followUpId, reason: "NEW_INBOUND" });
    }, 180_000);

    it("stops when the entitlement is gone", async () => {
      const { followUpId } = await scenario();

      const claim = await claimFollowUp(db(), followUpId, DUE, { mayAutomate: false });

      expect(claim).toEqual({ status: "STOPPED", followUpId, reason: "ENTITLEMENT_LOST" });
    }, 180_000);

    it("stops when the conversation's own AI switch is off", async () => {
      const { followUpId, profile, scope } = await scenario();
      await db().conversation.update({ where: { workspaceId_businessProfileId_id: { ...scope, id: profile.conversationId } }, data: { aiEnabled: false } });

      const claim = await claimFollowUp(db(), followUpId, DUE);

      expect(claim).toEqual({ status: "STOPPED", followUpId, reason: "ENTITLEMENT_LOST" });
    }, 180_000);

    it("blocks rather than cancels when the channel cannot carry it", async () => {
      const { followUpId, profile } = await scenario();
      await db().channelAccount.update({ where: { id: profile.channelAccount.id }, data: { status: "NEEDS_REAUTH" } });

      const claim = await claimFollowUp(db(), followUpId, DUE);

      // The business has something to fix. `BLOCKED` says an attempt was refused this time; `CANCELLED`
      // would say it will never happen, which is a different thing to show an operator.
      expect(claim).toEqual({ status: "STOPPED", followUpId, reason: "CHANNEL_INELIGIBLE" });
      expect((await readFollowUps(db(), profile.context, profile.conversationId))[0]?.status).toBe("BLOCKED");
    }, 180_000);

    it("stops on a stale anchor even with no new inbound message", async () => {
      const { followUpId, profile, scope } = await scenario();
      // The state version moves for reasons other than a customer message. Both are checked, because
      // either alone would miss half the cases.
      await db().conversation.update({ where: { workspaceId_businessProfileId_id: { ...scope, id: profile.conversationId } }, data: { stateVersion: { increment: 1 } } });

      const claim = await claimFollowUp(db(), followUpId, DUE);

      expect(claim).toEqual({ status: "STOPPED", followUpId, reason: "STALE_ANCHOR" });
    }, 180_000);

    it("stops when the conversation was closed", async () => {
      const { followUpId, profile, scope } = await scenario();
      await db().conversation.update({ where: { workspaceId_businessProfileId_id: { ...scope, id: profile.conversationId } }, data: { status: "CLOSED" } });

      const claim = await claimFollowUp(db(), followUpId, DUE);

      expect(claim).toEqual({ status: "STOPPED", followUpId, reason: "CONVERSATION_CLOSED" });
    }, 180_000);

    it("exhausts rather than chasing forever", async () => {
      const { followUpId, profile, scope } = await scenario({ maxAttempts: 1 });
      // One attempt spent, as a claim would.
      await db().followUp.update({ where: { id: followUpId }, data: { attemptCount: 1 } });

      const claim = await claimFollowUp(db(), followUpId, DUE);

      expect(claim).toEqual({ status: "STOPPED", followUpId, reason: "MAX_ATTEMPTS" });
      const row = (await readFollowUps(db(), profile.context, profile.conversationId))[0];
      expect(row?.status).toBe("EXHAUSTED");
      expect(scope.workspaceId).not.toBe("");
    }, 180_000);

    it("checks the bound before spending the attempt, not after", async () => {
      const { followUpId, profile } = await scenario({ maxAttempts: 2 });

      // Each round reopens the lease, which is what a worker that finished its attempt and rescheduled
      // would do. Without that the second claim would be refused as not-yet-due, which is the lease
      // working rather than the bound.
      await claimFollowUp(db(), followUpId, DUE);
      await db().followUp.update({ where: { id: followUpId }, data: { dueAt: DUE } });
      await claimFollowUp(db(), followUpId, DUE);
      await db().followUp.update({ where: { id: followUpId }, data: { dueAt: DUE } });
      const third = await claimFollowUp(db(), followUpId, DUE);

      // Two attempts, then stop. Checking after spending would allow a third, which is the off-by-one
      // that turns three into four for every customer.
      expect(third).toEqual({ status: "STOPPED", followUpId, reason: "MAX_ATTEMPTS" });
      expect((await readFollowUps(db(), profile.context, profile.conversationId))[0]?.attemptCount).toBe(2);
    }, 180_000);

    it("spends an attempt when it goes ahead, so the bound means something", async () => {
      const { followUpId, profile } = await scenario();

      await claimFollowUp(db(), followUpId, DUE);

      expect((await readFollowUps(db(), profile.context, profile.conversationId))[0]?.attemptCount).toBe(1);
    }, 180_000);

    it("holds the follow-up for a lease, and lets it go when the lease lapses", async () => {
      const { followUpId, profile } = await scenario({ maxAttempts: 2 });

      const first = await claimFollowUp(db(), followUpId, DUE);
      const immediately = await claimFollowUp(db(), followUpId, DUE);
      const afterLease = await claimFollowUp(db(), followUpId, new Date(DUE.getTime() + 6 * 60_000));

      // A worker that died between claiming and sending must not strand the follow-up forever — and must
      // not get a free attempt either. The lease lapses and the attempt it spent still counts.
      expect(first.status).toBe("READY");
      expect(immediately).toEqual({ status: "MISSED", followUpId });
      expect(afterLease.status).toBe("READY");
      expect((await readFollowUps(db(), profile.context, profile.conversationId))[0]?.attemptCount).toBe(2);
    }, 180_000);

    it("takes the claim once when two workers race for it", async () => {
      const { followUpId } = await scenario();

      const [first, second] = await Promise.all([claimFollowUp(db(), followUpId, DUE), claimFollowUp(db(), followUpId, DUE)]);

      // Exactly one goes ahead. The row lock makes the second worker wait; the lease the winner takes is
      // what it then finds, so it leaves the follow-up alone rather than sending a second message about
      // one silence.
      expect([first, second].filter((claim) => claim.status === "READY")).toHaveLength(1);
      expect([first, second].filter((claim) => claim.status === "MISSED")).toHaveLength(1);
    }, 180_000);
  });

  describe("the business's own hours", () => {
    it("defers to the next opening rather than messaging at four in the morning", async () => {
      // Due at 02:00 Madrid time, which is 00:00 UTC. The business's window opens at nine.
      const dueAt = new Date("2026-10-06T00:00:00.000Z");
      const { followUpId, profile } = await scenario({ dueAt, daypart: { timeZone: "Europe/Madrid", startHour: 9, endHour: 18 } });

      const claim = await claimFollowUp(db(), followUpId, dueAt);

      expect(claim.status).toBe("DEFERRED");
      // Still wanted, just not now: pending with a new due time, not stopped.
      const row = (await readFollowUps(db(), profile.context, profile.conversationId))[0];
      expect(row?.status).toBe("PENDING");
      expect(hourIn(row?.dueAt ?? NOW, "Europe/Madrid")).toBe(9);
    }, 180_000);

    it("goes ahead inside the window", async () => {
      const { followUpId } = await scenario({ daypart: { timeZone: "Europe/Madrid", startHour: 9, endHour: 18 } });

      // 12:00 in Madrid.
      const claim = await claimFollowUp(db(), followUpId, new Date("2026-10-06T10:00:00.000Z"));

      expect(claim.status).toBe("READY");
    }, 180_000);

    it("reads the hour in the business's zone, not the server's", () => {
      const at = new Date("2026-10-06T22:30:00.000Z");

      expect(hourIn(at, "UTC")).toBe(22);
      // The same instant, and a different business day.
      expect(hourIn(at, "Europe/Madrid")).toBe(0);
      expect(hourIn(at, "America/New_York")).toBe(18);
    });

    it("finds the next opening across a clock change", () => {
      // Madrid leaves summer time on 2026-10-25, so the offset differs at each end.
      const opening = nextOpening(new Date("2026-10-24T20:00:00.000Z"), "Europe/Madrid", 9);

      expect(hourIn(opening, "Europe/Madrid")).toBe(9);
      expect(opening.getTime()).toBeGreaterThan(new Date("2026-10-24T20:00:00.000Z").getTime());
    });

    it("sends nothing through a window of zero hours", () => {
      // The other reading — "start equals end means all day" — turns a misconfiguration into unattended
      // messages at three in the morning. `planFollowUp` and a CHECK both refuse such a window, and this
      // is the third place it is held, because the function is exported and somebody will call it.
      for (const hour of [0, 3, 9, 12, 23]) {
        expect(isWithinDaypart(hour, 9, 9)).toBe(false);
      }
    });

    it("handles a window that wraps past midnight", () => {
      // A business that answers in the evening and overnight. The spec's daypart is half-open either way.
      expect(isWithinDaypart(23, 20, 4)).toBe(true);
      expect(isWithinDaypart(2, 20, 4)).toBe(true);
      expect(isWithinDaypart(4, 20, 4)).toBe(false);
      expect(isWithinDaypart(12, 20, 4)).toBe(false);
      // And the ordinary direction, so the wrapping branch is not the only one exercised.
      expect(isWithinDaypart(9, 9, 18)).toBe(true);
      expect(isWithinDaypart(18, 9, 18)).toBe(false);
      expect(isWithinDaypart(8, 9, 18)).toBe(false);
    });
  });

  describe("the durable record, not the queue", () => {
    it("rebuilds the due work from the table", async () => {
      const { followUpId } = await scenario();

      const due = await dueFollowUps(db(), DUE);

      // The acceptance criteria put it plainly: the queue is not the source of truth. A queue that lost
      // its contents must not lose the intent, and this scan is what recovers it.
      expect(due.map((row) => row.id)).toContain(followUpId);
    }, 180_000);

    it("does not offer work that is not due yet", async () => {
      const { followUpId } = await scenario();

      const due = await dueFollowUps(db(), new Date(DUE.getTime() - 1000));

      expect(due.map((row) => row.id)).not.toContain(followUpId);
    }, 180_000);

    it("does not offer work that has already settled", async () => {
      const { followUpId, profile } = await scenario();
      await cancelFollowUp(db(), profile.context, followUpId, NOW);

      expect((await dueFollowUps(db(), DUE)).map((row) => row.id)).not.toContain(followUpId);
    }, 180_000);

    it("records the send by the coordinator's own operation id", async () => {
      const { followUpId, profile } = await scenario();
      await claimFollowUp(db(), followUpId, DUE);

      const sent = await recordFollowUpSent(db(), followUpId, "op-followup-1", DUE);

      // The follow-up and the delivery it caused can be joined, which is how somebody reading a send
      // finds out why it happened.
      expect(sent).toEqual({ status: "SENT", id: followUpId, operationId: "op-followup-1" });
      const row = (await readFollowUps(db(), profile.context, profile.conversationId))[0];
      expect(row?.status).toBe("SENT");
      expect(row?.stopReason).toBeNull();
    }, 180_000);

    it("refuses a SENT row with no operation id, in the database", async () => {
      const { followUpId } = await scenario();

      // A send with nothing to join it to is a claim nobody can check.
      await expect(
        db().followUp.update({ where: { id: followUpId }, data: { status: "SENT", settledAt: DUE } }),
      ).rejects.toThrow(/follow_ups_settlement_check/u);
    }, 180_000);

    it("refuses a settled row with no reason, in the database", async () => {
      const { followUpId } = await scenario();

      await expect(db().followUp.update({ where: { id: followUpId }, data: { status: "CANCELLED", settledAt: DUE } })).rejects.toThrow(
        /follow_ups_settlement_check/u,
      );
    }, 180_000);

    it("will not let any status but EXHAUSTED claim the attempts were used up", async () => {
      const { followUpId } = await scenario();

      await expect(
        db().followUp.update({ where: { id: followUpId }, data: { status: "CANCELLED", stopReason: "MAX_ATTEMPTS", settledAt: DUE } }),
      ).rejects.toThrow(/follow_ups_exhausted_check/u);
      await expect(
        db().followUp.update({ where: { id: followUpId }, data: { status: "EXHAUSTED", stopReason: "NEW_INBOUND", settledAt: DUE } }),
      ).rejects.toThrow(/follow_ups_exhausted_check/u);
    }, 180_000);

    it("cancels pending work the moment an inbound arrives, not when the scan notices", async () => {
      const { followUpId, profile, scope } = await scenario();

      const cancelled = await cancelPendingFollowUps(db(), scope, profile.conversationId, "NEW_INBOUND", NOW);

      expect(cancelled).toBe(1);
      const row = (await readFollowUps(db(), profile.context, profile.conversationId))[0];
      expect(row).toMatchObject({ id: followUpId, status: "SUPERSEDED", stopReason: "NEW_INBOUND" });
    }, 180_000);
  });

  describe("opting out", () => {
    it("records the words somebody recorded it with", async () => {
      seq += 1;
      const workspace = await seedWorkspace(db(), `followup-supp-${String(seq)}`);
      const [profile] = workspace.profiles as [SeededProfile];

      await suppressFollowUps(db(), profile.context, { contactId: profile.contactId, reason: "Asked us to stop on the phone" });

      expect(await isSuppressed(db(), profile.context, profile.contactId)).toBe(true);
      const row = await db().followUpSuppression.findFirst({ where: { contactId: profile.contactId }, select: { reason: true, recordedByUserId: true } });
      // An opt-out somebody cannot account for is one they cannot defend.
      expect(row?.reason).toBe("Asked us to stop on the phone");
      expect(row?.recordedByUserId).toBe(profile.context.userId);
    }, 180_000);

    it("refuses an opt-out with no reason", async () => {
      seq += 1;
      const workspace = await seedWorkspace(db(), `followup-supp2-${String(seq)}`);
      const [profile] = workspace.profiles as [SeededProfile];

      expect(await suppressFollowUps(db(), profile.context, { contactId: profile.contactId, reason: "   " })).toEqual({
        status: "REFUSED",
        reason: "an opt-out needs the words somebody recorded it with",
      });
    }, 180_000);

    it("stays one row however many times it is recorded", async () => {
      seq += 1;
      const workspace = await seedWorkspace(db(), `followup-supp3-${String(seq)}`);
      const [profile] = workspace.profiles as [SeededProfile];

      await suppressFollowUps(db(), profile.context, { contactId: profile.contactId, reason: "First time" });
      await suppressFollowUps(db(), profile.context, { contactId: profile.contactId, reason: "Second time" });

      // "Are they opted out" is a row, not a count.
      expect(await db().followUpSuppression.count({ where: { contactId: profile.contactId, liftedAt: null } })).toBe(1);
    }, 180_000);

    it("is lifted only by a person, and the row names them", async () => {
      seq += 1;
      const workspace = await seedWorkspace(db(), `followup-supp4-${String(seq)}`);
      const [profile] = workspace.profiles as [SeededProfile];
      await suppressFollowUps(db(), profile.context, { contactId: profile.contactId, reason: "Asked us to stop" });

      await liftSuppression(db(), profile.context, profile.contactId, NOW);

      expect(await isSuppressed(db(), profile.context, profile.contactId)).toBe(false);
      const row = await db().followUpSuppression.findFirst({ where: { contactId: profile.contactId }, select: { liftedByUserId: true, liftedAt: true } });
      expect(row?.liftedByUserId).toBe(profile.context.userId);
      // And a half-lifted row is refused: nothing may expire an opt-out on its own.
      await expect(
        db().followUpSuppression.updateMany({ where: { contactId: profile.contactId }, data: { liftedByUserId: null } }),
      ).rejects.toThrow(/followup_suppressions_lift_check/u);
    }, 180_000);

    it("does not cross a Business Profile", async () => {
      seq += 1;
      const workspace = await seedWorkspace(db(), `followup-supp5-${String(seq)}`, ["main", "second"]);
      const [first, second] = workspace.profiles as [SeededProfile, SeededProfile];
      await suppressFollowUps(db(), first.context, { contactId: first.contactId, reason: "Stop" });

      // A person who opted out of one business's follow-ups has said nothing about another's.
      expect(await isSuppressed(db(), first.context, first.contactId)).toBe(true);
      expect(await isSuppressed(db(), second.context, second.contactId)).toBe(false);
      // And asking the *other* profile about the suppressed contact must say no. Contact ids are unique,
      // so a query scoped only by id would answer yes and disclose one business's opt-out to another.
      expect(await isSuppressed(db(), second.context, first.contactId)).toBe(false);
      expect(await liftSuppression(db(), second.context, first.contactId, NOW)).toEqual({ status: "GONE" });
      expect(await isSuppressed(db(), first.context, first.contactId)).toBe(true);
    }, 180_000);
  });
});
