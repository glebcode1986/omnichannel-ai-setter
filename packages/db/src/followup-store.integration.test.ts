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
import { followUpGenerationKey } from "@omnichannel/application";
import { isWithinDaypart } from "@omnichannel/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createConversationOperationStore } from "./conversation-operations-store";
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
import { appendInboundMessage } from "./repositories/messages";
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
          // Required for an operator pause since #59: the system's own switch is identified by the actor
          // being absent, so a pause with no actor is one the backlog guard could close.
          byUserId: profile.context.userId,
        },
      });

      const claim = await claimFollowUp(db(), followUpId, DUE);

      // A suspension is an opt-out at the scope level, and a follow-up is automated outbound.
      expect(claim).toEqual({ status: "STOPPED", followUpId, reason: "OPTED_OUT" });
    }, 180_000);

    it("stops when the platform-wide switch is pulled, which it did not before", async () => {
      // The defect this exists for: the predicate here listed `WORKSPACE`, `BUSINESS_PROFILE` and
      // `CHANNEL_ACCOUNT` and **omitted `GLOBAL`** — so the switch an operator pulls when something is
      // wrong and they do not yet know what did not cover follow-ups, and a scheduled one went out
      // behind it. Every other path read `GLOBAL`; this one asked the question with its own `where`.
      const { followUpId, profile } = await scenario();
      const global = await db().automationSuspension.create({
        data: { scope: "GLOBAL", reason: "OPERATOR", since: NOW, byUserId: profile.context.userId },
        select: { id: true },
      });

      try {
        const claim = await claimFollowUp(db(), followUpId, DUE);

        expect(claim).toEqual({ status: "STOPPED", followUpId, reason: "OPTED_OUT" });
      } finally {
        // Lifted in a `finally`, because a GLOBAL switch left standing stops automated outbound for every
        // other test in this file — which is the whole point of the scope and makes it the one fixture
        // that must not leak. The first version of this test did leak it, and ten later tests failed.
        await db().automationSuspension.update({ where: { id: global.id }, data: { liftedAt: NOW, liftedByUserId: profile.context.userId } });
      }
    }, 180_000);

    it("is not stopped by a switch that has expired, or by one that has not started", async () => {
      // The other half, and the one that was safe-but-wrong: the predicate selected neither `since` nor
      // `until`, so a switch that had run out on its own clock cancelled follow-ups for ever, and one
      // scheduled for tomorrow cancelled them today. The domain decides the window now, as it does for
      // the delivery claim.
      const lapsed = await scenario();
      await db().automationSuspension.create({
        data: {
          scope: "BUSINESS_PROFILE",
          workspaceId: lapsed.profile.context.workspaceId,
          businessProfileId: lapsed.profile.businessProfileId,
          reason: "OPERATOR",
          since: new Date(NOW.getTime() - 7_200_000),
          until: new Date(NOW.getTime() - 3_600_000),
          byUserId: lapsed.profile.context.userId,
        },
      });

      expect((await claimFollowUp(db(), lapsed.followUpId, DUE)).status, "an expired switch is not a switch").toBe("READY");

      const future = await scenario();
      await db().automationSuspension.create({
        data: {
          scope: "BUSINESS_PROFILE",
          workspaceId: future.profile.context.workspaceId,
          businessProfileId: future.profile.businessProfileId,
          reason: "OPERATOR",
          since: new Date(DUE.getTime() + 86_400_000),
          byUserId: future.profile.context.userId,
        },
      });

      expect((await claimFollowUp(db(), future.followUpId, DUE)).status, "a switch that has not started is not a switch").toBe("READY");
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

      const claim = await claimFollowUp(db(), followUpId, DUE, { entitlement: { mayAutomate: false } });

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

    it("blocks rather than generating when nothing could carry the message now", async () => {
      const { followUpId, profile } = await scenario();

      // The port is injected, so this is the claim's own behaviour under test and not a provider rule:
      // a `false` must stop the claim *before* an attempt is spent, because the whole point of asking is
      // to avoid spending one on a message nothing can deliver.
      const claim = await claimFollowUp(db(), followUpId, DUE, { carries: () => false });

      expect(claim).toEqual({ status: "STOPPED", followUpId, reason: "CHANNEL_INELIGIBLE" });
      const row = (await readFollowUps(db(), profile.context, profile.conversationId))[0];
      expect(row).toMatchObject({ status: "BLOCKED", stopReason: "CHANNEL_INELIGIBLE", attemptCount: 0 });
    }, 180_000);

    it("tells the port what it read under the lock, not what planning assumed", async () => {
      const { followUpId, profile } = await scenario();
      await db().automationPolicy.updateMany({
        where: { workspaceId: profile.context.workspaceId, businessProfileId: profile.businessProfileId, channelAccountId: null },
        data: { instagramAfterWindowPolicy: "HUMAN_ASSISTED_EXTENDED" },
      });
      const asked: unknown[] = [];

      await claimFollowUp(db(), followUpId, DUE, {
        carries: (question) => {
          asked.push(question);
          return true;
        },
      });

      // The conversation's own channel and last inbound, and the profile's configured after-window
      // choice — the facts a window question needs, read inside the transaction that holds the lock.
      // A port given stale facts would answer a question about a world that has moved on.
      expect(asked).toHaveLength(1);
      expect(asked[0]).toMatchObject({
        channel: "INSTAGRAM",
        at: DUE,
        instagramAfterWindowPolicy: "HUMAN_ASSISTED_EXTENDED",
        whatsappAfterWindowPolicy: "SERVICE_WINDOW_ONLY",
      });
      expect((asked[0] as { lastInboundAt: Date | null }).lastInboundAt).toBeInstanceOf(Date);
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

  describe("the crash between scheduling and recording", () => {
    /**
     * Astra's first P1 on PR #82, as the window it actually is. A worker claims an attempt, schedules its
     * delivery, and dies before `recordFollowUpSent`. The row is still `PENDING`, the lease lapses, and
     * the next claim must not spend a fresh attempt and schedule a *second* operation — two operations are
     * two messages about one silence, and nothing downstream can deduplicate them, because the delivery
     * boundary is keyed on the operation and the two operations differ.
     *
     * So the claim asks first whether this attempt's draft already exists, and settles from what that
     * draft did. The attempt's draft is derived with the same exported key the worker generates under, so
     * the two cannot disagree.
     */
    const draftFor = async (
      profile: SeededProfile,
      followUpId: string,
      attempt: number,
      options: { readonly scheduled: boolean },
    ) => {
      const scope = { workspaceId: profile.context.workspaceId, businessProfileId: profile.businessProfileId };
      const draft = await db().aiDraft.create({
        data: {
          ...scope,
          conversationId: profile.conversationId,
          anchorMessageId: profile.messageId,
          anchorStateVersion: 1,
          generationKey: followUpGenerationKey({
            conversationId: profile.conversationId,
            anchorMessageId: profile.messageId,
            followUpId,
            attempt,
          }),
          trigger: "FOLLOW_UP",
          text: "Just checking in about that appointment.",
          structuredOutput: { reply: "Just checking in about that appointment." },
          confidence: 0.8,
          modelSuggestsSend: true,
          needsReview: false,
          status: options.scheduled ? "SCHEDULED" : "PENDING",
          modelProvider: "anthropic",
          modelName: "claude-opus-5",
          promptVersion: "reply.v1",
          schemaVersion: "ai-draft.v1",
        },
        select: { id: true },
      });
      if (!options.scheduled) {
        return { draftId: draft.id, operationId: undefined };
      }
      const operationId = `op-${followUpId}-${String(attempt)}`;
      await db().deliveryJobRecord.create({
        data: {
          ...scope,
          draftId: draft.id,
          operationId,
          correlationId: `corr-${operationId}`,
          status: "SCHEDULED",
          scheduledFor: new Date(DUE.getTime() + 30_000),
          selectedDelayMs: 30_000,
        },
      });
      return { draftId: draft.id, operationId };
    };

    it("records the operation the dead worker scheduled, instead of scheduling a second one", async () => {
      const { followUpId, profile } = await scenario({ maxAttempts: 3 });
      const first = await claimFollowUp(db(), followUpId, DUE);
      expect(first.status).toBe("READY");
      // What the worker did before it died: a draft for this attempt and a delivery for that draft.
      const { operationId } = await draftFor(profile, followUpId, 1, { scheduled: true });

      const afterLease = await claimFollowUp(db(), followUpId, new Date(DUE.getTime() + 6 * 60_000));

      expect(afterLease).toEqual({ status: "ALREADY_SENT", followUpId, attempt: 1, operationId });
      const [row] = await readFollowUps(db(), profile.context, profile.conversationId);
      expect(row?.status).toBe("SENT");
      // The attempt it spent, and no more: a second attempt here would be a second message.
      expect(row?.attemptCount).toBe(1);
      // The view does not carry the provider-facing operation, so the row itself is the check.
      const stored = await db().followUp.findUnique({ where: { id: followUpId }, select: { deliveryOperationId: true } });
      expect(stored?.deliveryOperationId).toBe(operationId);
    }, 180_000);

    it("settles an attempt whose draft the policy held, rather than retrying it for ever", async () => {
      const { followUpId, profile } = await scenario({ maxAttempts: 3 });
      await claimFollowUp(db(), followUpId, DUE);
      // A draft with no delivery: held for somebody to decide, so no send is coming for this attempt.
      await draftFor(profile, followUpId, 1, { scheduled: false });

      const afterLease = await claimFollowUp(db(), followUpId, new Date(DUE.getTime() + 6 * 60_000));

      // Retrying would re-ask a question that already has an answer, and an attempt whose draft keeps
      // being held is how a follow-up loops without end.
      expect(afterLease).toEqual({ status: "STOPPED", followUpId, reason: "REVIEW_PENDING" });
      const [row] = await readFollowUps(db(), profile.context, profile.conversationId);
      expect(row?.status).toBe("CANCELLED");
      expect(row?.attemptCount).toBe(1);
    }, 180_000);

    it("still lets an attempt that produced nothing at all be retried", async () => {
      // The pre-existing recovery, unchanged: a worker that died *before* generating leaves no draft, so
      // there is nothing to reconcile and the next claim is a genuine second attempt.
      const { followUpId, profile } = await scenario({ maxAttempts: 2 });

      await claimFollowUp(db(), followUpId, DUE);
      const afterLease = await claimFollowUp(db(), followUpId, new Date(DUE.getTime() + 6 * 60_000));

      expect(afterLease.status).toBe("READY");
      expect((await readFollowUps(db(), profile.context, profile.conversationId))[0]?.attemptCount).toBe(2);
    }, 180_000);

    it("reconciles even when the customer replied in the meantime", async () => {
      // The gate would answer `SUPERSEDED` here, and it would be answering about a message the customer
      // has already received. Recovery is asked first for exactly this case: what is left to do is to
      // write down what happened, not to decide it again.
      const { followUpId, profile } = await scenario({ maxAttempts: 3 });
      await claimFollowUp(db(), followUpId, DUE);
      const { operationId } = await draftFor(profile, followUpId, 1, { scheduled: true });
      await inbound(profile, new Date(DUE.getTime() + 60_000));

      const afterLease = await claimFollowUp(db(), followUpId, new Date(DUE.getTime() + 6 * 60_000));

      expect(afterLease).toMatchObject({ status: "ALREADY_SENT", operationId });
      expect((await readFollowUps(db(), profile.context, profile.conversationId))[0]?.status).toBe("SENT");
    }, 180_000);

    it("recovers the attempt that actually crashed, not the first one", async () => {
      // A mutation found this gap: every case above crashes on attempt 1, so a recovery that always
      // looked for attempt 1's draft would pass all of them. Here attempt 1 produced nothing and attempt
      // 2 is the one that got as far as scheduling — so a recovery keyed on the wrong attempt finds no
      // draft, spends attempt 3, and sends a second message about one silence.
      const { followUpId, profile } = await scenario({ maxAttempts: 3 });

      await claimFollowUp(db(), followUpId, DUE);
      const second = await claimFollowUp(db(), followUpId, new Date(DUE.getTime() + 6 * 60_000));
      expect(second.status).toBe("READY");
      const { operationId } = await draftFor(profile, followUpId, 2, { scheduled: true });

      const third = await claimFollowUp(db(), followUpId, new Date(DUE.getTime() + 20 * 60_000));

      expect(third).toEqual({ status: "ALREADY_SENT", followUpId, attempt: 2, operationId });
      const [row] = await readFollowUps(db(), profile.context, profile.conversationId);
      expect(row?.status).toBe("SENT");
      // Two attempts spent, not three.
      expect(row?.attemptCount).toBe(2);
    }, 180_000);

    it("keeps one attempt's identity distinct from the next, so a real second attempt is a second send", async () => {
      const { followUpId, profile } = await scenario({ maxAttempts: 3 });
      const keys = [1, 2].map((attempt) =>
        followUpGenerationKey({ conversationId: profile.conversationId, anchorMessageId: profile.messageId, followUpId, attempt }),
      );

      // Two attempts are two generations, bounded by `max_attempts` — which is where the decision to
      // chase somebody twice belongs. An identity keyed on the follow-up alone would collapse them and
      // silently turn three allowed attempts into one.
      expect(new Set(keys).size).toBe(2);
      expect(keys[0]).toContain(`${followUpId}:1`);
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

  /**
   * The two events that actually call off a chase, driven through the code that handles them.
   *
   * `cancelPendingFollowUps` being correct is tested above, and on its own that proves nothing about the
   * product: a cancellation helper with no caller is the defect class this repository keeps producing.
   * These cases call `appendInboundMessage` and the operations store's `takeOver` — the real paths an
   * inbound webhook and a person pressing *Take over* run — and assert the follow-up is already settled
   * afterwards, so no sweep ever offers it and no claim has to reason about it.
   */
  describe("called off by the events that actually happen", () => {
    it("is superseded by the customer's own reply, in the transaction that stores the message", async () => {
      const { followUpId, profile } = await scenario();
      const at = new Date(NOW.getTime() + 60_000);

      const message = await appendInboundMessage(db(), profile.context, {
        conversationId: profile.conversationId,
        kind: "TEXT",
        text: "sorry, got busy — still interested",
        occurredAt: at,
      });

      const row = (await readFollowUps(db(), profile.context, profile.conversationId)).find((candidate) => candidate.id === followUpId);
      expect(row).toMatchObject({ status: "SUPERSEDED", stopReason: "NEW_INBOUND", settledAt: at });
      // The message is stored and the chase is off as one fact: the append that wrote this row is the
      // same transaction that settled the follow-up, so no crash can leave one without the other.
      expect(message.id).toBeTruthy();
      // And the scan that rebuilds the work never offers it, which is what "not when the scan notices"
      // means: the row is settled before any worker reads the table.
      expect((await dueFollowUps(db(), DUE)).map((candidate) => candidate.id)).not.toContain(followUpId);
    }, 180_000);

    it("is cancelled when a person takes the conversation over", async () => {
      const { followUpId, profile } = await scenario();
      const at = new Date(NOW.getTime() + 60_000);

      const taken = await createConversationOperationStore(db(), profile.context).takeOver({ conversationId: profile.conversationId, at });

      expect(taken.status).toBe("TAKEN_OVER");
      const row = (await readFollowUps(db(), profile.context, profile.conversationId)).find((candidate) => candidate.id === followUpId);
      expect(row).toMatchObject({ status: "CANCELLED", stopReason: "HUMAN_TAKEOVER", settledAt: at });
      expect((await dueFollowUps(db(), DUE)).map((candidate) => candidate.id)).not.toContain(followUpId);
    }, 180_000);

    it("stays cancelled when the person hands the conversation back, but does not block the next plan", async () => {
      const { followUpId, goalId, profile } = await scenario();
      const store = createConversationOperationStore(db(), profile.context);

      await store.takeOver({ conversationId: profile.conversationId, at: new Date(NOW.getTime() + 60_000) });
      await store.handBack({ conversationId: profile.conversationId, at: new Date(NOW.getTime() + 120_000) });

      // Handing the conversation back does not resurrect the chase the takeover called off: a person
      // spent that time on this customer, and what to do next is a fresh decision, not a resumed timer.
      const row = (await readFollowUps(db(), profile.context, profile.conversationId)).find((candidate) => candidate.id === followUpId);
      expect(row).toMatchObject({ status: "CANCELLED", stopReason: "HUMAN_TAKEOVER" });
      // It must not block that decision either: "one pending follow-up per conversation" is about
      // pending ones, so a settled row cannot leave the conversation permanently unchaseable.
      const planned = await planFollowUp(db(), profile.context, {
        conversationId: profile.conversationId,
        goalId,
        dueAt: DUE,
        daypart: DAYPART,
        at: new Date(NOW.getTime() + 180_000),
      });
      expect(planned.status).toBe("PLANNED");
    }, 180_000);

    it("does not reach into another conversation, or another Business Profile", async () => {
      seq += 1;
      const workspace = await seedWorkspace(db(), `followup-cancel-${String(seq)}`, ["one", "two"]);
      const [first, second] = workspace.profiles as [SeededProfile, SeededProfile];
      const plan = async (profile: SeededProfile) => {
        const goal = await setPrimaryGoal(db(), profile.context, { conversationId: profile.conversationId, kind: "BOOK_APPOINTMENT", at: NOW });
        const planned = await planFollowUp(db(), profile.context, {
          conversationId: profile.conversationId,
          goalId: goal.status === "SET" ? goal.id : "",
          dueAt: DUE,
          daypart: DAYPART,
          at: NOW,
        });
        return planned.status === "PLANNED" ? planned.id : "";
      };
      const mine = await plan(first);
      const neighbour = await plan(second);

      await appendInboundMessage(db(), first.context, {
        conversationId: first.conversationId,
        kind: "TEXT",
        text: "still here",
        occurredAt: new Date(NOW.getTime() + 60_000),
      });

      expect((await readFollowUps(db(), first.context, first.conversationId)).find((row) => row.id === mine)?.status).toBe("SUPERSEDED");
      // The neighbour's chase is untouched, which the scope on the cancellation predicate is what
      // guarantees: one customer replying must not call off another profile's follow-ups.
      expect((await readFollowUps(db(), second.context, second.conversationId)).find((row) => row.id === neighbour)?.status).toBe("PENDING");
      expect((await dueFollowUps(db(), DUE)).map((row) => row.id)).toContain(neighbour);
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
