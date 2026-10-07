/**
 * Deciding whether a commit may be released, from evidence rather than from confidence (#60,
 * LAUNCH_READINESS.md).
 *
 * The spec's first sentence is the whole design: "production release is an exact-SHA decision supported
 * by reproducible evidence. 'Looks fine' is not a launch criterion." So everything here is a function of
 * recorded facts, and three of those functions exist to make a specific mistake unrepresentable.
 *
 * **A verdict belongs to a SHA, not to a branch.** `reviewerStatusOf` reads the newest verdict whose
 * reviewed SHA *equals* the release's own, and ignores every other. That is the spec's "never transfer a
 * PASS from an older SHA to a newer one", expressed as a derivation rather than as a rule somebody
 * remembers — and it is not hypothetical: this repository has had a stale `CHANGES_REQUESTED` sitting on
 * one SHA while the branch head was two commits further on, which read as a current verdict to anybody
 * glancing at it.
 *
 * **Releasability is derived, never stored.** There is no boolean on a release record saying "this was
 * releasable", because a stored boolean is a second answer that can disagree with the gate rows it was
 * computed from. `releaseDecision` recomputes it from the results every time it is asked.
 *
 * **A severity has to mean something.** `HIGH` is defined by the spec as "the affected autonomous
 * capability remains disabled" — which only means anything where there *is* a capability to switch off.
 * A `HIGH` on a gate that guards the release itself has nothing to disable, so it is escalated to a
 * blocker rather than quietly treated as a warning. That escalation is the difference between a severity
 * the code consults and a severity that decorates a report.
 *
 * Nothing here reads a clock, a database, a git repository or a CI system. Collecting the evidence is
 * `scripts/release/`'s job; judging it is this file's.
 */
import { literalGuard } from "./enum";

/**
 * What a failing gate takes away.
 *
 * `RELEASE` is the whole thing: a gate that guards it can only pass or stop the release, because there is
 * no narrower switch to reach for. The rest name capabilities a deployment can actually run without, which
 * is what makes `HIGH` a usable verdict rather than a softer word for `BLOCKER`.
 */
export const RELEASE_CAPABILITIES = [
  /** The release itself. A gate guarding this has no partial outcome. */
  "RELEASE",
  /** Sending anything without a person looking first. */
  "AUTOPILOT",
  /** Reading voice notes. The first explicitly metered resource, and separable. */
  "VOICE_TRANSCRIPTION",
  /** Writing to an external calendar or similar. Disabled for the initial MVP in any case. */
  "BOOKING",
  /** The operator's own view of what the platform is doing. */
  "OPERATOR_VISIBILITY",
] as const;
export type ReleaseCapability = (typeof RELEASE_CAPABILITIES)[number];

export interface ReleaseGate {
  readonly id: string;
  /** The spec's own section number, so a report and the document can be read side by side. */
  readonly section: number;
  /** The spec's own heading, verbatim. `scripts/release/gates.test.ts` holds the two against each other. */
  readonly heading: string;
  readonly guards: ReleaseCapability;
}

/**
 * The twenty gates of `LAUNCH_READINESS.md`, in its own order and with its own headings.
 *
 * Spelled out here rather than parsed at runtime, because a release decision must not depend on a
 * markdown file being present and well-formed in the deployed artefact. The duplication is the price, and
 * `scripts/release/gates.test.ts` pays it: it parses the spec's numbered sections and asserts this list matches
 * exactly — so a gate added to the document is a failing test until it is added here, and a gate invented
 * here without a section in the document fails too.
 *
 * `guards` is this file's own judgement rather than the spec's, and it is the part worth arguing with. The
 * reasoning: a gate about whether the release is reproducible at all, or whether its evidence exists,
 * guards `RELEASE` — there is nothing to switch off. A gate about unattended sending guards `AUTOPILOT`,
 * which a deployment can genuinely ship without by leaving every profile in DRAFT. Media guards
 * transcription; booking guards booking; alerting guards the operator's visibility, which is serious and
 * is not a reason to refuse to ship.
 */
