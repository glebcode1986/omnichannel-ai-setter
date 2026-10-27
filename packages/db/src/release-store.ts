/**
 * Recording what was verified about a commit, and reading back what it permits (#60,
 * LAUNCH_READINESS.md).
 *
 * **Authorized like a kill switch, and for the same reason.** Recording a release is what moves the §18
 * stage in force, and the stage is what can permit unattended sending across every workspace on the
 * platform. So all three writers here take a `PlatformContext` and require `OPERATE_RELEASE`, and all
 * three write a platform audit row in the same transaction as the fact they record. The tempting
 * precedent — `publishPlanVersion`, which takes no context — does not hold: publishing a plan version
 * moves no gate by itself, and the step that changes what a workspace may do, `setWorkspaceSubscription`,
 * *is* authorized and audited. These functions are that second step, not the first.
 *
 * **Nothing judged is stored, so nothing judged can drift.** `readRelease` returns the record, its gate
 * results, the verdicts about its commit, and the decision and reviewer status *computed from them*.
 * There is no column to disagree with.
 *
 * **The stage in force is the newest candidate that is actually approved** — gates releasable and an
 * independent PASS on its own SHA. That is what makes the exact-SHA rule a runtime fact rather than a
 * line in a report. And when that question cannot be answered — too many unreviewed proposals stacked
 * above the live one to see it — the answer is a refusal rather than a shrug: see `readReleaseInForce`.
 */
import {
  isGateSeverity,
  isReviewVerdict,
  isRolloutStage,
  releaseApproved,
  releaseDecision,
  reviewerStatusOf,
  rolloutAccessOf,
  RELEASE_GATE_IDS,
  type GateResult,
  type ReleaseCapability,
  type ReleaseDecision,
  type ReleaseReview,
  type ReviewerStatus,
  type ReviewVerdict,
  type RolloutAccess,
  type RolloutStage,
  UNRELEASED_ROLLOUT_ACCESS,
} from "@omnichannel/domain";

import type { DbClient, DbExecutor } from "./client";
import { DbInputError } from "./errors";
import { recordPlatformAuditEvent } from "./platform-audit-store";
import { platformActorOf, requirePlatformPermission, type PlatformContext } from "./platform-tenancy";

const FULL_SHA = /^[0-9a-f]{40}$/u;

/**
 * How many recent candidates are considered when looking for the one in force.
 *
 * Small, because this is read on the send path: a deployment has one release in force and perhaps a few
 * proposals above it, and looking further back would cost every claim a larger query to find a candidate
 * a newer approved one has already superseded.
 *
 * What makes the number safe is not its size but `readReleaseInForce` telling the two cases apart. A
 * window that found nothing used to mean "no staged rollout", which is the *permissive* answer — so
 * recording this many unreviewed proposals, the single most common state a candidate is in, would have
 * switched unattended sending on for everybody. Now exhausting the window with more records behind it is
 * `INDETERMINATE`, and that fails closed.
 */
const ROLLOUT_WINDOW = 10;

export interface RecordReleaseInput {
  readonly sha: string;
  readonly stage: RolloutStage;
  readonly rollbackPlan: string;
  readonly summary: string;
  readonly migrations?: readonly string[];
  readonly enabledFlags?: readonly string[];
  readonly results: readonly GateResult[];
  readonly at?: Date;
}

export interface RecordedRelease {
  readonly releaseId: string;
  readonly sha: string;
  readonly stage: RolloutStage;
  /** Computed from the results that were just written, not stored. */
  readonly decision: ReleaseDecision;
}

/**
 * Records a release candidate and its gate verdicts, in one transaction.
 *
 * Refuses a gate id the catalogue does not define, a duplicate verdict for one gate, and a commit already
 * proposed at this stage — each with a sentence naming the thing, rather than letting a unique index or a
 * CHECK surface as a constraint violation naming an index. The last of those is the one an operator
 * actually hits, by re-running the script.
 *
 * It does **not** refuse a candidate whose gates do not permit a release. Recording that a commit failed
 * its gates is the entire point of the record; the refusal belongs to whoever reads the decision.
 *
 * The gate results are written in this transaction and can never be added to afterwards — a trigger
 * enforces it. Without that, a candidate refused for a gate nobody evaluated could be made releasable
 * later by supplying the missing verdict, with no row edited and no new SHA.
 */
