// @vitest-environment jsdom
/**
 * Channel connection cards (Issue #27).
 *
 * The card is where a non-technical owner finds out why their assistant is silent, so the four states have
 * to read as four different situations. These tests check that they do, and that nothing resembling a
 * credential can reach the markup.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ChannelOnboardingFacts } from "@omnichannel/domain";

import { ChannelCards } from "./channel-cards";
import { catalogues } from "@/i18n/catalogue";
import { createTranslator } from "@/i18n/translate";

const t = createTranslator("en");
const label = (readiness: string) => catalogues.en[`channelReadiness.${readiness}` as keyof typeof catalogues.en];

afterEach(cleanup);

const account = (overrides: Partial<ChannelOnboardingFacts> = {}): ChannelOnboardingFacts => ({
  channel: "INSTAGRAM",
  status: "CONNECTED",
  canCarryText: true,
  mode: "DRAFT",
  outboundSuspended: false,
  caveats: [],
  ...overrides,
});

describe("channel cards", () => {
  it("offers a card for a channel that has never been connected", () => {
    render(<ChannelCards t={t} channels={[]} offered={["INSTAGRAM"]} connect={{ INSTAGRAM: { kind: "REDIRECT", action: "/connect" } }} />);

    // Without this the person has nothing to click: the absence of a channel is exactly when they need
    // the card most.
    expect(screen.getByText(label("NOT_CONFIGURED"))).toBeDefined();
    // A form and not a link: the connect route is POST-only, and an `<a href>` pointing at it answered
    // 405 — the one button on the setup screen connected nothing.
    const button = screen.getByRole("button", { name: /connect instagram/i });
    expect(button.getAttribute("type")).toBe("submit");
    expect(button.closest("form")?.getAttribute("action")).toBe("/connect");
    expect(button.closest("form")?.getAttribute("method")).toBe("post");
  });

  it("says four different things about four different situations", () => {
    const cases = [
      [account({ status: "NEEDS_REAUTH" }), label("CONFIGURED")],
      [account({ mode: "OFF" }), label("CONNECTED")],
      [account({ outboundSuspended: true }), label("ELIGIBLE")],
      [account(), label("SENDABLE")],
    ] as const;

    for (const [facts, text] of cases) {
      cleanup();
      render(<ChannelCards t={t} channels={[facts]} offered={["INSTAGRAM"]} />);
      expect(screen.getByText(text), text).toBeDefined();
    }

    // And the labels themselves are genuinely different sentences, not synonyms wearing four names.
    const all = ["NOT_CONFIGURED", "CONFIGURED", "CONNECTED", "ELIGIBLE", "SENDABLE"].map(label);
    expect(new Set(all).size).toBe(all.length);
  });

  it("still offers reconnection when the authorization lapsed", () => {
    render(<ChannelCards t={t} channels={[account({ status: "NEEDS_REAUTH" })]} offered={["INSTAGRAM"]} connect={{ INSTAGRAM: { kind: "REDIRECT", action: "/connect" } }} />);

    // "Incomplete Meta authorization is shown as an actionable connection problem, not a generic error."
    expect(screen.getByRole("button", { name: /connect instagram/i })).toBeDefined();
  });

  it("does not push a working channel to reconnect", () => {
    render(<ChannelCards t={t} channels={[account()]} offered={["INSTAGRAM"]} connect={{ INSTAGRAM: { kind: "REDIRECT", action: "/connect" } }} />);

    expect(screen.queryByRole("button", { name: /connect instagram/i })).toBeNull();
  });

  it("hides the connect action from a viewer who may not connect channels", () => {
    render(<ChannelCards t={t} channels={[]} offered={["INSTAGRAM"]} />);

    expect(screen.queryByRole("button", { name: /connect instagram/i })).toBeNull();
  });

  it("offers WhatsApp where the deployment has an app, and says so where it has not", () => {
    // WhatsApp has been connectable end to end since Issue #19 and the setup screen offered Instagram
    // alone, so the one place a customer could have connected it did not mention it.
    render(
      <ChannelCards
        t={t}
        channels={[]}
        offered={["INSTAGRAM", "WHATSAPP"]}
        connect={{ WHATSAPP: { kind: "EMBEDDED", connectPath: "/wa/start", completePath: "/wa/finish" } }}
      />,
    );

    expect(screen.getByRole("button", { name: /connect whatsapp/i })).toBeDefined();
    // Instagram is offered as a channel and has no control, because this reader cannot start one — and
    // the card says that rather than leaving an empty space somebody reads as a bug.
    expect(screen.queryByRole("button", { name: /connect instagram/i })).toBeNull();
    expect(screen.getByText(catalogues.en["setup.channelNotOffered"])).toBeDefined();
  });

  it("does not offer a channel this installation cannot connect", () => {
    // A deployment with no WhatsApp app answers every connect with 503. A button that does that reads
    // as our failure rather than as a missing app.
    render(<ChannelCards t={t} channels={[]} offered={["INSTAGRAM", "WHATSAPP"]} connect={{}} />);

    expect(screen.queryByRole("button", { name: /connect/i })).toBeNull();
    expect(screen.getAllByText(catalogues.en["setup.channelNotOffered"]).length).toBe(2);
  });

  it("renders nothing that looks like a credential", () => {
    // The component is never handed one, which is the real guarantee; this asserts the guarantee holds
    // for the whole rendered subtree rather than trusting the prop types.
    const { container } = render(
      <ChannelCards t={t} channels={[account(), account({ channel: "WHATSAPP" })]} offered={["INSTAGRAM", "WHATSAPP"]} connect={{ INSTAGRAM: { kind: "REDIRECT", action: "/connect" } }} />,
    );

    const markup = container.innerHTML;
    for (const forbidden of ["token", "secret", "Bearer", "access_token", "appsecret"]) {
      expect(markup.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it("shows a card per offered channel, including one with no account yet", () => {
    render(<ChannelCards t={t} channels={[account()]} offered={["INSTAGRAM", "WHATSAPP"]} />);

    expect(screen.getByRole("heading", { name: "Instagram" })).toBeDefined();
    expect(screen.getByRole("heading", { name: "WhatsApp" })).toBeDefined();
  });
});
