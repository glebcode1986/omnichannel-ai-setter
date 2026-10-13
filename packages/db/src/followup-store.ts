/**
 * Scheduled follow-ups, and the gate every one of them has to pass twice (GOALS_FOLLOWUPS.md, Issue #55).
 *
 * The issue's brief is "bounded goal execution and follow-up automation without turning the product into
 * an unlimited outreach engine". Four things here are what make the unbounded version unbuildable by
 * accident.
 *
 * **A follow-up carries no message.** It records *that* we intend to follow up, against which state, for
 * which goal, and by when. At execution it asks the shared coordinator for a reply through the same path
 * every automated send already uses — `requestFollowUpDraft` returns what to do, and the composition root
 * hands it to the delivery coordinator. There is no second send path here and nothing in this file
 * touches a provider.
 *
 * **Attempts are bounded in the database.** `max_attempts BETWEEN 1 AND 5` and `attempt_count <=
 * max_attempts` are CHECK constraints, so "no unlimited chasing" survives a careless caller, a migration
 * and a console session. `EXHAUSTED` is the only status that may claim `MAX_ATTEMPTS`, and vice versa.
 *
 * **The queue is never the source of truth.** The row is. A queue entry that vanished would delay a
 * follow-up; a row that vanished would lose the intent, and the acceptance criteria say the durable state
 * is here. `dueFollowUps` rebuilds the work from the table, so a lost queue rebuilds itself.
 *
 * **Everything is revalidated at execution, not at planning.** `claimFollowUp` re-reads the conversation,
 * the goal, the suppression list, the takeover state, the pending review and the channel's health inside
 * one transaction, with the conversation row locked. Anything that changed since the follow-up was planned
 * settles it with a named reason. This is the difference between a scheduler and a chaser: a scheduler
 * asks again.
 */
import { followUpGenerationKey } from "@omnichannel/application";
import { boundedMaxAttempts, isWithinDaypart, type FollowUpStopReason } from "@omnichannel/domain";

import type { DbClient, DbExecutor } from "./client";
import { profileScopeOf, type BusinessProfileContext } from "./tenancy";

export type FollowUpOutcome =
  | { readonly status: "PLANNED"; readonly id: string; readonly dueAt: Date }
  | { readonly status: "ALREADY_PENDING"; readonly id: string }
  /** Stopped, and the reason is the record of why this customer was not chased. */
  | { readonly status: "SETTLED"; readonly id: string; readonly reason: FollowUpStopReason }
  /** Handed to the coordinator. Its own variant, because a send is not a stop and has no stop reason. */
  | { readonly status: "SENT"; readonly id: string; readonly operationId: string }
  | { readonly status: "RECORDED"; readonly id: string }
  | { readonly status: "GONE" }
  | { readonly status: "REFUSED"; readonly reason: string };

export interface FollowUpView {
  readonly id: string;
  readonly conversationId: string;
  readonly goalId: string;
  readonly status: string;
  readonly dueAt: Date;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly stopReason: string | null;
  readonly anchorMessageId: string;
  readonly anchorStateVersion: number;
  readonly daypartTimeZone: string;
  readonly lastAttemptAt: Date | null;
  readonly settledAt: Date | null;
}

const followUpSelect = {
  id: true,
  conversationId: true,
  goalId: true,
  status: true,
  dueAt: true,
  attemptCount: true,
  maxAttempts: true,
  stopReason: true,
  anchorMessageId: true,
  anchorStateVersion: true,
  daypartTimeZone: true,
  lastAttemptAt: true,
  settledAt: true,
} as const;

/**
 * Plans one follow-up.
 *
 * Refuses rather than schedules whenever the *current* state already says no: there is no point writing a
 * row that the gate will reject, and a planning call that silently produced doomed work would make the
 * follow-up list a list of things that are not going to happen.
 *
 * The goal must be one a **person** set and still active. A model's suggestion cannot justify messaging
 * somebody — that is the whole reason `suggestGoal` writes a secondary goal and this reads `isPrimary`.
 */
