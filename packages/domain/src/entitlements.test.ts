/**
 * Resolving what a workspace may do (#38, ADR-017).
 *
 * The cases worth writing are the ones where a plausible shortcut gives the wrong answer: an expired
 * override that nobody removed, a plan that genuinely caps nothing, a workspace that has stopped paying
 * but has not stopped existing. Each is a sentence somebody has to read on a screen, and getting it
 * wrong means telling a business something untrue about its own account.
 */
import { describe, expect, it } from "vitest";

import {
  allowsPaidWork,
  capacityVerdict,
  featureAllowed,
  featureWithheld,
  paidWorkPermitted,
  resolveEntitlement,
  withinLimit,
  type PlanGrants,
  type ResolveEntitlementInput,
  type SubscriptionState,
} from "./entitlements";

const NOW = new Date("2026-10-07T12:00:00.000Z");

const grants: PlanGrants = {
  features: ["AI_DRAFTS", "AUTOPILOT", "INSTAGRAM", "WHATSAPP", "VOICE_TRANSCRIPTION"],
  limits: { BUSINESS_PROFILES: 3, SEATS: 5, ANALYTICS_RETENTION_DAYS: 180 },
  quotas: { VOICE_TRANSCRIPTION_SECONDS: 90_000 },
};

const resolve = (overrides: Partial<ResolveEntitlementInput> = {}) =>
  resolveEntitlement({
    workspaceId: "ws_1",
    state: "ACTIVE",
    planCode: "growth",
    planVersion: 2,
    grants,
    now: NOW,
    ...overrides,
  });

describe("which states still permit paid work", () => {
  it("permits it while a renewal is being chased, because a business must keep answering", () => {
    // Accepted policy: a payment that failed on Tuesday must not stop replies on Wednesday, and the
    // spec gives three days to fix it.
    expect(allowsPaidWork("PAST_DUE")).toBe(true);
    expect(allowsPaidWork("GRACE")).toBe(true);
  });

  it("permits it through a period somebody already paid for, even after cancelling", () => {
    expect(allowsPaidWork("CANCELED_PENDING_END")).toBe(true);
  });

  it("permits it on trial, and refuses it once nothing is live", () => {
    expect(allowsPaidWork("TRIALING")).toBe(true);
    expect(allowsPaidWork("INACTIVE")).toBe(false);
  });
});

describe("resolving a snapshot", () => {
  it("reports exactly what the plan grants, and false for everything it does not", () => {
    const snapshot = resolve();

    expect(snapshot.features).toMatchObject({ AI_DRAFTS: true, AUTOPILOT: true, WHATSAPP_TEMPLATE_AUTOPILOT: false, ADVANCED_ANALYTICS: false });
    expect(snapshot.limits).toEqual({ BUSINESS_PROFILES: 3, SEATS: 5, ANALYTICS_RETENTION_DAYS: 180 });
    expect(snapshot.quotas).toEqual({ VOICE_TRANSCRIPTION_SECONDS: 90_000 });
  });

  it("names the plan version it came from, so a decision can be explained afterwards", () => {
    // A workspace grandfathered on an old version must be able to show *which* old version, or "why can
    // I only have three?" has no answer anybody can check.
    expect(resolve()).toMatchObject({ planCode: "growth", planVersion: 2 });
  });

  it("keeps reporting the plan's capacity for a workspace that has stopped paying", () => {
    const snapshot = resolve({ state: "INACTIVE" });

    // "You are over your limit" and "you have not paid" are different messages needing different
    // answers from the person reading them. Zeroing the numbers would merge the two.
    expect(snapshot.paidWorkAllowed).toBe(false);
    expect(snapshot.limits["BUSINESS_PROFILES"]).toBe(3);
    expect(snapshot.features["AI_DRAFTS"]).toBe(true);
  });
});

describe("an override", () => {
  it("raises a limit without touching the plan everybody else is on", () => {
    const snapshot = resolve({ override: { limits: { BUSINESS_PROFILES: 25 } } });

    expect(snapshot.limits["BUSINESS_PROFILES"]).toBe(25);
    // Everything it did not mention still comes from the plan.
    expect(snapshot.limits["SEATS"]).toBe(5);
  });

  it("can switch a feature on, and can switch one off", () => {
    expect(resolve({ override: { features: { ADVANCED_ANALYTICS: true } } }).features["ADVANCED_ANALYTICS"]).toBe(true);
    // Both directions: an override is a deliberate departure, and sometimes the departure is downward.
    expect(resolve({ override: { features: { AUTOPILOT: false } } }).features["AUTOPILOT"]).toBe(false);
  });

  it("stops applying once it expires, rather than becoming permanent by neglect", () => {
    const lapsed = { limits: { BUSINESS_PROFILES: 25 }, expiresAt: new Date(NOW.getTime() - 1) };

    // The row is kept so an operator can see what was granted and when it lapsed; the snapshot reports
    // the plan. A temporary concession that nobody remembered to delete is not a plan change.
    expect(resolve({ override: lapsed }).limits["BUSINESS_PROFILES"]).toBe(3);
  });

  it("still applies in the instant before it expires", () => {
    expect(resolve({ override: { limits: { SEATS: 50 }, expiresAt: new Date(NOW.getTime() + 1) } }).limits["SEATS"]).toBe(50);
  });
});

