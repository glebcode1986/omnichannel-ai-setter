/**
 * The commercial catalogue: plans, add-ons, their prices and what a workspace has bought (#43).
 *
 * Three rules shape everything here, and all three come from `PRICING_PACKAGING.md` rather than from
 * convenience.
 *
 * **Nothing is inferred from a name or a provider identifier.** A plan's entitlements come from its
 * version's own grants; `providerPriceId` is an opaque string this file never parses, compares or branches
 * on. That is what lets the payment provider change between terms without changing the plan model.
 *
 * **Versions are immutable and stay interpretable for ever.** A workspace buys a version, so re-pricing or
 * re-packaging publishes a new one; triggers refuse an edit or a delete on either table. A `LEGACY` version
 * is withdrawn from sale and still honoured, which is what grandfathering means.
 *
 * **An add-on grants capacity or allowance and never upgrades the feature class.** A business on Starter
 * with three extra Business Profiles is still on Starter: nothing in this file can add a *feature*, and the
 * CHECK on `addon_versions` makes a row that tried to unrepresentable rather than merely discouraged.
 */
import { isPlanLimit, isUsageMetric, type PlanLimit, type UsageMetric } from "@omnichannel/domain";

import type { DbClient, DbExecutor } from "./client";
import { DbInputError } from "./errors";
import { requireRole, scopeOf, type WorkspaceContext } from "./tenancy";
import type { BillingIntervalValue, CatalogAvailability, CatalogPriceInput } from "./entitlement-store";

/** Buying and removing an add-on is a commercial change, which the spec makes the owner's. */
const BILLING_ROLES = ["OWNER"] as const;

export type AddOnKindValue = "RECURRING_CAPACITY" | "ONE_TIME_ALLOWANCE";

export interface AddOnVersionInput {
  readonly code: string;
  readonly name: string;
  readonly displayOrder?: number;
  readonly kind: AddOnKindValue;
  readonly availability?: CatalogAvailability;
  /** Capacity this grants, per unit bought. Required for recurring capacity, refused for a top-up. */
  readonly limits?: Readonly<Partial<Record<PlanLimit, number>>>;
  /** Allowance this grants, per unit bought. Required for a top-up, refused for recurring capacity. */
  readonly quotas?: Readonly<Partial<Record<UsageMetric, number>>>;
  readonly prices?: readonly CatalogPriceInput[];
}

export interface AddOnVersionRecord {
  readonly addOnVersionId: string;
  readonly code: string;
  readonly version: number;
  readonly kind: AddOnKindValue;
}

/**
 * Publishes the next version of an add-on, creating the add-on if this is its first.
 *
 * The kind and the grants have to agree, and the pairing is checked here as well as by a CHECK: a caller
 * that passed capacity for a top-up has described a product nobody priced, and saying so with a sentence
 * is more useful than a constraint violation.
 */
export async function publishAddOnVersion(db: DbClient, input: AddOnVersionInput): Promise<AddOnVersionRecord> {
  const limits = input.limits ?? {};
  const quotas = input.quotas ?? {};
  if (input.kind === "RECURRING_CAPACITY" && (Object.keys(limits).length === 0 || Object.keys(quotas).length > 0)) {
    throw new DbInputError("limits", "recurring capacity grants capacity and nothing else");
  }
  if (input.kind === "ONE_TIME_ALLOWANCE" && (Object.keys(quotas).length === 0 || Object.keys(limits).length > 0)) {
    throw new DbInputError("quotas", "a one-time top-up grants allowance and nothing else");
  }
  // A top-up is bought once and a capacity add-on recurs. Priced the other way round, the catalogue would
  // describe a subscription nobody can cancel or a one-off charge that never stops.
  const wrongInterval = (input.prices ?? []).find((price) =>
    input.kind === "ONE_TIME_ALLOWANCE" ? price.interval !== "ONE_TIME" : price.interval === "ONE_TIME",
  );
  if (wrongInterval !== undefined) {
    throw new DbInputError("prices", `a ${input.kind} add-on cannot be priced at ${wrongInterval.interval}`);
  }

  return db.$transaction(async (tx) => {
    const addOn = await tx.addOnDefinition.upsert({
      where: { code: input.code },
      create: { code: input.code, name: input.name, displayOrder: input.displayOrder ?? 0 },
      update: { name: input.name, ...(input.displayOrder === undefined ? {} : { displayOrder: input.displayOrder }) },
      select: { id: true, code: true },
    });
    const latest = await tx.addOnVersion.findFirst({ where: { addOnId: addOn.id }, orderBy: { version: "desc" }, select: { version: true } });
    const version = (latest?.version ?? 0) + 1;
    const row = await tx.addOnVersion.create({
      data: {
        addOnId: addOn.id,
        version,
        kind: input.kind,
        limits,
        quotas,
        ...(input.availability === undefined ? {} : { availability: input.availability }),
      },
      select: { id: true },
    });
    if (input.prices !== undefined && input.prices.length > 0) {
      await tx.addOnPrice.createMany({
        data: input.prices.map((price) => ({
          addOnVersionId: row.id,
          currency: price.currency,
          interval: price.interval,
          amountCents: price.amountCents,
          ...(price.providerPriceId === undefined ? {} : { providerPriceId: price.providerPriceId }),
        })),
      });
    }
    return { addOnVersionId: row.id, code: addOn.code, version, kind: input.kind };
  });
}