export async function planFollowUp(
  db: DbClient,
  context: BusinessProfileContext,
  input: {
    readonly conversationId: string;
    readonly goalId: string;
    readonly dueAt: Date;
    readonly maxAttempts?: number;
    readonly daypart: { readonly timeZone: string; readonly startHour: number; readonly endHour: number };
    readonly at?: Date;
  },
): Promise<FollowUpOutcome> {
  const scope = profileScopeOf(context);
  const at = input.at ?? new Date();

  if (input.dueAt <= at) {
    // A follow-up due in the past would fire on the next scan with no wait at all, which is an immediate
    // unattended message wearing a schedule's clothes.
    return { status: "REFUSED", reason: "a follow-up is due in the future" };
  }
  if (input.daypart.startHour === input.daypart.endHour) {
    return { status: "REFUSED", reason: "a sending window of zero hours sends nothing" };
  }

  return db.$transaction(async (tx) => {
    const conversation = await tx.conversation.findFirst({
      where: { ...scope, id: input.conversationId },
      select: { id: true, status: true, stateVersion: true, takeoverState: true, contactId: true, lastMessageAt: true },
    });
    if (conversation === null) {
      return { status: "GONE" };
    }
    if (conversation.status !== "OPEN") {
      return { status: "REFUSED", reason: "this conversation is not open" };
    }

    const goal = await tx.conversationGoal.findFirst({
      where: { ...scope, id: input.goalId, conversationId: input.conversationId, status: "ACTIVE", isPrimary: true },
      select: { id: true, kind: true },
    });
    if (goal === null) {
      // Either no such goal, or one that is secondary, terminal, or a model's suggestion.
      return { status: "REFUSED", reason: "a follow-up needs an active primary goal somebody set" };
    }
    if (goal.kind === "NONE") {
      // The goal says there is nothing further. Scheduling against it would be chasing somebody for a
      // reason that explicitly does not exist.
      return { status: "REFUSED", reason: "this conversation's goal is that nothing further happens" };
    }

    const suppressed = await tx.followUpSuppression.findFirst({
      where: { ...scope, contactId: conversation.contactId, liftedAt: null },
      select: { id: true },
    });
    if (suppressed !== null) {
      return { status: "REFUSED", reason: "this customer asked not to be followed up" };
    }

    // The newest message is the anchor. A follow-up planned against an older one would be stale the
    // moment it was written.
    const anchor = await tx.message.findFirst({
      where: { ...scope, conversationId: input.conversationId },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      select: { id: true },
    });
    if (anchor === null) {
      return { status: "REFUSED", reason: "a follow-up needs a conversation with something in it" };
    }

    const existing = await tx.followUp.findFirst({
      where: { ...scope, conversationId: input.conversationId, status: "PENDING" },
      select: { id: true },
    });
    if (existing !== null) {
      // One pending follow-up per conversation, which a partial unique index also enforces. Two would be
      // two messages about the same silence.
      return { status: "ALREADY_PENDING", id: existing.id };
    }

    const created = await tx.followUp.create({
      data: {
        ...scope,
        conversationId: input.conversationId,
        goalId: goal.id,
        status: "PENDING",
        dueAt: input.dueAt,
        anchorMessageId: anchor.id,
        anchorStateVersion: conversation.stateVersion,
        attemptCount: 0,
        // Clamped here as well as checked in the database, so a caller gets the bounded value rather than
        // an error they have to handle.
        maxAttempts: boundedMaxAttempts(input.maxAttempts),
        daypartTimeZone: input.daypart.timeZone,
        daypartStartHour: input.daypart.startHour,
        daypartEndHour: input.daypart.endHour,
        createdByUserId: context.userId,
      },
      select: { id: true, dueAt: true },
    });
    return { status: "PLANNED", id: created.id, dueAt: created.dueAt };
  });
}

/**
 * Follow-ups whose time has come, rebuilt from the table.
 *
 * The scan is the recovery mechanism as well as the schedule: the queue holds a job per follow-up for
 * promptness, and this exists so that a queue which lost its contents does not lose the intent. The
 * acceptance criteria put it plainly — the queue is not the source of truth.
 */
