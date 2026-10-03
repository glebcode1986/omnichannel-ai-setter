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
  ...overrides,
});

describe("channel cards", () => {
  it("offers a card for a channel that has never been connected", () => {
    render(<ChannelCards t={t} channels={[]} offered={["INSTAGRAM"]} instagramConnectPath="/connect" />);

    // Without this the person has nothing to click: the absence of a channel is exactly when they need
    // the card most.
    expect(screen.getByText(label("NOT_CONFIGURED"))).toBeDefined();
    expect(screen.getByRole("link", { name: /connect instagram/i }).getAttribute("href")).toBe("/connect");
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
    render(<ChannelCards t={t} channels={[account({ status: "NEEDS_REAUTH" })]} offered={["INSTAGRAM"]} instagramConnectPath="/connect" />);

    // "Incomplete Meta authorization is shown as an actionable connection problem, not a generic error."
    expect(screen.getByRole("link", { name: /connect instagram/i })).toBeDefined();
  });

  it("does not push a working channel to reconnect", () => {
    render(<ChannelCards t={t} channels={[account()]} offered={["INSTAGRAM"]} instagramConnectPath="/connect" />);

    expect(screen.queryByRole("link", { name: /connect instagram/i })).toBeNull();
  });

  it("hides the connect action from a viewer who may not connect channels", () => {
    render(<ChannelCards t={t} channels={[]} offered={["INSTAGRAM"]} />);

    expect(screen.queryByRole("link", { name: /connect instagram/i })).toBeNull();
  });

  it("renders nothing that looks like a credential", () => {
    // The component is never handed one, which is the real guarantee; this asserts the guarantee holds
    // for the whole rendered subtree rather than trusting the prop types.
    const { container } = render(
      <ChannelCards t={t} channels={[account(), account({ channel: "WHATSAPP" })]} offered={["INSTAGRAM", "WHATSAPP"]} instagramConnectPath="/connect" />,
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
