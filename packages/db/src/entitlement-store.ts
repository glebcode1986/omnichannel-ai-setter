/**
 * Where a workspace's commercial state is read and changed (#38, ADR-017).
 *
 * Two rules decide the shape of everything here.
 *
 * **The server is authoritative.** An entitlement check that a browser could influence is not a billing
 * boundary, so this resolves from stored rows and a clock, and returns a snapshot a caller cannot widen.
 *
 * **No provider vocabulary crosses this line.** A provider's identifiers live on `billing_accounts` as
 * opaque strings, and nothing in this file parses, compares or branches on them. Replacing the provider
 * is a change of rows, not of plan semantics.
 *
 * Commercial changes are OWNER-only. An admin runs the business's conversations; what the business is
 * paying for is the owner's, and the spec says so.
 */
import {
  resolveEntitlement,
  type EntitlementOverrideInput,
  type EntitlementSnapshot,
  type PlanFeature,
  type PlanGrants,
  type PlanLimit,
  type SubscriptionState,
  type UsageMetric,
} from "@omnichannel/domain";
import { isPlanFeature, isPlanLimit, isUsageMetric } from "@omnichannel/domain";

import { recordWorkspaceAuditEvent } from "./audit-store";
import type { DbClient } from "./client";
import { requireRole, scopeOf, type WorkspaceContext } from "./tenancy";

/** Commercial changes are the owner's, not an admin's. The spec is explicit and so is this. */
const BILLING_ROLES = ["OWNER"] as const;

export interface PlanVersionInput {
  readonly code: string;
  readonly name: string;
  readonly displayOrder?: number;
  readonly grants: PlanGrants;
  /**
   * Who may subscribe to this version (#43). Defaults to `PRIVATE`: a version is published before anybody
   * decides to advertise it, and a catalogue that appeared on the pricing page the moment it was written
   * would make "publish" and "launch" the same act.
   */
  readonly availability?: CatalogAvailability;
  /**
   * The price book for this version, one entry per currency and interval.
   *
   * A list rather than two amounts and a currency, because that pair could only ever describe one price
   * book. The annual amount is given outright rather than derived: the accepted rule is "pay ten months,
   * receive twelve", and a product that recomputed it would be free to disagree with an invoice a customer
   * already holds.
   */
  readonly prices?: readonly CatalogPriceInput[];
}

/** One price, in one currency, at one interval. */
export interface CatalogPriceInput {
  /** ISO 4217, upper case; a CHECK refuses anything else. */
  readonly currency: string;
  readonly interval: BillingIntervalValue;
  /** Minor units, so no money is ever a float. */
  readonly amountCents: number;
  /** The provider's own price object, opaque: nothing here parses, compares or branches on it. */
  readonly providerPriceId?: string;
}

export type CatalogAvailability = "PUBLIC" | "PRIVATE" | "LEGACY";
export type BillingIntervalValue = "MONTH" | "YEAR" | "ONE_TIME";

export interface PlanVersionRecord {
  readonly planVersionId: string;
  readonly code: string;
  readonly version: number;
  readonly grants: PlanGrants;
}

/**
 * Publishes the next version of a plan, creating the plan if this is its first.
 *
 * Always a new version, never an edit: a workspace subscribes to a version, so changing one would move
 * the terms under every workspace on it. A database trigger enforces the same thing, because a rule that
 * lives only in application code is one a migration or a console session can walk around.
 */
export async function publishPlanVersion(db: DbClient, input: PlanVersionInput): Promise<PlanVersionRecord> {
  return db.$transaction(async (tx) => {
    const plan = await tx.planDefinition.upsert({
      where: { code: input.code },
      create: { code: input.code, name: input.name, displayOrder: input.displayOrder ?? 0 },
      update: { name: input.name, ...(input.displayOrder === undefined ? {} : { displayOrder: input.displayOrder }) },
      select: { id: true, code: true },
    });
    const latest = await tx.planVersion.findFirst({ where: { planId: plan.id }, orderBy: { version: "desc" }, select: { version: true } });
    const version = (latest?.version ?? 0) + 1;
    const row = await tx.planVersion.create({
      data: {
        planId: plan.id,
        version,
        features: [...input.grants.features],
        limits: input.grants.limits,
        quotas: input.grants.quotas,
        ...(input.availability === undefined ? {} : { availability: input.availability }),
      },
      select: { id: true },
    });
    if (input.prices !== undefined && input.prices.length > 0) {
      // Written with the version, in its own transaction: a version whose prices landed separately could
      // be read between the two writes as a plan nobody can be charged for.
      await tx.planPrice.createMany({
        data: input.prices.map((price) => ({
          planVersionId: row.id,
          currency: price.currency,
          interval: price.interval,
          amountCents: price.amountCents,
          ...(price.providerPriceId === undefined ? {} : { providerPriceId: price.providerPriceId }),
        })),
      });
    }
    return { planVersionId: row.id, code: plan.code, version, grants: input.grants };
  });
}

