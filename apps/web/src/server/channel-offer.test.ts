/**
 * One answer to "which channels can this deployment connect, and how".
 *
 * This function exists because two screens asked separately and drifted. So the test that matters most is
 * the last one: both screens must now get the *same* object, and that is asserted by calling the function
 * the way each page calls it rather than by trusting that they do.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("./instagram", () => ({ instagramOAuthConfigured: () => instagramConfigured }));
vi.mock("./whatsapp", () => ({ whatsAppSignupConfigured: () => whatsAppConfigured }));

let instagramConfigured = true;
let whatsAppConfigured = true;

const { channelOffer, SUPPORTED_CHANNELS } = await import("./channel-offer");

const TARGET = { workspaceId: "ws_1", businessProfileId: "bp_1" } as const;
const owner = { role: "OWNER" } as Parameters<typeof channelOffer>[1];
const agent = { role: "AGENT" } as Parameters<typeof channelOffer>[1];

describe("a deployment with both apps configured", () => {
  it("offers both channels and a control for each", () => {
    instagramConfigured = true;
    whatsAppConfigured = true;

    const offer = channelOffer(TARGET, owner);

    expect(offer.offered).toEqual(["INSTAGRAM", "WHATSAPP"]);
    expect(offer.connect.INSTAGRAM).toEqual({
      kind: "REDIRECT",
      action: "/api/workspaces/ws_1/business-profiles/bp_1/channels/instagram/connect",
    });
    expect(offer.connect.WHATSAPP).toEqual({
      kind: "EMBEDDED",
      connectPath: "/api/workspaces/ws_1/business-profiles/bp_1/channels/whatsapp/connect",
      completePath: "/api/workspaces/ws_1/business-profiles/bp_1/channels/whatsapp/complete",
    });
  });
});

describe("a deployment with no Instagram app", () => {
  it("still shows the card, and offers no control to start a connection that cannot finish", () => {
    instagramConfigured = false;
    whatsAppConfigured = true;

    const offer = channelOffer(TARGET, owner);

    // The card stays: a reader is entitled to see where a channel stands even where they cannot act on
    // it. What goes away is the button that walked them out to Meta, which refused credentials it had
    // never heard of and showed them a page of its own.
    expect(offer.offered).toContain("INSTAGRAM");
    expect(offer.connect.INSTAGRAM).toBeUndefined();
    expect(offer.connect.WHATSAPP).toBeDefined();
  });
});

describe("a deployment with neither", () => {
  it("offers every card and no control at all", () => {
    instagramConfigured = false;
    whatsAppConfigured = false;

    const offer = channelOffer(TARGET, owner);

    expect(offer.offered).toEqual(SUPPORTED_CHANNELS);
    expect(offer.connect).toEqual({});
  });
});

describe("a reader who may not configure channels", () => {
  it("gets no control even where both apps are configured", () => {
    instagramConfigured = true;
    whatsAppConfigured = true;

    const offer = channelOffer(TARGET, agent);

    expect(offer.offered).toEqual(SUPPORTED_CHANNELS);
    expect(offer.connect).toEqual({});
  });
});

describe("the two screens", () => {
  it("get the same offer for the same reader and target", () => {
    instagramConfigured = true;
    whatsAppConfigured = true;

    // The setup screen passes a prepared `target`; the channels screen passes the two ids inline. The
    // divergence this function replaced was exactly of that kind — same intent, two spellings, and one of
    // them stopped working — so the two call shapes are compared rather than assumed equal.
    const fromSetup = channelOffer(TARGET, owner);
    const fromChannels = channelOffer({ workspaceId: "ws_1", businessProfileId: "bp_1" }, owner);

    expect(fromChannels).toEqual(fromSetup);
  });
});
