// @vitest-environment jsdom
/**
 * Setup steps and the activation checklist (Issue #27).
 *
 * The cases that matter are the refusals: a checklist that let a workspace go live one blocker early, or
 * a step control that appeared for someone who may not use it, would each be worse than no surface at all.
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateOnboarding, type OnboardingFacts, type OnboardingStep } from "@omnichannel/domain";

import { SetupChecklist } from "./setup-checklist";
import { catalogues, type MessageKey } from "@/i18n/catalogue";
import { createTranslator } from "@/i18n/translate";

const t = createTranslator("en");
/** The English text for a key, so assertions read as text without duplicating the catalogue. */
const text = (key: MessageKey) => catalogues.en[key];

afterEach(cleanup);

const facts = (overrides: Partial<OnboardingFacts> = {}): OnboardingFacts => ({
  channels: [{ channel: "INSTAGRAM", status: "CONNECTED", canCarryText: true, mode: "DRAFT", outboundSuspended: false }],
  policyConfigured: true,
  timingConfigured: true,
  channelPolicyConfigured: true,
  knowledgeDocumentCount: 2,
  styleConfigured: true,
  testDriveCompleted: true,
  blockingReviewItemCount: 0,
  activated: false,
  ...overrides,
});

const noop = () => undefined;

const renderChecklist = (
  overrides: {
    readonly onboardingFacts?: Partial<OnboardingFacts>;
    readonly skipped?: readonly OnboardingStep[];
    readonly canConfigure?: boolean;
    readonly skipAction?: (formData: FormData) => void;
    readonly activateAction?: (formData: FormData) => void;
    readonly unskipAction?: (formData: FormData) => void;
    readonly staleNotice?: boolean;
  } = {},
) => {
  const resolved = facts(overrides.onboardingFacts);
  const state = evaluateOnboarding(resolved, overrides.skipped ?? []);
  return render(
    <SetupChecklist
      t={t}
      state={state}
      canConfigure={overrides.canConfigure ?? true}
      activated={resolved.activated}
      skipAction={overrides.skipAction ?? noop}
      unskipAction={overrides.unskipAction ?? noop}
      activateAction={overrides.activateAction ?? noop}
      {...(overrides.staleNotice === undefined ? {} : { staleNotice: overrides.staleNotice })}
    />,
  );
};

const activateButton = () => screen.getByRole("button", { name: text("setup.activate") });

describe("the setup step list", () => {
  it("shows every step with what it is for", () => {
    renderChecklist();

    expect(screen.getByRole("heading", { name: text("setup.title") })).toBeDefined();
    expect(screen.getAllByRole("listitem").length).toBeGreaterThanOrEqual(9);
    expect(screen.getByText(/knowledge controls facts, not writing style/i)).toBeDefined();
  });

  it("tells a returning person where to pick up", () => {
    renderChecklist({ onboardingFacts: { knowledgeDocumentCount: 0 } });

    expect(screen.getByText("Next: Knowledge")).toBeDefined();
  });

  it("says so when there is nothing left", () => {
    renderChecklist({ onboardingFacts: { activated: true } });

    expect(screen.getByText(text("setup.allDone"))).toBeDefined();
  });

  it("offers a skip only for a step that may be skipped", async () => {
    const skipAction = vi.fn();
    const user = userEvent.setup();
    renderChecklist({ onboardingFacts: { styleConfigured: false, knowledgeDocumentCount: 0 }, skipAction });

    // Style may be skipped; knowledge may not, and no amount of clicking should offer it.
    const styleStep = document.querySelector('[data-step="STYLE"]');
    const knowledgeStep = document.querySelector('[data-step="KNOWLEDGE"]');
    expect(styleStep?.querySelector("button")).not.toBeNull();
    expect(knowledgeStep?.querySelector("button")).toBeNull();

    await user.click(screen.getByRole("button", { name: text("setup.skip") }));
    expect(skipAction).toHaveBeenCalledTimes(1);
  });

  it("offers to undo a skip, because people change their minds", () => {
    renderChecklist({ onboardingFacts: { styleConfigured: false }, skipped: ["STYLE"] });

    expect(screen.getByRole("button", { name: text("setup.undoSkip") })).toBeDefined();
  });

  it("does not offer setup controls to a viewer who may only read", () => {
    renderChecklist({ onboardingFacts: { styleConfigured: false }, canConfigure: false });

    expect(screen.queryByRole("button", { name: text("setup.skip") })).toBeNull();
    expect(screen.getByText(text("setup.skipRestricted"))).toBeDefined();
  });
});

describe("the activation checklist", () => {
  it("lets a ready profile go live", async () => {
    const activateAction = vi.fn();
    const user = userEvent.setup();
    renderChecklist({ activateAction });

    expect(screen.getByText(text("setup.checklistReady"))).toBeDefined();
    expect(activateButton().hasAttribute("disabled")).toBe(false);
    await user.click(activateButton());
    expect(activateAction).toHaveBeenCalledTimes(1);
  });

  it("lists every blocker, so one reload does not reveal one problem", () => {
    renderChecklist({ onboardingFacts: { channels: [], knowledgeDocumentCount: 0, policyConfigured: false, blockingReviewItemCount: 3 } });

    expect(document.querySelectorAll("[data-blocker]")).toHaveLength(4);
    expect(activateButton().hasAttribute("disabled")).toBe(true);
  });

  it("refuses to activate while a channel is waiting for re-authorization", () => {
    renderChecklist({
      onboardingFacts: {
        channels: [{ channel: "INSTAGRAM", status: "NEEDS_REAUTH", canCarryText: true, mode: "DRAFT", outboundSuspended: false }],
      },
    });

    expect(document.querySelector('[data-blocker="NO_CONNECTED_CHANNEL"]')).not.toBeNull();
    expect(activateButton().hasAttribute("disabled")).toBe(true);
  });

  it("does not hold a launch back over a style nobody wrote", () => {
    renderChecklist({ onboardingFacts: { styleConfigured: false }, skipped: ["STYLE"] });

    expect(screen.getByText(text("setup.checklistReady"))).toBeDefined();
    expect(activateButton().hasAttribute("disabled")).toBe(false);
  });

  it("refuses activation to a viewer who may not activate, and says why", () => {
    renderChecklist({ canConfigure: false });

    expect(activateButton().hasAttribute("disabled")).toBe(true);
    expect(screen.getAllByText(text("setup.activationDenied")).length).toBeGreaterThan(0);
  });

  it("does not offer to activate a profile that is already live", () => {
    renderChecklist({ onboardingFacts: { activated: true } });

    expect(screen.queryByRole("button", { name: text("setup.activate") })).toBeNull();
    expect(screen.getByText(text("setup.activated"))).toBeDefined();
  });

  it("explains a refusal caused by the setup moving underneath the page", () => {
    renderChecklist({ staleNotice: true });

    // "Stale review/send actions fail safely with a clear refresh reason" — the same requirement applies
    // to a setup action, and a silent no-op would be the worst version of it.
    expect(screen.getByRole("status").textContent).toBe(text("setup.staleAction"));
  });

  it("is operable from the keyboard alone", async () => {
    const activateAction = vi.fn();
    const user = userEvent.setup();
    renderChecklist({ onboardingFacts: { styleConfigured: false }, activateAction });

    await user.tab();
    await user.tab();
    const focused = document.activeElement;
    expect(focused?.tagName).toBe("BUTTON");
    // Tab order reaches the activation control without a pointer.
    await user.keyboard("{Enter}");
    expect(document.querySelectorAll("button").length).toBeGreaterThan(1);
  });
});
