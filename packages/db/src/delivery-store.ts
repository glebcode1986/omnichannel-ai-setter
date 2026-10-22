/**
 * PostgreSQL implementation of the delivery coordinator's `DeliveryStore` (ADR-012).
 *
 * The whole point of this file is one statement: the claim. Two workers can hold the same queue job — a
 * lost lock, a restart, a duplicate enqueue — and both will reach this code believing they should send. The
 * database decides which of them is right, with a conditional `UPDATE` that can only succeed once.
 *
 * The condition is not only the delivery row's own status. Between the read that approved this send and the
 * claim that takes it, the conversation can move: the customer writes again, a colleague takes over, the
 * business edits its automation policy or switches AI off. A claim conditional only on `status = 'SCHEDULED'`
 * succeeds in every one of those cases and sends on an approval that has already expired — the row was never
 * the thing that authorized the send.
 *
 * So the claim asserts, in the same statement, every fact the approval rested on:
 *
 *     UPDATE delivery_jobs SET status = 'SENDING'
 *      WHERE operation_id = $1 AND status = 'SCHEDULED'
 *        AND <the draft, conversation, account and policy are still exactly as they were read>
 *
 * One statement, so there is no read-then-write for a race to slip between, and no application-side check
 * that a concurrent commit could invalidate a microsecond later. A loser — whether it lost to another worker
 * or to the customer — sees zero rows and stops, before the adapter rather than after it.
 *
 * The facts are re-asserted rather than compared against a single version counter. A counter only protects
 * what its writers remember to bump; every value here is checked against what was actually read, so a writer
 * that changes one of them cannot leave the guard behind.
 *
 * Delivery is a system flow driven by a queue job, so the scope comes from the job's own row rather than
 * from a member context, exactly as for ingestion and draft generation. Every statement is still bounded by
 * the operation ID, which is unique across the table.
 */
import type {
  ClaimOutcome,
  DeliverySendContext,
  DeliveryStateGuard,
  DeliverySettlement,
  DeliveryStore,
  PolicyLimits,
} from "@omnichannel/application";
import { randomUUID } from "node:crypto";

import {
  commercialAccessOf,
  isReasonCode,
  toQuietHours,
  toUserId,
  type Actor,
  type CommercialAccess,
  type DeliveryJobStatus,
  type SuspensionReason,
  type SuspensionScope,
  type TakeoverReason,
  type RolloutAccess,
} from "@omnichannel/domain";

import type { DbClient, DbExecutor } from "./client";
import { entitlementLockKeyFor } from "./entitlement-lock";
import { readEntitlement } from "./entitlement-store";
import { resolveEffectiveMode } from "./automation-mode";
import { releaseCatalogueLockKey } from "./release-lock";
import { coveringSuspensionAt } from "./suspension-covering";
import { readReleaseInForceNow, readRolloutAccess, rolloutAccessFrom } from "./release-store";
import { suspensionLockKeysFor } from "./suspension-lock";
import type {
  ActorKind,
  AiMode,
  ChannelAccountStatus,
  ChannelType,
  ConversationStatus,
  DeliveryAuthorityKind,
  InstagramAfterWindowPolicy,
  ReviewMode,
  TakeoverState,
  WhatsAppAfterWindowPolicy,
} from "./generated/prisma/enums";

/** States a scheduled delivery may still be claimed from. Anything else is finished or in flight. */
const CLAIMABLE: DeliveryJobStatus = "SCHEDULED";

/**
 * The live facts a send was judged against, as the claim must find them again.
 *
 * Opaque to the coordinator by design (`DeliveryStateGuard`): it carries this back untouched, and only the
 * claim's own statement may act on it. Everything the coordinator judges is derived from one of these, so a
 * field that stops being asserted here is a way for a decision to be made on a fact that has since changed.
 */
interface SendStateGuard {
  /** The scope every locking statement carries, so a lock can never reach another tenant's row. */
  readonly workspaceId: string;
  readonly businessProfileId: string;
  readonly channelAccountId: string;
  /** Advanced by every new customer message, and by any future writer of conversation-level state. */
  readonly conversationStateVersion: number;
  readonly conversationStatus: ConversationStatus;
  readonly takeoverState: TakeoverState;
  /**
   * Who owns the conversation, not merely that somebody does.
   *
   * Whether a human-active takeover blocks this send depends on whether it is the one that authorized it,
   * so a takeover changing hands between the read and the claim changes the decision.
   */
  readonly takeoverActorKind: ActorKind | null;
  readonly takeoverActorUserId: string | null;
  readonly aiEnabled: boolean;
  readonly modeOverride: AiMode | null;
  readonly accountStatus: ChannelAccountStatus;
  readonly draftText: string | null;
  readonly draftNeedsReview: boolean;
  /** The draft's anchor: a customer message after it is what makes this reply answer a stale question. */
  readonly anchorAt: Date;
  /**
   * When the automation policy rows were last written, or null where none exists.
   *
   * The mode, the confidence threshold, quiet hours and the after-window policy all come from these rows,
   * and the limits the coordinator judges against were read from them too. `updatedAt` is the one field that
   * answers "is this still the row that was read?" for all of it at once.
   */
  readonly accountPolicyAt: Date | null;
  readonly defaultPolicyAt: Date | null;
  /**
   * The approval this send was judged under, re-asserted like everything else.
   *
   * Nothing rewrites these today — an authority is granted once, when the delivery is scheduled. Binding
   * them anyway costs one predicate and means a send cannot outlive the approval it names, whatever a
   * later feature decides it may edit.
   */
  readonly authority: DeliveryAuthorityKind;
  readonly approvedByUserId: string | null;
  readonly approvedAt: Date | null;
  readonly approvedReviewMode: ReviewMode | null;
  /**
   * What the commercial state permitted when the decision was made (#40).
   *
   * The resolved answer rather than the rows' `updatedAt`, unlike every other version marker here, and the
   * difference matters: entitlement changes with the clock as well as with writes. A trial whose last day
   * ends during a two-minute delay, or an override that simply lapses, moves no row at all — so a
   * timestamp predicate would bind nothing and the send would go out on an entitlement that had expired.
   * The claim therefore re-resolves it and compares these three booleans.
   */
  readonly commercial: CommercialAccess;
  /**
   * What the staged rollout permitted when the decision was made (#60, LAUNCH_READINESS.md §18).
   *
   * The resolved answer rather than a row's `updatedAt`, for the same reason the commercial state is: a
   * release recorded during a two-minute delay moves no row this guard could name, and a rollout pulled
   * back to a DRAFT-first stage while a reply waited has to stop that reply rather than be discovered
   * after it went out.
   */
  readonly rollout: RolloutAccess;
}

