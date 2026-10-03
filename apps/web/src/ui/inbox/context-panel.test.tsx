// @vitest-environment jsdom
/**
 * Why the assistant did what it did (Issue #28).
 *
 * The panel's whole value is that it does not paraphrase. Reason codes and cited source ids are shown as
 * the gates wrote them, because an operator's next move is usually to quote one in a message to us, and a
 * friendlier sentence would lose the only identifier that made the decision traceable.
 *
 * It also has to stop where Issue #29 begins: no approve, no edit, no reject. The test for that is here
 * rather than in review, because "it renders no buttons" is exactly the kind of boundary that erodes.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationDetail, LatestDraft } from "@omnichannel/db";

import { ContextPanel } from "./context-panel";
import { catalogues, type MessageKey } from "@/i18n/catalogue";
import { createTranslator } from "@/i18n/translate";

const t = createTranslator("en");
const text = (key: MessageKey) => catalogues.en[key];

afterEach(cleanup);

const draft = (overrides: Partial<LatestDraft> = {}): LatestDraft => ({
  id: "dr_1",
  status: "PENDING",
  confidence: 0.62,
  needsReview: true,
  reasonCodes: ["LOW_CONFIDENCE", "PRICE_QUESTION"],
  citedSourceIds: ["kd_menu", "kd_hours"],
  intent: "BOOKING",
  suggestedLeadStage: "QUALIFIED",
  createdAt: new Date("2026-09-30T10:05:00.000Z"),
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
  humanTakeoverAt: null,
  lastInboundAt: new Date("2026-09-30T10:00:00.000Z"),
  lastOutboundAt: new Date("2026-09-30T10:06:00.000Z"),
  messages: [],
  latestDraft: draft(),
  ...overrides,
});

describe("the assistant's latest decision", () => {
  it("shows the reason codes exactly as the gates wrote them", () => {
    render(<ContextPanel t={t} conversation={conversation()} />);

    expect(screen.getByText("LOW_CONFIDENCE")).toBeDefined();
    expect(screen.getByText("PRICE_QUESTION")).toBeDefined();
  });

  it("shows the facts it relied on, by id", () => {
    render(<ContextPanel t={t} conversation={conversation()} />);

    expect(screen.getByText("kd_menu")).toBeDefined();
    expect(screen.getByText("kd_hours")).toBeDefined();
  });

  it("says plainly when it cited nothing, rather than showing an empty list", () => {
    render(<ContextPanel t={t} conversation={conversation({ latestDraft: draft({ citedSourceIds: [] }) })} />);

    expect(screen.getByText(text("context.noSources"))).toBeDefined();
  });

  it("shows confidence as a percentage a person can act on", () => {
    render(<ContextPanel t={t} conversation={conversation()} />);

    expect(screen.getByText("62%")).toBeDefined();
  });

  it("shows how it read the message and what stage it would suggest", () => {
    render(<ContextPanel t={t} conversation={conversation()} />);

    expect(screen.getByText(`${text("context.intent")}: BOOKING`)).toBeDefined();
    expect(screen.getByText(`${text("context.suggestedStage")}: ${text("leadStage.QUALIFIED")}`)).toBeDefined();
  });

  it("says there is no decision yet when the assistant has not drafted anything", () => {
    render(<ContextPanel t={t} conversation={conversation({ latestDraft: undefined })} />);

    expect(screen.getByText(text("context.noDecision"))).toBeDefined();
  });

  it("omits the 'why it was held' list when there was nothing to hold", () => {
    render(<ContextPanel t={t} conversation={conversation({ latestDraft: draft({ reasonCodes: [] }) })} />);

    expect(screen.queryByText(text("context.reasons"))).toBeNull();
  });
});

describe("who is handling the conversation", () => {
  it("names the person holding it, and since when", () => {
    render(
      <ContextPanel
        t={t}
        conversation={conversation({
          takeoverState: "HUMAN_ACTIVE",
          takeoverByName: "Marina",
          humanTakeoverAt: new Date("2026-09-30T10:04:00.000Z"),
        })}
      />,
    );

    expect(screen.getByText(/Marina/u)).toBeDefined();
    expect(document.querySelector('[data-takeover="HUMAN_ACTIVE"]')).not.toBeNull();
  });

  it("holds the statement together when the takeover has no timestamp", () => {
    render(<ContextPanel t={t} conversation={conversation({ takeoverState: "HUMAN_ACTIVE", takeoverByName: "Marina", humanTakeoverAt: null })} />);

    expect(document.querySelector('[data-takeover="HUMAN_ACTIVE"]')?.textContent).toBe("Held by Marina");
  });

  it("says a conversation is queued for review", () => {
    render(<ContextPanel t={t} conversation={conversation({ takeoverState: "REVIEW_REQUIRED" })} />);

    expect(screen.getByText(text("context.reviewQueued"))).toBeDefined();
  });

  it("says nobody has taken it over, rather than leaving the question open", () => {
    render(<ContextPanel t={t} conversation={conversation()} />);

    expect(screen.getByText(text("context.takeoverNone"))).toBeDefined();
  });
});

describe("the customer and the channel", () => {
  it("shows the contact, the handle, the channel and the mode", () => {
    render(<ContextPanel t={t} conversation={conversation()} />);

    expect(screen.getByText("Ann Petrova")).toBeDefined();
    expect(screen.getByText("@ann")).toBeDefined();
    expect(screen.getByText(text("channel.INSTAGRAM"))).toBeDefined();
    expect(screen.getByText(text("aiMode.DRAFT"))).toBeDefined();
  });

  it("shows the mode in force, not the conversation's empty override", () => {
    // A conversation with no override inherits the channel's policy. Reading `null` as "off" would tell
    // an operator automation was disabled while it was in fact drafting replies.
    render(<ContextPanel t={t} conversation={conversation({ modeOverride: null, effectiveMode: "AUTOPILOT" })} />);

    expect(screen.getByText(text("aiMode.AUTOPILOT"))).toBeDefined();
    expect(screen.queryByText(text("aiMode.OFF"))).toBeNull();
    expect(screen.getByText(text("context.modeInherited"))).toBeDefined();
  });

  it("says when the mode was set on this conversation rather than inherited", () => {
    render(<ContextPanel t={t} conversation={conversation({ modeOverride: "OFF", effectiveMode: "OFF" })} />);

    expect(screen.getByText(text("context.modeOverridden"))).toBeDefined();
    expect(document.querySelector('[data-mode-source="OVERRIDE"]')).not.toBeNull();
  });

  it("says the channel is connected", () => {
    render(<ContextPanel t={t} conversation={conversation()} />);

    expect(screen.getByText(text("accountStatus.CONNECTED"))).toBeDefined();
    expect(screen.queryByText(text("context.cannotSend"))).toBeNull();
    expect(document.querySelector('[data-account-status] .badge')?.getAttribute("data-tone")).toBe("ok");
  });

  it.each(["NEEDS_REAUTH", "DISCONNECTED"])("warns that nothing can be sent while the account is %s", (status) => {
    // The case where every other field on this screen looks healthy and no reply would actually leave.
    render(<ContextPanel t={t} conversation={conversation({ accountStatus: status })} />);

    expect(screen.getByText(text(`accountStatus.${status}` as never))).toBeDefined();
    expect(screen.getByText(text("context.cannotSend"))).toBeDefined();
    // Carried by the badge's tone as well as by the sentence: an operator scanning the pane should not
    // have to read the paragraph to see that this channel is the problem.
    expect(document.querySelector('[data-account-status] .badge')?.getAttribute("data-tone")).toBe("stop");
  });

  it("names a conversation that is no longer open, and stays quiet when it is", () => {
    render(<ContextPanel t={t} conversation={conversation({ status: "ARCHIVED" })} />);
    expect(screen.getByText(text("conversationStatus.ARCHIVED"))).toBeDefined();

    cleanup();
    render(<ContextPanel t={t} conversation={conversation()} />);
    expect(screen.queryByText(text("conversationStatus.OPEN"))).toBeNull();
  });

  it("says when each side last spoke", () => {
    render(<ContextPanel t={t} conversation={conversation()} />);

    expect(screen.getByText(text("context.lastInbound"))).toBeDefined();
    expect(screen.getByText(text("context.lastOutbound"))).toBeDefined();
  });

  it("says 'never' rather than showing a blank where a reply would be", () => {
    render(<ContextPanel t={t} conversation={conversation({ lastOutboundAt: null })} />);

    expect(screen.getByText(text("context.never"))).toBeDefined();
  });
});

describe("the boundary with the Review queue", () => {
  it("offers no actions at all, and says where they will live", () => {
    // A disabled Approve button would read as "you may not do this", which is a different and false
    // statement from "this is not built yet".
    render(<ContextPanel t={t} conversation={conversation()} />);

    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(screen.queryAllByRole("textbox")).toEqual([]);
    expect(screen.getByText(text("context.reviewActionsLater"))).toBeDefined();
  });

  it("names its own region for a screen reader", () => {
    render(<ContextPanel t={t} conversation={conversation()} />);

    expect(screen.getByRole("complementary", { name: text("inbox.contextLabel") })).toBeDefined();
  });

  it("reads in Russian without leaving the codes translated", () => {
    render(<ContextPanel t={createTranslator("ru")} conversation={conversation()} />);

    expect(screen.getByText(catalogues.ru["context.reasons"])).toBeDefined();
    // The code itself stays as written: it is an identifier, not prose.
    expect(screen.getByText("LOW_CONFIDENCE")).toBeDefined();
  });
});