export interface CatalogPrice {
  readonly currency: string;
  readonly interval: BillingIntervalValue;
  readonly amountCents: number;
  /** Present only where a provider has been integrated; opaque to everything that reads it. */
  readonly providerPriceId?: string;
}

export interface CatalogPlan {
  readonly planVersionId: string;
  readonly code: string;
  readonly name: string;
  readonly version: number;
  readonly availability: CatalogAvailability;
  readonly displayOrder: number;
  readonly features: readonly string[];
  readonly limits: Readonly<Partial<Record<PlanLimit, number>>>;
  readonly quotas: Readonly<Partial<Record<UsageMetric, number>>>;
  readonly prices: readonly CatalogPrice[];
}

export interface CatalogAddOn {
  readonly addOnVersionId: string;
  readonly code: string;
  readonly name: string;
  readonly version: number;
  readonly kind: AddOnKindValue;
  readonly availability: CatalogAvailability;
  readonly displayOrder: number;
  readonly limits: Readonly<Partial<Record<PlanLimit, number>>>;
  readonly quotas: Readonly<Partial<Record<UsageMetric, number>>>;
  readonly prices: readonly CatalogPrice[];
}

export interface Catalog {
  readonly plans: readonly CatalogPlan[];
  readonly addOns: readonly CatalogAddOn[];
}

/**
 * The catalogue, as a pricing page or a settings screen reads it.
 *
 * `availability` is a filter rather than a flag on the rows returned: a page that received every version
 * and decided for itself which to show would be a second place the rule lived. The newest version of each
 * product is returned, because that is the one on sale — a `LEGACY` listing is for explaining a
 * grandfathered subscription, not for offering it.
 */
export async function readCatalog(db: DbExecutor, availability: readonly CatalogAvailability[] = ["PUBLIC"]): Promise<Catalog> {
  const [planRows, addOnRows] = await Promise.all([
    db.planVersion.findMany({
      where: { availability: { in: [...availability] } },
      orderBy: [{ plan: { displayOrder: "asc" } }, { version: "desc" }],
      select: {
        id: true,
        version: true,
        availability: true,
        features: true,
        limits: true,
        quotas: true,
        plan: { select: { code: true, name: true, displayOrder: true } },
        prices: { select: { currency: true, interval: true, amountCents: true, providerPriceId: true } },
      },
    }),
    db.addOnVersion.findMany({
      where: { availability: { in: [...availability] } },
      orderBy: [{ addOn: { displayOrder: "asc" } }, { version: "desc" }],
      select: {
        id: true,
        version: true,
        kind: true,
        availability: true,
        limits: true,
        quotas: true,
        addOn: { select: { code: true, name: true, displayOrder: true } },
        prices: { select: { currency: true, interval: true, amountCents: true, providerPriceId: true } },
      },
    }),
  ]);

  return {
    plans: newestPerProduct(planRows, (row) => row.plan.code).map((row) => ({
      planVersionId: row.id,
      code: row.plan.code,
      name: row.plan.name,
      version: row.version,
      availability: row.availability,
      displayOrder: row.plan.displayOrder,
      features: row.features,
      limits: numbersOf(row.limits, isPlanLimit),
      quotas: numbersOf(row.quotas, isUsageMetric),
      prices: row.prices.map(toPrice),
    })),
    addOns: newestPerProduct(addOnRows, (row) => row.addOn.code).map((row) => ({
      addOnVersionId: row.id,
      code: row.addOn.code,
      name: row.addOn.name,
      version: row.version,
      kind: row.kind,
      availability: row.availability,
      displayOrder: row.addOn.displayOrder,
      limits: numbersOf(row.limits, isPlanLimit),
      quotas: numbersOf(row.quotas, isUsageMetric),
      prices: row.prices.map(toPrice),
    })),
  };
}