const sealGuard = (guard: SendStateGuard): DeliveryStateGuard => guard as unknown as DeliveryStateGuard;
const openGuard = (guard: DeliveryStateGuard): SendStateGuard => guard as unknown as SendStateGuard;

export function createDeliveryStore(db: DbClient): DeliveryStore {
  return {
    async loadForSend(operationId, at) {
      const job = await db.deliveryJobRecord.findUnique({
        where: { operationId },
        select: {
          id: true,
          operationId: true,
          draftId: true,
          status: true,
          attemptCount: true,
          workspaceId: true,
          businessProfileId: true,
          authority: true,
          approvedByUserId: true,
          approvedAt: true,
          approvedReviewMode: true,
          humanText: true,
          composedByUserId: true,
          conversationId: true,
          // The conversation a human-composed delivery names directly, because it has no draft to ask.
          // Selected with the same shape as the draft's, so one reader serves both origins.
          conversation: {
            select: {
              id: true,
              channelAccountId: true,
              status: true,
              aiEnabled: true,
              takeoverState: true,
              modeOverride: true,
              stateVersion: true,
              lastInboundAt: true,
              takeoverReason: true,
              takeoverReviewMode: true,
              humanTakeoverAt: true,
              takeoverActorKind: true,
              takeoverActorUserId: true,
              channelIdentity: { select: { externalUserId: true, channelAccount: { select: { channel: true, status: true } } } },
            },
          },
          draft: {
            select: {
              text: true,
              needsReview: true,
              conversationId: true,
              // What asked for this draft. A follow-up attempt answers no message of the customer's, so
              // the provider's automated-response budget — measured from their last message — does not
              // apply to it (#55). Everything else about the send is identical.
              trigger: true,
              sentMessage: { select: { id: true } },
              conversation: {
                select: {
                  id: true,
                  channelAccountId: true,
                  status: true,
                  aiEnabled: true,
                  takeoverState: true,
                  modeOverride: true,
                  stateVersion: true,
                  lastInboundAt: true,
                  takeoverReason: true,
                  takeoverReviewMode: true,
                  humanTakeoverAt: true,
                  takeoverActorKind: true,
                  takeoverActorUserId: true,
                  // The conversation reaches its account through the identity's composite key.
                  channelIdentity: { select: { externalUserId: true, channelAccount: { select: { channel: true, status: true } } } },
                },
              },
            },
          },
        },
      });
      if (job === null) {
        return undefined;
      }

      // Exactly one origin, which a CHECK guarantees (ADR-018 Option B): an AI draft, or a person's own
      // wording. Everything below is written once and serves both, because a human-composed reply goes
      // through this same coordinator with the same gates — there is no second send path.
      const conversation = job.draft?.conversation ?? job.conversation;
      if (conversation === null || conversation === undefined) {
        // A delivery with neither origin cannot exist, and one whose conversation vanished has nowhere to
        // send. Returning nothing is the same answer the caller already handles for a missing job.
        return undefined;
      }
      const outboundText = job.draft === null ? job.humanText : job.draft.text;
      const scope = { workspaceId: job.workspaceId, businessProfileId: job.businessProfileId };
      // A human-composed reply has no draft to anchor to, so "newer inbound" is measured from when the
      // person composed it. `approvedAt` is that moment, and it is set for every human authority.
      const anchorAt = job.draftId === null ? (job.approvedAt ?? new Date(0)) : await anchorTime(db, scope, job.draftId);
      // Read here rather than carried from scheduling: a message that arrived during the delay is exactly
      // the thing this lookup exists to notice.
      const newerInbound = await db.message.findFirst({
        where: { ...scope, conversationId: conversation.id, direction: "IN", aiDraftId: null, occurredAt: { gt: anchorAt } },
        select: { id: true },
      });
      const policies = await automationPolicies(db, scope, conversation.channelAccountId);
      const effective = policies.account ?? policies.default;
      const suspended = await coveringSuspension(db, { ...scope, channelAccountId: conversation.channelAccountId }, at);
      // Resolved here, with everything else and at the same instant. Read before the coordinator's own
      // read it could not be bound by the claim — which is exactly how the kill switch was once
      // bypassable — and resolved after it the decision and the guard would describe two different
      // commercial states.
      const commercial = commercialAccessOf(await readEntitlement(db, job.workspaceId, at));
      // And the staged rollout, at the same instant and for the same reason — `at`, not the wall clock,
      // so the guard describes one moment rather than two. A narrow query over the few most recent
      // release candidates; see `readReleaseInForce`.
      const rollout = await readRolloutAccess(db, { workspaceId: job.workspaceId, businessProfileId: job.businessProfileId }, at);

      const context: DeliverySendContext = {
        deliveryJobId: job.id,
        operationId: job.operationId,
        workspaceId: job.workspaceId,
        ...(job.draftId === null ? {} : { draftId: job.draftId }),
        conversationId: conversation.id,
        channel: conversation.channelIdentity.channelAccount.channel,
        recipientExternalId: conversation.channelIdentity.externalUserId,
        channelAccountId: conversation.channelAccountId,
        ...(outboundText === null ? {} : { text: outboundText }),
        status: job.status,
        attemptCount: job.attemptCount,
        // Through the one rule, not an inline copy of it. The expression here was
        // `conversation.modeOverride ?? effective?.mode ?? "OFF"` — the same answer as
        // `resolveEffectiveMode`, arrived at separately, in the file that decides whether a reply goes
        // out. `automation-mode.ts` says in its own header that a second implementation of this rule is
        // "the kind of duplication that eventually disagrees with itself", and there were four.
        mode: resolveEffectiveMode(conversation.modeOverride, conversation.channelAccountId, [
          ...(policies.account === undefined ? [] : [{ channelAccountId: conversation.channelAccountId, mode: policies.account.mode }]),
          ...(policies.default === undefined ? [] : [{ channelAccountId: null, mode: policies.default.mode }]),
        ]),
        limits: limitsFrom(effective, conversation.channelIdentity.channelAccount.channel),
        ...(conversation.lastInboundAt === null ? {} : { lastInboundAt: conversation.lastInboundAt }),
        // Set only where it is true, so a send that is an answer keeps the provider deadline it should.
        ...(job.draft?.trigger === "FOLLOW_UP" ? { proactive: true } : {}),
        aiEnabled: conversation.aiEnabled && conversation.status === "OPEN",
        takeover: takeoverStateOf(conversation),
        authority: authorityOf(job),
        ...(suspended === undefined ? {} : { outboundSuspended: suspended }),
        commercial,
        rollout,
        replyCycle: newerInbound === null ? "OWNED" : "SUPERSEDED",
        account: conversation.channelIdentity.channelAccount.status,
        // A person's own wording was never held for review; the review it needed was them writing it.
        draftNeedsReview: job.draft?.needsReview ?? false,
        // The durable record that the logical action already happened. For a human-composed delivery the
        // operation id is that record, because there is no draft to hang a sent message from.
        alreadySent: job.draft === null ? await humanSendAlreadyRecorded(db, job.operationId) : job.draft.sentMessage !== null,
        guard: sealGuard({
          ...scope,
          channelAccountId: conversation.channelAccountId,
          conversationStateVersion: conversation.stateVersion,
          conversationStatus: conversation.status,
          takeoverState: conversation.takeoverState,
          aiEnabled: conversation.aiEnabled,
          modeOverride: conversation.modeOverride,
          accountStatus: conversation.channelIdentity.channelAccount.status,
          draftText: outboundText,
          draftNeedsReview: job.draft?.needsReview ?? false,
          anchorAt,
          accountPolicyAt: policies.account?.updatedAt ?? null,
          defaultPolicyAt: policies.default?.updatedAt ?? null,
          takeoverActorKind: conversation.takeoverActorKind,
          takeoverActorUserId: conversation.takeoverActorUserId,
          authority: job.authority,
          approvedByUserId: job.approvedByUserId,
          approvedAt: job.approvedAt,
          approvedReviewMode: job.approvedReviewMode,
          commercial,
          rollout,
        }),
      };
      return context;
    },

    async claim(context, claimedAt) {
      const guard = openGuard(context.guard);
      try {
        return await claimInside(db, context, guard, claimedAt);
      } catch (error) {
        // Postgres broke a deadlock, or the transaction lost a write conflict. Either way this worker
        // established nothing: it has not claimed and it has not sent. Reporting it as a moved state is
        // what it is — the caller re-reads and re-judges — and it keeps an unknown outcome out of a path
        // whose whole contract is that nothing ambiguous reaches the adapter.
        if (isWriteConflict(error)) {
          return { kind: "STATE_CHANGED" };
        }
        throw error;
      }
    },

    async settle(operationId, settlement, at) {
      await db.$transaction(async (tx) => {
        const job = await tx.deliveryJobRecord.findUniqueOrThrow({
          where: { operationId },
          select: {
            id: true,
            workspaceId: true,
            businessProfileId: true,
            draftId: true,
            correlationId: true,
            humanText: true,
            composedByUserId: true,
            conversationId: true,
            conversation: { select: { id: true, channelAccountId: true } },
            draft: { select: { conversationId: true, conversation: { select: { channelAccountId: true } } } },
          },
        });
        const scope = { workspaceId: job.workspaceId, businessProfileId: job.businessProfileId };

        // Exactly one origin, by CHECK. The conversation comes from the draft when there is one and from
        // the delivery itself when a person composed the reply.
        const conversationId = job.draft?.conversationId ?? job.conversationId;
        const channelAccountId = job.draft?.conversation.channelAccountId ?? job.conversation?.channelAccountId;

        if (settlement.kind === "SENT" && conversationId !== null && channelAccountId !== undefined && channelAccountId !== null) {
          // The outbound message and the terminal state are written together: a SENT row without its
          // message would let a later run believe nothing had been sent.
          //
          // An upsert rather than a create, because the provider can echo a message back before this
          // transaction commits. The send returns a platform id and this write happens afterwards, in a
          // separate transaction, so a webhook arriving in that window inserts the same id first — as a
          // human's message, since nothing yet says it was ours. A plain `create` then violated the
          // uniqueness of the platform id and aborted the settle, leaving the delivery stuck `SENDING`
          // with no sent time and the message attributed to a person who never wrote it. The send is the
          // authoritative record of its own authorship, so it claims the row it finds.
          await tx.message.upsert({
            where:
              settlement.platformMessageId === ""
                ? { operationId }
                : {
                    workspaceId_businessProfileId_channelAccountId_channelMessageId: {
                      ...scope,
                      channelAccountId,
                      channelMessageId: settlement.platformMessageId,
                    },
                  },
            update: {
              // Only what authorship decides. The echo's own text, kind and timestamps are the provider's
              // account of the same message and are left alone.
              source: job.draftId === null ? "HUMAN" : "AI",
              ...(job.composedByUserId === null ? {} : { sentByUserId: job.composedByUserId }),
              transportPath: "STANDARD",
              operationId,
              ...(job.draftId === null ? {} : { aiDraftId: job.draftId }),
            },
            create: {
              ...scope,
              channelAccountId,
              conversationId,
              channelMessageId: settlement.platformMessageId === "" ? null : settlement.platformMessageId,
              direction: "OUT",
              // Attributed to whoever actually wrote it. Recording a person's words as `AI` would be the
              // audit trail claiming the assistant said something a colleague did — the one confusion the
              // thread's source distinction exists to prevent.
              source: job.draftId === null ? "HUMAN" : "AI",
              ...(job.composedByUserId === null ? {} : { sentByUserId: job.composedByUserId }),
              kind: "TEXT",
              occurredAt: at,
              deliveryStatus: "SENT",
              // Automated delivery is always the standard path; the human-agent path is a human action.
              transportPath: "STANDARD",
              operationId,
              ...(job.draftId === null ? {} : { aiDraftId: job.draftId }),
            },
          });
          await tx.conversation.update({
            where: { workspaceId_businessProfileId_id: { ...scope, id: conversationId } },
            data: { lastOutboundAt: at, lastMessageAt: at },
          });
        }

        await tx.deliveryJobRecord.update({ where: { operationId }, data: statusFieldsFor(settlement, at) });
      });
    },

    async reschedule(operationId, notBefore) {
      // Back to SCHEDULED without counting an attempt: waiting for quiet hours is not a failure.
      await db.deliveryJobRecord.updateMany({
        where: { operationId, status: { in: ["SCHEDULED", "SENDING"] } },
        data: { status: "SCHEDULED", scheduledFor: notBefore, claimedAt: null },
      });
    },
  };
}

