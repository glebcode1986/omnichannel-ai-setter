/**
 * The accepted Starter / Growth / Scale catalogue, as data (#43, PRICING_PACKAGING.md v0.6).
 *
 * One definition, in one file, published through the ordinary catalogue store. The spec is explicit that
 * public pricing values come from the plan catalogue and are "not duplicated constants", so a pricing page
 * reads this through `readCatalog` rather than carrying its own copy — and a price shown to a customer and
 * a price they are charged cannot drift apart, because there is only one of them.
 *
 * Nothing here is reopened during implementation. The numbers are the accepted ones; changing a price or a
 * capacity means a new version of this catalogue, which is exactly what `publishPlanVersion` produces.
 *
 * Two things deliberately absent:
 *
 * - **no AI-reply quota.** Core AI generation is customer-facing `UNMETERED` on every paid tier, so there
 *   is no `AI_GENERATION_CYCLES` entry to find. The ledger still counts generations internally, which is a
 *   different thing and must never be shown as a billable allowance.
 * - **no provider price identifiers.** They are references a billing adapter fills in once a provider is
 *   chosen (#41), and the catalogue is interpretable without them: a plan's entitlements come from its own
 *   grants, never from a provider's price object.
 */
import type { PlanFeature } from "@omnichannel/domain";

import { publishAddOnVersion, type AddOnVersionRecord } from "./catalog-store";
import type { DbClient, DbExecutor } from "./client";
import { publishPlanVersion, type CatalogPriceInput, type PlanVersionRecord } from "./entitlement-store";

/** The initial public price book's currency. The architecture stays multi-currency; this is the first one. */
export const ACCEPTED_CURRENCY = "EUR";

/**
 * The accepted trial, as product configuration rather than as code.
 *
 * It starts when a Business Profile is first successfully connected to a channel, not at account creation
 * — which is why a workspace with no subscription may still create that first profile, and why the
 * capacity check treats an unstated ceiling as uncapped (#40).
 *
 * These numbers were a constant nothing read for two phases: no code started a trial, no plan version
 * expressed these grants, and a test asserted the constant against itself. `publishAcceptedCatalog`
 * publishes them as a plan version now, and `ensureWorkspaceTrial` is what puts a workspace on it.
 */
export const ACCEPTED_TRIAL = {
  days: 14,
  cardRequired: false,
  businessProfiles: 1,
  seats: 3,
  voiceTranscriptionMinutes: 100,
} as const;

/**
 * The plan code a trialling workspace is on.
 *
 * A real, immutable plan version rather than a special case in the entitlement reader: a trial grants
 * features and ceilings exactly as a paid tier does, and expressing it as a version means
 * `readEntitlement`, the capacity checks and the usage reservations all answer for it without knowing it
 * is a trial. What makes it a trial is the subscription's `TRIALING` state and its `trialEndsAt`.
 *
 * Published `PRIVATE`, because it is not for sale: nobody chooses it, and the billing screen must not
 * offer it beside Starter, Growth and Scale.
 */
export const TRIAL_PLAN_CODE = "trial";

/** Every feature a paid tier includes. The tiers differ in capacity, not in what the assistant can do. */
const CORE_FEATURES: readonly PlanFeature[] = [
  "AI_DRAFTS",
  "AUTOPILOT",
  "INSTAGRAM",
  "WHATSAPP",
  "WHATSAPP_TEMPLATE_AUTOPILOT",
  "VOICE_TRANSCRIPTION",
  "ADVANCED_ANALYTICS",
  "MULTI_MEMBER",
];

const MINUTE_SECONDS = 60;

/**
 * The three public tiers.
 *
 * Annual amounts are stated outright, not derived. The accepted rule is "pay ten months, receive twelve",
 * and a product that recomputed it would be free to disagree with an invoice a customer already holds.
 */
export const ACCEPTED_PLANS = [
  {
    code: "starter",
    name: "Starter",
    displayOrder: 1,
    monthlyCents: 4_900,
    annualCents: 49_000,
    businessProfiles: 1,
    seats: 1,
    analyticsRetentionDays: 30,
    voiceMinutes: 300,
  },
  {
    code: "growth",
    name: "Growth",
    displayOrder: 2,
    monthlyCents: 9_900,
    annualCents: 99_000,
    businessProfiles: 3,
    seats: 5,
    analyticsRetentionDays: 183,
    voiceMinutes: 1_500,
  },
  {
    code: "scale",
    name: "Scale",
    displayOrder: 3,
    monthlyCents: 24_900,
    annualCents: 249_000,
    businessProfiles: 10,
    seats: 15,
    analyticsRetentionDays: 730,
    voiceMinutes: 6_000,
  },
] as const;

/**
 * The accepted self-serve add-ons.
 *
 * Capacity add-ons recur; allowance top-ups are bought once. Neither changes the feature class of the base
 * plan — a business on Starter with three extra profiles is still on Starter — and the CHECK on
 * `addon_versions` makes a row that tried to unrepresentable.
 */