describe("asking whether an action is permitted", () => {
  it("needs both the plan's permission and a live subscription", () => {
    expect(featureAllowed(resolve(), "AUTOPILOT")).toBe(true);
    expect(featureAllowed(resolve({ state: "INACTIVE" }), "AUTOPILOT")).toBe(false);
    expect(featureAllowed(resolve(), "ADVANCED_ANALYTICS")).toBe(false);
  });

  it("permits one more only below the ceiling", () => {
    expect(withinLimit(resolve(), "BUSINESS_PROFILES", 2)).toBe(true);
    // At the ceiling, not past it: three profiles on a limit of three means no fourth.
    expect(withinLimit(resolve(), "BUSINESS_PROFILES", 3)).toBe(false);
  });

  it("treats a plan that caps nothing as uncapped rather than as zero", () => {
    const uncapped = resolve({ grants: { ...grants, limits: {} } });

    // "No limit" is a real answer. Reading it as zero would make such a plan refuse everything.
    expect(withinLimit(uncapped, "BUSINESS_PROFILES", 10_000)).toBe(true);
  });

  it("refuses one more once the subscription is not live, whatever the ceiling says", () => {
    expect(withinLimit(resolve({ state: "INACTIVE" }), "SEATS", 0)).toBe(false);
  });
});

describe("the vocabulary itself", () => {
  it("contains no payment provider's words", () => {
    // The point of the normalized layer: a provider's own status strings must never reach a feature
    // check, because the day the provider changes is the day every check would have to.
    const states: readonly SubscriptionState[] = ["TRIALING", "ACTIVE", "PAST_DUE", "GRACE", "CANCELED_PENDING_END", "INACTIVE"];
    for (const state of states) {
      expect(state).not.toMatch(/stripe|paddle|paypal|cryptomus|wayforpay/iu);
    }
  });
});

/**
 * Paid work and the clock (#40).
 *
 * Two of the permitting states carry their own deadline, and until this existed `paidWorkAllowed` read
 * only the state — so a cancelled workspace kept sending until a provider webhook happened to move it,
 * and a trial kept working after it had expired. Nothing writes a row when a date passes, which is also
 * why the delivery claim re-resolves the entitlement instead of comparing row versions.
 */
describe("when a permitting state has run out", () => {
  it("stops paid work once a cancelled subscription's paid period has ended", () => {
    const ended = { state: "CANCELED_PENDING_END" as const, periodEndsAt: new Date(NOW.getTime() - 1), now: NOW };

    expect(paidWorkPermitted(ended)).toBe(false);
    // And the state on its own still says yes, which is the gap this closes.
    expect(allowsPaidWork("CANCELED_PENDING_END")).toBe(true);
  });

  it("keeps the period the customer paid for", () => {
    expect(paidWorkPermitted({ state: "CANCELED_PENDING_END", periodEndsAt: new Date(NOW.getTime() + 1), now: NOW })).toBe(true);
  });

  it("stops paid work once a trial has expired", () => {
    expect(paidWorkPermitted({ state: "TRIALING", trialEndsAt: new Date(NOW.getTime() - 1), now: NOW })).toBe(false);
    expect(paidWorkPermitted({ state: "TRIALING", trialEndsAt: new Date(NOW.getTime() + 1), now: NOW })).toBe(true);
  });

  it("treats the deadline itself as past, because a period that ends at noon does not include noon", () => {
    expect(paidWorkPermitted({ state: "TRIALING", trialEndsAt: NOW, now: NOW })).toBe(false);
  });

  it("leaves grace to its state, because its duration is configuration rather than a stored instant", () => {
    // `graceStartedAt` is when it began; how long it lasts is product policy and provider retry
    // schedules, so the transition out of it belongs to the adapter that can see them.
    expect(paidWorkPermitted({ state: "GRACE", now: NOW })).toBe(true);
  });

  it("reaches the resolved snapshot, not only the helper", () => {
    const snapshot = resolve({ state: "TRIALING", trialEndsAt: new Date(NOW.getTime() - 1) });

    expect(snapshot.paidWorkAllowed).toBe(false);
    // The plan still says what it says: "your trial ended" and "your plan excludes this" are different
    // sentences, and a lapsed trial must not be made to read like the second.
    expect(snapshot.features.AI_DRAFTS).toBe(true);
  });
});