export async function dueFollowUps(db: DbExecutor, now: Date, limit = 100): Promise<readonly DueFollowUp[]> {
  const rows = await db.followUp.findMany({
    where: { status: "PENDING", dueAt: { lte: now } },
    orderBy: [{ dueAt: "asc" }, { id: "asc" }],
    take: Math.min(Math.max(Math.trunc(limit), 1), 500),
    // The scope comes back with the row, which `FollowUpView` does not carry: a profile-scoped read
    // already knows whose profile it asked about, and this scan does not — it crosses every tenant by
    // design, because due work is due whoever it belongs to. Returning rows without their scope made
    // this function unusable by the only caller it exists for, which is why it had none.
    select: { ...followUpSelect, workspaceId: true, businessProfileId: true },
  });
  return rows;
}

/**
 * A follow-up that is due, with the tenant it belongs to.
 *
 * Separate from `FollowUpView` rather than widening it: every other read of a follow-up is already inside
 * a Business Profile context, and adding two fields a scoped caller cannot use would invite somebody to
 * trust them instead of the context they were given.
 */
export interface DueFollowUp extends FollowUpView {
  readonly workspaceId: string;
  readonly businessProfileId: string;
}

/** What `claimFollowUp` decided, and what the caller should do about it. */
export type FollowUpClaim =
  /** Go ahead: generate a reply for this goal and hand it to the delivery coordinator. */
  | {
      readonly status: "READY";
      readonly followUpId: string;
      readonly conversationId: string;
      readonly goalKind: string;
      readonly anchorMessageId: string;
      readonly anchorStateVersion: number;
      readonly attempt: number;
      readonly maxAttempts: number;
    }
  /** Not now, and here is the reason. The row is already settled or rescheduled. */
  | { readonly status: "STOPPED"; readonly followUpId: string; readonly reason: FollowUpStopReason }
  /** Outside the business's own sending hours. Still pending, moved to the next hour that is inside them. */
  | { readonly status: "DEFERRED"; readonly followUpId: string; readonly dueAt: Date }
  /**
   * This attempt's outbound already exists, and the claim recorded it rather than making another.
   *
   * The crash window Astra's first P1 on PR #82 named: a worker that scheduled an attempt's delivery and
   * died before recording it leaves a `PENDING` row whose lease lapses, and the next claim would
   * otherwise spend a fresh attempt and schedule a *second* operation for the same silence. Two
   * operations are two sends, and nothing downstream can deduplicate them because their identities
   * differ. So a claim first asks whether the previous attempt already produced a draft, and settles the
   * follow-up from what that draft actually did.
   */
  | { readonly status: "ALREADY_SENT"; readonly followUpId: string; readonly attempt: number; readonly operationId: string }
  /** Somebody else took it, or it is gone. */
  | { readonly status: "MISSED"; readonly followUpId: string };

/**
 * Asks, one more time, whether this follow-up should happen — and spends an attempt if it does.
 *
 * Everything the issue lists is re-read here rather than trusted from planning time: the newest inbound,
 * the conversation's state version, human takeover, an unresolved review, opt-out and suspension,
 * entitlement, the channel's eligibility, and whether the goal still stands. The conversation row is
 * locked first, so an inbound message committing concurrently either happens before this claim and is
 * seen, or waits and sees the result — the same boundary `delivery-store` takes before a send, and for
 * the same reason.
 *
 * A stop is recorded with its reason in this transaction. A caller that crashed immediately afterwards
 * would leave a settled follow-up and no send, which is the safe direction: the alternative is a send with
 * no record of the decision behind it.
 */
/**
 * How long a successful claim holds the follow-up before another worker may take it.
 *
 * The claim moves `due_at` forward by this much, which is what makes a claim exclusive: a second worker
 * finds the follow-up not yet due and leaves it alone. It is also the recovery mechanism — a worker that
 * died between claiming and sending leaves a row that becomes claimable again once the lease lapses, with
 * the attempt it spent still counted against the bound.
 */
export const FOLLOW_UP_CLAIM_LEASE_MS = 5 * 60_000;