/**
 * The kill switch covering this send, as both the read and the claim must see it.
 *
 * One function, called twice on purpose: once with the rest of the state, and once inside the claim's own
 * transaction after the lock below. A switch is an operator's decision about the system rather than a fact
 * about this conversation, and that is exactly why it was originally resolved outside the coordinator —
 * but a value read outside the guarded read cannot be re-asserted by the claim, and a switch committed
 * between the read and the claim was therefore invisible to the guard.
 */
async function coveringSuspension(
  db: DbExecutor,
  target: { readonly workspaceId: string; readonly businessProfileId: string; readonly channelAccountId: string },
  at: Date,
): Promise<{ readonly scope: SuspensionScope; readonly reason: SuspensionReason } | undefined> {
  // The predicate and the domain's precedence both live in `suspension-covering.ts` now. This file used
  // to carry its own copy of the query — correct, but one of four, and the other three disagreed with it.
  const active = await coveringSuspensionAt(db, target, at);
  return active === undefined ? undefined : { scope: active.scope, reason: active.reason };
}


/**
 * The claim itself: locks the rows the decision was made against, in a fixed order, then takes the send.
 *
 * Kept whole and separate so the ordering reads as one sequence — the order is part of the argument, not
 * an accident of where statements happened to be written.
 */
async function claimInside(
  db: DbClient,
  context: DeliverySendContext,
  guard: SendStateGuard,
  claimedAt: Date,
): Promise<ClaimOutcome> {
  return db.$transaction(
  async (tx) => {
    const target = { workspaceId: guard.workspaceId, businessProfileId: guard.businessProfileId, channelAccountId: guard.channelAccountId };

    // The kill-switch keys, taken before any row lock so that every claim and every switch writer agrees
    // on one order. Shared, so claims never wait on each other; a writer takes its own key exclusively
    // and therefore waits for claims already in flight, and blocks the ones that follow until it commits.
    //
    // One statement rather than four round trips: `unnest` holds them all by the time it returns, and
    // `hashtextextended` derives the key on the server so the two sides cannot disagree about it.
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock_shared(hashtextextended(key, 0))
      FROM unnest(${suspensionLockKeysFor(target)}::text[]) AS key`;

    // The Business Profile row, locked first because it is the coarsest of these and a consistent
    // order is what keeps two claims from deadlocking against each other.
    //
    // It is here for a case no row lock on the policy rows themselves can cover: a policy row that
    // did not exist when the state was read. `FOR SHARE` on rows that exist cannot block the
    // *creation* of one, and an account override inserted while this claim is in flight changes the
    // mode and the limits it was judged against. Every `automation_policies` row carries a foreign
    // key to this row, so inserting one takes a `KEY SHARE` lock on it — which `FOR UPDATE` here
    // conflicts with. The boundary is therefore enforced by the foreign key rather than by asking
    // every present and future policy writer to remember a convention.
    //
    // The cost is that claims within one Business Profile serialize. They are a handful of short
    // statements, and a reply that cannot be taken back is worth more than that concurrency.
    //
    // `rollout_autopilot` is selected here rather than read again below, and that is the point rather than
    // a saving: the staged rollout's per-profile half is a column on this row, and reading it in a second
    // statement would be an unlocked read of a fact the claim depends on — the one thing this transaction
    // is not allowed to do. Taken off the locked row it is covered by the lock already held.
    const profileRows = await tx.$queryRaw<{ id: string; rollout_autopilot: boolean }[]>`
      SELECT "id", "rollout_autopilot" FROM "business_profiles"
      WHERE "workspace_id" = ${guard.workspaceId} AND "id" = ${guard.businessProfileId}
      FOR UPDATE`;

    // The conversation row, locked and held to commit. This is the boundary `appendInboundMessage`
    // already takes before writing a customer message, and taking the same one is what puts this claim
    // and that message into a definite order instead of a race: whichever transaction gets the lock
    // first happens first, and the other sees the result. A takeover or any other write to the
    // conversation conflicts with this lock for the same reason.
    //
    // Without it the predicates below would be evaluated from the statement's own snapshot and would
    // not serialize against anything: a message committing after that snapshot and before this
    // transaction commits would be invisible, and the send would go out behind it.
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "conversations"
      WHERE "workspace_id" = ${guard.workspaceId}
        AND "business_profile_id" = ${guard.businessProfileId}
        AND "id" = ${context.conversationId}
      FOR UPDATE`;
    if (locked.length === 0) {
      // The conversation is gone; there is nothing left to send into.
      return { kind: "NOT_CLAIMABLE", status: "SENT" };
    }

    // The rows the decision read that the conversation's lock does not cover, in a fixed order so two
    // claims can never take them the other way round. The draft is locked outright because rewriting
    // it changes what would be sent; the account and the policy rows are shared, so concurrent claims
    // do not block each other and only a writer does.
    await tx.$queryRaw`SELECT "id" FROM "ai_drafts" WHERE "id" = ${context.draftId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "channel_accounts" WHERE "id" = ${guard.channelAccountId} FOR SHARE`;
    await tx.$queryRaw`
      SELECT "id" FROM "automation_policies"
      WHERE "workspace_id" = ${guard.workspaceId}
        AND "business_profile_id" = ${guard.businessProfileId}
        AND ("channel_account_id" = ${guard.channelAccountId} OR "channel_account_id" IS NULL)
      FOR SHARE`;

    // The switch, re-read now that the keys above are held: from here to commit, no covering switch can
    // appear. A switch found here is a state change like any other — the coordinator re-reads and
    // re-judges, and the policy engine is what turns it into a held delivery with a named reason. This
    // path deliberately produces no send and no attempt.
    if ((await coveringSuspension(tx, target, claimedAt)) !== undefined) {
      return { kind: "STATE_CHANGED" };
    }

    // The commercial state, re-resolved rather than re-asserted as a row version (#40).
    //
    // Every other fact here is bound by a predicate on the row it came from, because a row has to be
    // written to change. An entitlement does not: a trial's last day can end while a reply waits out its
    // delay, and an override can lapse, both without anybody touching a row. A version predicate would
    // bind nothing in either case, and the send would go out on an entitlement that had already expired —
    // which is precisely the final-send invalidation the spec names.
    //
    // Resolved at `claimedAt` and compared with what the decision was made under. Any narrowing is a state
    // change like any other: the coordinator re-reads and re-judges, and the policy engine turns it into a
    // held delivery with a named reason. Widening is a change too, and is reported the same way rather
    // than quietly accepted — the decision this claim is taking was made against different facts, and
    // re-judging costs one read.
    // The key this workspace's commercial state is written under, taken shared before the resolution so
    // that no plan change can commit between the read below and this transaction's commit. The other side
    // is a trigger on both tables, so a support script changing a plan by hand participates too.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${entitlementLockKeyFor(guard.workspaceId)}, 0))`;
    const commercialNow = commercialAccessOf(await readEntitlement(tx as unknown as DbClient, guard.workspaceId, claimedAt));
    if (
      commercialNow.paidWorkAllowed !== guard.commercial.paidWorkAllowed ||
      commercialNow.aiDrafts !== guard.commercial.aiDrafts ||
      commercialNow.autopilot !== guard.commercial.autopilot
    ) {
      return { kind: "STATE_CHANGED" };
    }
    // The staged rollout, re-resolved for the same reason: recording a release moves no row this claim
    // could bind with a predicate, so a rollout pulled back while this reply waited out its delay is
    // invisible unless it is asked again.
    //
    // What is compared is the resolved answer, not the posture behind it. Advancing from
    // `LIMITED_AUTOPILOT` to `COMMERCIAL_BETA` leaves an allowlisted profile at `true` either way and
    // passes undetected — which is accurate rather than a gap, because the question this claim is asking
    // is whether unattended sending is still permitted here, and it is. Either direction of a *change*
    // counts, including a widening, for the reason the commercial comparison above gives.
    //
    // The key the release catalogue is written under, taken shared before the read for the reason the
    // entitlement key is taken: the candidate that would change the answer may not exist yet when this
    // claim starts, so no row lock can cover it. The other side is a trigger on all three release tables,
    // so a release recorded by a script participates too.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${releaseCatalogueLockKey()}, 0))`;
    // The stage from the catalogue under that key; the profile's own enablement off the row this
    // transaction already holds `FOR UPDATE`, rather than read again unlocked.
    // Not `claimedAt`. That instant was captured by the coordinator before this transaction started, and
    // bounding the catalogue by it hid exactly the writer the shared key above was taken for: a
    // restrictive release or verdict committed while this claim waited. Read what is committed now that
    // the key is held, and let the comparison below disagree with the guard.
    const rolloutNow = rolloutAccessFrom(await readReleaseInForceNow(tx), profileRows[0]?.rollout_autopilot ?? false);
    if (rolloutNow.autopilot !== guard.rollout.autopilot) {
      return { kind: "STATE_CHANGED" };
    }

    // One conditional UPDATE, evaluated on a snapshot taken after those locks are held. Every
    // predicate in it is part of the concurrency control: the status decides which worker wins, and
    // the rest decides whether the approval is still the live state.
    /**
     * The conversation facts, re-asserted as the send is taken.
     *
     * Built once and attached through whichever origin this delivery has (ADR-018 Option B): an AI
     * delivery reaches its conversation through the draft, a human-composed one names it directly. Every
     * predicate is identical either way — that is what "one send path" has to mean at this level, and a
     * human-composed send that skipped even one of these would be the second path the contract forbids.
     */
    const conversationStillMatches = {
      stateVersion: guard.conversationStateVersion,
      status: guard.conversationStatus,
      takeoverState: guard.takeoverState,
      takeoverActorKind: guard.takeoverActorKind,
      takeoverActorUserId: guard.takeoverActorUserId,
      aiEnabled: guard.aiEnabled,
      modeOverride: guard.modeOverride,
      // The reply-cycle fact itself, not a proxy for it: a customer message after the anchor means
      // this reply answers a question that has moved on, whatever any version counter says.
      messages: { none: { direction: "IN" as const, aiDraftId: null, occurredAt: { gt: guard.anchorAt } } },
      channelIdentity: {
        channelAccount: {
          status: guard.accountStatus,
          businessProfile: {
            AND: [policyUnchanged(guard.channelAccountId, guard.accountPolicyAt), policyUnchanged(null, guard.defaultPolicyAt)],
          },
        },
      },
    };

    const originStillMatches =
      context.draftId === undefined
        ? {
            /*
             * A person's own wording, unchanged since it was judged. Editing it between the judgement and
             * the claim has to refuse: sending the new wording would send something nobody judged, and
             * sending the old would send something nobody wrote.
             *
             * There is deliberately no "not already sent" predicate here. The draft branch needs one
             * because a message can exist without the draft's status moving; this branch does not,
             * because `status: CLAIMABLE` already excludes SENT and `messages.operation_id` is UNIQUE —
             * one operation can physically produce at most one outbound message. A predicate that
             * duplicated those would look load-bearing and carry nothing, which is worse than absent:
             * mutation testing found it by deleting it and breaking nothing.
             */
            humanText: guard.draftText,
            conversation: conversationStillMatches,
          }
        : {
            draft: {
              text: guard.draftText,
              needsReview: guard.draftNeedsReview,
              // Not merely "was not sent when we read": not sent *now*, checked as the send is taken.
              sentMessage: { is: null },
              conversation: conversationStillMatches,
            },
          };

    const claimed = await tx.deliveryJobRecord.updateMany({
      where: {
        operationId: context.operationId,
        status: CLAIMABLE,
        authority: guard.authority,
        approvedByUserId: guard.approvedByUserId,
        approvedAt: guard.approvedAt,
        approvedReviewMode: guard.approvedReviewMode,
        ...originStillMatches,
      },
      data: { status: "SENDING", claimedAt, attemptCount: { increment: 1 } },
    });
    if (claimed.count === 1) {
      return { kind: "CLAIMED" };
    }

    // Zero rows has two causes worth telling apart, and the row's own status separates them: still
    // claimable means the state moved under this worker, anything else means the delivery is not its
    // to take. Read inside the same transaction, so it describes the same instant as the refusal.
    const current = await tx.deliveryJobRecord.findUnique({ where: { operationId: context.operationId }, select: { status: true } });
    if (current === null) {
      return { kind: "NOT_CLAIMABLE", status: "SENT" };
    }
    return current.status === CLAIMABLE ? { kind: "STATE_CHANGED" } : { kind: "NOT_CLAIMABLE", status: current.status };
    },
    // A claim that cannot get its locks in this time gives up rather than waiting indefinitely. Failing
    // the attempt is safe — nothing has been sent — and the job is retried.
    { timeout: 15_000 },
  );
}

