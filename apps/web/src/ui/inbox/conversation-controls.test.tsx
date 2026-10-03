// @vitest-environment jsdom
/**
 * Taking a conversation, and stopping a reply (Issue #29).
 *
 * The case this exists for is the claimed send. A delivery the worker has taken may be at the provider
 * already, so the pane must not offer to cancel it — and must not offer a disabled button either, because
 * a failed cancel afterwards would imply the customer did not receive something they may well have. The
 * control is absent and a sentence explains why.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationDetail, PendingSend } from "@omnichannel/db";

import { ConversationControls } from "./conversation-controls";
import { catalogues, type MessageKey } from "@/i18n/catalogue";
import { createTranslator } from "@/i18n/translate";

const t = createTranslator("en");
const text = (key: MessageKey) => catalogues.en[key];
const VIEWER = "usr_viewer";

afterEach(cleanup);

const actions = () => ({
  takeOver: vi.fn(() => Promise.resolve()),
  handBack: vi.fn(() => Promise.resolve()),
  cancelSend: vi.fn(() => Promise.resolve()),
});

const send = (overrides: Partial<PendingSend> = {}): PendingSend => ({
  operationId: "op_1",
  draftId: "dr_1",
  text: "Saturday at 3pm works.",
  scheduledFor: new Date("2026-09-30T10:05:00.000Z"),
  claimed: false,
  authority: "AUTOMATED",
  ...overrides,
});

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

const controls = (overrides: Partial<ConversationDetail> = {}) =>
  render(
    <ConversationControls
      t={t}
      conversation={conversation(overrides)}
      target={{ workspaceId: "ws_1", businessProfileId: "bp_1" }}
      viewerUserId={VIEWER}
      takeoverByUserId={overrides.takeoverByUserId ?? null}
      takeoverPausedUntil={overrides.takeoverPausedUntil ?? null}
      actions={actions()}
    />,
  );

describe("taking over and handing back", () => {
  it("offers to take a conversation nobody is holding", () => {
    controls();

    expect(screen.getByRole("button", { name: text("control.takeOver") })).toBeDefined();
    expect(screen.queryByRole("button", { name: text("control.handBack") })).toBeNull();
  });

  it("offers to hand back one that is held", () => {
    controls({ takeoverState: "HUMAN_ACTIVE", takeoverByUserId: VIEWER });

    expect(screen.getByRole("button", { name: text("control.handBack") })).toBeDefined();
    expect(screen.queryByRole("button", { name: text("control.takeOver") })).toBeNull();
  });

  it("says 'you' rather than naming the viewer to themselves", () => {
    controls({ takeoverState: "HUMAN_ACTIVE", takeoverByUserId: VIEWER, takeoverByName: "Marina" });

    expect(screen.getByText(text("control.heldByYou"))).toBeDefined();
    expect(screen.queryByText(/Marina/u)).toBeNull();
  });

  it("names the colleague when somebody else is holding it", () => {
    controls({ takeoverState: "HUMAN_ACTIVE", takeoverByUserId: "usr_other", takeoverByName: "Marina" });

    expect(screen.getByText(/Marina/u)).toBeDefined();
    expect(screen.queryByText(text("control.heldByYou"))).toBeNull();
  });

  it("says when the assistant will resume, when a pause is running", () => {
    controls({ takeoverState: "HUMAN_ACTIVE", takeoverByUserId: VIEWER, takeoverPausedUntil: new Date("2026-09-30T18:00:00.000Z") });

    expect(document.querySelector('[data-paused-until="2026-09-30T18:00:00.000Z"]')).not.toBeNull();
  });

  it("says nothing about resuming when nothing is paused", () => {
    controls({ takeoverState: "HUMAN_ACTIVE", takeoverByUserId: VIEWER });

    expect(document.querySelector("[data-paused-until]")).toBeNull();
  });

  it("offers a pause with a duration, defaulting to something sensible rather than empty", () => {
    controls();

    const hours = screen.getByLabelText(text("control.pauseHours"));
    expect(hours).toHaveProperty("value", "6");
    expect(hours.getAttribute("min")).toBe("1");
  });
});

describe("a reply waiting to go out", () => {
  it("shows it, with when it goes and what it says", () => {
    controls({ pendingSends: [send()] });

    expect(screen.getByText(text("control.pendingTitle"))).toBeDefined();
    expect(screen.getByText("Saturday at 3pm works.")).toBeDefined();
    expect(document.querySelector("[data-operation='op_1'] time")?.getAttribute("datetime")).toBe("2026-09-30T10:05:00.000Z");
  });

  it("offers to stop one the worker has not taken", () => {
    controls({ pendingSends: [send({ claimed: false })] });

    expect(screen.getByRole("button", { name: text("control.cancelSend") })).toBeDefined();
    expect(document.querySelector('input[name="operationId"]')?.getAttribute("value")).toBe("op_1");
  });

  it("offers nothing at all for one already being sent, and says why", () => {
    controls({ pendingSends: [send({ claimed: true })] });

    // Not a disabled button: a cancel that failed afterwards would suggest the customer did not get it.
    expect(screen.queryByRole("button", { name: text("control.cancelSend") })).toBeNull();
    expect(screen.getByText(text("control.sending"))).toBeDefined();
    expect(document.querySelector('[data-uncancellable="true"]')).not.toBeNull();
  });

  it("handles a claimed and an unclaimed send side by side", () => {
    controls({ pendingSends: [send({ operationId: "op_a", claimed: true }), send({ operationId: "op_b", claimed: false })] });

    expect(screen.getAllByRole("button", { name: text("control.cancelSend") })).toHaveLength(1);
    expect(document.querySelector('[data-operation="op_b"] input[name="operationId"]')?.getAttribute("value")).toBe("op_b");
  });

  it("says nothing about pending sends when nothing is queued", () => {
    controls({ pendingSends: [] });

    expect(screen.queryByText(text("control.pendingTitle"))).toBeNull();
  });

  it("shows a queued send that carries no text without an empty paragraph", () => {
    controls({ pendingSends: [send({ text: null })] });

    expect(document.querySelector("[data-operation='op_1'] .message-text")).toBeNull();
    expect(screen.getByRole("button", { name: text("control.cancelSend") })).toBeDefined();
  });
});

describe("the pane as a whole", () => {
  it("names its region, so a screen reader can reach it", () => {
    controls();

    expect(screen.getByRole("region", { name: text("control.title") })).toBeDefined();
  });

  it("reports no delivery outcome of its own", () => {
    // The delivery coordinator decides whether a send happens. A control that turned green before the
    // server agreed would be the UI reporting a platform outcome it does not know.
    controls({ pendingSends: [send()] });

    for (const key of ["deliveryStatus.SENT", "deliveryStatus.DELIVERED", "deliveryStatus.READ"] as const) {
      expect(screen.queryByText(text(key))).toBeNull();
    }
  });

  it("reads in Russian", () => {
    render(
      <ConversationControls
        t={createTranslator("ru")}
        conversation={conversation({ pendingSends: [send({ claimed: true })] })}
        target={{ workspaceId: "ws_1", businessProfileId: "bp_1" }}
        viewerUserId={VIEWER}
        takeoverByUserId={null}
        takeoverPausedUntil={null}
        actions={actions()}
      />,
    );

    expect(screen.getByText(catalogues.ru["control.sending"])).toBeDefined();
  });
});