export async function claimFollowUp(
  db: DbClient,
  followUpId: string,
  now: Date,
  entitlement: { readonly mayAutomate: boolean } = { mayAutomate: true },
  leaseMs = FOLLOW_UP_CLAIM_LEASE_MS,
): Promise<FollowUpClaim> {
  return db.$transaction(async (tx) => {
    // The follow-up row, locked *before* anything is read from it.
    //
    // Reading first and locking second is the bug this replaced: the attempt count came from a snapshot
    // taken before the lock, so two workers racing for one follow-up both saw zero attempts spent, both
    // passed the bound, and both went ahead. The customer got two messages. Locking first means the
    // second worker's read happens after the first has committed and sees the attempt it spent.
    //
    // Locked in a fixed order — follow-up, then conversation — so two claims on different follow-ups in
    // the same conversation cannot deadlock by taking them the other way round.
    const claimed = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "follow_ups" WHERE "id" = ${followUpId}::uuid AND "status" = 'PENDING' FOR UPDATE`;
    if (claimed.length === 0) {
      return { status: "MISSED", followUpId };
    }

    const followUp = await tx.followUp.findFirst({
      where: { id: followUpId, status: "PENDING" },
      select: {
        id: true,
        workspaceId: true,
        businessProfileId: true,
        conversationId: true,
        goalId: true,
        dueAt: true,
        anchorMessageId: true,
        anchorStateVersion: true,
        attemptCount: true,
        maxAttempts: true,
        daypartTimeZone: true,
        daypartStartHour: true,
        daypartEndHour: true,
      },
    });
    if (followUp === null) {
      return { status: "MISSED", followUpId };
    }
    // Not due, which means either it is not time yet or another worker holds the lease. Both are somebody
    // else's business, and both are `MISSED` from here.
    if (followUp.dueAt > now) {
      return { status: "MISSED", followUpId };
    }
    const scope = { workspaceId: followUp.workspaceId, businessProfileId: followUp.businessProfileId };

    // The conversation, locked and held to commit. Without this the predicates below would be read from
    // this statement's own snapshot and would serialize against nothing: a customer message committing
    // after the snapshot and before this transaction commits would be invisible, and the follow-up would
    // go out behind it.
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "conversations"
      WHERE "workspace_id" = ${scope.workspaceId}
        AND "business_profile_id" = ${scope.businessProfileId}
        AND "id" = ${followUp.conversationId}
      FOR UPDATE`;
    if (locked.length === 0) {
      return { status: "MISSED", followUpId };
    }

    const stop = async (reason: FollowUpStopReason, status: "CANCELLED" | "SUPERSEDED" | "BLOCKED" | "EXHAUSTED"): Promise<FollowUpClaim> => {
      await tx.followUp.update({ where: { id: followUp.id }, data: { status, stopReason: reason, settledAt: now, lastAttemptAt: now } });
      return { status: "STOPPED", followUpId: followUp.id, reason };
    };

    // Recovery, asked **before** the gates and before an attempt is spent.
    //
    // Before the gates on purpose: if this attempt's message already went out, the customer has it, and a
    // gate that then answered `SUPERSEDED` because they replied to it would record a decision the world
    // has already overtaken. What is left to do is to write down what happened.
    //
    // The attempt's draft is the durable record of the attempt having got that far, and the generation key
    // is derived the same way the worker derives it — one format, exported from `application`, because two
    // spellings of it would differ one day and the symptom would be a second follow-up about one silence.
    if (followUp.attemptCount > 0) {
      const previous = await tx.aiDraft.findFirst({
        where: {
          ...scope,
          generationKey: followUpGenerationKey({
            conversationId: followUp.conversationId,
            anchorMessageId: followUp.anchorMessageId,
            followUpId: followUp.id,
            attempt: followUp.attemptCount,
          }),
        },
        select: { id: true },
      });
      if (previous !== null) {
        // The delivery record is the authority rather than the draft's status: `scheduleAutomatedDelivery`
        // writes the record and moves the draft in one transaction, so a record is what "an operation
        // exists for this attempt" means, and it carries the identity to record.
        const scheduled = await tx.deliveryJobRecord.findUnique({
          where: { workspaceId_businessProfileId_draftId: { ...scope, draftId: previous.id } },
          select: { operationId: true },
        });
        if (scheduled !== null) {
          await tx.followUp.update({
            where: { id: followUp.id },
            data: { status: "SENT", deliveryOperationId: scheduled.operationId, settledAt: now, lastAttemptAt: now },
          });
          return { status: "ALREADY_SENT", followUpId: followUp.id, attempt: followUp.attemptCount, operationId: scheduled.operationId };
        }
        // A draft with no delivery: the policy held it, so somebody has to decide and no send is coming
        // for this attempt. Settled rather than retried — a retry would re-ask a question that has an
        // answer, and retrying an attempt whose draft keeps being held is how a follow-up loops for ever.
        return stop("REVIEW_PENDING", "CANCELLED");
      }
    }

    const conversation = await tx.conversation.findFirst({
      where: { ...scope, id: followUp.conversationId },
      select: {
        status: true,
        stateVersion: true,
        takeoverState: true,
        contactId: true,
        channelAccountId: true,
        aiEnabled: true,
        // Through the identity, which is where the account hangs off a conversation.
        channelIdentity: { select: { channelAccount: { select: { status: true } } } },
      },
    });
    if (conversation === null) {
      return { status: "MISSED", followUpId };
    }

    if (conversation.status !== "OPEN") {
      return stop("CONVERSATION_CLOSED", "CANCELLED");
    }

    const goal = await tx.conversationGoal.findFirst({ where: { ...scope, id: followUp.goalId }, select: { status: true, kind: true } });
    if (goal === null || goal.status !== "ACTIVE" || goal.kind === "NONE") {
      // Achieved, abandoned, or replaced. Either way there is nothing to follow up about.
      return stop("GOAL_TERMINAL", "CANCELLED");
    }

    // A person is handling it. Automation does not interrupt them, whatever was scheduled.
    if (conversation.takeoverState !== "NONE") {
      return stop("HUMAN_TAKEOVER", "CANCELLED");
    }

    const suppressed = await tx.followUpSuppression.findFirst({
      where: { ...scope, contactId: conversation.contactId, liftedAt: null },
      select: { id: true },
    });
    if (suppressed !== null) {
      return stop("OPTED_OUT", "CANCELLED");
    }

    // Suspension is an opt-out at the scope level: somebody stopped automated outbound for this
    // workspace, profile or account, and a follow-up is automated outbound.
    const suspended = await tx.automationSuspension.findFirst({
      where: {
        liftedAt: null,
        OR: [
          { scope: "WORKSPACE", workspaceId: scope.workspaceId },
          { scope: "BUSINESS_PROFILE", workspaceId: scope.workspaceId, businessProfileId: scope.businessProfileId },
          { scope: "CHANNEL_ACCOUNT", workspaceId: scope.workspaceId, channelAccountId: conversation.channelAccountId },
        ],
      },
      select: { id: true },
    });
    if (suspended !== null) {
      return stop("OPTED_OUT", "CANCELLED");
    }

    if (!entitlement.mayAutomate || !conversation.aiEnabled) {
      // Entitlement is passed in because it is not this table's fact to know; `aiEnabled` is the
      // conversation's own switch. Either one off means automation may not speak here.
      return stop("ENTITLEMENT_LOST", "CANCELLED");
    }

    if (conversation.channelIdentity.channelAccount.status !== "CONNECTED") {
      // Needs re-authorization or disconnected. A follow-up that tried anyway would fail at the provider
      // and spend an attempt on a problem the business has to fix first.
      return stop("CHANNEL_INELIGIBLE", "BLOCKED");
    }

    // The customer wrote back, or the conversation moved on. Either way the follow-up answers a question
    // that has changed. Two independent checks on purpose: the state version moves for reasons other than
    // an inbound message, and an inbound can arrive without anything else changing.
    const newerInbound = await tx.message.findFirst({
      where: { ...scope, conversationId: followUp.conversationId, direction: "IN", id: { not: followUp.anchorMessageId }, occurredAt: { gt: await anchorTime(tx, scope, followUp.anchorMessageId) } },
      select: { id: true },
    });
    if (newerInbound !== null) {
      return stop("NEW_INBOUND", "SUPERSEDED");
    }
    if (conversation.stateVersion !== followUp.anchorStateVersion) {
      return stop("STALE_ANCHOR", "SUPERSEDED");
    }

    // A draft is waiting for somebody. A second outbound would pre-empt their decision.
    const pendingReview = await tx.aiDraft.findFirst({
      where: { ...scope, conversationId: followUp.conversationId, needsReview: true, status: { in: ["PENDING", "HELD", "HELD_AMBIGUOUS"] } },
      select: { id: true },
    });
    if (pendingReview !== null) {
      return stop("REVIEW_PENDING", "CANCELLED");
    }

    // The bound, checked before the attempt is spent rather than after. Checking afterwards would allow
    // one more attempt than the maximum, which is exactly the kind of off-by-one that turns three into
    // four for every customer.
    if (followUp.attemptCount >= followUp.maxAttempts) {
      return stop("MAX_ATTEMPTS", "EXHAUSTED");
    }

    // The business's own hours, in the business's own zone. Deferring rather than stopping, because the
    // follow-up is still wanted — just not at four in the morning.
    const localHour = hourIn(now, followUp.daypartTimeZone);
    if (!isWithinDaypart(localHour, followUp.daypartStartHour, followUp.daypartEndHour)) {
      const dueAt = nextOpening(now, followUp.daypartTimeZone, followUp.daypartStartHour);
      await tx.followUp.update({ where: { id: followUp.id }, data: { dueAt } });
      return { status: "DEFERRED", followUpId: followUp.id, dueAt };
    }

    const attempt = followUp.attemptCount + 1;
    // The attempt is spent and the lease taken in one write. Leaving `due_at` where it was would let a
    // second worker claim the same follow-up the moment this transaction commits, and the customer would
    // get two messages about one silence.
    await tx.followUp.update({
      where: { id: followUp.id },
      data: { attemptCount: attempt, lastAttemptAt: now, dueAt: new Date(now.getTime() + leaseMs) },
    });
    return {
      status: "READY",
      followUpId: followUp.id,
      conversationId: followUp.conversationId,
      goalKind: goal.kind,
      anchorMessageId: followUp.anchorMessageId,
      anchorStateVersion: followUp.anchorStateVersion,
      attempt,
      maxAttempts: followUp.maxAttempts,
    };
  });
}