export const RELEASE_GATES: readonly ReleaseGate[] = [
  { id: "EXACT_SHA_CI", section: 1, heading: "Exact release SHA / CI", guards: "RELEASE" },
  { id: "STAGING", section: 2, heading: "Production-like staging", guards: "RELEASE" },
  { id: "MESSAGING_E2E", section: 3, heading: "Messaging E2E matrix", guards: "RELEASE" },
  { id: "AUTOPILOT_HEADLESS", section: 4, heading: "AUTOPILOT with dashboard closed", guards: "AUTOPILOT" },
  { id: "AI_REGRESSION", section: 5, heading: "AI regression/evaluation gate", guards: "AUTOPILOT" },
  { id: "KNOWLEDGE_STYLE", section: 6, heading: "Knowledge / Style gate", guards: "AUTOPILOT" },
  { id: "HUMAN_REVIEW_RACE", section: 7, heading: "Human / Review race gate", guards: "RELEASE" },
  { id: "TENANT_ISOLATION", section: 8, heading: "Tenant / Business Profile isolation gate", guards: "RELEASE" },
  { id: "RELIABILITY_CHAOS", section: 9, heading: "Reliability / chaos gate", guards: "RELEASE" },
  { id: "LOAD_CONCURRENCY", section: 10, heading: "Load / concurrency gate", guards: "RELEASE" },
  { id: "BILLING_ENTITLEMENT", section: 11, heading: "Billing / entitlement gate", guards: "RELEASE" },
  { id: "PRIVACY_DELETION", section: 12, heading: "Privacy / deletion gate", guards: "RELEASE" },
  { id: "MEDIA", section: 13, heading: "Media gate", guards: "VOICE_TRANSCRIPTION" },
  { id: "BOOKING", section: 14, heading: "Booking/external-action gate", guards: "BOOKING" },
  { id: "UX_LOCALIZATION", section: 15, heading: "UX / localization / accessibility", guards: "RELEASE" },
  { id: "OBSERVABILITY", section: 16, heading: "Observability / runbooks", guards: "OPERATOR_VISIBILITY" },
  { id: "KILL_SWITCHES", section: 17, heading: "Kill switches / feature flags", guards: "RELEASE" },
  { id: "STAGED_ROLLOUT", section: 18, heading: "Staged rollout", guards: "AUTOPILOT" },
  { id: "PER_CUSTOMER_READINESS", section: 19, heading: "Per-customer go-live readiness", guards: "AUTOPILOT" },
  { id: "RELEASE_EVIDENCE", section: 20, heading: "Release evidence", guards: "RELEASE" },
];

export const RELEASE_GATE_IDS: readonly string[] = RELEASE_GATES.map((gate) => gate.id);


/**
 * The spec's four severities, most serious last.
 *
 * Ordered so that the worst result in a set can be found without a comparison table, and so that a new
 * severity would have to be placed deliberately rather than appended.
 */
export const GATE_SEVERITIES = ["PASS", "KNOWN_LIMITATION", "HIGH", "BLOCKER"] as const;
export type GateSeverity = (typeof GATE_SEVERITIES)[number];
export const isGateSeverity = literalGuard(GATE_SEVERITIES);

export interface GateResult {
  readonly gateId: string;
  readonly severity: GateSeverity;
  /**
   * What was actually run or read: a command, a CI run, a suite, a signed-off checklist.
   *
   * Required for every severity including `PASS`, because "this gate passed" with nothing behind it is
   * the exact claim the spec refuses — "do not rely on 'Claude ran it locally' without recorded
   * commands/results".
   */
  readonly evidence: string;
  /** Why this is acceptable. Required for `KNOWN_LIMITATION`: an unbounded limitation is not one. */
  readonly note?: string;
}

