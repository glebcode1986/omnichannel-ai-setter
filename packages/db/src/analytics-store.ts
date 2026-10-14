/**
 * Operational metrics (LEADS_ANALYTICS_UX.md, Issue #34).
 *
 * The definitions live in `docs/specs/ANALYTICS_DEFINITIONS.md` and the SQL here is the only
 * implementation of them. A metric with two implementations has two values, and the day somebody notices
 * is the day they stop trusting the whole page.
 *
 * Three things this file is careful about.
 *
 * **Application state and provider state are never added together.** What we decided — scheduled, held for
 * review, cancelled, handed to the provider — is ours. What happened to the message — delivered, read,
 * failed at the provider — is theirs, and only they can say. `deliveryOutcomes` returns the two as separate
 * groups for exactly that reason: a send we accepted is not a message that arrived, and a dashboard that
 * blurred them would let somebody tell a customer "it was delivered" on our word alone.
 *
 * **A day needs a timezone, and the caller says which.** Every bucketed metric takes an IANA zone and
 * there is no default. A silent UTC would put a 9pm conversation in Madrid on the wrong day and nothing on
 * screen would explain the discrepancy. The workspace's quiet-hours zone is deliberately *not* reused: it
 * says when we may message customers, which is a different question that happens to have the same shape.
 *
 * **Scope comes from the context.** Metrics take a `WorkspaceContext` and are filtered to the Business
 * Profiles that context may see, which for a SELECTED scope is narrower than the workspace.
 */
import type { ReasonCode } from "@omnichannel/domain";

import type { DbExecutor } from "./client";
import { authorizedBusinessProfileFilter, scopeOf, type WorkspaceContext } from "./tenancy";

/**
 * What every metric is measured over.
 *
 * `from` is inclusive and `to` is exclusive, which is the only pair of conventions that lets adjacent
 * ranges tile without double-counting the boundary. `timeZone` is required; see the file comment.
 */
export interface MetricWindow {
  readonly from: Date;
  readonly to: Date;
  /** An IANA zone name, e.g. `Europe/Madrid`. Required: a day is not a fact without one. */
  readonly timeZone: string;
}

/** The dimensions the spec asks to filter by. Every one is optional and means "all" when absent. */
export interface MetricFilter {
  readonly businessProfileId?: string;
  readonly channelAccountId?: string;
  /** The mode in force on the conversation, as an override; absent means any. */
  readonly mode?: "OFF" | "DRAFT" | "AUTOPILOT";
  readonly leadStage?: string;
  readonly assignedUserId?: string;
}

interface Bound {
  readonly workspaceId: string;
  readonly profileIds: readonly string[] | null;
  readonly filter: MetricFilter;
  readonly window: MetricWindow;
}

/**
 * Resolves the authorized scope once, so every query below is filtered the same way.
 *
 * `profileIds === null` means "every profile in the workspace" — an ALL scope. An empty array would mean
 * the opposite and is never produced: a SELECTED scope with no profiles cannot be issued.
 */
function bind(context: WorkspaceContext, window: MetricWindow, filter: MetricFilter): Bound {
  const workspaceId = scopeOf(context);
  if (window.timeZone.trim() === "") {
    throw new Error("a metric window needs an explicit IANA time zone");
  }
  if (window.to <= window.from) {
    throw new Error("a metric window ends after it starts");
  }
  // Branded ids compared as strings: the filter arrives from a query string, and widening the brand to
  // accept it would let an unchecked id reach every other function that trusts the brand.
  const allowed: readonly string[] | null = authorizedBusinessProfileFilter(context).businessProfileId?.in ?? null;
  // A requested profile is intersected with what the context may see, never trusted on its own.
  const profileIds =
    filter.businessProfileId === undefined
      ? allowed
      : allowed === null || allowed.includes(filter.businessProfileId)
        ? [filter.businessProfileId]
        : [];
  return { workspaceId, profileIds, filter, window };
}

/** True when the bound scope can match nothing, so a query would be a round trip for a known answer. */
function empty(bound: Bound): boolean {
  return bound.profileIds !== null && bound.profileIds.length === 0;
}

export interface VolumePoint {
  /** The local calendar day in the requested zone, as `YYYY-MM-DD`. */
  readonly day: string;
  readonly inboundMessages: number;
  readonly inboundConversations: number;
}