export async function recordRelease(db: DbClient, context: PlatformContext, input: RecordReleaseInput): Promise<RecordedRelease> {
  requirePlatformPermission(context, "OPERATE_RELEASE", "record a release candidate");
  const actor = platformActorOf(context);
  const at = input.at ?? new Date();
  if (!FULL_SHA.test(input.sha)) {
    throw new DbInputError("sha", "a release names one full 40-character commit SHA; an abbreviation is how a verdict moves to the wrong commit");
  }
  if (input.rollbackPlan.trim() === "" || input.summary.trim() === "") {
    throw new DbInputError("rollbackPlan", "a release records why it is going out and how to get back from it");
  }
  const unknown = input.results.map((result) => result.gateId).filter((gateId) => !RELEASE_GATE_IDS.includes(gateId));
  if (unknown.length > 0) {
    throw new DbInputError("results", `not release gates: ${unknown.join(", ")}`);
  }
  const seen = new Set<string>();
  for (const result of input.results) {
    if (seen.has(result.gateId)) {
      throw new DbInputError("results", `two verdicts for ${result.gateId}; one gate has one answer`);
    }
    seen.add(result.gateId);
  }
  const already = await db.releaseRecord.findUnique({ where: { sha_stage: { sha: input.sha, stage: input.stage } }, select: { id: true } });
  if (already !== null) {
    throw new DbInputError("stage", `${input.sha} is already recorded at ${input.stage}; advancing a rollout is a new stage, and nothing here is edited`);
  }

  return db.$transaction(async (tx) => {
    const release = await tx.releaseRecord.create({
      data: {
        sha: input.sha,
        actorUserId: actor.userId,
        stage: input.stage,
        rollbackPlan: input.rollbackPlan.trim(),
        summary: input.summary.trim(),
        migrations: [...(input.migrations ?? [])],
        enabledFlags: [...(input.enabledFlags ?? [])],
        // Written rather than left to the column default, so the record and the audit row it writes in
        // this transaction agree about when the release was recorded. `readReleaseInForce` orders by this
        // column and bounds it by the caller's instant, so a record whose time disagreed with the audit
        // would also be a record the claim that logged it could not see.
        createdAt: at,
      },
      select: { id: true, sha: true, stage: true },
    });
    if (input.results.length > 0) {
      await tx.releaseGateResult.createMany({
        data: input.results.map((result) => ({
          releaseId: release.id,
          gateId: result.gateId,
          severity: result.severity,
          evidence: result.evidence,
          ...(result.note === undefined ? {} : { note: result.note }),
        })),
      });
    }
    const decision = releaseDecision(input.results);
    await recordPlatformAuditEvent(tx, context, {
      kind: "RELEASE_RECORDED",
      subjectType: "ReleaseRecord",
      subjectId: release.id,
      reason: input.summary,
      // Severities and refusal counts, never the evidence strings: those are in the record, and an audit
      // row is a statement that something happened rather than a second copy of it.
      detail: {
        sha: release.sha,
        stage: release.stage,
        releasable: decision.releasable,
        blockers: decision.blockers.length,
        disabledCapabilities: decision.disabledCapabilities,
        gatesEvaluated: input.results.length,
      },
      occurredAt: at,
    });
    return { releaseId: release.id, sha: release.sha, stage: isRolloutStage(release.stage) ? release.stage : input.stage, decision };
  });
}

export interface RecordReleaseReviewInput {
  readonly reviewer: string;
  readonly verdict: ReviewVerdict;
  /** The commit the verdict was given about. The only thing the row is attached to. */
  readonly reviewedSha: string;
  readonly reference?: string;
  readonly submittedAt: Date;
}

/**
 * Appends an independent reviewer's verdict about a commit.
 *
 * Attached to the SHA and to nothing else. A verdict is about a commit, not about a proposal: the same
 * commit proposed again at the next stage of §18's progression inherits the verdict, which is right —
 * the reviewer passed that code — and a verdict may be filed for a commit nobody has proposed yet, which
 * is a reviewer being early rather than an error.
 *
 * `candidates` is how many recorded candidates this verdict bears on. Zero is reported rather than
 * refused, and it is the number a caller wants: filing a `PASS` against a SHA nothing was proposed at is
 * almost always a typo in forty characters, and the honest moment to say so is now.
 */
