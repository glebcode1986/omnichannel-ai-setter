/**
 * Everything a billing screen shows, read in one pass (#42).
 *
 * One read rather than six, for the reason the Inbox and the Style screen assemble theirs the same way: a
 * page built from several independent reads can render a plan from one instant beside a usage figure from
 * another, and a person reading "you are over your limit" next to a limit that has already changed has
 * been told something untrue about their own account.
 *
 * Two things are deliberately *absent* from what this returns, and their absence is the point:
 *
 * - **no provider identifiers.** `readCatalog` carries `providerPriceId` because a checkout needs it; a
 *   screen does not, and a value that reaches a page can reach a view-source. Nothing here copies one, so
 *   "no provider-sensitive data is rendered" is a property of the type rather than a rule somebody has to
 *   remember while editing a component later.
 * - **no AI-reply allowance.** Core generation is customer-facing unmetered, so only metrics a plan
 *   actually sells appear here. The internal generation counter stays where it is, visible to operations
 *   rather than presented to a customer as a bill.
 *
 * It reads and returns. Nothing here changes a subscription, and the browser is never the authority: the
 * state on this screen is the server's answer at `at`, not whatever a checkout redirect claimed.
 */
import {
  allowanceState,
  commercialAccessOf,
  USAGE_METRICS,
  type AllowanceState,
  type CommercialAccess,
  type EntitlementSnapshot,
  type PlanFeature,
  type PlanLimit,
  type SubscriptionState,
  type UsageMetric,
} from "@omnichannel/domain";

import { readCatalog, readTopUpBalance, type AddOnKindValue } from "./catalog-store";
import type { DbClient } from "./client";
import { readEntitlement, type BillingIntervalValue } from "./entitlement-store";
import { readUsage } from "./usage-store";

/** A price as a screen may show it: an amount, a currency and how often. Never a provider's own object. */
export interface DisplayPrice {
  readonly currency: string;
  readonly interval: BillingIntervalValue;
  /** Minor units, so the page formats money rather than inheriting a float. */
  readonly amountCents: number;
}

export interface SubscriptionSummary {
  readonly state: SubscriptionState;
  readonly planCode: string;
  readonly planName: string;
  readonly planVersion: number;
  /** When the current paid or trial period ends, which is when a cancellation or a trial actually bites. */
  readonly periodEndsAt?: Date;
  readonly trialEndsAt?: Date;
  readonly graceStartedAt?: Date;
  /** Set once a cancellation has been requested; the period above is when it takes effect. */
  readonly canceledAt?: Date;
  readonly prices: readonly DisplayPrice[];
}

export interface CapacityUse {
  readonly limit: PlanLimit;
  readonly inUse: number;
  /** Absent means the plan does not cap this at all, which is a real answer rather than a missing one. */
  readonly ceiling?: number;
}

export interface ActiveAddOn {
  readonly code: string;
  readonly name: string;
  readonly kind: AddOnKindValue;
  readonly quantity: number;
  /** When it stops granting, where a removal has already been requested. */
  readonly activeUntil?: Date;
}

export interface AllowanceSummary extends AllowanceState {
  readonly metric: UsageMetric;
  /** When the cycle turns over and the included half resets. */
  readonly resetsAt: Date;
  /** When the soonest bought balance lapses, where any is held. */
  readonly purchaseExpiresAt?: Date;
}

export interface BillingOverview {
  /** Absent for a workspace that has never been on a plan: pre-trial, not lapsed. */
  readonly subscription?: SubscriptionSummary;
  readonly entitlement: EntitlementSnapshot;
  /** The three booleans a send decision is made from, so a screen can explain what has stopped and why. */
  readonly access: CommercialAccess;
  readonly capacity: readonly CapacityUse[];
  readonly allowances: readonly AllowanceSummary[];
  readonly addOns: readonly ActiveAddOn[];
  /** The public catalogue, for comparison. Prices only; no provider references. */
  readonly offers: readonly {
    readonly planVersionId: string;
    readonly code: string;
    readonly name: string;
    readonly version: number;
    readonly features: readonly PlanFeature[];
    readonly limits: Readonly<Partial<Record<PlanLimit, number>>>;
    readonly quotas: Readonly<Partial<Record<UsageMetric, number>>>;
    readonly prices: readonly DisplayPrice[];
    readonly current: boolean;
  }[];
  /** The instant every number above was read at, so a page can say when it last knew. */
  readonly readAt: Date;
}