/**
 * Inbound volume per local day.
 *
 * Counts messages and the conversations they arrived in separately, because ten messages from one person
 * and one message from ten people are the same number and not the same day.
 *
 * The local day is computed with **two** conversions. The column is `timestamp without time zone` holding
 * UTC, so a single `AT TIME ZONE 'Europe/Madrid'` would *interpret* the stored value as Madrid local time
 * and convert it away from UTC — the opposite of what is wanted, and wrong by exactly the offset. It has
 * to be attached to UTC first and then converted, which is what actually answers "which local day was
 * this". The test that a 22:30 UTC message lands on the next Madrid day is what caught it.
 */
export async function inboundVolume(
  db: DbExecutor,
  context: WorkspaceContext,
  window: MetricWindow,
  filter: MetricFilter = {},
): Promise<readonly VolumePoint[]> {
  const bound = bind(context, window, filter);
  if (empty(bound)) {
    return [];
  }
  const rows = await db.$queryRaw<{ day: string; messages: bigint; conversations: bigint }[]>`
    SELECT to_char(date_trunc('day', (m."occurred_at" AT TIME ZONE 'UTC') AT TIME ZONE ${window.timeZone}), 'YYYY-MM-DD') AS day,
           COUNT(*) AS messages,
           COUNT(DISTINCT m."conversation_id") AS conversations
      FROM "messages" m
      JOIN "conversations" c
        ON c."workspace_id" = m."workspace_id" AND c."business_profile_id" = m."business_profile_id" AND c."id" = m."conversation_id"
     WHERE m."workspace_id" = ${bound.workspaceId}
       AND m."direction" = 'IN'
       AND m."occurred_at" >= ${window.from} AND m."occurred_at" < ${window.to}
       AND (${bound.profileIds}::text[] IS NULL OR m."business_profile_id" = ANY(${bound.profileIds}::text[]))
       AND (${filter.channelAccountId ?? null}::text IS NULL OR m."channel_account_id" = ${filter.channelAccountId ?? null})
       AND (${filter.mode ?? null}::text IS NULL OR c."mode_override"::text = ${filter.mode ?? null})
       AND (${filter.leadStage ?? null}::text IS NULL OR c."lead_stage"::text = ${filter.leadStage ?? null})
       AND (${filter.assignedUserId ?? null}::text IS NULL OR c."assigned_user_id" = ${filter.assignedUserId ?? null})
     GROUP BY 1
     ORDER BY 1`;
  return rows.map((row) => ({ day: row.day, inboundMessages: Number(row.messages), inboundConversations: Number(row.conversations) }));
}

export interface ResponseTimes {
  /** How many first responses the percentiles are computed from. Zero means the rest is `null`, not zero. */
  readonly samples: number;
  readonly medianSeconds: number | null;
  readonly p90Seconds: number | null;
}

/**
 * First-response time.
 *
 * Measured from the first inbound message of a reply cycle to the next outbound message in the same
 * conversation. "First of a cycle" means an inbound with no earlier unanswered inbound: a customer who
 * sends three messages in a row is waiting once, not three times, and counting each would flatter the
 * median every time somebody types the way people actually type.
 *
 * An inbound still waiting at the end of the window contributes nothing rather than a partial duration.
 * Its wait is not over, and treating "not yet answered" as a fast reply is the one direction this metric
 * must never be wrong in.
 */