export const ACCEPTED_ADDONS = [
  { code: "extra-business-profile", name: "One more Business Profile", displayOrder: 1, kind: "RECURRING_CAPACITY", monthlyCents: 2_500, limits: { BUSINESS_PROFILES: 1 } },
  { code: "extra-seat", name: "One more seat", displayOrder: 2, kind: "RECURRING_CAPACITY", monthlyCents: 700, limits: { SEATS: 1 } },
  { code: "voice-500", name: "500 voice minutes", displayOrder: 3, kind: "ONE_TIME_ALLOWANCE", onceCents: 800, minutes: 500 },
  { code: "voice-2000", name: "2,000 voice minutes", displayOrder: 4, kind: "ONE_TIME_ALLOWANCE", onceCents: 2_500, minutes: 2_000 },
  { code: "voice-5000", name: "5,000 voice minutes", displayOrder: 5, kind: "ONE_TIME_ALLOWANCE", onceCents: 4_900, minutes: 5_000 },
] as const;

export interface PublishedCatalog {
  readonly plans: readonly PlanVersionRecord[];
  readonly addOns: readonly AddOnVersionRecord[];
  /** The version a trialling workspace is put on. Not among `plans`: it is not for sale. */
  readonly trial: PlanVersionRecord;
}

/**
 * Which provider price a published catalogue price corresponds to.
 *
 * Keyed by the product's own vocabulary — a plan or add-on code and an interval — and valued with the
 * provider's opaque id. The map belongs to a deployment rather than to the catalogue: the accepted prices
 * are the same everywhere, and the Stripe (or other provider) price objects that mirror them are created
 * per account, so a deployment serving two sellers has two of them.
 *
 * It has to be given at publication because catalogue prices are **immutable**: a trigger refuses an
 * `UPDATE` on `plan_prices`, with "catalogue prices are immutable: publish a new version instead". So a
 * provider price id that is not supplied here can never be supplied at all, and `readCheckoutRouting`
 * would find none — which means no provider checkout could be priced and the whole payment step would be
 * unavailable in exactly the deployment that published its catalogue the normal way.
 */
export interface ProviderPriceMap {
  /** `{ "growth": { "MONTH": "price_…", "YEAR": "price_…" } }`, by plan or add-on code. */
  readonly [code: string]: Readonly<Partial<Record<"MONTH" | "YEAR" | "ONE_TIME", string>>> | undefined;
}

/**
 * Publishes the accepted catalogue, as `PUBLIC`.
 *
 * Idempotent in the only sense a versioned catalogue can be: calling it twice publishes a second version
 * of everything, because a version is never edited. A deployment runs it once, and the newest version of
 * each product is the one on sale — so a repeat is wasteful rather than wrong, and `readCatalog` still
 * answers with one plan per code.
 *
 * Voice allowances are stated in the spec as minutes and stored as seconds, because the metric is
 * `VOICE_TRANSCRIPTION_SECONDS` and the provider reports seconds. The conversion happens here, once,
 * rather than at every place that compares a reading against an allowance.
 *
 * `providerPrices` is optional, and omitting it publishes exactly what it published before: a
 * provider-neutral catalogue. A deployment that intends to take payments supplies the map, because this
 * is the only moment at which it can be stored.
 */
export async function publishAcceptedCatalog(db: DbClient, providerPrices: ProviderPriceMap = {}): Promise<PublishedCatalog> {
  const plans: PlanVersionRecord[] = [];
  for (const plan of ACCEPTED_PLANS) {
    plans.push(
      await publishPlanVersion(db, {
        code: plan.code,
        name: plan.name,
        displayOrder: plan.displayOrder,
        availability: "PUBLIC",
        grants: {
          features: [...CORE_FEATURES],
          limits: {
            BUSINESS_PROFILES: plan.businessProfiles,
            SEATS: plan.seats,
            ANALYTICS_RETENTION_DAYS: plan.analyticsRetentionDays,
          },
          // No `AI_GENERATION_CYCLES`: core generation is unmetered customer-facing on every paid tier.
          quotas: { VOICE_TRANSCRIPTION_SECONDS: plan.voiceMinutes * MINUTE_SECONDS },
        },
        prices: [monthly(plan.monthlyCents, providerPrices[plan.code]?.MONTH), annual(plan.annualCents, providerPrices[plan.code]?.YEAR)],
      }),
    );
  }

  // The trial, as a plan version of its own. Published `PRIVATE` by default, priced at nothing, and
  // carrying the same core features as the paid tiers — the accepted trial differs from them in capacity
  // and in having an end date, not in what the assistant may do.
  const trial = await publishPlanVersion(db, {
    code: TRIAL_PLAN_CODE,
    name: "Trial",
    displayOrder: 0,
    grants: {
      features: [...CORE_FEATURES],
      limits: { BUSINESS_PROFILES: ACCEPTED_TRIAL.businessProfiles, SEATS: ACCEPTED_TRIAL.seats },
      quotas: { VOICE_TRANSCRIPTION_SECONDS: ACCEPTED_TRIAL.voiceTranscriptionMinutes * MINUTE_SECONDS },
    },
  });

  const addOns: AddOnVersionRecord[] = [];
  for (const addOn of ACCEPTED_ADDONS) {
    addOns.push(
      await publishAddOnVersion(db, {
        code: addOn.code,
        name: addOn.name,
        displayOrder: addOn.displayOrder,
        kind: addOn.kind,
        availability: "PUBLIC",
        ...("limits" in addOn ? { limits: addOn.limits } : {}),
        ...("minutes" in addOn ? { quotas: { VOICE_TRANSCRIPTION_SECONDS: addOn.minutes * MINUTE_SECONDS } } : {}),
        prices:
          "monthlyCents" in addOn
            ? [monthly(addOn.monthlyCents, providerPrices[addOn.code]?.MONTH)]
            : [once(addOn.onceCents, providerPrices[addOn.code]?.ONE_TIME)],
      }),
    );
  }

  return { plans, addOns, trial };
}