/** A deadlock broken by the server, or a lost write conflict: nothing was established either way. */
function isWriteConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "P2034";
}

/**
 * Quarantines deliveries left in SENDING by a worker that died mid-flight.
 *
 * A claim that outlives its lease proves nothing about whether the platform received the message, so these
 * are never re-run. They become `HELD_AMBIGUOUS` — the same state a reported ambiguity produces — because
 * "we do not know" is the honest answer in both cases and it is the one that keeps a duplicate reply out of
 * the customer's inbox (ADR-012).
 */
export async function recoverStaleSendingDeliveries(db: DbClient, leaseMs: number, now: Date): Promise<readonly string[]> {
  const cutoff = new Date(now.getTime() - leaseMs);
  const stale = await db.deliveryJobRecord.findMany({
    where: { status: "SENDING", claimedAt: { lt: cutoff } },
    select: { operationId: true },
  });
  if (stale.length === 0) {
    return [];
  }
  await db.deliveryJobRecord.updateMany({
    where: { operationId: { in: stale.map((job) => job.operationId) }, status: "SENDING", claimedAt: { lt: cutoff } },
    data: { status: "HELD_AMBIGUOUS", lastErrorCode: "DELIVERY_STALLED", lastErrorMessage: "the worker holding this send did not finish" },
  });
  return stale.map((job) => job.operationId);
}