export async function recordReleaseReview(
  db: DbClient,
  context: PlatformContext,
  input: RecordReleaseReviewInput,
): Promise<{ readonly reviewId: string; readonly candidates: number }> {
  requirePlatformPermission(context, "OPERATE_RELEASE", "file a release review verdict");
  if (!FULL_SHA.test(input.reviewedSha)) {
    throw new DbInputError("reviewedSha", "a verdict names the full commit it was given about");
  }
  if (input.reviewer.trim() === "") {
    throw new DbInputError("reviewer", "a verdict names who gave it");
  }

  return db.$transaction(async (tx) => {
    const candidates = await tx.releaseRecord.count({ where: { sha: input.reviewedSha } });
    const review = await tx.releaseReview.create({
      data: {
        reviewer: input.reviewer.trim(),
        verdict: input.verdict,
        reviewedSha: input.reviewedSha,
        ...(input.reference === undefined ? {} : { reference: input.reference }),
        submittedAt: input.submittedAt,
      },
      select: { id: true },
    });
    await recordPlatformAuditEvent(tx, context, {
      kind: "RELEASE_REVIEW_RECORDED",
      subjectType: "ReleaseReview",
      subjectId: review.id,
      reason: `${input.verdict} from ${input.reviewer.trim()}`,
      detail: { reviewedSha: input.reviewedSha, verdict: input.verdict, candidates },
      occurredAt: input.submittedAt,
    });
    return { reviewId: review.id, candidates };
  });
}

/**
 * Adds a Business Profile to the limited-rollout autopilot allowlist, or removes it.
 *
 * §18's third stage is "limited AUTOPILOT on explicitly selected BPs", and this is the selecting. Without
 * it the stage would be unreachable except by hand-written SQL against production — which is the thing
 * the operator console (#59) exists to end.
 *
 * Idempotent, and a no-op writes no audit row: the audit should say what happened, and nothing happened.
 */
export async function setRolloutAutopilot(
  db: DbClient,
  context: PlatformContext,
  input: {
    readonly workspaceId: string;
    readonly businessProfileId: string;
    readonly enabled: boolean;
    readonly reason: string;
    readonly at?: Date;
  },
): Promise<{ readonly changed: boolean }> {
  requirePlatformPermission(context, "OPERATE_RELEASE", "change the limited-rollout autopilot allowlist");
  if (input.reason.trim() === "") {
    throw new DbInputError("reason", "selecting a profile for unattended sending records why");
  }
  const at = input.at ?? new Date();

  return db.$transaction(async (tx) => {
    const profile = await tx.businessProfile.findUnique({
      where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.businessProfileId } },
      select: { rolloutAutopilot: true },
    });
    if (profile === null) {
      throw new DbInputError("businessProfileId", "no such Business Profile in that workspace");
    }
    if (profile.rolloutAutopilot === input.enabled) {
      return { changed: false };
    }
    // The transition is the predicate, and its count decides — the same correction `liftKillSwitch` and
    // `revokeSupportAccessSession` took on #102, and the same defect: the read above cannot settle this.
    // Two operators adding the same profile both see `false`, both pass the check, and an unconditional
    // `update` lets both report a transition and file an audit row for it, when only one `false -> true`
    // ever happened. The flag ends up right either way; the record does not.
    const { count } = await tx.businessProfile.updateMany({
      where: { workspaceId: input.workspaceId, id: input.businessProfileId, rolloutAutopilot: !input.enabled },
      data: { rolloutAutopilot: input.enabled },
    });
    if (count === 0) {
      // Somebody else made this exact transition between the read and the write. Same answer as finding
      // it already in the wanted state, and deliberately no transition event: there was no transition.
      return { changed: false };
    }
    await recordPlatformAuditEvent(tx, context, {
      kind: "ROLLOUT_ALLOWLIST_CHANGED",
      subjectType: "BusinessProfile",
      subjectId: input.businessProfileId,
      reason: input.reason,
      workspaceId: input.workspaceId,
      businessProfileId: input.businessProfileId,
      detail: { enabled: input.enabled },
      occurredAt: at,
    });
    return { changed: true };
  });
}