async function anchorTime(tx: DbExecutor, scope: { workspaceId: string; businessProfileId: string }, messageId: string): Promise<Date> {
  const anchor = await tx.message.findFirst({ where: { ...scope, id: messageId }, select: { occurredAt: true } });
  // A missing anchor would make every message "newer", which is the safe direction: the follow-up stops.
  return anchor?.occurredAt ?? new Date(0);
}

/** The local hour in a zone, for the daypart check. */
export function hourIn(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, hour: "2-digit", hour12: false }).formatToParts(at);
  return Number(parts.find((part) => part.type === "hour")?.value ?? "0") % 24;
}

/**
 * The next moment the business's window opens.
 *
 * Computed by stepping forward an hour at a time rather than by arithmetic on the offset, because an hour
 * that does not exist — the one a clock change skips — has no instant to name, and asking the calendar
 * avoids having to reason about which one that is.
 */
export function nextOpening(from: Date, timeZone: string, startHour: number): Date {
  for (let step = 1; step <= 48; step += 1) {
    const candidate = new Date(from.getTime() + step * 3_600_000);
    if (hourIn(candidate, timeZone) === startHour) {
      return candidate;
    }
  }
  // Unreachable for any real zone: 48 hourly steps pass every hour of the clock at least twice. A day
  // later is a defensible answer rather than a throw, because refusing to schedule would lose the intent.
  return new Date(from.getTime() + 86_400_000);
}