export interface SubscribeInput {
  readonly planVersionId: string;
  readonly state: SubscriptionState;
  readonly periodEndsAt?: Date;
  readonly trialEndsAt?: Date;
  readonly graceStartedAt?: Date;
  readonly canceledAt?: Date;
}

/**
 * Puts a workspace on a plan version, or moves it.
 *
 * The previous state is read before the write so the audit row can say what changed rather than only
 * what it became — "moved to Growth" is a different sentence from "moved from Starter to Growth", and
 * only the second one answers the question somebody is actually asking.
 */
export async function setWorkspaceSubscription(
  db: DbClient,
  context: WorkspaceContext,
  input: SubscribeInput,
): Promise<{ readonly state: SubscriptionState; readonly planVersionId: string }> {
  requireRole(context, BILLING_ROLES, "change the subscription");
  const workspaceId = scopeOf(context);

  return db.$transaction(async (tx) => {
    const before = await tx.workspaceSubscription.findUnique({
      where: { workspaceId },
      select: { state: true, planVersion: { select: { version: true, plan: { select: { code: true } } } } },
    });
    const data = {
      planVersionId: input.planVersionId,
      state: input.state,
      periodEndsAt: input.periodEndsAt ?? null,
      trialEndsAt: input.trialEndsAt ?? null,
      graceStartedAt: input.graceStartedAt ?? null,
      canceledAt: input.canceledAt ?? null,
    };
    await tx.workspaceSubscription.upsert({ where: { workspaceId }, create: { workspaceId, ...data }, update: data });
    const after = await tx.planVersion.findUniqueOrThrow({
      where: { id: input.planVersionId },
      select: { version: true, plan: { select: { code: true } } },
    });

    await recordWorkspaceAuditEvent(tx, context, {
      kind: "SUBSCRIPTION_CHANGED",
      summary: `Subscription ${before === null ? "started" : "changed"}: ${after.plan.code} v${String(after.version)} (${input.state})`,
      subjectType: "Workspace",
      subjectId: workspaceId,
      actorUserId: context.userId,
      // Normalized state and the product's own plan codes. No provider identifier appears here, which is
      // what keeps an audit trail readable after the provider is replaced.
      detail: {
        fromState: before?.state ?? null,
        toState: input.state,
        fromPlan: before === null ? null : `${before.planVersion.plan.code} v${String(before.planVersion.version)}`,
        toPlan: `${after.plan.code} v${String(after.version)}`,
      },
    });
    return { state: input.state, planVersionId: input.planVersionId };
  });
}

/** Grants, replaces or clears a workspace's override. Always audited: a departure is worth explaining. */
export async function setEntitlementOverride(
  db: DbClient,
  context: WorkspaceContext,
  input: { readonly override: EntitlementOverrideInput; readonly reason: string } | undefined,
): Promise<void> {
  requireRole(context, BILLING_ROLES, "change entitlement overrides");
  const workspaceId = scopeOf(context);

  await db.$transaction(async (tx) => {
    if (input === undefined) {
      await tx.entitlementOverride.deleteMany({ where: { workspaceId } });
      await recordWorkspaceAuditEvent(tx, context, {
        kind: "ENTITLEMENT_OVERRIDDEN",
        summary: "Entitlement override removed",
        subjectType: "Workspace",
        subjectId: workspaceId,
        actorUserId: context.userId,
        detail: { removed: true },
      });
      return;
    }
    const data = {
      features: input.override.features ?? {},
      limits: input.override.limits ?? {},
      quotas: input.override.quotas ?? {},
      reason: input.reason,
      grantedByUserId: context.userId,
      expiresAt: input.override.expiresAt ?? null,
    };
    await tx.entitlementOverride.upsert({ where: { workspaceId }, create: { workspaceId, ...data }, update: data });
    await recordWorkspaceAuditEvent(tx, context, {
      kind: "ENTITLEMENT_OVERRIDDEN",
      summary: `Entitlement override granted: ${input.reason}`,
      subjectType: "Workspace",
      subjectId: workspaceId,
      actorUserId: context.userId,
      detail: { features: data.features, limits: data.limits, quotas: data.quotas, expiresAt: data.expiresAt },
    });
  });
}

/**
 * The effective entitlement for a workspace at one instant.
 *
 * Takes the workspace id rather than a context, because the callers that matter most are server-side
 * checks with no session: the delivery coordinator revalidating immediately before a delayed send, and
 * the worker deciding whether to transcribe. Inventing an authorization context so those would type-check
 * is how a background path acquires authority nobody granted.
 *
 * A workspace with no subscription row is `INACTIVE` on no plan rather than an error. That is the honest
 * description of a workspace that has not started a trial, and it is also the safe one: every feature
 * check answers no.
 */