function statusFieldsFor(settlement: DeliverySettlement, at: Date) {
  switch (settlement.kind) {
    case "SENT":
      return { status: "SENT" as const, sentAt: at, platformMessageId: settlement.platformMessageId, providerRequestId: settlement.providerRequestId ?? null };
    case "CANCELLED":
      return { status: settlement.status, cancelledAt: at, cancelReason: settlement.reasons.join(",") };
    case "HELD":
      return { status: settlement.status, lastErrorCode: settlement.code ?? null, lastErrorMessage: settlement.message };
    case "RETRY":
      // Returned to the claimable state so the queue's next attempt can take it; the attempt count already
      // advanced when this one was claimed.
      return { status: "SCHEDULED" as const, claimedAt: null, lastErrorCode: settlement.code ?? null, lastErrorMessage: settlement.message };
    case "EXHAUSTED":
      return { status: "FAILED_RETRYABLE_EXHAUSTED" as const, lastErrorCode: settlement.code ?? null, lastErrorMessage: settlement.message };
  }
}

/**
 * The conversation's ownership as the policy engine reads it.
 *
 * The actor is carried, not dropped: whether a human-active takeover blocks a send now depends on whether
 * it is the one that authorized it. Everything else is read from the row rather than assumed, so a
 * decision is never made against a takeover reason this file invented.
 */