export async function firstResponseTimes(
  db: DbExecutor,
  context: WorkspaceContext,
  window: MetricWindow,
  filter: MetricFilter = {},
): Promise<ResponseTimes> {
  const bound = bind(context, window, filter);
  if (empty(bound)) {
    return { samples: 0, medianSeconds: null, p90Seconds: null };
  }
  const rows = await db.$queryRaw<{ samples: bigint; median: number | null; p90: number | null }[]>`
    WITH scoped AS (
      SELECT m."conversation_id", m."direction", m."occurred_at"
        FROM "messages" m
        JOIN "conversations" c
          ON c."workspace_id" = m."workspace_id" AND c."business_profile_id" = m."business_profile_id" AND c."id" = m."conversation_id"
       WHERE m."workspace_id" = ${bound.workspaceId}
         AND (${bound.profileIds}::text[] IS NULL OR m."business_profile_id" = ANY(${bound.profileIds}::text[]))
         AND (${filter.channelAccountId ?? null}::text IS NULL OR m."channel_account_id" = ${filter.channelAccountId ?? null})
         AND (${filter.mode ?? null}::text IS NULL OR c."mode_override"::text = ${filter.mode ?? null})
         AND (${filter.leadStage ?? null}::text IS NULL OR c."lead_stage"::text = ${filter.leadStage ?? null})
         AND (${filter.assignedUserId ?? null}::text IS NULL OR c."assigned_user_id" = ${filter.assignedUserId ?? null})
    ),
    marked AS (
      SELECT "conversation_id", "direction", "occurred_at",
             LAG("direction") OVER (PARTITION BY "conversation_id" ORDER BY "occurred_at", "direction") AS previous
        FROM scoped
    ),
    -- The first inbound of each cycle: the conversation's very first message, or one that follows an
    -- outbound. A second consecutive inbound is the same wait continuing.
    cycle_starts AS (
      SELECT "conversation_id", "occurred_at"
        FROM marked
       WHERE "direction" = 'IN' AND (previous IS NULL OR previous = 'OUT')
         AND "occurred_at" >= ${window.from} AND "occurred_at" < ${window.to}
    ),
    answered AS (
      SELECT s."occurred_at" AS asked,
             (SELECT MIN(o."occurred_at") FROM scoped o
               WHERE o."conversation_id" = s."conversation_id" AND o."direction" = 'OUT' AND o."occurred_at" > s."occurred_at") AS answered_at
        FROM cycle_starts s
    )
    SELECT COUNT(*) AS samples,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (answered_at - asked))) AS median,
           percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (answered_at - asked))) AS p90
      FROM answered
     WHERE answered_at IS NOT NULL`;
  const row = rows[0];
  const samples = Number(row?.samples ?? 0);
  // Zero samples is not a zero response time. Saying "0s median" for a day nobody wrote in would be the
  // best-looking number on the page and a complete fiction.
  return samples === 0
    ? { samples: 0, medianSeconds: null, p90Seconds: null }
    : { samples, medianSeconds: round(row?.median), p90Seconds: round(row?.p90) };
}

function round(value: number | null | undefined): number | null {
  return value === null || value === undefined ? null : Math.round(value * 10) / 10;
}

export interface DraftOutcomes {
  readonly generated: number;
  /** Sent without anybody approving it: `AUTOMATED` authority on the delivery. */
  readonly autoSent: number;
  /** Sent because a person approved or composed it. */
  readonly humanApprovedSent: number;
  readonly awaitingReview: number;
  readonly heldAmbiguous: number;
  readonly dismissed: number;
  readonly superseded: number;
  readonly failed: number;
}

/**
 * What became of the drafts the model generated.
 *
 * Counted by the draft's own status and its delivery's authority, not by the message that resulted: a
 * draft that was approved and then failed at the provider was still reviewed by a person, and folding it
 * into "failed" would make the review work invisible.
 */