/**
 * Records that a claimed follow-up reached the coordinator.
 *
 * Separate from the claim because the send is arranged outside this transaction, by the coordinator that
 * owns every send. Once it has an operation id, the follow-up is `SENT` and names it — which is what lets
 * somebody reading a delivery find the follow-up that caused it.
 */
export async function recordFollowUpSent(db: DbExecutor, followUpId: string, operationId: string, at = new Date()): Promise<FollowUpOutcome> {
  const changed = await db.followUp.updateMany({
    where: { id: followUpId, status: "PENDING" },
    data: { status: "SENT", deliveryOperationId: operationId, settledAt: at, lastAttemptAt: at },
  });
  return changed.count === 0 ? { status: "GONE" } : { status: "SENT", id: followUpId, operationId };
}

/**
 * Cancels every pending follow-up on a conversation.
 *
 * Called when an inbound message arrives or a person takes over, so the cancellation is a fact the moment
 * the thing that invalidated it happens — rather than something the next scan notices. `claimFollowUp`
 * checks the same conditions again anyway: this is the prompt path, and that is the correct one.
 */
export async function cancelPendingFollowUps(
  db: DbExecutor,
  scope: { readonly workspaceId: string; readonly businessProfileId: string },
  conversationId: string,
  reason: FollowUpStopReason,
  at = new Date(),
): Promise<number> {
  const status = reason === "NEW_INBOUND" || reason === "SUPERSEDED_BY_NEWER" ? "SUPERSEDED" : "CANCELLED";
  const changed = await db.followUp.updateMany({
    where: { ...scope, conversationId, status: "PENDING" },
    data: { status, stopReason: reason, settledAt: at },
  });
  return changed.count;
}