/**
 * The newest version of each product, from a list already ordered newest-first within a product.
 *
 * A `Map` keyed on the stable code, not on the display name: two products may share a name across a
 * rename, and the code is the thing that identifies one.
 */
function newestPerProduct<T>(rows: readonly T[], codeOf: (row: T) => string): readonly T[] {
  const newest = new Map<string, T>();
  for (const row of rows) {
    if (!newest.has(codeOf(row))) {
      newest.set(codeOf(row), row);
    }
  }
  return [...newest.values()];
}

function toPrice(price: { currency: string; interval: string; amountCents: number; providerPriceId: string | null }): CatalogPrice {
  return {
    currency: price.currency,
    interval: price.interval as BillingIntervalValue,
    amountCents: price.amountCents,
    ...(price.providerPriceId === null ? {} : { providerPriceId: price.providerPriceId }),
  };
}

/**
 * A checked read of a JSON grant column.
 *
 * The same shape `entitlement-store` uses, and for the same reason: the column is JSON, so its keys are a
 * runtime question, and a key nobody defined must be dropped rather than carried into a decision.
 */
function numbersOf<K extends string>(value: unknown, isKey: (key: string) => key is K): Readonly<Partial<Record<K, number>>> {
  const empty: Partial<Record<K, number>> = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return empty;
  }
  const out: Partial<Record<K, number>> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isKey(key) && typeof entry === "number" && Number.isFinite(entry)) {
      out[key] = entry;
    }
  }
  return out;
}

/**
 * Records that a workspace is paying for a recurring add-on, or changes how many of it.
 *
 * Quantity rather than one row per unit: "three extra seats" is one decision somebody made, and three
 * rows would make removing one of them ambiguous. Refused for a top-up, which is not something a
 * workspace *has* — it is a balance, and `grantUsageTopUp` is how one arrives.
 */
export async function setWorkspaceAddOn(
  db: DbClient,
  context: WorkspaceContext,
  input: { readonly addOnVersionId: string; readonly quantity: number; readonly activeFrom?: Date },
): Promise<void> {
  requireRole(context, BILLING_ROLES, "change add-ons");
  const workspaceId = scopeOf(context);
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1) {
    throw new DbInputError("quantity", "must be at least one");
  }
  const version = await db.addOnVersion.findUnique({ where: { id: input.addOnVersionId }, select: { kind: true } });
  if (version === null) {
    throw new DbInputError("addOnVersionId", "must be a published add-on version");
  }
  if (version.kind !== "RECURRING_CAPACITY") {
    throw new DbInputError("addOnVersionId", "a one-time top-up is granted as a balance, not held as a subscription");
  }
  const activeFrom = input.activeFrom ?? new Date();
  await db.workspaceAddOn.upsert({
    where: { workspaceId_addOnVersionId: { workspaceId, addOnVersionId: input.addOnVersionId } },
    // Re-buying something that was ended reopens it rather than leaving a dated row behind to confuse the
    // entitlement: the workspace is paying for it again, from now.
    update: { quantity: input.quantity, activeFrom, activeUntil: null },
    create: { workspaceId, addOnVersionId: input.addOnVersionId, quantity: input.quantity, activeFrom },
  });
}

