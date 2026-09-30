// @vitest-environment jsdom
/**
 * One review item, and specifically what it refuses to offer (Issue #29).
 *
 * The expensive mistakes on this card are all offers: offering to send a reply the customer has already
 * moved past, offering to approve a generation that produced nothing, offering a bulk action. So most of
 * these cases assert that a control is *absent* — and absent rather than disabled, because a greyed-out
 * Approve reads as "you may not", which is a different and false statement from "there is nothing here
 * to send".
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReviewItem } from "@omnichannel/db";

import { ReviewCard } from "./review-card";
import { catalogues, type MessageKey } from "@/i18n/catalogue";
import { createTranslator } from "@/i18n/translate";

const t = createTranslator("en");
const text = (key: MessageKey) => catalogues.en[key];
const BASE = "/workspaces/ws_1/profiles/bp_1";

afterEach(cleanup);

const actions = () => ({
  approve: vi.fn(() => Promise.resolve()),
  editAndSend: vi.fn(() => Promise.resolve()),
  dismiss: vi.fn(() => Promise.resolve()),
  claim: vi.fn(() => Promise.resolve()),
});

const item = (overrides: Partial<ReviewItem> = {}): ReviewItem => ({
  draftId: "dr_1",
  conversationId: "cv_1",
  channelAccountId: "ca_ig",
  channel: "INSTAGRAM",
  accountStatus: "CONNECTED",
  contactName: "Ann Petrova",
  handle: "@ann",
  text: "Saturday at 3pm works.",
  confidence: 0.64,
  needsReview: true,
  reasonCodes: ["LOW_CONFIDENCE"],
  citedSourceIds: ["kd_hours"],
  retrieval: { status: "OK", suppliedCount: 3 },
  intent: "BOOKING",
  suggestedLeadStage: "QUALIFIED",
  createdAt: new Date("2026-09-30T10:00:00.000Z"),
  reviewMode: "NORMAL",
  takeoverState: "REVIEW_REQUIRED",
  takeoverReason: "LOW_CONFIDENCE_REVIEW",
  stale: false,
  anchorStateVersion: 3,
  conversationStateVersion: 3,
  lastInboundAt: new Date("2026-09-30T09:59:00.000Z"),
  ...overrides,
});

const card = (overrides: Partial<ReviewItem> = {}) =>
  render(<ReviewCard t={t} item={item(overrides)} basePath={BASE} from="review" target={{ workspaceId: "ws_1", businessProfileId: "bp_1" }} actions={actions()} />);

describe("what the card shows before a decision", () => {
  it("shows the reason codes as the gates wrote them", () => {
    card({ reasonCodes: ["LOW_CONFIDENCE", "MISSING_FACT"] });

    expect(screen.getByText("LOW_CONFIDENCE")).toBeDefined();
    expect(screen.getByText("MISSING_FACT")).toBeDefined();
  });

  it("explains the codes whose consequence is not obvious from the code", () => {
    card({ reasonCodes: ["HUMAN_AGENT_REVIEW_REQUIRED"] });

    expect(screen.getByText("HUMAN_AGENT_REVIEW_REQUIRED")).toBeDefined();
    expect(screen.getByText(/human-support path/u)).toBeDefined();
  });

  it("renders the WhatsApp template requirement distinctly from the Instagram one", () => {
    card({ reasonCodes: ["TEMPLATE_REQUIRED"] });

    expect(screen.getByText(text("review.templateRequired"))).toBeDefined();
    expect(screen.queryByText(text("review.humanAgentSend"))).toBeNull();
  });

  it("separates what was available from what was used", () => {
    // Same empty citation list means two different things depending on this number.
    card({ retrieval: { status: "OK", suppliedCount: 3 }, citedSourceIds: ["kd_hours"] });

    expect(screen.getByText(/3 facts were available/u)).toBeDefined();
    expect(screen.getByText(/1 used in this reply/u)).toBeDefined();
  });

  it("says the knowledge base could not be consulted, rather than showing a zero", () => {
    card({ retrieval: { status: "UNAVAILABLE", suppliedCount: 0 }, citedSourceIds: [] });

    expect(screen.getByText(text("review.retrievalUnavailable"))).toBeDefined();
    expect(screen.queryByText(/facts were available/u)).toBeNull();
  });

  it("marks a send that would use the provider's human-support path", () => {
    card({ reviewMode: "HUMAN_AGENT" });

    expect(document.querySelector('[data-human-agent="true"]')).not.toBeNull();
    // The mode travels with every decision: a form that dropped it would authorize a different send.
    for (const input of document.querySelectorAll('input[name="reviewMode"]')) {
      expect(input.getAttribute("value")).toBe("HUMAN_AGENT");
    }
  });

  it("links to the conversation the reply belongs to", () => {
    card();

    expect(screen.getByRole("link", { name: "Ann Petrova" }).getAttribute("href")).toBe(`${BASE}/inbox/cv_1`);
  });
});

describe("an item the customer has overtaken", () => {
  it("offers no way to send it", () => {
    card({ stale: true });

    // Absent, not disabled: there is nothing here to send, which is not the same as "you may not".
    expect(screen.queryByRole("button", { name: text("review.approve") })).toBeNull();
    expect(screen.queryByRole("button", { name: text("review.edit") })).toBeNull();
  });

  it("still offers to clear it, because somebody has to", () => {
    card({ stale: true });

    expect(screen.getByRole("button", { name: text("review.dismiss") })).toBeDefined();
    expect(screen.getByRole("button", { name: text("review.claim") })).toBeDefined();
  });

  it("says why, in a sentence and not only as a badge", () => {
    card({ stale: true });

    expect(screen.getByText(text("review.stale"))).toBeDefined();
    expect(document.querySelector('[data-stale-badge="true"]')).not.toBeNull();
    expect(document.querySelector('[data-stale="true"]')).not.toBeNull();
  });

  it("offers the send controls when the conversation has not moved", () => {
    card({ stale: false });

    expect(screen.getByRole("button", { name: text("review.approve") })).toBeDefined();
    expect(screen.getByRole("button", { name: text("review.edit") })).toBeDefined();
  });
});

describe("a generation that produced nothing usable", () => {
  it("offers no approval, because there is no wording to approve", () => {
    card({ text: null });

    expect(screen.queryByRole("button", { name: text("review.approve") })).toBeNull();
    expect(screen.getByText(text("review.noText"))).toBeDefined();
  });

  it("still offers to dismiss it", () => {
    card({ text: null });

    expect(screen.getByRole("button", { name: text("review.dismiss") })).toBeDefined();
  });
});

describe("editing before sending", () => {
  it("starts from the assistant's wording rather than an empty box", () => {
    card();

    const box = screen.getByLabelText(text("review.editLabel"));
    expect(box).toHaveProperty("value", "Saturday at 3pm works.");
  });

  it("asks separately whether to learn from the wording, and does not assume yes", () => {
    // Learning is a second, different consequence: it weights this phrasing in every later answer.
    card();

    const learn = screen.getByLabelText(text("review.learn"));
    expect(learn).toHaveProperty("checked", false);
    expect(learn.getAttribute("name")).toBe("learn");
  });
});

describe("the boundary the contract draws", () => {
  it("offers no bulk selection of any kind, and says the single-send rule is deliberate", () => {
    card();

    // No checkbox except the style-learning one, and certainly no select-all.
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(1);
    expect(checkboxes[0]).toBe(screen.getByLabelText(text("review.learn")));
  });

  it("carries the draft id on every action, so a decision names what it decided", () => {
    card();

    const drafts = [...document.querySelectorAll('input[name="draftId"]')].map((input) => input.getAttribute("value"));
    expect(drafts.length).toBeGreaterThan(2);
    expect(new Set(drafts)).toEqual(new Set(["dr_1"]));
  });

  it("remembers which surface the person decided from", () => {
    card();

    for (const input of document.querySelectorAll('input[name="from"]')) {
      expect(input.getAttribute("value")).toBe("review");
    }
  });
});

describe("keyboard operation", () => {
  it("reaches every decision by tabbing, in the order they are offered", async () => {
    const user = userEvent.setup();
    card();

    // The conversation link first, then send-as-written, the edit box, the learn checkbox, edit-and-send,
    // the note, dismiss and claim. Nothing on this card needs a mouse, and the reading order is the
    // decision order rather than whatever the markup happened to produce.
    const order = [
      screen.getByRole("link", { name: "Ann Petrova" }),
      screen.getByRole("button", { name: text("review.approve") }),
      screen.getByLabelText(text("review.editLabel")),
      screen.getByLabelText(text("review.learn")),
      screen.getByRole("button", { name: text("review.edit") }),
      screen.getByLabelText(text("review.dismissNote")),
      screen.getByRole("button", { name: text("review.dismiss") }),
      screen.getByRole("button", { name: text("review.claim") }),
    ];
    for (const element of order) {
      await user.tab();
      expect(document.activeElement).toBe(element);
    }
  });

  it("lands on the remaining decisions when the send controls are gone", async () => {
    const user = userEvent.setup();
    card({ stale: true });

    // The first tab is the conversation link, then straight to the two actions still available: a stale
    // item must not leave someone tabbing through controls that are not there.
    await user.tab();
    expect(document.activeElement?.getAttribute("href")).toBe(`${BASE}/inbox/cv_1`);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByLabelText(text("review.dismissNote")));
  });

  it("labels the edit box and the note, not just placeholders", () => {
    card();

    expect(screen.getByLabelText(text("review.editLabel")).tagName).toBe("TEXTAREA");
    expect(screen.getByLabelText(text("review.dismissNote")).getAttribute("name")).toBe("note");
  });
});

describe("the same card in Russian", () => {
  it("translates the sentences and leaves the codes alone", () => {
    render(
      <ReviewCard
        t={createTranslator("ru")}
        item={item({ stale: true })}
        basePath={BASE}
        from="inbox"
        target={{ workspaceId: "ws_1", businessProfileId: "bp_1" }}
        actions={actions()}
      />,
    );

    expect(screen.getByText(catalogues.ru["review.stale"])).toBeDefined();
    expect(within(document.body).getByText("LOW_CONFIDENCE")).toBeDefined();
  });
});
