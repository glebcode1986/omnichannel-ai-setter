// @vitest-environment jsdom
/**
 * The front door's three panes (#115).
 *
 * The cases worth writing are the ones where the page would tell somebody something untrue about their own
 * account: a trial presented as running when no subscription exists, a promise of a trial in a deployment
 * that has published no trial plan, a paid term's end date rendered as a trial expiry, and a control
 * offered to somebody the server will refuse.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NAME_MAX_LENGTH, type OnboardingProfileState, type WorkspaceOnboardingState } from "@omnichannel/db";
import { toBusinessProfileId } from "@omnichannel/domain";

import { CreateProfileForm } from "./create-profile-form";
import { CreateWorkspaceForm } from "./create-workspace-form";
import { WorkspaceEntry } from "./workspace-entry";
import { catalogues, type MessageKey } from "@/i18n/catalogue";
import { createTranslator } from "@/i18n/translate";

const t = createTranslator("en");
const ru = createTranslator("ru");
const text = (key: MessageKey) => catalogues.en[key];
const action = () => Promise.resolve();

afterEach(cleanup);

const state = (overrides: Partial<WorkspaceOnboardingState> = {}): WorkspaceOnboardingState => ({
  profiles: [],
  trial: { noTrialReason: "AWAITING_FIRST_CONNECTION" },
  readAt: new Date("2026-10-28T12:00:00.000Z"),
  ...overrides,
});

describe("the workspace creation form", () => {
  it("offers one labelled field and a submit", () => {
    render(<CreateWorkspaceForm t={t} action={action} />);

    expect(screen.getByLabelText(text("onboarding.workspaceNameLabel"))).toBeDefined();
    expect(screen.getByRole("button", { name: text("onboarding.createWorkspace") })).toBeDefined();
  });

  it("caps the field at the length the store enforces", () => {
    // Not the rule — the rule is the action and the store — but a field that invited 400 characters and
    // then refused them is a form that wastes somebody's typing.
    render(<CreateWorkspaceForm t={t} action={action} />);

    expect(screen.getByLabelText(text("onboarding.workspaceNameLabel")).getAttribute("maxLength")).toBe(String(NAME_MAX_LENGTH));
  });

  it("says the limit in the sentence rather than leaving the placeholder in it", () => {
    render(<CreateWorkspaceForm t={t} action={action} />);

    expect(screen.getByText(`Up to ${String(NAME_MAX_LENGTH)} characters.`)).toBeDefined();
    expect(document.body.textContent).not.toContain("{max}");
  });
});

describe("the business profile creation form", () => {
  it("offers the control to a membership that may create one", () => {
    render(<CreateProfileForm t={t} action={action} allowed />);

    expect(screen.getByLabelText(text("onboarding.profileNameLabel"))).toBeDefined();
    expect(screen.getByRole("button", { name: text("onboarding.createProfile") })).toBeDefined();
  });

  it("withholds the control and says why, rather than leaving a blank space", () => {
    // "I cannot find where to add a profile" and "I am not allowed to" are different problems, and only
    // one of them is worth asking an administrator about.
    render(<CreateProfileForm t={t} action={action} allowed={false} />);

    expect(screen.getByText(text("onboarding.createProfileForbidden"))).toBeDefined();
    expect(screen.queryByRole("button")).toBeNull();
    expect(document.querySelector('[data-form="create-profile"]')).toBeNull();
  });
});

describe("the frame the first screen after signing in is drawn in", () => {
  /*
   * These were the complaint — "очень сыро" — and they are the part no other test here could notice,
   * because every case above asks what the words say. The screen said the right things inside a bare
   * `<ul>` carrying its own `listStyle`/`margin`/`padding`, under a lone `h2`, with its one form wearing
   * a class named after the Knowledge editor.
   */
  const profile: OnboardingProfileState = {
    businessProfileId: toBusinessProfileId("bp_1"),
    name: "Main",
    status: "SETUP",
    connectedChannels: [],
  };

  it("puts the profiles in a panel with a heading, not loose on the page", () => {
    const { container } = render(<WorkspaceEntry t={t} workspaceId="ws_1" state={state({ profiles: [profile] })} />);

    const panel = container.querySelector("section.panel");
    expect(panel, "the list is framed like every other section in the product").not.toBeNull();
    expect(panel?.querySelector("h2")?.textContent).toBe(text("workspaces.profilesYours"));
    // A card title is `h3`: it sits under the section's heading, not beside it.
    expect(panel?.querySelector("ul.card-grid li.card h3")?.textContent).toBe("Main");
  });

  it("explains what a business profile is when there are none, instead of only reporting that there are none", () => {
    render(<WorkspaceEntry t={t} workspaceId="ws_1" state={state({ profiles: [] })} />);

    // Somebody seeing this has nothing else on the screen, and has never had one of these.
    expect(screen.getByText(text("workspaces.profilesEmpty"))).toBeDefined();
    expect(screen.getByText(text("workspaces.profilesEmptyBody"))).toBeDefined();
    expect(document.querySelector("section.panel .empty-state")).not.toBeNull();
  });

  it("draws the next step as a control rather than as a word in a sentence", () => {
    render(<WorkspaceEntry t={t} workspaceId="ws_1" state={state({ profiles: [profile] })} />);

    const next = screen.getByRole("link", { name: text("onboarding.continueSetup") });
    expect(next.className).toContain("button");
    expect(next.getAttribute("data-variant")).toBe("primary");
  });

  it("carries no inline style, on either branch", () => {
    // Three of them lived here: the grid's list reset and the card title's size and margin, all written
    // as numbers on the element where no stylesheet and no media query can reach them.
    const withProfiles = render(<WorkspaceEntry t={t} workspaceId="ws_1" state={state({ profiles: [profile] })} />);
    expect(withProfiles.container.querySelectorAll("[style]")).toHaveLength(0);
    cleanup();

    const withNone = render(<WorkspaceEntry t={t} workspaceId="ws_1" state={state({ profiles: [] })} />);
    expect(withNone.container.querySelectorAll("[style]")).toHaveLength(0);
  });

  it.each([
    ["the workspace form", <CreateWorkspaceForm key="w" t={t} action={action} />, "create-workspace"],
    ["the profile form", <CreateProfileForm key="p" t={t} action={action} allowed />, "create-profile"],
  ])("gives %s the product's own field frame", (_name, element, formName) => {
    const { container } = render(element);

    // `form-stack` holding a `form-grid` of `field`s, which is what every other form in the product is.
    // Both used to be `knowledge-editor` — a class named after a different feature, on the two forms a
    // new customer submits before they have seen any other screen.
    const form = container.querySelector(`form[data-form="${formName}"]`);
    expect(form?.className).toBe("form-stack");
    expect(form?.querySelector(".form-grid .field > label")).not.toBeNull();
    expect(form?.querySelector(".form-grid .field > input")).not.toBeNull();
    expect(form?.querySelector(".form-actions > button")).not.toBeNull();
  });
});