export interface ReleaseView {
  readonly releaseId: string;
  readonly sha: string;
  readonly stage: RolloutStage;
  readonly rollbackPlan: string;
  readonly summary: string;
  readonly migrations: readonly string[];
  readonly enabledFlags: readonly string[];
  readonly createdAt: Date;
  readonly results: readonly GateResult[];
  readonly reviews: readonly (ReleaseReview & { readonly reference: string | null })[];
  /** Computed. There is no stored column that could disagree with the rows above. */
  readonly decision: ReleaseDecision;
  readonly reviewer: ReviewerStatus;
  readonly approved: boolean;
}

/** What a candidate's own rows look like before the verdicts about its commit are joined in. */
const CANDIDATE_SELECT = {
  id: true,
  sha: true,
  stage: true,
  rollbackPlan: true,
  summary: true,
  migrations: true,
  enabledFlags: true,
  createdAt: true,
  results: { select: { gateId: true, severity: true, evidence: true, note: true }, orderBy: { gateId: "asc" } },
} as const;

/**
 * One release candidate with everything recorded about it, and what that adds up to.
 *
 * Takes the stage as well as the SHA, because one commit may be proposed at several stages and each
 * proposal is its own decision. Without a stage the newest proposal of that commit is returned, which is
 * what an operator typing a SHA means.
 */