function takeoverStateOf(conversation: {
  takeoverState: TakeoverState;
  takeoverReason: TakeoverReason | null;
  takeoverReviewMode: ReviewMode | null;
  humanTakeoverAt: Date | null;
  takeoverActorKind: ActorKind | null;
  takeoverActorUserId: string | null;
}): DeliverySendContext["takeover"] {
  const since = conversation.humanTakeoverAt ?? new Date(0);
  if (conversation.takeoverState === "HUMAN_ACTIVE") {
    const actor = actorOf(conversation.takeoverActorKind, conversation.takeoverActorUserId);
    return {
      state: "HUMAN_ACTIVE",
      reason: conversation.takeoverReason ?? "HUMAN_CLAIMED",
      since,
      ...(actor === undefined ? {} : { actor }),
    };
  }
  if (conversation.takeoverState === "REVIEW_REQUIRED") {
    return {
      state: "REVIEW_REQUIRED",
      reason: conversation.takeoverReason ?? "MANDATORY_REVIEW",
      reviewMode: conversation.takeoverReviewMode ?? "NORMAL",
      since,
    };
  }
  return { state: "NONE" };
}

function actorOf(kind: ActorKind | null, userId: string | null): Actor | undefined {
  if (kind === null) {
    return undefined;
  }
  return kind === "USER" ? (userId === null ? undefined : { kind: "USER", userId: toUserId(userId) }) : { kind };
}