describe("what the workspace entry says about the trial", () => {
  it("promises the trial on first connection when a trial plan exists to start", () => {
    render(<WorkspaceEntry t={t} workspaceId="ws_1" state={state()} />);

    expect(screen.getByText(text("onboarding.trialNotStarted"))).toBeDefined();
    expect(document.querySelector('[data-trial="AWAITING_FIRST_CONNECTION"]')?.getAttribute("data-tone")).toBeNull();
  });

  it("refuses to promise a trial this deployment cannot start, and marks it a blocker", () => {
    // The live defect this exists for: with no published catalogue `ensureWorkspaceTrial` returns
    // silently, so a connection succeeds and grants nothing. Saying "connect to start your trial" there
    // is a promise the deployment cannot keep.
    render(<WorkspaceEntry t={t} workspaceId="ws_1" state={state({ trial: { noTrialReason: "TRIAL_PLAN_UNPUBLISHED" } })} />);

    expect(screen.getByText(text("onboarding.trialUnavailable"))).toBeDefined();
    expect(document.querySelector('[data-trial="TRIAL_PLAN_UNPUBLISHED"]')?.getAttribute("data-tone")).toBe("stop");
    expect(screen.queryByText(text("onboarding.trialNotStarted"))).toBeNull();
  });

  it("dates a running trial from the row rather than from today", () => {
    const trialEndsAt = new Date("2026-11-11T12:00:00.000Z");
    render(
      <WorkspaceEntry t={t} workspaceId="ws_1" state={state({ trial: { subscriptionState: "TRIALING", planCode: "trial", trialEndsAt } })} />,
    );

    expect(document.querySelector('[data-trial="TRIALING"]')).not.toBeNull();
    expect(screen.getByText(/Trial ends/u)).toBeDefined();
    expect(document.querySelector("time")?.getAttribute("dateTime")).toBe(trialEndsAt.toISOString());
  });

  it("never renders a paid term's end date as a trial expiry", () => {
    // A paid subscription also carries an end date. Presenting that as a trial expiry is how a screen
    // tells a paying customer their trial is about to run out.
    render(<WorkspaceEntry t={t} workspaceId="ws_1" state={state({ trial: { subscriptionState: "ACTIVE", planCode: "growth" } })} />);

    expect(document.querySelector('[data-trial="ACTIVE"]')).not.toBeNull();
    expect(screen.queryByText(/Trial ends/u)).toBeNull();
    expect(document.querySelector("time")).toBeNull();
  });

  it("says nothing about a trial it has no state for", () => {
    render(<WorkspaceEntry t={t} workspaceId="ws_1" state={state({ trial: {} })} />);

    expect(document.querySelector("[data-trial]")).toBeNull();
  });
});