export const RELEASE_REFUSALS = [
  /** A gate came back BLOCKER. */
  "BLOCKER_GATE",
  /** A gate has no result at all. Silence is not a pass. */
  "GATE_NOT_EVALUATED",
  /** A gate passed with nothing recorded behind it. */
  "EVIDENCE_MISSING",
  /** A limitation nobody bounded. */
  "LIMITATION_UNDOCUMENTED",
  /** A `HIGH` on a gate that guards the release itself: there is nothing to disable. */
  "HIGH_WITH_NOTHING_TO_DISABLE",
  /**
   * Two verdicts for one gate.
   *
   * Refused rather than resolved. Last-wins would silently discard the other one, and the one discarded
   * is as likely to be the `BLOCKER` as the `PASS` — a release manager merging two runs' result lists is
   * exactly how that happens, and the merge looks clean.
   */
  "DUPLICATE_GATE_RESULT",
  /**
   * A result for a gate this catalogue does not define.
   *
   * Reported against the stored id rather than ignored, because ignoring it is the failure: a gate removed
   * from the catalogue would make an archived record carrying its `BLOCKER` read as releasable, and that
   * record is recomputed on every send.
   */
  "UNKNOWN_GATE",
] as const;
export type ReleaseRefusal = (typeof RELEASE_REFUSALS)[number];

export interface ReleaseBlocker {
  readonly gateId: string;
  readonly refusal: ReleaseRefusal;
}

export interface ReleaseDecision {
  /** Derived, never stored: a stored boolean is a second answer that can disagree with its own inputs. */
  readonly releasable: boolean;
  /** Every reason it is not, rather than the first — a release manager fixes the list, not the head of it. */
  readonly blockers: readonly ReleaseBlocker[];
  /** Capabilities a `HIGH` leaves switched off. The release may proceed; these may not. */
  readonly disabledCapabilities: readonly ReleaseCapability[];
  /** The bounded limitations this release ships with, each with the note that bounds it. */
  readonly knownLimitations: readonly { readonly gateId: string; readonly note: string }[];
}

/**
 * Judges a set of gate results.
 *
 * Four things make a release impossible and they are deliberately not one check: a blocker; a gate nobody
 * evaluated; a gate claimed as passed with no evidence; and a limitation with nothing bounding it. The
 * second is the one that would otherwise be missed — a report that lists nineteen passes and omits the
 * twentieth gate reads as nineteen passes, and the omission is where an untested path lives.
 *
 * The fifth is the escalation: a `HIGH` on a gate guarding `RELEASE` has no capability to switch off, so
 * treating it as a warning would be treating it as nothing. It becomes a blocker, and the refusal says
 * which kind of wrong it is so the person reading can either fix the gate or fix the model.
 */
