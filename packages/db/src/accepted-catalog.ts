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
import type { DbClient } from "./client";
import { publishPlanVersion, type CatalogPriceInput, type PlanVersionRecord } from "./entitlement-store";

/** The initial public price book's currency. The architecture stays multi-currency; this is the first one. */
export const ACCEPTED_CURRENCY = "EUR";

/**
 * The accepted trial, as product configuration rather than as code.
 *
 * It starts after the first Business Profile is successfully connected, not at account creation — which is
 * why a workspace with no subscription may still create that first profile, and why the capacity check
 * treats an unstated ceiling as uncapped (#40).
 */
export const ACCEPTED_TRIAL = {
  days: 14,
  cardRequired: false,
  businessProfiles: 1,
  seats: 3,
  voiceTranscriptionMinutes: 100,
} as const;

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
 */
export async function publishAcceptedCatalog(db: DbClient): Promise<PublishedCatalog> {
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
        prices: [monthly(plan.monthlyCents), annual(plan.annualCents)],
      }),
    );
  }

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
        prices: "monthlyCents" in addOn ? [monthly(addOn.monthlyCents)] : [once(addOn.onceCents)],
      }),
    );
  }

  return { plans, addOns };
}

const monthly = (amountCents: number): CatalogPriceInput => ({ currency: ACCEPTED_CURRENCY, interval: "MONTH", amountCents });
const annual = (amountCents: number): CatalogPriceInput => ({ currency: ACCEPTED_CURRENCY, interval: "YEAR", amountCents });
const once = (amountCents: number): CatalogPriceInput => ({ currency: ACCEPTED_CURRENCY, interval: "ONE_TIME", amountCents });