export async function draftOutcomes(
  db: DbExecutor,
  context: WorkspaceContext,
  window: MetricWindow,
  filter: MetricFilter = {},
): Promise<DraftOutcomes> {
  const bound = bind(context, window, filter);
  if (empty(bound)) {
    return { generated: 0, autoSent: 0, humanApprovedSent: 0, awaitingReview: 0, heldAmbiguous: 0, dismissed: 0, superseded: 0, failed: 0 };
  }
  const rows = await db.$queryRaw<
    {
      generated: bigint;
      auto_sent: bigint;
      human_sent: bigint;
      awaiting: bigint;
      ambiguous: bigint;
      dismissed: bigint;
      superseded: bigint;
      failed: bigint;
    }[]
  >`
    SELECT COUNT(*) AS generated,
           COUNT(*) FILTER (WHERE d."status" = 'SENT' AND j."authority" = 'AUTOMATED') AS auto_sent,
           COUNT(*) FILTER (WHERE d."status" = 'SENT' AND j."authority" = 'HUMAN_APPROVED') AS human_sent,
           COUNT(*) FILTER (WHERE d."status" IN ('PENDING', 'HELD') AND d."needs_review") AS awaiting,
           COUNT(*) FILTER (WHERE d."status" = 'HELD_AMBIGUOUS') AS ambiguous,
           COUNT(*) FILTER (WHERE d."status" = 'DISMISSED') AS dismissed,
           COUNT(*) FILTER (WHERE d."status" = 'CANCELLED_SUPERSEDED') AS superseded,
           COUNT(*) FILTER (WHERE d."status" = 'FAILED') AS failed
      FROM "ai_drafts" d
      JOIN "conversations" c
        ON c."workspace_id" = d."workspace_id" AND c."business_profile_id" = d."business_profile_id" AND c."id" = d."conversation_id"
      LEFT JOIN "delivery_jobs" j
        ON j."workspace_id" = d."workspace_id" AND j."business_profile_id" = d."business_profile_id" AND j."draft_id" = d."id"
     WHERE d."workspace_id" = ${bound.workspaceId}
       AND d."created_at" >= ${window.from} AND d."created_at" < ${window.to}
       AND (${bound.profileIds}::text[] IS NULL OR d."business_profile_id" = ANY(${bound.profileIds}::text[]))
       AND (${filter.channelAccountId ?? null}::text IS NULL OR c."channel_account_id" = ${filter.channelAccountId ?? null})
       AND (${filter.mode ?? null}::text IS NULL OR c."mode_override"::text = ${filter.mode ?? null})
       AND (${filter.leadStage ?? null}::text IS NULL OR c."lead_stage"::text = ${filter.leadStage ?? null})
       AND (${filter.assignedUserId ?? null}::text IS NULL OR c."assigned_user_id" = ${filter.assignedUserId ?? null})`;
  const row = rows[0];
  return {
    generated: Number(row?.generated ?? 0),
    autoSent: Number(row?.auto_sent ?? 0),
    humanApprovedSent: Number(row?.human_sent ?? 0),
    awaitingReview: Number(row?.awaiting ?? 0),
    heldAmbiguous: Number(row?.ambiguous ?? 0),
    dismissed: Number(row?.dismissed ?? 0),
    superseded: Number(row?.superseded ?? 0),
    failed: Number(row?.failed ?? 0),
  };
}

export interface ReasonCount {
  readonly reason: string;
  readonly drafts: number;
}

/**
 * Why drafts waited, by reason code.
 *
 * A draft can carry several reasons and is counted under each: the question this answers is "what is
 * holding replies up", and attributing a draft to one of its three reasons would understate the other two.
 * The totals therefore do not sum to the draft count, which is stated in the definitions rather than
 * papered over.
 */
export async function reviewReasons(
  db: DbExecutor,
  context: WorkspaceContext,
  window: MetricWindow,
  filter: MetricFilter = {},
): Promise<readonly ReasonCount[]> {
  const bound = bind(context, window, filter);
  if (empty(bound)) {
    return [];
  }
  const rows = await db.$queryRaw<{ reason: string; drafts: bigint }[]>`
    SELECT reason, COUNT(DISTINCT d."id") AS drafts
      FROM "ai_drafts" d
      JOIN "conversations" c
        ON c."workspace_id" = d."workspace_id" AND c."business_profile_id" = d."business_profile_id" AND c."id" = d."conversation_id"
      CROSS JOIN LATERAL unnest(d."reason_codes") AS reason
     WHERE d."workspace_id" = ${bound.workspaceId}
       AND d."created_at" >= ${window.from} AND d."created_at" < ${window.to}
       AND (${bound.profileIds}::text[] IS NULL OR d."business_profile_id" = ANY(${bound.profileIds}::text[]))
       AND (${filter.channelAccountId ?? null}::text IS NULL OR c."channel_account_id" = ${filter.channelAccountId ?? null})
       AND (${filter.mode ?? null}::text IS NULL OR c."mode_override"::text = ${filter.mode ?? null})
       AND (${filter.leadStage ?? null}::text IS NULL OR c."lead_stage"::text = ${filter.leadStage ?? null})
       AND (${filter.assignedUserId ?? null}::text IS NULL OR c."assigned_user_id" = ${filter.assignedUserId ?? null})
     GROUP BY 1
     ORDER BY 2 DESC, 1 ASC`;
  return rows.map((row) => ({ reason: row.reason, drafts: Number(row.drafts) }));
}