export async function readBillingOverview(db: DbClient, workspaceId: string, at = new Date()): Promise<BillingOverview> {
  const [entitlement, subscription, catalog, usage, addOnRows, profiles, seats] = await Promise.all([
    readEntitlement(db, workspaceId, at),
    db.workspaceSubscription.findUnique({
      where: { workspaceId },
      select: {
        state: true,
        periodEndsAt: true,
        trialEndsAt: true,
        graceStartedAt: true,
        canceledAt: true,
        planVersionId: true,
        planVersion: {
          select: {
            version: true,
            plan: { select: { code: true, name: true } },
            prices: { select: { currency: true, interval: true, amountCents: true } },
          },
        },
      },
    }),
    readCatalog(db),
    readUsage(db, workspaceId, at),
    db.workspaceAddOn.findMany({
      where: { workspaceId, activeFrom: { lte: at }, OR: [{ activeUntil: null }, { activeUntil: { gt: at } }] },
      select: { quantity: true, activeUntil: true, addOnVersion: { select: { kind: true, addOn: { select: { code: true, name: true } } } } },
    }),
    // Counted rather than inferred from the entitlement: a ceiling says what is allowed, and only a count
    // says what exists. The two differ exactly when somebody needs to be told about it.
    db.businessProfile.count({ where: { workspaceId } }),
    db.workspaceMember.count({ where: { workspaceId } }),
  ]);

  const inUse: Partial<Record<PlanLimit, number>> = { BUSINESS_PROFILES: profiles, SEATS: seats };
  const allowances: AllowanceSummary[] = [];
  for (const metric of USAGE_METRICS) {
    const included = entitlement.quotas[metric];
    if (included === undefined) {
      // The plan does not sell this, so there is no allowance to report. Rendering a zero would read as
      // "you have used it all", which is a different sentence and a different thing to do about it.
      continue;
    }
    const purchased = await readTopUpBalance(db, workspaceId, metric, at);
    const counter = usage.counters[metric];
    allowances.push({
      metric,
      resetsAt: usage.cycle.endsAt,
      ...(purchased.nextExpiryAt === undefined ? {} : { purchaseExpiresAt: purchased.nextExpiryAt }),
      ...allowanceState({
        included,
        purchased: purchased.remaining,
        // What is held by a reservation is spent as far as a person is concerned: it is not available to
        // them, and reporting it as free would promise room that the next recording will take.
        used: (counter?.committed ?? 0) + (counter?.reserved ?? 0),
      }),
    });
  }

  return {
    ...(subscription === null
      ? {}
      : {
          subscription: {
            state: subscription.state,
            planCode: subscription.planVersion.plan.code,
            planName: subscription.planVersion.plan.name,
            planVersion: subscription.planVersion.version,
            ...(subscription.periodEndsAt === null ? {} : { periodEndsAt: subscription.periodEndsAt }),
            ...(subscription.trialEndsAt === null ? {} : { trialEndsAt: subscription.trialEndsAt }),
            ...(subscription.graceStartedAt === null ? {} : { graceStartedAt: subscription.graceStartedAt }),
            ...(subscription.canceledAt === null ? {} : { canceledAt: subscription.canceledAt }),
            prices: subscription.planVersion.prices.map(toDisplayPrice),
          },
        }),
    entitlement,
    access: commercialAccessOf(entitlement),
    capacity: (["BUSINESS_PROFILES", "SEATS"] as const).map((limit) => ({
      limit,
      inUse: inUse[limit] ?? 0,
      ...(entitlement.limits[limit] === undefined ? {} : { ceiling: entitlement.limits[limit] }),
    })),
    allowances,
    addOns: addOnRows.map((row) => ({
      code: row.addOnVersion.addOn.code,
      name: row.addOnVersion.addOn.name,
      kind: row.addOnVersion.kind,
      quantity: row.quantity,
      ...(row.activeUntil === null ? {} : { activeUntil: row.activeUntil }),
    })),
    offers: catalog.plans.map((plan) => ({
      planVersionId: plan.planVersionId,
      code: plan.code,
      name: plan.name,
      version: plan.version,
      features: plan.features.filter(isPlanFeatureName),
      limits: plan.limits,
      quotas: plan.quotas,
      // Mapped rather than passed through, which is what drops `providerPriceId` on the floor.
      prices: plan.prices.map(toDisplayPrice),
      current: subscription?.planVersionId === plan.planVersionId,
    })),
    readAt: at,
  };
}

/**
 * Copies only what a page may see. The provider's own price object stops here, by construction.
 *
 * No cast: both sources already carry the interval as the three values the column admits — the catalogue
 * read narrowed it once, and a Prisma enum arrives as its own union. Widening the parameter to `string`
 * would have made this the second place that decided what an interval can be.
 */
function toDisplayPrice(price: { currency: string; interval: BillingIntervalValue; amountCents: number }): DisplayPrice {
  return { currency: price.currency, interval: price.interval, amountCents: price.amountCents };
}

/**
 * A checked read of a stored feature name.
 *
 * The column is a string array, so a name nobody defined is a runtime possibility — and a screen that
 * rendered one would be showing a stranger's text as a plan's contents.
 */
function isPlanFeatureName(value: string): value is PlanFeature {
  return (PLAN_FEATURE_NAMES as readonly string[]).includes(value);
}

const PLAN_FEATURE_NAMES: readonly PlanFeature[] = [
  "AI_DRAFTS",
  "AUTOPILOT",
  "INSTAGRAM",
  "WHATSAPP",
  "WHATSAPP_TEMPLATE_AUTOPILOT",
  "VOICE_TRANSCRIPTION",
  "ADVANCED_ANALYTICS",
  "MULTI_MEMBER",
];
