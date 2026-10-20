/**
 * What a workspace is allowed to do, as the product understands it (#38, ADR-017).
 *
 * The whole point of this file is that none of it is a payment provider's vocabulary. A provider has its
 * own statuses, its own price objects and its own ideas about what a subscription is; those belong in an
 * adapter, and the moment one of them reaches a feature check the product is married to that provider.
 * So the names here are the product's own, and `packages/domain` has no dependency that could offer
 * another set.
 *
 * Three kinds of entitlement, because they are enforced differently and failing to separate them is how
 * a capacity limit ends up being checked once a month:
 *
 * - a **feature** is on or off, and is asked before an action;
 * - a **limit** is a ceiling on things that exist at once, and is asked before creating one more;
 * - a **quota** is an allowance consumed over a period, and is asked before spending some.
 */
import { literalGuard } from "./enum";

/**
 * Features a plan may switch on.
 *
 * Deliberately not a list of screens. A feature is something the server refuses to do, so each of these
 * names an action with a side effect rather than a page somebody can look at — hiding a page is
 * convenience, and the spec is explicit that it is never the billing boundary.
 */
export const PLAN_FEATURES = [
  "AI_DRAFTS",
  "AUTOPILOT",
  "INSTAGRAM",
  "WHATSAPP",
  "WHATSAPP_TEMPLATE_AUTOPILOT",
  "VOICE_TRANSCRIPTION",
  "ADVANCED_ANALYTICS",
  "MULTI_MEMBER",
] as const;
export type PlanFeature = (typeof PLAN_FEATURES)[number];
export const isPlanFeature = literalGuard(PLAN_FEATURES);

/** Ceilings on things that exist at once. Checked before creating one more, never after. */
export const PLAN_LIMITS = ["BUSINESS_PROFILES", "SEATS", "ANALYTICS_RETENTION_DAYS"] as const;
export type PlanLimit = (typeof PLAN_LIMITS)[number];
export const isPlanLimit = literalGuard(PLAN_LIMITS);

/**
 * Allowances consumed over a period.
 *
 * One today, and that is a product decision rather than a gap: core AI replies are included and
 * unmetered in the public plans, so putting a quota on them here would describe a product this is not.
 * The ledger still counts generations internally (#39), which is a different thing from a customer-facing
 * allowance and must not be confused with one.
 */
export const USAGE_METRICS = ["VOICE_TRANSCRIPTION_SECONDS"] as const;
export type UsageMetric = (typeof USAGE_METRICS)[number];
export const isUsageMetric = literalGuard(USAGE_METRICS);

/**
 * The normalized subscription states.
 *
 * Providers have their own, and they disagree with each other; these are the six the product reasons
 * about. A provider status maps into one of them inside the billing adapter, and no feature check ever
 * sees the original string.
 */
export const SUBSCRIPTION_STATES = ["TRIALING", "ACTIVE", "PAST_DUE", "GRACE", "CANCELED_PENDING_END", "INACTIVE"] as const;
export type SubscriptionState = (typeof SUBSCRIPTION_STATES)[number];
export const isSubscriptionState = literalGuard(SUBSCRIPTION_STATES);

/**
 * The states in which a workspace may still do paid work.
 *
 * `PAST_DUE` and `GRACE` are both in, and that is the accepted product policy rather than an oversight:
 * a renewal that failed on Tuesday must not stop a business answering its customers on Wednesday, and the
 * spec gives three days to fix it. `CANCELED_PENDING_END` is in because the period was already paid for.
 */
export const PAID_ACCESS_STATES: readonly SubscriptionState[] = ["TRIALING", "ACTIVE", "PAST_DUE", "GRACE", "CANCELED_PENDING_END"];

export function allowsPaidWork(state: SubscriptionState): boolean {
  return PAID_ACCESS_STATES.includes(state);
}

/** An immutable description of what one plan version grants. */
export interface PlanGrants {
  readonly features: readonly PlanFeature[];
  /** Ceilings. An absent limit means the plan does not cap that thing at all. */
  readonly limits: Readonly<Partial<Record<PlanLimit, number>>>;
  /** Period allowances. An absent metric means the plan includes none of it. */
  readonly quotas: Readonly<Partial<Record<UsageMetric, number>>>;
}

/**
 * A deliberate departure from a plan, for one workspace.
 *
 * Support grants one, a sales agreement needs one, an incident is apologised for with one. It is separate
 * from the plan because folding it in would mean editing a plan version — and a plan version is
 * immutable precisely so that the thousand workspaces on it do not move when one of them is helped.
 */