/** How often a reason was `MISSING_FACT`, which is the knowledge gap the spec asks to surface. */
export async function missingFactFrequency(
  db: DbExecutor,
  context: WorkspaceContext,
  window: MetricWindow,
  filter: MetricFilter = {},
): Promise<{ readonly drafts: number; readonly share: number | null }> {
  const [reasons, drafts] = await Promise.all([
    reviewReasons(db, context, window, filter),
    draftOutcomes(db, context, window, filter),
  ]);
  const missing = reasons.find((row) => row.reason === ("MISSING_FACT" satisfies ReasonCode))?.drafts ?? 0;
  // `null` rather than 0 when nothing was generated: a share of no drafts is not zero percent, it is
  // undefined, and a 0% on screen reads as "knowledge is complete".
  return { drafts: missing, share: drafts.generated === 0 ? null : Math.round((missing / drafts.generated) * 1000) / 1000 };
}

export interface TakeoverRate {
  readonly conversationsWithInbound: number;
  readonly takenOver: number;
  readonly rate: number | null;
}

/**
 * How often a person took a conversation over.
 *
 * The denominator is conversations that received an inbound message in the window, not all conversations:
 * a takeover rate measured against threads nobody wrote in would fall every quiet week and look like an
 * improvement.
 */
export async function takeoverRate(
  db: DbExecutor,
  context: WorkspaceContext,
  window: MetricWindow,
  filter: MetricFilter = {},
): Promise<TakeoverRate> {
  const bound = bind(context, window, filter);
  if (empty(bound)) {
    return { conversationsWithInbound: 0, takenOver: 0, rate: null };
  }
  const rows = await db.$queryRaw<{ active: bigint; taken: bigint }[]>`
    WITH active AS (
      SELECT DISTINCT c."id", c."human_takeover_at"
        FROM "conversations" c
        JOIN "messages" m
          ON m."workspace_id" = c."workspace_id" AND m."business_profile_id" = c."business_profile_id" AND m."conversation_id" = c."id"
       WHERE c."workspace_id" = ${bound.workspaceId}
         AND m."direction" = 'IN'
         AND m."occurred_at" >= ${window.from} AND m."occurred_at" < ${window.to}
         AND (${bound.profileIds}::text[] IS NULL OR c."business_profile_id" = ANY(${bound.profileIds}::text[]))
         AND (${filter.channelAccountId ?? null}::text IS NULL OR c."channel_account_id" = ${filter.channelAccountId ?? null})
         AND (${filter.mode ?? null}::text IS NULL OR c."mode_override"::text = ${filter.mode ?? null})
         AND (${filter.leadStage ?? null}::text IS NULL OR c."lead_stage"::text = ${filter.leadStage ?? null})
         AND (${filter.assignedUserId ?? null}::text IS NULL OR c."assigned_user_id" = ${filter.assignedUserId ?? null})
    )
    SELECT COUNT(*) AS active,
           COUNT(*) FILTER (WHERE "human_takeover_at" >= ${window.from} AND "human_takeover_at" < ${window.to}) AS taken
      FROM active`;
  const row = rows[0];
  const active = Number(row?.active ?? 0);
  const taken = Number(row?.taken ?? 0);
  return { conversationsWithInbound: active, takenOver: taken, rate: active === 0 ? null : Math.round((taken / active) * 1000) / 1000 };
}

export interface DeliveryOutcomes {
  /**
   * What we decided. Ours to state.
   */
  readonly application: {
    readonly scheduled: number;
    readonly heldForReview: number;
    readonly heldAmbiguous: number;
    readonly handedToProvider: number;
    readonly cancelled: number;
    readonly failedAfterRetries: number;
  };
  /**
   * What the provider reported. Theirs to state, and absent until they do.
   */
  readonly provider: {
    readonly awaitingReport: number;
    readonly reportedSent: number;
    readonly reportedDelivered: number;
    readonly reportedRead: number;
    readonly reportedFailed: number;
  };
  /** Sends whose outcome we could not determine and had to reconcile (ADR-012). */
  readonly ambiguous: { readonly open: number; readonly resolved: number };
}

