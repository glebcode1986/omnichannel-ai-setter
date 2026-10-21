/**
 * What a plan change would cost, and how close an allowance is to running out (#42).
 *
 * Both answers belong to a screen rather than to a gate, and both are arithmetic — which is why they live
 * here: a number a business is about to make a decision on should not be computed in a React component
 * where nothing can test it.
 *
 * The spec is insistent on one thing in particular: before a downgrade or a cancellation a person is shown
 * *which* of their resources exceed the new plan, and nothing is deleted. So this names the excess rather
 * than returning a yes or no — "you are over" is not an answer somebody can act on, and "these three
 * Business Profiles are over" is.
 */
import { literalGuard } from "./enum";
import { DomainValidationError } from "./errors";
import { PLAN_FEATURES, PLAN_LIMITS, type PlanFeature, type PlanLimit } from "./entitlements";

/** How close a metered allowance is to being spent. */
export const ALLOWANCE_HEALTHS = ["OK", "WARNING", "EXHAUSTED"] as const;
export type AllowanceHealth = (typeof ALLOWANCE_HEALTHS)[number];
export const isAllowanceHealth = literalGuard(ALLOWANCE_HEALTHS);

/**
 * The share of an allowance that still being left counts as a warning.
 *
 * Product configuration with a stated default rather than a number buried in a component. The spec asks
 * for "a warning state before exhaustion" and does not fix the threshold, so one tenth is the default and
 * the caller may say otherwise — what matters is that the same number decides the badge, the colour and
 * the sentence, instead of three places each choosing for themselves.
 */
export const DEFAULT_ALLOWANCE_WARNING_FRACTION = 0.1;

export interface AllowanceState {
  /** What the plan includes this cycle. */
  readonly included: number;
  /** What was bought on top, still valid. */
  readonly purchased: number;
  /** What has been spent, including anything currently held by a reservation. */
  readonly used: number;
  readonly remaining: number;
  readonly health: AllowanceHealth;
}

/**
 * The state of one allowance, as a screen shows it.
 *
 * `remaining` is floored at zero rather than going negative. A commit may legitimately exceed what was
 * held — the work happened, and the ledger records it honestly — but "minus forty seconds remaining" is
 * not a thing anybody can read, and the fact it conveys is already `EXHAUSTED`.
 */
export function allowanceState(input: {
  readonly included: number;
  readonly purchased?: number;
  readonly used: number;
  readonly warnAtFraction?: number;
}): AllowanceState {
  const fraction = input.warnAtFraction ?? DEFAULT_ALLOWANCE_WARNING_FRACTION;
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
    throw new DomainValidationError("warnAtFraction", "must be a share between zero and one");
  }
  const purchased = input.purchased ?? 0;
  const allowance = input.included + purchased;
  const remaining = Math.max(0, allowance - input.used);
  return {
    included: input.included,
    purchased,
    used: input.used,
    remaining,
    health: healthOf(allowance, remaining, fraction),
  };
}

function healthOf(allowance: number, remaining: number, fraction: number): AllowanceHealth {
  if (remaining <= 0) {
    return "EXHAUSTED";
  }
  // A plan that includes nothing and has nothing bought is exhausted the moment it is looked at, which the
  // branch above has already said. Here the allowance is positive, so the share is meaningful.
  return remaining <= allowance * fraction ? "WARNING" : "OK";
}

/** One ceiling the workspace is already over, or would be. */
export interface CapacityExcess {
  readonly limit: PlanLimit;
  /** How many exist now. */
  readonly inUse: number;
  /** What the plan being considered allows. */
  readonly ceiling: number;
}

export interface PlanChangeConsequences {
  /** Ceilings the workspace would exceed on the plan being considered, with the numbers to say so. */
  readonly overCapacity: readonly CapacityExcess[];
  /** Features in use that the plan being considered does not include. */
  readonly losingFeatures: readonly PlanFeature[];
  /** True when nothing would be lost and nothing would be over. */
  readonly clean: boolean;
}

/**
 * What switching to another plan would mean for this workspace.
 *
 * Deliberately does not decide anything. The accepted downgrade behaviour is that customer data is never
 * deleted, the person is shown what exceeds the new limits and *they* choose which resources stay active —
 * so a function that answered "allowed" or "refused" would be answering a question nobody asked.
 *
 * An absent ceiling on the target plan is uncapped and can therefore never be exceeded, which is the same
 * reading `capacityVerdict` uses. A feature is "lost" only if it is in use now: a plan that drops a feature
 * the business never switched on has cost it nothing, and listing it would be a warning about nothing.
 */
export function planChangeConsequences(input: {
  readonly target: {
    readonly limits: Readonly<Partial<Record<PlanLimit, number>>>;
    readonly features: readonly PlanFeature[];
  };
  /** How many of each capped thing exist now, counted by the caller. */
  readonly inUse: Readonly<Partial<Record<PlanLimit, number>>>;
  /** Which features the workspace has now, so only a real loss is reported. */
  readonly featuresInUse: Readonly<Record<PlanFeature, boolean>>;
}): PlanChangeConsequences {
  const overCapacity: CapacityExcess[] = [];
  for (const limit of PLAN_LIMITS) {
    const ceiling = input.target.limits[limit];
    const inUse = input.inUse[limit] ?? 0;
    if (ceiling !== undefined && inUse > ceiling) {
      overCapacity.push({ limit, inUse, ceiling });
    }
  }
  const losingFeatures = PLAN_FEATURES.filter((feature) => input.featuresInUse[feature] && !input.target.features.includes(feature));
  return { overCapacity, losingFeatures, clean: overCapacity.length === 0 && losingFeatures.length === 0 };
}