export async function readRelease(db: DbExecutor, sha: string, stage?: RolloutStage): Promise<ReleaseView | null> {
  const row = await db.releaseRecord.findFirst({
    where: { sha, ...(stage === undefined ? {} : { stage }) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: CANDIDATE_SELECT,
  });
  if (row === null) {
    return null;
  }
  const [view] = await withReviews(db, [row]);
  return view ?? null;
}

/**
 * Release candidates, newest first, for an operator deciding what is in force and what is pending.
 *
 * Ordered by `createdAt` **and** `id`, because `id` is a `uuid(7)` and therefore time-ordered, and
 * because `createdAt` alone leaves ties undefined: two candidates recorded in the same millisecond would
 * make "which is newest" a property of the plan PostgreSQL chose, and this ordering decides which stage
 * is in force on every send.
 */
export async function listReleases(db: DbExecutor, limit = 20): Promise<readonly ReleaseView[]> {
  const rows = await db.releaseRecord.findMany({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: Math.min(Math.max(Math.trunc(limit), 1), 100),
    select: CANDIDATE_SELECT,
  });
  return withReviews(db, rows);
}

type CandidateRow = {
  readonly id: string;
  readonly sha: string;
  readonly stage: string;
  readonly rollbackPlan: string;
  readonly summary: string;
  readonly migrations: string[];
  readonly enabledFlags: string[];
  readonly createdAt: Date;
  readonly results: readonly { readonly gateId: string; readonly severity: string; readonly evidence: string; readonly note: string | null }[];
};

type ReviewRow = {
  readonly reviewer: string;
  readonly verdict: string;
  readonly reviewedSha: string;
  readonly reference: string | null;
  readonly submittedAt: Date;
};

/** Joins in the verdicts about these candidates' commits: one query for the whole page, not one each. */
async function withReviews(db: DbExecutor, rows: readonly CandidateRow[]): Promise<readonly ReleaseView[]> {
  if (rows.length === 0) {
    return [];
  }
  const reviews = await db.releaseReview.findMany({
    where: { reviewedSha: { in: [...new Set(rows.map((row) => row.sha))] } },
    orderBy: [{ submittedAt: "desc" }, { id: "desc" }],
    select: { reviewer: true, verdict: true, reviewedSha: true, reference: true, submittedAt: true },
  });
  return rows.map((row) => viewOf(row, reviews.filter((review) => review.reviewedSha === row.sha)));
}

/**
 * The stored enums, checked rather than cast.
 *
 * A cast would be a claim about the database made in TypeScript, and these rows can be written by hand or
 * by a migration that added a value this build does not know — in which case the honest outcome is a
 * refusal naming the value, not a `GateSeverity` that is not one being handed to `releaseDecision`.
 *
 * Shared by both readers rather than written out twice. Two mappings from the same rows to the same domain
 * values is the kind of duplication that disagrees later, and this pair would have disagreed about which
 * invalid value it refused.
 */
function stageOf(stage: string): RolloutStage {
  if (!isRolloutStage(stage)) {
    throw new DbInputError("stage", `stored release stage is not one this build knows: ${stage}`);
  }
  return stage;
}

function gateResultsOf(rows: readonly { readonly gateId: string; readonly severity: string; readonly evidence: string; readonly note: string | null }[]): GateResult[] {
  return rows.map((result) => {
    if (!isGateSeverity(result.severity)) {
      throw new DbInputError("severity", `stored gate severity is not one this build knows: ${result.severity}`);
    }
    return {
      gateId: result.gateId,
      severity: result.severity,
      evidence: result.evidence,
      ...(result.note === null ? {} : { note: result.note }),
    };
  });
}

function verdictOf(verdict: string): ReviewVerdict {
  if (!isReviewVerdict(verdict)) {
    throw new DbInputError("verdict", `stored review verdict is not one this build knows: ${verdict}`);
  }
  return verdict;
}

/** One stored candidate, with the decision and the reviewer status computed from its own rows. */
function viewOf(row: CandidateRow, reviewRows: readonly ReviewRow[]): ReleaseView {
  const stage = stageOf(row.stage);
  const results = gateResultsOf(row.results);
  const reviews = reviewRows.map((review) => ({
    reviewer: review.reviewer,
    verdict: verdictOf(review.verdict),
    reviewedSha: review.reviewedSha,
    reference: review.reference,
    submittedAt: review.submittedAt,
  }));
  const verdict = releaseApproved({ sha: row.sha, results, reviews });
  return {
    releaseId: row.id,
    sha: row.sha,
    stage,
    rollbackPlan: row.rollbackPlan,
    summary: row.summary,
    migrations: row.migrations,
    enabledFlags: row.enabledFlags,
    createdAt: row.createdAt,
    results,
    reviews,
    decision: verdict.decision,
    reviewer: verdict.reviewer,
    approved: verdict.approved,
  };
}

/**
 * The release in force, or the reason there is no answer.
 *
 * Three outcomes and they are deliberately not two:
 *
 * - `NONE` — this deployment has recorded no release at all. A development checkout, a test database and
 *   a deployment that has never used the release process are all here, and in all three there is no stage
 *   to enforce. `rolloutPermitsAutopilot` treats it as permitted, which is why it has to be told apart
 *   from the next case.
 * - `IN_FORCE` — the newest approved candidate, with the stage it names and the capabilities its own
 *   gates left switched off.
 * - `INDETERMINATE` — there are candidates, and none of the ones examined is approved. This is the case
 *   that used to be reported as `NONE`, and reporting it that way meant that recording ten unreviewed
 *   proposals switched unattended sending on for the whole platform: recording *evidence* turned the gate
 *   off. It now fails closed.
 *
 * `at` bounds the catalogue to the instant the caller is deciding about, so a claim re-resolving at
 * `claimedAt` sees the same catalogue the rest of its facts were read from.
 */
export type ReleaseInForce =
  | { readonly kind: "NONE" }
  | { readonly kind: "IN_FORCE"; readonly stage: RolloutStage; readonly disabledCapabilities: readonly ReleaseCapability[]; readonly sha: string }
  | { readonly kind: "INDETERMINATE"; readonly examined: number };

export async function readReleaseInForce(db: DbExecutor, at: Date, limit = ROLLOUT_WINDOW): Promise<ReleaseInForce> {
  return readCatalogue(db, at, limit);
}

/**
 * The catalogue as this transaction can see it **now**, with no as-of bound (#60).
 *
 * Astra's P1 on PR #103, and the point is the interaction between two correct pieces. The send claim
 * takes `pg_advisory_xact_lock_shared` on the release-catalogue key precisely because the candidate that
 * would change its answer may not exist yet when the claim starts — a row lock cannot cover a row nobody
 * has written. It then re-resolved the catalogue with `readReleaseInForce(tx, claimedAt)`, and
 * `claimedAt` is captured by the coordinator *before* the claim transaction begins. So a restrictive
 * release, or a `CHANGES_REQUESTED` review, committed while this claim was waiting for that key was
 * excluded by `createdAt <= claimedAt` — the lock was acquired and the query then hid the writer it had
 * been taken for.
 *
 * Taking a lock does not repair a query that excludes the winning writer. The guarded read on the send
 * path therefore uses this reader: it sees what is committed once the key is held, so a stage or verdict
 * that landed during the wait makes the claim disagree with the guard and return `STATE_CHANGED`.
 *
 * `readReleaseInForce` keeps the as-of bound and keeps its callers: a console showing what was in force
 * at an instant, and `readRolloutAccess` resolving the facts a decision is being judged from. Those are
 * deliberately as-of. This one is deliberately not.
 */
export async function readReleaseInForceNow(db: DbExecutor, limit = ROLLOUT_WINDOW): Promise<ReleaseInForce> {
  return readCatalogue(db, undefined, limit);
}

async function readCatalogue(db: DbExecutor, at: Date | undefined, limit: number): Promise<ReleaseInForce> {
  const window = Math.min(Math.max(Math.trunc(limit), 1), 100);
  const rows = await db.releaseRecord.findMany({
    where: at === undefined ? {} : { createdAt: { lte: at } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: window,
    // Narrow on purpose: this runs on the send path, inside the claim transaction, with the Business
    // Profile row held `FOR UPDATE`. The rollback plan, the summary, the migration list and the enabled
    // flags are for a person reading a record; none of them is part of the question "is this approved".
    select: {
      id: true,
      sha: true,
      stage: true,
      results: { select: { gateId: true, severity: true, evidence: true, note: true } },
    },
  });
  if (rows.length === 0) {
    return { kind: "NONE" };
  }
  const reviews = await db.releaseReview.findMany({
    // `submittedAt` only ever arrives through the spread, so it cannot collide with a key already in
    // this literal — the duplicate-key shape that cost `listKillSwitches` its expiry predicate.
    where: {
      reviewedSha: { in: [...new Set(rows.map((row) => row.sha))] },
      ...(at === undefined ? {} : { submittedAt: { lte: at } }),
    },
    select: { reviewer: true, verdict: true, reviewedSha: true, submittedAt: true },
  });
  for (const row of rows) {
    const matching: ReleaseReview[] = reviews
      .filter((review) => review.reviewedSha === row.sha)
      .map((review) => ({
        reviewer: review.reviewer,
        verdict: verdictOf(review.verdict),
        reviewedSha: review.reviewedSha,
        submittedAt: review.submittedAt,
      }));
    const verdict = releaseApproved({ sha: row.sha, results: gateResultsOf(row.results), reviews: matching });
    if (verdict.approved) {
      return { kind: "IN_FORCE", stage: stageOf(row.stage), disabledCapabilities: verdict.decision.disabledCapabilities, sha: row.sha };
    }
  }
  return { kind: "INDETERMINATE", examined: rows.length };
}

/**
 * What the rollout permits, from the release in force and this profile's own enablement.
 *
 * The one derivation, and it is a plain function rather than a second query because the delivery claim
 * has already read the profile's flag off a row it holds `FOR UPDATE` and must not read it again
 * unlocked. Two code paths computing a `RolloutPosture` by hand would be two answers to the question
 * that decides whether a reply goes out unattended.
 */
export function rolloutAccessFrom(inForce: ReleaseInForce, explicitlyEnabled: boolean): RolloutAccess {
  if (inForce.kind === "INDETERMINATE") {
    // The one case that is not a posture: we could not establish the rollout, which is different from
    // establishing that there is none. `UNRELEASED_ROLLOUT_ACCESS` is the refusal, and the asymmetry is
    // written down where it is defined.
    return UNRELEASED_ROLLOUT_ACCESS;
  }
  return rolloutAccessOf({
    ...(inForce.kind === "IN_FORCE" ? { stage: inForce.stage, disabledCapabilities: inForce.disabledCapabilities } : { disabledCapabilities: [] }),
    explicitlyEnabled,
  });
}

/**
 * Whether the staged rollout permits unattended sending for one Business Profile.
 *
 * Takes the profile rather than only the stage, because §18's `LIMITED_AUTOPILOT` is explicitly "on
 * explicitly selected BPs" — a stage alone cannot answer it. A profile that does not exist is not
 * enabled, which is the deny direction.
 */
export async function readRolloutAccess(
  db: DbExecutor,
  target: { readonly workspaceId: string; readonly businessProfileId: string },
  at: Date,
): Promise<RolloutAccess> {
  const [inForce, profile] = await Promise.all([
    readReleaseInForce(db, at),
    db.businessProfile.findUnique({
      where: { workspaceId_id: { workspaceId: target.workspaceId, id: target.businessProfileId } },
      select: { rolloutAutopilot: true },
    }),
  ]);
  return rolloutAccessFrom(inForce, profile?.rolloutAutopilot ?? false);
}

/** Re-exported so a caller reading a stored verdict does not have to reach into the domain for it. */
export { reviewerStatusOf };