/**
 * The two state machines, side by side and never summed.
 *
 * This is the shape the hard invariant demands. `handedToProvider` says we gave the message to Meta;
 * `reportedDelivered` says Meta said it arrived. They are different claims with different evidence, and
 * only one of them may ever be shown to a customer as "delivered".
 *
 * `awaitingReport` is the honest name for outbound messages the provider has not spoken about yet. The
 * tempting alternative — counting them as delivered because we sent them successfully — is precisely the
 * inference this metric exists to prevent.
 */
export async function deliveryOutcomes(
  db: DbExecutor,
  context: WorkspaceContext,
  window: MetricWindow,
  filter: MetricFilter = {},
): Promise<DeliveryOutcomes> {
  const bound = bind(context, window, filter);
  if (empty(bound)) {
    return {
      application: { scheduled: 0, heldForReview: 0, heldAmbiguous: 0, handedToProvider: 0, cancelled: 0, failedAfterRetries: 0 },
      provider: { awaitingReport: 0, reportedSent: 0, reportedDelivered: 0, reportedRead: 0, reportedFailed: 0 },
      ambiguous: { open: 0, resolved: 0 },
    };
  }

  const [jobs, messages, reconciliations] = await Promise.all([
    db.$queryRaw<
      { scheduled: bigint; held_review: bigint; held_ambiguous: bigint; sent: bigint; cancelled: bigint; failed: bigint }[]
    >`
      SELECT COUNT(*) FILTER (WHERE j."status" = 'SCHEDULED') AS scheduled,
             COUNT(*) FILTER (WHERE j."status" = 'HELD_REVIEW') AS held_review,
             COUNT(*) FILTER (WHERE j."status" = 'HELD_AMBIGUOUS') AS held_ambiguous,
             COUNT(*) FILTER (WHERE j."status" = 'SENT') AS sent,
             COUNT(*) FILTER (WHERE j."status" IN ('CANCELLED_SUPERSEDED', 'CANCELLED_HUMAN_TAKEOVER', 'CANCELLED_POLICY')) AS cancelled,
             COUNT(*) FILTER (WHERE j."status" = 'FAILED_RETRYABLE_EXHAUSTED') AS failed
        FROM "delivery_jobs" j
       WHERE j."workspace_id" = ${bound.workspaceId}
         AND j."created_at" >= ${window.from} AND j."created_at" < ${window.to}
         AND (${bound.profileIds}::text[] IS NULL OR j."business_profile_id" = ANY(${bound.profileIds}::text[]))`,
    db.$queryRaw<{ awaiting: bigint; sent: bigint; delivered: bigint; read: bigint; failed: bigint }[]>`
      SELECT COUNT(*) FILTER (WHERE m."delivery_status" IS NULL OR m."delivery_status" = 'PENDING') AS awaiting,
             COUNT(*) FILTER (WHERE m."delivery_status" = 'SENT') AS sent,
             COUNT(*) FILTER (WHERE m."delivery_status" = 'DELIVERED') AS delivered,
             COUNT(*) FILTER (WHERE m."delivery_status" = 'READ') AS read,
             COUNT(*) FILTER (WHERE m."delivery_status" = 'FAILED') AS failed
        FROM "messages" m
        JOIN "conversations" c
          ON c."workspace_id" = m."workspace_id" AND c."business_profile_id" = m."business_profile_id" AND c."id" = m."conversation_id"
       WHERE m."workspace_id" = ${bound.workspaceId}
         AND m."direction" = 'OUT'
         AND m."occurred_at" >= ${window.from} AND m."occurred_at" < ${window.to}
         AND (${bound.profileIds}::text[] IS NULL OR m."business_profile_id" = ANY(${bound.profileIds}::text[]))
         AND (${filter.channelAccountId ?? null}::text IS NULL OR m."channel_account_id" = ${filter.channelAccountId ?? null})
         AND (${filter.mode ?? null}::text IS NULL OR c."mode_override"::text = ${filter.mode ?? null})
         AND (${filter.leadStage ?? null}::text IS NULL OR c."lead_stage"::text = ${filter.leadStage ?? null})
         AND (${filter.assignedUserId ?? null}::text IS NULL OR c."assigned_user_id" = ${filter.assignedUserId ?? null})`,
    db.$queryRaw<{ open: bigint; resolved: bigint }[]>`
      SELECT COUNT(*) FILTER (WHERE r."resolved_at" IS NULL) AS open,
             COUNT(*) FILTER (WHERE r."resolved_at" IS NOT NULL) AS resolved
        FROM "delivery_reconciliations" r
       WHERE r."workspace_id" = ${bound.workspaceId}
         AND r."created_at" >= ${window.from} AND r."created_at" < ${window.to}
         AND (${bound.profileIds}::text[] IS NULL OR r."business_profile_id" = ANY(${bound.profileIds}::text[]))`,
  ]);

  const job = jobs[0];
  const message = messages[0];
  const reconciliation = reconciliations[0];
  return {
    application: {
      scheduled: Number(job?.scheduled ?? 0),
      heldForReview: Number(job?.held_review ?? 0),
      heldAmbiguous: Number(job?.held_ambiguous ?? 0),
      handedToProvider: Number(job?.sent ?? 0),
      cancelled: Number(job?.cancelled ?? 0),
      failedAfterRetries: Number(job?.failed ?? 0),
    },
    provider: {
      awaitingReport: Number(message?.awaiting ?? 0),
      reportedSent: Number(message?.sent ?? 0),
      reportedDelivered: Number(message?.delivered ?? 0),
      reportedRead: Number(message?.read ?? 0),
      reportedFailed: Number(message?.failed ?? 0),
    },
    ambiguous: { open: Number(reconciliation?.open ?? 0), resolved: Number(reconciliation?.resolved ?? 0) },
  };
}