export async function readEntitlement(db: DbClient, workspaceId: string, now: Date): Promise<EntitlementSnapshot> {
  const [subscription, override, addOns] = await Promise.all([
    db.workspaceSubscription.findUnique({
      where: { workspaceId },
      select: {
        state: true,
        periodEndsAt: true,
        // Read with the period end, because a trial that has expired stops paid work exactly as a
        // cancelled period that has ended does, and the state says neither (#40).
        trialEndsAt: true,
        planVersion: { select: { version: true, features: true, limits: true, quotas: true, plan: { select: { code: true } } } },
      },
    }),
    db.entitlementOverride.findUnique({ where: { workspaceId }, select: { features: true, limits: true, quotas: true, expiresAt: true } }),
    // Recurring capacity the workspace is paying for *at this instant* (#43). A removal takes effect at
    // the end of the paid period, so the row is dated rather than deleted and the window is read rather
    // than assumed.
    db.workspaceAddOn.findMany({
      where: { workspaceId, activeFrom: { lte: now }, OR: [{ activeUntil: null }, { activeUntil: { gt: now } }] },
      select: { quantity: true, addOnVersion: { select: { limits: true, kind: true } } },
    }),
  ]);
  const purchasedCapacity = addOns
    .filter((row) => row.addOnVersion.kind === "RECURRING_CAPACITY")
    .map((row) => ({ limits: numbersOf(row.addOnVersion.limits, isPlanLimit), quantity: row.quantity }));

  if (subscription === null) {
    return resolveEntitlement({
      workspaceId,
      state: "INACTIVE",
      planCode: "none",
      planVersion: 0,
      // No plan has been chosen, which a capacity check has to be able to tell from a plan that chose
      // zero (#40): the first is a workspace that has not started its trial, the second is one that has
      // reached a ceiling somebody agreed to.
      subscribed: false,
      grants: { features: [], limits: {}, quotas: {} },
      now,
    });
  }

  return resolveEntitlement({
    workspaceId,
    state: subscription.state,
    planCode: subscription.planVersion.plan.code,
    planVersion: subscription.planVersion.version,
    grants: {
      features: subscription.planVersion.features.filter(isPlanFeature),
      limits: numbersOf(subscription.planVersion.limits, isPlanLimit),
      quotas: numbersOf(subscription.planVersion.quotas, isUsageMetric),
    },
    ...(override === null
      ? {}
      : {
          override: {
            features: booleansOf(override.features, isPlanFeature),
            limits: numbersOf(override.limits, isPlanLimit),
            quotas: numbersOf(override.quotas, isUsageMetric),
            ...(override.expiresAt === null ? {} : { expiresAt: override.expiresAt }),
          },
        }),
    ...(purchasedCapacity.length === 0 ? {} : { addOns: purchasedCapacity }),
    ...(subscription.periodEndsAt === null ? {} : { periodEndsAt: subscription.periodEndsAt }),
    ...(subscription.trialEndsAt === null ? {} : { trialEndsAt: subscription.trialEndsAt }),
    now,
  });
}

/**
 * Reads a JSON map into the domain's own keys, dropping anything it does not recognise.
 *
 * A checked read rather than a cast. These columns are JSON written by an earlier release, so a key that
 * no longer exists, or one a console session invented, must not become an entitlement — the alternative
 * is a plan granting a feature the product has never heard of.
 */
function numbersOf<K extends PlanLimit | UsageMetric>(stored: unknown, isKey: (value: string) => value is K): Partial<Record<K, number>> {
  const row = typeof stored === "object" && stored !== null && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {};
  const result: Partial<Record<K, number>> = {};
  for (const [key, value] of Object.entries(row)) {
    if (isKey(key) && typeof value === "number" && Number.isFinite(value) && value >= 0) {
      result[key] = value;
    }
  }
  return result;
}

function booleansOf<K extends PlanFeature>(stored: unknown, isKey: (value: string) => value is K): Partial<Record<K, boolean>> {
  const row = typeof stored === "object" && stored !== null && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {};
  const result: Partial<Record<K, boolean>> = {};
  for (const [key, value] of Object.entries(row)) {
    if (isKey(key) && typeof value === "boolean") {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Records the opaque identifiers a provider adapter needs.
 *
 * The only place they are written, and nothing reads them except the adapter that put them there. They
 * are stored beside the workspace rather than inside the subscription because a workspace may pay one
 * term through one provider and a later term through another, and the plan it is on does not change when
 * it does.
 */
export async function setBillingAccount(
  db: DbClient,
  context: WorkspaceContext,
  input: { readonly provider: string; readonly providerCustomerId?: string; readonly providerSubscriptionId?: string },
): Promise<void> {
  requireRole(context, BILLING_ROLES, "change billing provider details");
  const workspaceId = scopeOf(context);
  const data = {
    provider: input.provider,
    providerCustomerId: input.providerCustomerId ?? null,
    providerSubscriptionId: input.providerSubscriptionId ?? null,
  };
  await db.billingAccount.upsert({ where: { workspaceId }, create: { workspaceId, ...data }, update: data });
}