/** A person calls it off. */
export async function cancelFollowUp(
  db: DbExecutor,
  context: BusinessProfileContext,
  followUpId: string,
  at = new Date(),
): Promise<FollowUpOutcome> {
  const scope = profileScopeOf(context);
  const changed = await db.followUp.updateMany({
    where: { ...scope, id: followUpId, status: "PENDING" },
    data: { status: "CANCELLED", stopReason: "HUMAN_CANCELLED", settledAt: at },
  });
  return changed.count === 0 ? { status: "GONE" } : { status: "SETTLED", id: followUpId, reason: "HUMAN_CANCELLED" };
}

/** The follow-ups of one conversation, newest first. */
export async function readFollowUps(db: DbExecutor, context: BusinessProfileContext, conversationId: string): Promise<readonly FollowUpView[]> {
  const scope = profileScopeOf(context);
  return db.followUp.findMany({
    where: { ...scope, conversationId },
    orderBy: [{ createdAt: "desc" }],
    take: 50,
    select: followUpSelect,
  });
}

/** Records that a customer asked not to be chased. */
export async function suppressFollowUps(
  db: DbExecutor,
  context: BusinessProfileContext,
  input: { readonly contactId: string; readonly reason: string; readonly sourceMessageId?: string },
): Promise<FollowUpOutcome> {
  const scope = profileScopeOf(context);
  if (input.reason.trim() === "") {
    return { status: "REFUSED", reason: "an opt-out needs the words somebody recorded it with" };
  }
  const existing = await db.followUpSuppression.findFirst({ where: { ...scope, contactId: input.contactId, liftedAt: null }, select: { id: true } });
  if (existing !== null) {
    // Already opted out. Writing a second row would make "are they opted out" a count.
    return { status: "RECORDED", id: existing.id };
  }
  const created = await db.followUpSuppression.create({
    data: {
      ...scope,
      contactId: input.contactId,
      reason: input.reason.trim(),
      recordedByUserId: context.userId,
      ...(input.sourceMessageId === undefined ? {} : { sourceMessageId: input.sourceMessageId }),
    },
    select: { id: true },
  });
  return { status: "RECORDED", id: created.id };
}

/** A person lifts an opt-out. Nothing else can: a suppression that expired on its own would resume chasing. */
export async function liftSuppression(db: DbExecutor, context: BusinessProfileContext, contactId: string, at = new Date()): Promise<FollowUpOutcome> {
  const scope = profileScopeOf(context);
  const changed = await db.followUpSuppression.updateMany({
    where: { ...scope, contactId, liftedAt: null },
    data: { liftedAt: at, liftedByUserId: context.userId },
  });
  return changed.count === 0 ? { status: "GONE" } : { status: "RECORDED", id: contactId };
}

/** Whether this customer may be followed up at all. */
export async function isSuppressed(db: DbExecutor, context: BusinessProfileContext, contactId: string): Promise<boolean> {
  const scope = profileScopeOf(context);
  return (await db.followUpSuppression.findFirst({ where: { ...scope, contactId, liftedAt: null }, select: { id: true } })) !== null;
}
