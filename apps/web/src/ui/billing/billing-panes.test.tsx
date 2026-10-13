// @vitest-environment jsdom
/**
 * The billing panes (#42).
 *
 * The cases worth writing are the ones where a page would mislead somebody about their own money: a
 * cancellation that reads like it already happened, a plan shown without the state that makes it
 * meaningful, a price rendered a hundred times too large, and a control offered to somebody the server
 * will refuse.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AllowanceSummary } from "@omnichannel/db";

import { AllowanceMeter } from "./allowance-meter";
import { CapacityList } from "./capacity-list";
import { formatPrice } from "./money";
import { PlanOffers } from "./plan-offers";
import { SubscriptionCard } from "./subscription-card";
import type { BillingScreenData, PlanOffer } from "@/server/billing-screen";
import { catalogues, type MessageKey } from "@/i18n/catalogue";
import { createTranslator } from "@/i18n/translate";

const t = createTranslator("en");
const text = (key: MessageKey) => catalogues.en[key];
const NOW = new Date("2026-10-07T12:00:00.000Z");
const DAY = 86_400_000;

afterEach(cleanup);

const data = (overrides: Partial<BillingScreenData> = {}): BillingScreenData => ({
  overview: {
    subscription: {
      state: "ACTIVE",
      planCode: "growth",
      planName: "Growth",
      planVersion: 1,
      periodEndsAt: new Date(NOW.getTime() + 20 * DAY),
      prices: [{ currency: "EUR", interval: "MONTH", amountCents: 9_900 }],
    },
    entitlement: {
      workspaceId: "ws_1",
      state: "ACTIVE",
      planCode: "growth",
      planVersion: 1,
      subscribed: true,
      paidWorkAllowed: true,
      features: {
        AI_DRAFTS: true,
        AUTOPILOT: true,
        INSTAGRAM: true,
        WHATSAPP: true,
        WHATSAPP_TEMPLATE_AUTOPILOT: true,
        VOICE_TRANSCRIPTION: true,
        ADVANCED_ANALYTICS: true,
        MULTI_MEMBER: true,
      },
      limits: { BUSINESS_PROFILES: 3, SEATS: 5 },
      quotas: { VOICE_TRANSCRIPTION_SECONDS: 90_000 },
      resolvedAt: NOW,
    },
    access: { paidWorkAllowed: true, aiDrafts: true, autopilot: true },
    capacity: [
      { limit: "BUSINESS_PROFILES", inUse: 2, ceiling: 3 },
      { limit: "SEATS", inUse: 1 },
    ],
    allowances: [],
    addOns: [],
    offers: [],
    readAt: NOW,
  },
  offers: [],
  canManage: true,
  checkoutAvailable: false,
  basePath: "/workspaces/ws/profiles/bp/settings/billing",
  ...overrides,
});

describe("the subscription card", () => {
  it("names the plan, its version and whether paid work is allowed", () => {
    render(<SubscriptionCard t={t} data={data()} />);

    expect(document.querySelector('[data-plan="growth"]')?.textContent).toContain("Growth");
    expect(document.querySelector('[data-state="ACTIVE"]')?.textContent).toBe(text("subscriptionState.ACTIVE"));
  });

  it("renders a price as money rather than as a count of cents", () => {
    render(<SubscriptionCard t={t} data={data()} />);

    // `Translator.money` takes major units and every stored amount is minor ones. Nothing type-checks
    // that, so this is what notices €9,900 a month.
    const monthly = document.querySelector('[data-price="MONTH"]')?.textContent ?? "";
    expect(monthly).toContain("99");
    expect(monthly).not.toContain("9,900");
  });

  it("says a workspace with no plan has none, rather than showing it as ended", () => {
    render(<SubscriptionCard t={t} data={data({ overview: { ...data().overview, subscription: undefined } })} />);

    expect(document.querySelector('[data-plan="none"]')?.textContent).toBe(text("billing.noPlan"));
  });

  it("explains what cancelling does before offering it", () => {
    render(<SubscriptionCard t={t} data={data()} actions={{ cancel: vi.fn(), resume: vi.fn() }} />);

    // The consequence beside the control, not behind it: a warning that appears after the click is a
    // warning nobody was given.
    expect(screen.getByRole("button", { name: text("billing.cancel") })).toBeDefined();
    expect(document.querySelector('[data-consequence="cancel"]')?.textContent).toBe(text("billing.cancelExplains"));
  });

  it("offers to keep the subscription once a cancellation is pending, and says when it bites", () => {
    const base = data();
    const canceling = data({
      overview: {
        ...base.overview,
        subscription: { ...base.overview.subscription!, state: "CANCELED_PENDING_END", canceledAt: NOW },
      },
    });

    render(<SubscriptionCard t={t} data={canceling} actions={{ cancel: vi.fn(), resume: vi.fn() }} />);

    expect(screen.getByRole("button", { name: text("billing.resume") })).toBeDefined();
    expect(document.querySelector('[data-date="canceling"]')).not.toBeNull();
    // And not the cancel button: offering both would invite a click that does nothing.
    expect(screen.queryByRole("button", { name: text("billing.cancel") })).toBeNull();
  });

  it("tells an admin why there is nothing to press, rather than hiding it silently", () => {
    render(<SubscriptionCard t={t} data={data({ canManage: false })} actions={{ cancel: vi.fn(), resume: vi.fn() }} />);

    // Billing is the owner's, and an admin who may do everything else would otherwise assume the product
    // is broken. The store refuses them whatever this says.
    expect(document.querySelector('[data-restricted="true"]')?.textContent).toBe(text("billing.ownerOnly"));
    expect(screen.queryByRole("button", { name: text("billing.cancel") })).toBeNull();
  });

  it("distinguishes a renewal from an ending, on the same date field", () => {
    render(<SubscriptionCard t={t} data={data()} />);

    expect(document.querySelector('[data-date="renews"]')).not.toBeNull();
    expect(document.querySelector('[data-date="canceling"]')).toBeNull();
  });
});

describe("an allowance meter", () => {
  const allowance = (overrides: Partial<AllowanceSummary> = {}): AllowanceSummary => ({
    metric: "VOICE_TRANSCRIPTION_SECONDS",
    included: 18_000,
    purchased: 0,
    used: 1_000,
    remaining: 17_000,
    health: "OK",
    resetsAt: new Date(NOW.getTime() + 10 * DAY),
    ...overrides,
  });

  it("shows what is left of what there is", () => {
    render(
      <ul>
        <AllowanceMeter t={t} allowance={allowance()} />
      </ul>,
    );

    expect(document.querySelector('[data-metric="VOICE_TRANSCRIPTION_SECONDS"]')?.getAttribute("data-health")).toBe("OK");
    expect(document.body.textContent).toContain(text("allowanceHealth.OK"));
  });

  it("names the bought half separately, because the two expire differently", () => {
    render(
      <ul>
        <AllowanceMeter t={t} allowance={allowance({ purchased: 1_800, remaining: 18_800, purchaseExpiresAt: new Date(NOW.getTime() + 40 * DAY) })} />
      </ul>,
    );

    expect(document.querySelector('[data-purchased="true"]')).not.toBeNull();
    expect(document.querySelector('[data-purchase-expires="true"]')).not.toBeNull();
  });

  it("carries the health as data as well as words, so a stylesheet need not parse prose", () => {
    render(
      <ul>
        <AllowanceMeter t={t} allowance={allowance({ used: 18_000, remaining: 0, health: "EXHAUSTED" })} />
      </ul>,
    );

    expect(document.querySelector('[data-health="EXHAUSTED"]')).not.toBeNull();
  });

  it("renders a progress element with an accessible name rather than a bare bar", () => {
    render(
      <ul>
        <AllowanceMeter t={t} allowance={allowance()} />
      </ul>,
    );

    // A styled div conveys nothing to a screen reader. A real `progress` carries its value and its name.
    expect(screen.getByRole("progressbar", { name: text("usageMetric.VOICE_TRANSCRIPTION_SECONDS") })).toBeDefined();
  });
});

describe("the capacity list", () => {
  it("shows what is used beside what is allowed", () => {
    render(<CapacityList t={t} capacity={data().overview.capacity} addOns={[]} />);

    expect(document.querySelector('[data-limit="BUSINESS_PROFILES"]')?.textContent).toContain("2");
  });

  it("says a plan caps nothing rather than showing a zero", () => {
    render(<CapacityList t={t} capacity={[{ limit: "SEATS", inUse: 4 }]} addOns={[]} />);

    // A zero would read as "you may have none of these".
    expect(document.querySelector('[data-limit="SEATS"]')?.textContent).toContain(text("billing.capacityUncapped").replace("{inUse}", "4"));
  });

  it("marks a ceiling that is already exceeded", () => {
    render(<CapacityList t={t} capacity={[{ limit: "SEATS", inUse: 9, ceiling: 5 }]} addOns={[]} />);

    expect(document.querySelector('[data-limit="SEATS"]')?.getAttribute("data-over")).toBe("true");
  });

  it("lists add-ons being paid for, with the date one ends", () => {
    render(
      <CapacityList
        t={t}
        capacity={[]}
        addOns={[{ code: "extra-seat", name: "One more seat", kind: "RECURRING_CAPACITY", quantity: 3, activeUntil: new Date(NOW.getTime() + DAY) }]}
      />,
    );

    const addOn = document.querySelector('[data-addon="extra-seat"]');
    expect(addOn?.textContent).toContain("3");
    expect(addOn?.querySelector("time")).not.toBeNull();
  });
});

describe("the other plans", () => {
  const offer = (overrides: Partial<PlanOffer> = {}): PlanOffer => ({
    planVersionId: "pv_1",
    code: "starter",
    name: "Starter",
    version: 1,
    prices: [{ currency: "EUR", interval: "MONTH", amountCents: 4_900 }],
    current: false,
    consequences: { overCapacity: [], losingFeatures: [], clean: true },
    ...overrides,
  });

  it("says a move costs nothing when it costs nothing", () => {
    render(<PlanOffers t={t} offers={[offer()]} checkoutAvailable={false} />);

    expect(document.querySelector('[data-offer-state="clean"]')?.textContent).toBe(text("billing.offerClean"));
  });

  it("names each resource that would exceed the plan, with the numbers", () => {
    render(
      <PlanOffers
        t={t}
        offers={[offer({ consequences: { overCapacity: [{ limit: "BUSINESS_PROFILES", inUse: 4, ceiling: 1 }], losingFeatures: [], clean: false } })]}
        checkoutAvailable={false}
      />,
    );

    const consequence = document.querySelector('[data-consequence="BUSINESS_PROFILES"]')?.textContent ?? "";
    expect(consequence).toContain("4");
    expect(consequence).toContain("1");
    // And the reassurance beside it: nothing is deleted and the choice is theirs.
    expect(document.body.textContent).toContain(text("billing.offerExplains"));
  });

  it("names a feature that would be lost", () => {
    render(
      <PlanOffers t={t} offers={[offer({ consequences: { overCapacity: [], losingFeatures: ["AUTOPILOT"], clean: false } })]} checkoutAvailable={false} />,
    );

    expect(document.querySelector('[data-consequence="AUTOPILOT"]')?.textContent).toContain(text("feature.AUTOPILOT"));
  });

  it("marks the current plan and offers it no consequences", () => {
    render(<PlanOffers t={t} offers={[offer({ current: true })]} checkoutAvailable={false} />);

    expect(document.querySelector('[data-offer-state="current"]')?.textContent).toBe(text("billing.currentOffer"));
  });

  it("says plainly that changing plan is not available here", () => {
    render(<PlanOffers t={t} offers={[offer()]} checkoutAvailable={false} />);

    // Honest rather than hopeful: an upgrade needs authoritative confirmation that money moved, and a
    // button that could not produce one would be a button that lies.
    expect(document.querySelector('[data-checkout="unavailable"]')?.textContent).toBe(text("billing.checkoutUnavailable"));
  });

  it("stops saying so once a provider exists", () => {
    render(<PlanOffers t={t} offers={[offer()]} checkoutAvailable />);

    expect(document.querySelector('[data-checkout="unavailable"]')).toBeNull();
  });
});

describe("formatting a price", () => {
  it("reads a stored minor-unit amount as money", () => {
    expect(formatPrice(t, 4_900, "EUR")).toContain("49");
    expect(formatPrice(t, 49_000, "EUR")).toContain("490");
  });

  it("uses the currency on the row rather than a hardcoded one", () => {
    // The architecture stays multi-currency, and a hardcoded EUR here would be the first place that
    // stopped being true.
    expect(formatPrice(t, 4_900, "USD")).not.toBe(formatPrice(t, 4_900, "EUR"));
  });

  it("does not assume every currency has two minor digits", () => {
    // Yen has none: a hundredth of a yen is not a thing, and dividing by a hundred would render one
    // hundred-thousandth of the price.
    expect(formatPrice(t, 4_900, "JPY")).toContain("4,900");
  });
});