export interface EntitlementOverrideInput {
  readonly features?: Readonly<Partial<Record<PlanFeature, boolean>>>;
  readonly limits?: Readonly<Partial<Record<PlanLimit, number>>>;
  readonly quotas?: Readonly<Partial<Record<UsageMetric, number>>>;
  /** When the override stops applying. Absent means it stands until somebody removes it. */
  readonly expiresAt?: Date;
}

/** Everything a server-side check needs, resolved for one instant. */
export interface EntitlementSnapshot {
  readonly workspaceId: string;
  readonly state: SubscriptionState;
  /** Which plan version produced this, so a decision can be explained afterwards. */
  readonly planCode: string;
  readonly planVersion: number;
  /** False when paid work must stop; capacity and features below are still reported honestly. */
  readonly paidWorkAllowed: boolean;
  readonly features: Readonly<Record<PlanFeature, boolean>>;
  readonly limits: Readonly<Partial<Record<PlanLimit, number>>>;
  readonly quotas: Readonly<Partial<Record<UsageMetric, number>>>;
  /** When the current period ends, which is when a cancellation or a trial actually bites. */
  readonly periodEndsAt?: Date;
  readonly resolvedAt: Date;
}

export interface ResolveEntitlementInput {
  readonly workspaceId: string;
  readonly state: SubscriptionState;
  readonly planCode: string;
  readonly planVersion: number;
  readonly grants: PlanGrants;
  readonly override?: EntitlementOverrideInput;
  readonly periodEndsAt?: Date;
  readonly now: Date;
}

/**
 * The effective entitlement, from the plan and whatever was granted on top.
 *
 * Pure, and that is what makes it testable and what keeps it honest: it reads no database, calls no
 * provider, and cannot therefore be "mostly right except when the network is slow".
 *
 * **An expired override is not applied.** It is kept on the row so an operator can see what was granted
 * and when it lapsed, but a snapshot resolved after its expiry reports the plan — otherwise a temporary
 * concession becomes permanent by nobody remembering to delete it.
 *
 * **A workspace with no paid access keeps its reported capacity.** The features and limits still describe
 * what the plan grants; `paidWorkAllowed` is the separate fact that stops new paid work. Zeroing the
 * numbers would make "you are over your limit" and "you have not paid" the same message, and they need
 * different answers from the person reading them.
 */
export function resolveEntitlement(input: ResolveEntitlementInput): EntitlementSnapshot {
  const override = input.override !== undefined && !expired(input.override, input.now) ? input.override : undefined;

  const features = Object.fromEntries(
    PLAN_FEATURES.map((feature) => [feature, override?.features?.[feature] ?? input.grants.features.includes(feature)]),
  ) as Record<PlanFeature, boolean>;

  const limits: Partial<Record<PlanLimit, number>> = {};
  for (const limit of PLAN_LIMITS) {
    const value = override?.limits?.[limit] ?? input.grants.limits[limit];
    if (value !== undefined) {
      limits[limit] = value;
    }
  }

  const quotas: Partial<Record<UsageMetric, number>> = {};
  for (const metric of USAGE_METRICS) {
    const value = override?.quotas?.[metric] ?? input.grants.quotas[metric];
    if (value !== undefined) {
      quotas[metric] = value;
    }
  }

  return {
    workspaceId: input.workspaceId,
    state: input.state,
    planCode: input.planCode,
    planVersion: input.planVersion,
    paidWorkAllowed: allowsPaidWork(input.state),
    features,
    limits,
    quotas,
    ...(input.periodEndsAt === undefined ? {} : { periodEndsAt: input.periodEndsAt }),
    resolvedAt: input.now,
  };
}

function expired(override: EntitlementOverrideInput, now: Date): boolean {
  return override.expiresAt !== undefined && override.expiresAt.getTime() <= now.getTime();
}

/** Whether a feature may be used right now. Both halves: the plan grants it *and* paid work is allowed. */
export function featureAllowed(snapshot: EntitlementSnapshot, feature: PlanFeature): boolean {
  return snapshot.paidWorkAllowed && snapshot.features[feature];
}

/**
 * Whether one more of something may be created.
 *
 * `current` is what exists now, counted by the caller, because only the caller knows what it is counting.
 * An absent limit is uncapped — which is a real answer, not a missing one: a plan may genuinely not cap
 * a thing, and treating "no limit" as zero would make every such plan useless.
 */
export function withinLimit(snapshot: EntitlementSnapshot, limit: PlanLimit, current: number): boolean {
  if (!snapshot.paidWorkAllowed) {
    return false;
  }
  const ceiling = snapshot.limits[limit];
  return ceiling === undefined || current < ceiling;
}