/**
 * Ends a recurring add-on, at the end of the period already paid for.
 *
 * Dated rather than deleted, because the accepted downgrade behaviour is explicit about it: removal takes
 * effect at the end of the paid period, and a row removed now would take capacity away from a business
 * that has paid for it until Friday.
 */
export async function endWorkspaceAddOn(
  db: DbClient,
  context: WorkspaceContext,
  input: { readonly addOnVersionId: string; readonly activeUntil: Date },
): Promise<void> {
  requireRole(context, BILLING_ROLES, "change add-ons");
  const workspaceId = scopeOf(context);
  await db.workspaceAddOn.updateMany({
    where: { workspaceId, addOnVersionId: input.addOnVersionId, activeUntil: null },
    data: { activeUntil: input.activeUntil },
  });
}

/**
 * Adds a bought allowance to a workspace's balance.
 *
 * Separate from the plan's quota on purpose: the accepted policy spends the included allowance first and
 * only then a top-up, and the two expire differently — a plan's allowance resets with the cycle, a top-up
 * carries through the end of the *next* billing period and then lapses. One number could express neither.
 */
export async function grantUsageTopUp(
  db: DbClient,
  context: WorkspaceContext,
  input: {
    readonly metric: UsageMetric;
    readonly amount: number;
    readonly expiresAt: Date;
    readonly addOnVersionId?: string;
    readonly purchasedAt?: Date;
  },
): Promise<{ readonly topUpId: string }> {
  requireRole(context, BILLING_ROLES, "buy a top-up");
  const workspaceId = scopeOf(context);
  if (!Number.isSafeInteger(input.amount) || input.amount < 1) {
    throw new DbInputError("amount", "must be a positive whole number of units");
  }
  const row = await db.usageTopUp.create({
    data: {
      workspaceId,
      metric: input.metric,
      amount: input.amount,
      purchasedAt: input.purchasedAt ?? new Date(),
      expiresAt: input.expiresAt,
      ...(input.addOnVersionId === undefined ? {} : { addOnVersionId: input.addOnVersionId }),
    },
    select: { id: true },
  });
  return { topUpId: row.id };
}

export interface TopUpBalance {
  /** What is left and still valid at the instant asked about. */
  readonly remaining: number;
  /** When the soonest of those balances lapses, so a screen can warn before it does. */
  readonly nextExpiryAt?: Date;
}

/**
 * What a workspace has left in bought allowance for one metric.
 *
 * Expired balances are excluded rather than deleted: the row is the record of a purchase, and a business
 * asking why its minutes ran out is owed the answer that it bought some in March and they lapsed in May.
 */
export async function readTopUpBalance(db: DbExecutor, workspaceId: string, metric: UsageMetric, at: Date): Promise<TopUpBalance> {
  const rows = await db.usageTopUp.findMany({
    where: { workspaceId, metric, expiresAt: { gt: at } },
    orderBy: { expiresAt: "asc" },
    select: { amount: true, consumed: true, expiresAt: true },
  });
  const live = rows.filter((row) => row.consumed < row.amount);
  const remaining = live.reduce((total, row) => total + (row.amount - row.consumed), 0);
  const soonest = live[0]?.expiresAt;
  return { remaining, ...(soonest === undefined ? {} : { nextExpiryAt: soonest }) };
}

/**
 * Spends bought allowance, soonest to expire first.
 *
 * That order is the point: spending the furthest-dated balance first would let a nearer one lapse unused,
 * which is a business losing minutes it paid for to an implementation detail. Returns what it could not
 * cover, so the caller can say so rather than assume.
 */
export async function consumeTopUp(tx: DbExecutor, workspaceId: string, metric: UsageMetric, amount: number, at: Date): Promise<number> {
  let outstanding = amount;
  const rows = await tx.usageTopUp.findMany({
    where: { workspaceId, metric, expiresAt: { gt: at } },
    orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
    select: { id: true, amount: true, consumed: true },
  });
  for (const row of rows) {
    if (outstanding <= 0) {
      break;
    }
    const available = row.amount - row.consumed;
    if (available <= 0) {
      continue;
    }
    const taken = Math.min(available, outstanding);
    await tx.usageTopUp.update({ where: { id: row.id }, data: { consumed: row.consumed + taken } });
    outstanding -= taken;
  }
  return outstanding;
}
