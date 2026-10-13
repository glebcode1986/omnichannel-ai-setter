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

/**
 * Whether paid work is permitted *now*, which the state alone cannot answer (#40).
 *
 * Two of the permitting states carry their own end date, and the spec says plainly what happens when it
 * passes: at trial expiry without payment, and at the end of a cancelled subscription's paid period,
 * "paid AI generation, automation and transcription stop". A check that read only the state would keep
 * sending for a cancelled workspace until a provider webhook happened to move it — and a delayed reply
 * waiting out its delay can cross either boundary with nothing written at all, which is why the delivery
 * claim re-resolves this rather than comparing row versions.
 *
 * `GRACE` is deliberately left to its state. Its duration is product configuration and its mechanics are
 * provider retry schedules, so the transition out of it belongs to the billing adapter that can see them;
 * inventing an expiry here would guess at a number the spec keeps configurable.
 */
export function paidWorkPermitted(input: {
  readonly state: SubscriptionState;
  readonly periodEndsAt?: Date;
  readonly trialEndsAt?: Date;
  readonly now: Date;
}): boolean {
  if (!allowsPaidWork(input.state)) {
    return false;
  }
  if (input.state === "CANCELED_PENDING_END" && elapsed(input.periodEndsAt, input.now)) {
    // The period that was paid for is over and nothing replaced it.
    return false;
  }
  if (input.state === "TRIALING" && elapsed(input.trialEndsAt, input.now)) {
    return false;
  }
  return true;
}