describe("what the workspace entry says about each profile", () => {
  const profile: OnboardingProfileState = {
    businessProfileId: toBusinessProfileId("bp_1"),
    name: "Main",
    status: "SETUP",
    connectedChannels: [],
  };

  it("says plainly that nothing is connected, which is the question a new profile raises", () => {
    render(<WorkspaceEntry t={t} workspaceId="ws_1" state={state({ profiles: [{ ...profile, connectedChannels: [] }] })} />);

    expect(screen.getByText(text("onboarding.noChannelConnected"))).toBeDefined();
    expect(screen.getByRole("link", { name: text("onboarding.continueSetup") }).getAttribute("href")).toBe(
      "/workspaces/ws_1/profiles/bp_1/setup",
    );
  });

  it("lists the channels that are live, localized rather than raw", () => {
    render(
      <WorkspaceEntry t={t} workspaceId="ws_1" state={state({ profiles: [{ ...profile, connectedChannels: ["INSTAGRAM", "WHATSAPP"] }] })} />,
    );

    expect(screen.getByText("Connected: Instagram, WhatsApp")).toBeDefined();
  });

  it("renders the whole pane in Russian for a Russian reader", () => {
    // The gate that fails the build on unlocalized text cannot tell whether the *right* locale came out,
    // and an enum interpolated into a localized sentence is exactly where English has leaked before.
    render(
      <WorkspaceEntry t={ru} workspaceId="ws_1" state={state({ profiles: [{ ...profile, status: "ACTIVE", connectedChannels: [] }] })} />,
    );

    expect(screen.getByText(catalogues.ru["onboarding.trialNotStarted"])).toBeDefined();
    expect(screen.getByText(catalogues.ru["onboarding.noChannelConnected"])).toBeDefined();
    expect(screen.getByText(catalogues.ru["profileStatus.ACTIVE"])).toBeDefined();
  });
});