export function releaseDecision(results: readonly GateResult[]): ReleaseDecision {
  const blockers: ReleaseBlocker[] = [];
  const disabled = new Set<ReleaseCapability>();
  const knownLimitations: { readonly gateId: string; readonly note: string }[] = [];
  const byGate = new Map<string, GateResult>();
  const duplicated = new Set<string>();
  const unknown = new Set<string>();

  for (const result of results) {
    if (byGate.has(result.gateId)) {
      duplicated.add(result.gateId);
    }
    byGate.set(result.gateId, result);
    if (!RELEASE_GATE_IDS.includes(result.gateId)) {
      unknown.add(result.gateId);
    }
  }
  // Before the catalogue walk, and in the results' own id order, so a report lists them where a reader
  // looking for "why is this not releasable" will see them first.
  for (const gateId of [...duplicated].toSorted()) {
    blockers.push({ gateId, refusal: "DUPLICATE_GATE_RESULT" });
  }
  for (const gateId of [...unknown].toSorted()) {
    blockers.push({ gateId, refusal: "UNKNOWN_GATE" });
  }

  for (const gate of RELEASE_GATES) {
    const result = byGate.get(gate.id);
    if (result === undefined) {
      blockers.push({ gateId: gate.id, refusal: "GATE_NOT_EVALUATED" });
      continue;
    }
    if (result.evidence.trim() === "") {
      blockers.push({ gateId: gate.id, refusal: "EVIDENCE_MISSING" });
      continue;
    }
    switch (result.severity) {
      case "BLOCKER":
        blockers.push({ gateId: gate.id, refusal: "BLOCKER_GATE" });
        break;
      case "HIGH":
        if (gate.guards === "RELEASE") {
          blockers.push({ gateId: gate.id, refusal: "HIGH_WITH_NOTHING_TO_DISABLE" });
        } else {
          disabled.add(gate.guards);
        }
        break;
      case "KNOWN_LIMITATION":
        if (result.note === undefined || result.note.trim() === "") {
          blockers.push({ gateId: gate.id, refusal: "LIMITATION_UNDOCUMENTED" });
        } else {
          knownLimitations.push({ gateId: gate.id, note: result.note.trim() });
        }
        break;
      case "PASS":
        break;
    }
  }

  return {
    releasable: blockers.length === 0,
    blockers,
    // In the capability list's own order, so two runs over the same results read identically.
    disabledCapabilities: RELEASE_CAPABILITIES.filter((capability) => disabled.has(capability)),
    knownLimitations,
  };
}

/** The worst thing in a set of results, for a one-line summary. `PASS` when there is nothing. */
export function worstSeverity(results: readonly GateResult[]): GateSeverity {
  return GATE_SEVERITIES.reduce<GateSeverity>((worst, severity) => (results.some((result) => result.severity === severity) ? severity : worst), "PASS");
}

/**
 * The staged rollout of `LAUNCH_READINESS.md` §18, in order.
 *
 * A release is at exactly one of these, and the order is the progression — which is why
 * `rolloutStageAtLeast` compares positions rather than equality: "from Commercial Beta onwards" is the
 * shape almost every rule here takes.
 */
export const ROLLOUT_STAGES = ["INTERNAL", "DESIGN_PARTNERS_DRAFT", "LIMITED_AUTOPILOT", "COMMERCIAL_BETA", "GENERAL_AVAILABILITY"] as const;
export type RolloutStage = (typeof ROLLOUT_STAGES)[number];
export const isRolloutStage = literalGuard(ROLLOUT_STAGES);

/** Whether this stage is at or beyond another. Positions, not equality: the stages are a progression. */
export function rolloutStageAtLeast(stage: RolloutStage, minimum: RolloutStage): boolean {
  return ROLLOUT_STAGES.indexOf(stage) >= ROLLOUT_STAGES.indexOf(minimum);
}

/**
 * Where a profile stands with respect to the staged rollout.
 *
 * `stage` absent means **no release is in force**, which is not the same as an early stage and is handled
 * as such by `rolloutPermitsAutopilot`. A development checkout, a test database and a deployment that has
 * never recorded a release are all in that state, and treating them as `INTERNAL` would switch automated
 * sending off for the product's own test suite — which would say the gate is in the wrong place rather
 * than that the default is right.
 */
export interface RolloutPosture {
  readonly stage?: RolloutStage;
  /**
   * Whether this Business Profile is on the explicit list §18 calls for at `LIMITED_AUTOPILOT`.
   *
   * Only consulted at that one stage. Before it nobody autopilots whatever the list says; after it the
   * plan governs, because a rollout that kept an allowlist for ever would be a permanent gate wearing a
   * temporary name.
   */
  readonly explicitlyEnabled: boolean;
  /**
   * What the release in force switched off: `releaseDecision(...).disabledCapabilities`, carried here.
   *
   * This is the field that makes the issue's severity rule real rather than advisory. A `HIGH` gate is
   * deliberately *not* a blocker — "HIGH: affected autonomous feature remains disabled" means the release
   * goes out with that feature off, not that the release stops. So the decision names the capability, and
   * something has to be the thing that keeps it off. Without this the stage alone would answer, and a
   * release whose `AUTOPILOT_HEADLESS` gate came back `HIGH` would still permit unattended sending at
   * `COMMERCIAL_BETA` — a release that recorded, in its own evidence, that it must not.
   *
   * Required rather than optional, for the reason `PolicyInput.commercial` gives about itself: an optional
   * list would read as "nothing disabled" at every site that forgot it, which is the one direction this
   * must never fail in. A deployment with no release in force passes an empty list and means it.
   */
  readonly disabledCapabilities: readonly ReleaseCapability[];
}