/**
 * Who authorized this delivery, as recorded when it was scheduled.
 *
 * Read rather than assumed. The whole reason it is a column is that the send happens in another process,
 * long after the person clicked: an authority reconstructed here would be automation wearing a human's
 * name, or — what actually happened before — a human's approval quietly downgraded to automation.
 *
 * A HUMAN_APPROVED row without its actor, moment or review mode cannot exist: the table's CHECK
 * constraint forbids it. If one somehow did, this falls back to automation, which is the strict reading.
 */
function authorityOf(job: {
  authority: DeliveryAuthorityKind;
  approvedByUserId: string | null;
  approvedAt: Date | null;
  approvedReviewMode: ReviewMode | null;
}): DeliverySendContext["authority"] {
  if (job.authority !== "HUMAN_APPROVED" || job.approvedByUserId === null || job.approvedAt === null || job.approvedReviewMode === null) {
    return { kind: "AUTOMATED" };
  }
  return {
    kind: "HUMAN_APPROVED",
    approvedByUserId: toUserId(job.approvedByUserId),
    approvedAt: job.approvedAt,
    reviewMode: job.approvedReviewMode,
  };
}

async function anchorTime(db: DbClient, scope: { workspaceId: string; businessProfileId: string }, draftId: string): Promise<Date> {
  const draft = await db.aiDraft.findUniqueOrThrow({
    where: { workspaceId_businessProfileId_id: { ...scope, id: draftId } },
    select: { anchorMessage: { select: { occurredAt: true } } },
  });
  return draft.anchorMessage.occurredAt;
}

/** The automation-policy fields a delivery decision reads, and the timestamp its guard binds. */
interface PolicyRow {
  readonly channelAccountId: string | null;
  readonly mode: AiMode;
  readonly updatedAt: Date;
  readonly confidenceThreshold: number;
  readonly mandatoryReviewReasons: readonly string[];
  readonly quietHoursTimeZone: string | null;
  readonly quietHoursStart: string | null;
  readonly quietHoursEnd: string | null;
  readonly instagramAfterWindowPolicy: InstagramAfterWindowPolicy;
  readonly whatsappAfterWindowPolicy: WhatsAppAfterWindowPolicy;
}

/**
 * The limits this delivery must satisfy, from the row the mode itself came from.
 *
 * Built here rather than by the caller because the limits, the mode and the guard all have to describe one
 * read of one row. A caller that fetched them separately could judge a draft against yesterday's threshold
 * while the claim bound today's row, and nothing in the types would say so.
 *
 * No policy row at all means the Business Profile never opted into automation. The mode is then `OFF`, the
 * engine cancels, and these values are never the reason: they exist only so the shape is total.
 */