export interface StageMovement {
  readonly toStage: string;
  readonly transitions: number;
  readonly conversations: number;
}

export interface LeadMetrics {
  readonly movements: readonly StageMovement[];
  readonly qualified: number;
  readonly engaged: number;
  readonly qualificationRate: number | null;
}

/**
 * Lead movement, and the qualification rate.
 *
 * Counted from the transitions rather than from the conversation's current stage, because a lead that
 * reached QUALIFIED and then went to LOST was still qualified in the window. Reading only the current
 * stage would erase that and make a bad month look like an empty one.
 */
export async function leadMovement(
  db: DbExecutor,
  context: WorkspaceContext,
  window: MetricWindow,
  filter: MetricFilter = {},
): Promise<LeadMetrics> {
  const bound = bind(context, window, filter);
  if (empty(bound)) {
    return { movements: [], qualified: 0, engaged: 0, qualificationRate: null };
  }
  const rows = await db.$queryRaw<{ to_stage: string; transitions: bigint; conversations: bigint }[]>`
    SELECT t."to_stage"::text AS to_stage, COUNT(*) AS transitions, COUNT(DISTINCT t."conversation_id") AS conversations
      FROM "lead_stage_transitions" t
      JOIN "conversations" c
        ON c."workspace_id" = t."workspace_id" AND c."business_profile_id" = t."business_profile_id" AND c."id" = t."conversation_id"
     WHERE t."workspace_id" = ${bound.workspaceId}
       AND t."changed_at" >= ${window.from} AND t."changed_at" < ${window.to}
       AND (${bound.profileIds}::text[] IS NULL OR t."business_profile_id" = ANY(${bound.profileIds}::text[]))
       AND (${filter.channelAccountId ?? null}::text IS NULL OR c."channel_account_id" = ${filter.channelAccountId ?? null})
       AND (${filter.mode ?? null}::text IS NULL OR c."mode_override"::text = ${filter.mode ?? null})
       AND (${filter.assignedUserId ?? null}::text IS NULL OR c."assigned_user_id" = ${filter.assignedUserId ?? null})
     GROUP BY 1
     ORDER BY 1`;

  const movements = rows.map((row) => ({
    toStage: row.to_stage,
    transitions: Number(row.transitions),
    conversations: Number(row.conversations),
  }));
  const reached = (stage: string) => movements.find((row) => row.toStage === stage)?.conversations ?? 0;
  const qualified = reached("QUALIFIED");
  const engaged = reached("ENGAGED");
  // Of the leads that got as far as a conversation worth having, how many qualified. `null` when nothing
  // engaged, because a rate over nothing is undefined rather than zero.
  return { movements, qualified, engaged, qualificationRate: engaged === 0 ? null : Math.round((qualified / engaged) * 1000) / 1000 };
}