/**
 * Whether the staged rollout permits unattended sending for this profile.
 *
 * Only ever *subtracts*. The plan's `AUTOPILOT` feature, the profile's own mode and the kill switch all
 * still apply; this is one more reason a send may not go out unattended, in a product that is mid-rollout.
 *
 * - the release in force switched `AUTOPILOT` off — refused, whatever stage it names;
 * - no release in force — permitted; there is no stage to enforce, and see `RolloutPosture.stage`;
 * - `INTERNAL`, `DESIGN_PARTNERS_DRAFT` — refused for everybody, which is §18's "DRAFT-first";
 * - `LIMITED_AUTOPILOT` — permitted only for an explicitly enabled profile;
 * - `COMMERCIAL_BETA` and beyond — permitted; the plan governs.
 */
export function rolloutPermitsAutopilot(posture: RolloutPosture): boolean {
  // First, and before the stage: a release that recorded `AUTOPILOT` as disabled recorded it as disabled.
  // A stage that would otherwise permit unattended sending does not overrule the release's own evidence,
  // because the stage is what the release *proposed* and this is what its gates actually said.
  if (posture.disabledCapabilities.includes("AUTOPILOT")) {
    return false;
  }
  if (posture.stage === undefined) {
    return true;
  }
  if (!rolloutStageAtLeast(posture.stage, "LIMITED_AUTOPILOT")) {
    return false;
  }
  return rolloutStageAtLeast(posture.stage, "COMMERCIAL_BETA") || posture.explicitlyEnabled;
}

/**
 * What the staged rollout permits, as the policy engine sees it (#60).
 *
 * One boolean, and the narrowness is deliberate. The engine reads a resolved answer the way it reads
 * `CommercialAccess` rather than a plan code — dragging a commit SHA, a stage name or a release record
 * into the send decision would make the policy engine depend on the release process, and then every test
 * of a send would need a release.
 */
export interface RolloutAccess {
  /** Whether unattended sending is released for this profile. Only ever false; never a grant. */
  readonly autopilot: boolean;
}

/** The resolved answer for one profile. The only sanctioned way to build a `RolloutAccess`. */
export function rolloutAccessOf(posture: RolloutPosture): RolloutAccess {
  return { autopilot: rolloutPermitsAutopilot(posture) };
}

/**
 * The rollout access of a caller that could not establish the rollout at all.
 *
 * Named rather than written out as `{ autopilot: false }` at each site, so that "we could not find out"
 * and "the stage forbids it" are the same refusal rather than two spellings of it that drift apart — the
 * reasoning `NO_COMMERCIAL_ACCESS` gives for itself.
 *
 * Note the asymmetry with billing, because it is the kind that bites: *absence of a release* means no
 * staged rollout is in force and unattended sending is permitted, while *failure to establish the
 * rollout* must fail closed. Those are different facts and only the second one belongs here.
 */
export const UNRELEASED_ROLLOUT_ACCESS: RolloutAccess = { autopilot: false };

/**
 * The rollout access of a deployment with no staged release in force.
 *
 * Derived from the builder rather than written out, so it cannot drift from what
 * `rolloutPermitsAutopilot` actually answers for that case. A development checkout, a test database and a
 * deployment that has never recorded a release are all here, and in all three the rollout gate has no
 * stage to enforce — see `RolloutPosture.stage` for why that is the right default and not merely the
 * convenient one.
 */