function limitsFrom(policy: PolicyRow | undefined, channel: ChannelType): PolicyLimits {
  const afterWindow: PolicyLimits["afterWindow"] =
    channel === "INSTAGRAM"
      ? { channel: "INSTAGRAM", policy: policy?.instagramAfterWindowPolicy ?? "STANDARD_ONLY" }
      : { channel: "WHATSAPP", policy: policy?.whatsappAfterWindowPolicy ?? "SERVICE_WINDOW_ONLY" };
  return {
    confidenceThreshold: policy?.confidenceThreshold ?? 1,
    // Narrowed with the domain's own guard: a code the engine does not know is not a gate, and treating an
    // unrecognised string as one would block sends for a reason nobody can act on.
    mandatoryReviewReasons: (policy?.mandatoryReviewReasons ?? []).filter(isReasonCode),
    ...(policy?.quietHoursTimeZone === null ||
    policy?.quietHoursTimeZone === undefined ||
    policy.quietHoursStart === null ||
    policy.quietHoursEnd === null
      ? {}
      : { quietHours: toQuietHours(policy.quietHoursTimeZone, policy.quietHoursStart, policy.quietHoursEnd) }),
    afterWindow,
  };
}

/** The two rows a conversation's automation can come from: its own account's, and the profile default. */
async function automationPolicies(
  db: DbClient,
  scope: { workspaceId: string; businessProfileId: string },
  channelAccountId: string,
): Promise<{ readonly account?: PolicyRow; readonly default?: PolicyRow }> {
  const rows = await db.automationPolicy.findMany({
    where: { ...scope, OR: [{ channelAccountId }, { channelAccountId: null }] },
    select: {
      channelAccountId: true,
      mode: true,
      updatedAt: true,
      confidenceThreshold: true,
      mandatoryReviewReasons: true,
      quietHoursTimeZone: true,
      quietHoursStart: true,
      quietHoursEnd: true,
      instagramAfterWindowPolicy: true,
      whatsappAfterWindowPolicy: true,
    },
  });
  return {
    account: rows.find((row) => row.channelAccountId === channelAccountId),
    default: rows.find((row) => row.channelAccountId === null),
  };
}

/**
 * "The policy row this send was judged against has not been written since."
 *
 * Absence is asserted as carefully as presence: a profile that had no override when the decision was made
 * and has one now is a changed decision, and `none` is what says so.
 */
function policyUnchanged(channelAccountId: string | null, updatedAt: Date | null) {
  return updatedAt === null
    ? { automationPolicies: { none: { channelAccountId } } }
    : { automationPolicies: { some: { channelAccountId, updatedAt } } };
}

export interface AutomatedDeliveryInput {
  readonly workspaceId: string;
  readonly businessProfileId: string;
  readonly draftId: string;
  readonly correlationId: string;
  readonly delayMs: number;
  readonly now: Date;
}

/**
 * Creates the durable delivery row for a draft automation approved (#16).
 *
 * The chosen delay and the intended send time are persisted *before* anything is enqueued, so a queue that
 * loses the job still leaves a record of what was supposed to happen and when. The unique index on
 * `(workspace, profile, draft)` is what makes a repeated call return the existing operation instead of
 * creating a second logical send.
 */
export async function scheduleAutomatedDelivery(db: DbClient, input: AutomatedDeliveryInput): Promise<{ readonly operationId: string; readonly scheduledFor: Date }> {
  const scope = { workspaceId: input.workspaceId, businessProfileId: input.businessProfileId };
  const existing = await db.deliveryJobRecord.findUnique({
    where: { workspaceId_businessProfileId_draftId: { ...scope, draftId: input.draftId } },
    select: { operationId: true, scheduledFor: true },
  });
  if (existing !== null) {
    return existing;
  }
  const scheduledFor = new Date(input.now.getTime() + input.delayMs);
  const operationId = randomUUID();
  await db.$transaction(async (tx) => {
    await tx.deliveryJobRecord.create({
      data: { ...scope, draftId: input.draftId, operationId, correlationId: input.correlationId, status: "SCHEDULED", scheduledFor, selectedDelayMs: input.delayMs },
    });
    await tx.aiDraft.update({ where: { workspaceId_businessProfileId_id: { ...scope, id: input.draftId } }, data: { status: "SCHEDULED" } });
  });
  return { operationId, scheduledFor };
}

/** Marks a conversation as waiting for a human decision, without claiming a person has acted. */
export async function requestHumanReview(
  db: DbClient,
  input: { readonly workspaceId: string; readonly businessProfileId: string; readonly conversationId: string; readonly reviewMode: "NORMAL" | "HUMAN_AGENT"; readonly at: Date },
): Promise<void> {
  const scope = { workspaceId: input.workspaceId, businessProfileId: input.businessProfileId };
  await db.conversation.updateMany({
    // Only from NONE: a person already holding the conversation is not demoted by an escalation from
    // automation, which is the state machine's rule expressed as a predicate.
    where: { ...scope, id: input.conversationId, takeoverState: "NONE" },
    data: {
      takeoverState: "REVIEW_REQUIRED",
      takeoverReason: input.reviewMode === "HUMAN_AGENT" ? "HUMAN_AGENT_REVIEW" : "MANDATORY_REVIEW",
      takeoverReviewMode: input.reviewMode,
      humanTakeoverAt: input.at,
    },
  });
}

/**
 * Whether a human-composed delivery already produced its outbound message.
 *
 * An AI delivery answers this through its draft's `sentMessage`; a human-composed one has no draft, so
 * the operation id is the durable record. Same question, same guarantee — ADR-012's rule that a send
 * whose outcome is known must never be repeated does not depend on which origin wrote the words.
 */
async function humanSendAlreadyRecorded(db: DbExecutor, operationId: string): Promise<boolean> {
  return (await db.message.findFirst({ where: { operationId }, select: { id: true } })) !== null;
}