export interface ModelUsage {
  readonly provider: string;
  readonly model: string;
  readonly generations: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  /** Null when no generation in this group reported a latency. */
  readonly medianLatencyMs: number | null;
}

/**
 * AI usage, per provider and model.
 *
 * Tokens and latency only. **Cost is deliberately not computed here**: prices change, differ per contract
 * and are not in this database, so a currency figure would be a guess rendered to two decimal places —
 * the most convincing possible way to be wrong. The spec says "usage/cost telemetry *when available*", and
 * what is available is usage.
 */
export async function modelUsage(
  db: DbExecutor,
  context: WorkspaceContext,
  window: MetricWindow,
  filter: MetricFilter = {},
): Promise<readonly ModelUsage[]> {
  const bound = bind(context, window, filter);
  if (empty(bound)) {
    return [];
  }
  const rows = await db.$queryRaw<
    {
      provider: string;
      model: string;
      generations: bigint;
      input_tokens: bigint | null;
      output_tokens: bigint | null;
      cache_read: bigint | null;
      cache_write: bigint | null;
      median_latency: number | null;
    }[]
  >`
    SELECT d."model_provider" AS provider, d."model_name" AS model, COUNT(*) AS generations,
           SUM(d."input_tokens") AS input_tokens, SUM(d."output_tokens") AS output_tokens,
           SUM(d."cache_read_tokens") AS cache_read, SUM(d."cache_write_tokens") AS cache_write,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY d."latency_ms") AS median_latency
      FROM "ai_drafts" d
     WHERE d."workspace_id" = ${bound.workspaceId}
       AND d."created_at" >= ${window.from} AND d."created_at" < ${window.to}
       AND (${bound.profileIds}::text[] IS NULL OR d."business_profile_id" = ANY(${bound.profileIds}::text[]))
     GROUP BY 1, 2
     ORDER BY 3 DESC, 1, 2`;
  return rows.map((row) => ({
    provider: row.provider,
    model: row.model,
    generations: Number(row.generations),
    inputTokens: Number(row.input_tokens ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),
    cacheReadTokens: Number(row.cache_read ?? 0),
    cacheWriteTokens: Number(row.cache_write ?? 0),
    medianLatencyMs: row.median_latency === null ? null : Math.round(row.median_latency),
  }));
}

export interface OperationalSnapshot {
  readonly window: MetricWindow;
  readonly volume: readonly VolumePoint[];
  readonly responseTimes: ResponseTimes;
  readonly drafts: DraftOutcomes;
  readonly reviewReasons: readonly ReasonCount[];
  readonly missingFacts: { readonly drafts: number; readonly share: number | null };
  readonly takeover: TakeoverRate;
  readonly delivery: DeliveryOutcomes;
  readonly leads: LeadMetrics;
  readonly usage: readonly ModelUsage[];
}

/** Everything the analytics page shows, for one window and one set of filters. */
export async function readOperationalSnapshot(
  db: DbExecutor,
  context: WorkspaceContext,
  window: MetricWindow,
  filter: MetricFilter = {},
): Promise<OperationalSnapshot> {
  const [volume, responseTimes, drafts, reasons, takeover, delivery, leads, usage] = await Promise.all([
    inboundVolume(db, context, window, filter),
    firstResponseTimes(db, context, window, filter),
    draftOutcomes(db, context, window, filter),
    reviewReasons(db, context, window, filter),
    takeoverRate(db, context, window, filter),
    deliveryOutcomes(db, context, window, filter),
    leadMovement(db, context, window, filter),
    modelUsage(db, context, window, filter),
  ]);
  const missing = reasons.find((row) => row.reason === ("MISSING_FACT" satisfies ReasonCode))?.drafts ?? 0;
  return {
    window,
    volume,
    responseTimes,
    drafts,
    reviewReasons: reasons,
    // Computed from the two results already in hand rather than by asking again, so the page cannot show
    // a share that disagrees with the reason table beside it.
    missingFacts: { drafts: missing, share: drafts.generated === 0 ? null : Math.round((missing / drafts.generated) * 1000) / 1000 },
    takeover,
    delivery,
    leads,
    usage,
  };
}