export const NO_STAGED_ROLLOUT: RolloutAccess = rolloutAccessOf({ explicitlyEnabled: false, disabledCapabilities: [] });

/**
 * What an independent reviewer said, and about which commit.
 *
 * `reviewedSha` is the whole point of the type. A verdict without it is an opinion about a branch, and a
 * branch moves.
 */
export const REVIEW_VERDICTS = ["PASS", "CHANGES_REQUESTED"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];
export const isReviewVerdict = literalGuard(REVIEW_VERDICTS);

export interface ReleaseReview {
  readonly reviewer: string;
  readonly verdict: ReviewVerdict;
  readonly reviewedSha: string;
  readonly submittedAt: Date;
}

/** The reviewer's position on a release, including "nobody has looked at this commit". */
export const REVIEWER_STATUSES = ["NOT_REVIEWED", "CHANGES_REQUESTED", "PASS"] as const;
export type ReviewerStatus = (typeof REVIEWER_STATUSES)[number];

/**
 * The reviewer status of one exact commit.
 *
 * Derived from the verdicts rather than stored on the release, and only from the verdicts whose reviewed
 * SHA **is** the release's own. Every other verdict is ignored — not weighed, not warned about, ignored —
 * because a verdict on another commit is not evidence about this one however recently it was written.
 *
 * This is `LAUNCH_READINESS.md` §1's "never transfer a PASS from an older SHA to a newer one", and the
 * inverse matters just as much: a `CHANGES_REQUESTED` left on an earlier commit must not read as the
 * current position of a commit that repaired it. Both halves of that mistake have happened in this
 * repository's own review history, which is why this is a derivation and not a convention.
 *
 * The newest matching verdict wins, because a reviewer who looked twice meant the second time.
 */
export function reviewerStatusOf(sha: string, reviews: readonly ReleaseReview[]): ReviewerStatus {
  const matching = reviews.filter((review) => review.reviewedSha === sha);
  if (matching.length === 0) {
    return "NOT_REVIEWED";
  }
  const newest = Math.max(...matching.map((review) => review.submittedAt.getTime()));
  const newestVerdicts = matching.filter((review) => review.submittedAt.getTime() === newest);
  // A tie is decided against the release, not by whichever row the database happened to return first.
  //
  // Equal timestamps are not exotic: a script filing a batch of verdicts parsed from one report stamps
  // them all with the batch's own time. Sorting alone leaves the winner to insertion order, so the same
  // stored rows could answer `PASS` on one deployment and `CHANGES_REQUESTED` on another — and this
  // function is recomputed on every send. Preferring the refusal makes the answer both deterministic and
  // the safe one; a reviewer who meant to withdraw a `CHANGES_REQUESTED` can say so in a later second.
  return newestVerdicts.some((review) => review.verdict === "CHANGES_REQUESTED") ? "CHANGES_REQUESTED" : "PASS";
}

/**
 * Whether a release may actually go out: the gates *and* the reviewer, together.
 *
 * Kept apart from `releaseDecision` on purpose. The gates are facts about the commit; the reviewer status
 * is a judgement about it, and a surface that conflated them could not say "it verifies and nobody has
 * looked at it" — which is the single most common state a release candidate is in, and the one most
 * worth being able to name.
 */
export function releaseApproved(input: {
  readonly sha: string;
  readonly results: readonly GateResult[];
  readonly reviews: readonly ReleaseReview[];
}): { readonly approved: boolean; readonly decision: ReleaseDecision; readonly reviewer: ReviewerStatus } {
  const decision = releaseDecision(input.results);
  const reviewer = reviewerStatusOf(input.sha, input.reviews);
  return { approved: decision.releasable && reviewer === "PASS", decision, reviewer };
}
