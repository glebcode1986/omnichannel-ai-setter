// @vitest-environment jsdom
/**
 * The composer (ADR-018 Option B; Issue #29).
 *
 * What it must never do is promise delivery. Pressing send queues a reply which the coordinator then
 * re-checks against the takeover, a newer message, the provider's window, the account's health and the
 * kill switch — so the pane says that, and offers nothing that reports a platform outcome.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationDetail } from "@omnichannel/db";

import { Composer } from "./composer";
import { catalogues, type MessageKey } from "@/i18n/catalogue";
import { createTranslator } from "@/i18n/translate";

const t = createTranslator("en");
const text = (key: MessageKey) => catalogues.en[key];
const TARGET = { workspaceId: "ws_1", businessProfileId: "bp_1" };

afterEach(cleanup);

const conversation = (overrides: Partial<ConversationDetail> = {}): ConversationDetail => ({
  id: "cv_1",
  channel: "INSTAGRAM",
  channelAccountId: "ca_ig",
  accountStatus: "CONNECTED",
  contactName: "Ann Petrova",
  handle: "@ann",
  status: "OPEN",
  leadStage: "ENGAGED",
  modeOverride: null,
  effectiveMode: "DRAFT",
  aiEnabled: true,
  takeoverState: "NONE",
  takeoverReason: null,
  takeoverReviewMode: null,
  takeoverByName: null,
  takeoverByUserId: null,
  takeoverPausedUntil: null,
  humanTakeoverAt: null,
  lastInboundAt: null,
  lastOutboundAt: null,
  messages: [],
  pendingSends: [],
  ...overrides,
});

const composer = (props: Partial<Parameters<typeof Composer>[0]> = {}) =>
  render(
    <Composer
      t={t}
      conversation={conversation()}
      target={TARGET}
      hasPendingReply={false}
      humanAgentAvailable={false}
      action={vi.fn(() => Promise.resolve())}
      {...props}
    />,
  );

describe("writing a reply", () => {
  it("offers a box and a send button", () => {
    composer();

    expect(screen.getByLabelText(text("composer.label"))).toBeDefined();
    expect(screen.getByRole("button", { name: text("composer.send") })).toBeDefined();
  });

  it("says plainly that sending queues a reply rather than delivering one", () => {
    // The coordinator decides whether it goes out. A composer that promised delivery would be making a
    // claim the gates have not agreed to.
    composer();

    expect(screen.getByText(text("composer.gatesNote"))).toBeDefined();
  });

  it("reports no delivery outcome of its own", () => {
    composer();

    for (const key of ["deliveryStatus.SENT", "deliveryStatus.DELIVERED", "deliveryStatus.READ"] as const) {
      expect(screen.queryByText(text(key))).toBeNull();
    }
  });

  it("requires something to send", () => {
    composer();

    expect(screen.getByLabelText(text("composer.label")).hasAttribute("required")).toBe(true);
  });
});

describe("the provider's human-support path", () => {
  it("is offered only where the conversation is already waiting on one", () => {
    // Offering it everywhere would invite authorizing a send the gates will refuse (ADR-014).
    composer({ humanAgentAvailable: false });
    expect(screen.queryByLabelText(text("composer.humanAgent"))).toBeNull();

    cleanup();
    composer({ humanAgentAvailable: true });
    expect(screen.getByLabelText(text("composer.humanAgent"))).toBeDefined();
  });

  it("sends the mode as a value the server reads, unchecked by default", () => {
    composer({ humanAgentAvailable: true });

    const box = screen.getByLabelText(text("composer.humanAgent"));
    expect(box).toHaveProperty("checked", false);
    expect(box.getAttribute("name")).toBe("reviewMode");
    expect(box.getAttribute("value")).toBe("HUMAN_AGENT");
  });
});

describe("when it does not offer a box", () => {
  it("says a reply of theirs is already queued, rather than disabling the box", () => {
    // Disabled reads as "you may not". The truth is that one of theirs is waiting, and the pending-send
    // card is where they stop it.
    composer({ hasPendingReply: true });

    expect(screen.getByText(text("composer.pending"))).toBeDefined();
    expect(screen.queryByLabelText(text("composer.label"))).toBeNull();
    expect(screen.queryAllByRole("button")).toEqual([]);
  });

  it("says a closed conversation cannot be replied into", () => {
    composer({ conversation: conversation({ status: "CLOSED" }) });

    expect(screen.getByText(text("composer.closed"))).toBeDefined();
    expect(screen.queryByLabelText(text("composer.label"))).toBeNull();
  });

  it("offers the box again for an open conversation with nothing queued", () => {
    composer();

    expect(screen.getByLabelText(text("composer.label"))).toBeDefined();
    expect(screen.queryByText(text("composer.pending"))).toBeNull();
    expect(screen.queryByText(text("composer.closed"))).toBeNull();
  });
});

describe("in Russian", () => {
  it("reads in Russian", () => {
    render(
      <Composer
        t={createTranslator("ru")}
        conversation={conversation()}
        target={TARGET}
        hasPendingReply={false}
        humanAgentAvailable
        action={vi.fn(() => Promise.resolve())}
      />,
    );

    expect(screen.getByText(catalogues.ru["composer.gatesNote"])).toBeDefined();
    expect(screen.getByLabelText(catalogues.ru["composer.humanAgent"])).toBeDefined();
  });
});