/**
 * Configuration, which is a different question from paid work (#40).
 *
 * `featureAllowed` folds payment in and is right for a provider call. Capacity and configuration must not:
 * a business whose card failed may still reconnect a channel, and a workspace that has chosen no plan at
 * all has to be able to connect its first — that act is what starts its trial, so a gate that refused it
 * would shut the product's own front door.
 */
describe("what a plan withholds from configuration", () => {
  it("withholds nothing when no plan has been chosen", () => {
    const pretrial = resolve({ state: "INACTIVE", subscribed: false, grants: { features: [], limits: {}, quotas: {} } });

    expect(featureWithheld(pretrial, "INSTAGRAM")).toBe(false);
    expect(capacityVerdict({ snapshot: pretrial, limit: "BUSINESS_PROFILES", current: 0 })).toEqual({ kind: "ALLOWED" });
    // And paid work is still refused, which is the half that must not move.
    expect(pretrial.paidWorkAllowed).toBe(false);
  });

  it("withholds what a chosen plan leaves out, whether or not the bill is paid", () => {
    const withoutWhatsApp = { features: ["INSTAGRAM"] as const, limits: {}, quotas: {} };

    expect(featureWithheld(resolve({ grants: { ...withoutWhatsApp, features: [...withoutWhatsApp.features] } }), "WHATSAPP")).toBe(true);
    expect(
      featureWithheld(resolve({ state: "INACTIVE", grants: { ...withoutWhatsApp, features: [...withoutWhatsApp.features] } }), "WHATSAPP"),
    ).toBe(true);
  });

  it("does not withhold what the plan includes from a workspace that has stopped paying", () => {
    // The spec keeps the workspace usable while a payment is sorted out; what stops is sending.
    const lapsed = resolve({ state: "INACTIVE" });

    expect(featureWithheld(lapsed, "INSTAGRAM")).toBe(false);
    expect(featureAllowed(lapsed, "INSTAGRAM")).toBe(false);
  });
});

describe("whether one more of something may be created", () => {
  it("allows up to the ceiling and refuses at it", () => {
    expect(capacityVerdict({ snapshot: resolve(), limit: "BUSINESS_PROFILES", current: 2 })).toEqual({ kind: "ALLOWED" });
    expect(capacityVerdict({ snapshot: resolve(), limit: "BUSINESS_PROFILES", current: 3 })).toEqual({
      kind: "AT_LIMIT",
      limit: "BUSINESS_PROFILES",
      ceiling: 3,
      current: 3,
    });
  });

  it("treats an absent ceiling as genuinely uncapped", () => {
    const uncapped = resolve({ grants: { features: [...grants.features], limits: {}, quotas: {} } });

    expect(capacityVerdict({ snapshot: uncapped, limit: "SEATS", current: 99 })).toEqual({ kind: "ALLOWED" });
  });

  it("ignores payment, because reorganizing a workspace is not paid work", () => {
    // `withinLimit` answers the combined question and refuses outright; this one must not, or a business
    // whose card failed could not rename or rearrange anything it already owns.
    const lapsed = resolve({ state: "INACTIVE" });

    expect(withinLimit(lapsed, "BUSINESS_PROFILES", 0)).toBe(false);
    expect(capacityVerdict({ snapshot: lapsed, limit: "BUSINESS_PROFILES", current: 0 })).toEqual({ kind: "ALLOWED" });
  });

  it("refuses a withheld feature before it looks at the ceiling", () => {
    // A plan that does not sell a team must not admit a second member merely because it states no seat
    // ceiling — and the refusal has to say which of the two it is.
    const soloPlan = resolve({ grants: { features: ["AI_DRAFTS"], limits: {}, quotas: {} } });

    expect(capacityVerdict({ snapshot: soloPlan, limit: "SEATS", current: 1, requires: { feature: "MULTI_MEMBER", from: 1 } })).toEqual({
      kind: "FEATURE_OFF",
      feature: "MULTI_MEMBER",
    });
  });

  it("does not consult that feature below the count it starts at", () => {
    // Every workspace has an owner. A plan that does not sell a *team* has not forbidden the person who
    // owns the workspace.
    const soloPlan = resolve({ grants: { features: ["AI_DRAFTS"], limits: {}, quotas: {} } });

    expect(capacityVerdict({ snapshot: soloPlan, limit: "SEATS", current: 0, requires: { feature: "MULTI_MEMBER", from: 1 } })).toEqual({
      kind: "ALLOWED",
    });
  });
});