// `providerPriceId` is omitted rather than set to `undefined`, because the store distinguishes the two:
// absent leaves the column null, and the catalogue stays provider-neutral where a deployment has not
// mapped it.
const priced = (interval: CatalogPriceInput["interval"], amountCents: number, providerPriceId: string | undefined): CatalogPriceInput => ({
  currency: ACCEPTED_CURRENCY,
  interval,
  amountCents,
  ...(providerPriceId === undefined ? {} : { providerPriceId }),
});
/**
 * Starts the accepted no-card trial for a workspace, if it has never had a subscription (#44).
 *
 * The act this answers is "a Business Profile was successfully connected", and the whole product depended
 * on it happening while nothing did it: `ACCEPTED_TRIAL` was a constant read by one test, no plan version
 * expressed its grants, and the only production writer of `workspace_subscriptions` was the settlement
 * path — which pins `ACTIVE`. So a real workspace reached a connected channel with no subscription at all,
 * `readEntitlement` answered `INACTIVE` with no grants, and every paid capability was off before anybody
 * had been asked for money. Two comments elsewhere in this package already described this as "the act
 * which starts its trial"; this is the code that makes them true.
 *
 * **Exactly once, structurally.** `workspace_subscriptions.workspace_id` is unique, and the insert is
 * `ON CONFLICT DO NOTHING` — so a workspace that already has *any* subscription keeps it, whether that is
 * a running trial, a paid term or a cancelled one. Two concurrent connections cannot both start a trial,
 * and a replay cannot restart an expired one. There is no read-then-write to lose a race in.
 *
 * **Idempotent rather than once-only at the call site**, which is why it is safe to call on every
 * successful connection: a trial that failed to start because the process died after the account was
 * written starts on the next connection instead of never. The guarantee lives in the index, not in
 * whoever remembered to call this.
 *
 * Returns whether this call is the one that started it, so a caller can audit the fact once.
 */
export async function ensureWorkspaceTrial(
  db: DbExecutor,
  workspaceId: string,
  now: Date,
): Promise<{ readonly started: boolean; readonly trialEndsAt?: Date }> {
  const trial = await db.planVersion.findFirst({
    where: { plan: { code: TRIAL_PLAN_CODE } },
    orderBy: { version: "desc" },
    select: { id: true },
  });
  if (trial === null) {
    // No trial version has been published in this deployment, so there is nothing to put the workspace
    // on. Silent rather than thrown: a connection must not fail because a catalogue was not published,
    // and the workspace is left exactly as it was — with no grants, which is the conservative answer.
    return { started: false };
  }
  const trialEndsAt = new Date(now.getTime() + ACCEPTED_TRIAL.days * DAY_MS);
  const created = await db.workspaceSubscription.createMany({
    data: [{ workspaceId, planVersionId: trial.id, state: "TRIALING", trialEndsAt }],
    // The whole guarantee. `ON CONFLICT DO NOTHING` on the unique workspace, so an existing subscription
    // of any kind is left alone and nothing throws — a thrown unique violation inside a caller's
    // transaction would abort work that had already succeeded.
    skipDuplicates: true,
  });
  return created.count === 1 ? { started: true, trialEndsAt } : { started: false };
}

const DAY_MS = 24 * 60 * 60 * 1_000;

const monthly = (amountCents: number, providerPriceId?: string): CatalogPriceInput => priced("MONTH", amountCents, providerPriceId);
const annual = (amountCents: number, providerPriceId?: string): CatalogPriceInput => priced("YEAR", amountCents, providerPriceId);
const once = (amountCents: number, providerPriceId?: string): CatalogPriceInput => priced("ONE_TIME", amountCents, providerPriceId);