/** A deadline that has arrived. An absent one has not arrived and never will. */
function elapsed(deadline: Date | undefined, now: Date): boolean {
  return deadline !== undefined && deadline.getTime() <= now.getTime();
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
  /**
   * Whether a plan has ever been chosen for this workspace (#40).
   *
   * Not the same question as `paidWorkAllowed`, and the difference decides what a capacity check may
   * enforce. A workspace that has not started a trial has no plan *stating* a ceiling or a feature, so
   * there is nothing to enforce — which is what lets it create the first Business Profile, the act the
   * accepted trial policy says starts the trial. A workspace whose card failed is a different thing
   * entirely: its plan still states exactly what it states.
   */
  readonly subscribed: boolean;
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
  /** False only for a workspace with no subscription row at all. */
  readonly subscribed?: boolean;
  readonly planCode: string;
  readonly planVersion: number;
  readonly grants: PlanGrants;
  readonly override?: EntitlementOverrideInput;
  readonly periodEndsAt?: Date;
  /** When a trial ends. Read for the same reason the period end is: the state alone cannot say "now". */
  readonly trialEndsAt?: Date;
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
    subscribed: input.subscribed ?? true,
    paidWorkAllowed: paidWorkPermitted({
      state: input.state,
      ...(input.periodEndsAt === undefined ? {} : { periodEndsAt: input.periodEndsAt }),
      ...(input.trialEndsAt === undefined ? {} : { trialEndsAt: input.trialEndsAt }),
      now: input.now,
    }),
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

/** Whether one more of something may be created, and why not when it may not. */
export type CapacityVerdict =
  | { readonly kind: "ALLOWED" }
  /** The plan caps this and the cap is reached. */
  | { readonly kind: "AT_LIMIT"; readonly limit: PlanLimit; readonly ceiling: number; readonly current: number }
  /** The plan does not sell this capability at all, however much room the ceiling would allow. */
  | { readonly kind: "FEATURE_OFF"; readonly feature: PlanFeature };

/**
 * Whether one more of something may be created, as *capacity* rather than as payment (#40).
 *
 * Three decisions are deliberately separated from `withinLimit`, which answers the combined question for
 * callers that only need one yes or no.
 *
 * **Payment is not consulted.** Creating a Business Profile or adding a teammate is configuration, and the
 * spec stops paid AI generation, automation and transcription — not a business reorganizing its own
 * workspace. It also insists the workspace stays usable while a payment is sorted out, and `withinLimit`
 * returning false for every unpaid workspace would make even the first Business Profile impossible.
 *
 * **An absent limit is uncapped**, which is a real answer rather than a missing one: a plan may genuinely
 * not cap a thing. A workspace with no subscription therefore has no stated ceiling — which is what lets
 * it create the first Business Profile, the act the accepted trial policy says *starts* the trial.
 *
 * **A feature and a ceiling are different refusals.** A plan that does not sell multi-member workspaces
 * must not admit a second member merely because it states no seat ceiling.
 */
export function capacityVerdict(input: {
  readonly snapshot: EntitlementSnapshot;
  readonly limit: PlanLimit;
  /** How many exist now, counted by the caller, because only the caller knows what it is counting. */
  readonly current: number;
  /** A feature this capability also requires, checked before the ceiling. */
  readonly requires?: { readonly feature: PlanFeature; readonly from: number };
}): CapacityVerdict {
  if (!input.snapshot.subscribed) {
    // No plan has been chosen yet, so no plan states a ceiling or withholds a feature, and there is
    // nothing here to enforce. The gates that cost money — generation, sending, transcription — refuse
    // this workspace anyway, through `paidWorkAllowed`; configuration is what it is still allowed to do,
    // and connecting its first Business Profile is how it starts a trial at all.
    return { kind: "ALLOWED" };
  }
  const gate = input.requires;
  if (gate !== undefined && input.current >= gate.from && !input.snapshot.features[gate.feature]) {
    return { kind: "FEATURE_OFF", feature: gate.feature };
  }
  const ceiling = input.snapshot.limits[input.limit];
  if (ceiling !== undefined && input.current >= ceiling) {
    return { kind: "AT_LIMIT", limit: input.limit, ceiling, current: input.current };
  }
  return { kind: "ALLOWED" };
}

/**
 * What the commercial state permits, reduced to the facts a send decision may depend on (#40).
 *
 * A separate, tiny value rather than the whole snapshot, for the reason every other `PolicyInput` field is
 * reduced: the policy engine must not be able to reach a plan code, a price or a provider reference, and a
 * decision that could branch on `planCode` would be a commercial package leaking into send safety.
 *
 * Three booleans, because the three refusals are three different conversations with the business — pay,
 * change plan, or wait — and a single "allowed" flag would make them one.
 */
export interface CommercialAccess {
  /** False when paid work must stop: no subscription, or past trial and past grace. */
  readonly paidWorkAllowed: boolean;
  /** Whether the plan includes automated reply generation at all. */
  readonly aiDrafts: boolean;
  /** Whether the plan includes sending without a person looking first. */
  readonly autopilot: boolean;
}

/**
 * The commercial facts, read from a resolved snapshot.
 *
 * `paidWorkAllowed` is carried separately from the features rather than folded into them. A workspace
 * whose card failed still *has* the features its plan grants, and the two answers are different: "your
 * plan does not include this" is fixed by changing plan, "you have not paid" by paying. `featureAllowed`
 * deliberately answers the combined question for callers that only need one yes or no; this keeps them
 * apart for a caller that has to explain itself.
 */
export function commercialAccessOf(snapshot: EntitlementSnapshot): CommercialAccess {
  return {
    paidWorkAllowed: snapshot.paidWorkAllowed,
    aiDrafts: snapshot.features.AI_DRAFTS,
    autopilot: snapshot.features.AUTOPILOT,
  };
}

/**
 * The commercial access of a workspace nothing is known about.
 *
 * Every answer is no. Used where a caller genuinely has no snapshot — and named, rather than written out
 * as three `false`s at each site, so that "we could not establish the entitlement" and "the plan says no"
 * are the same refusal rather than two spellings of it that could drift apart.
 */
export const NO_COMMERCIAL_ACCESS: CommercialAccess = { paidWorkAllowed: false, aiDrafts: false, autopilot: false };

/**
 * Whether a plan positively withholds a capability from *configuration* (#40).
 *
 * The third of the three feature questions, and the distinctions are the point:
 *
 * - `featureAllowed` — may this be *used* right now? Plan **and** payment. This is what gates a provider
 *   call: generation, transcription, an automated send.
 * - `snapshot.features[f]` — does the plan list it? Payment ignored.
 * - `featureWithheld` — does a chosen plan refuse it? Payment ignored, **and** a workspace with no plan
 *   refuses nothing.
 *
 * That last clause is what keeps the product's front door open. Connecting the first channel is how a
 * workspace starts its trial, so a gate that read "no plan, therefore no features" would refuse the one
 * act that would have given it a plan. And a business whose card failed may still reconnect a channel or
 * rename a profile: the spec stops paid AI generation, automation and transcription, and insists the
 * workspace itself stays usable while the payment is sorted out.
 */
export function featureWithheld(snapshot: EntitlementSnapshot, feature: PlanFeature): boolean {
  return snapshot.subscribed && !snapshot.features[feature];
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
