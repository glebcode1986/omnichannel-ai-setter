// @vitest-environment jsdom
/**
 * The hero's three conversations.
 *
 * The demonstration used to show one shop enquiry, which answered "what does a reply look like" and
 * left the question a visitor actually arrives with — *would this work for my trade*. Three of them
 * answer it, and the cases worth writing are the ones where three would be worse than one:
 *
 * - a tab that changes the label but not the conversation, which is a brochure pretending to be a demo;
 * - a conversation that carries over part of the previous one, because the typing effect counts
 *   characters and the previous text was longer;
 * - the WhatsApp example not actually saying WhatsApp, which is the whole reason that one is here;
 * - a tablist a keyboard cannot move along, which is the usual way this control is built.
 *
 * The timers are faked throughout: the component is a clock, and a test that waits for real seconds is
 * a test that is flaky on a loaded machine.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CancelWindow, type CancelWindowCopy } from "./cancel-window";

const SCENARIOS = [
  {
    id: "dental",
    tab: "Dental clinic",
    channel: "Instagram Direct",
    customerText: "Do you place implants?",
    draftText: "Yes, implants are one of our main procedures.",
    why: "Facts: Procedures",
  },
  {
    id: "travel",
    tab: "Travel agency",
    channel: "Instagram Direct",
    customerText: "Is the trip still open?",
    draftText: "Two rooms left.",
    why: "Facts: Availability",
  },
  {
    id: "order",
    tab: "Food delivery",
    channel: "WhatsApp Business",
    customerText: "Two large pepperoni, please.",
    draftText: "Got it, 1,890 ₽.",
    why: "Facts: Menu",
  },
] as const;

const copy: CancelWindowCopy = {
  scenariosLabel: "Example conversations",
  scenarios: SCENARIOS,
  customerLabel: "Customer",
  draftLabel: "Drafted reply",
  typing: "Drafting",
  waiting: Array.from({ length: 11 }, (_unused, seconds) => `Goes out in ${String(seconds)}s`),
  cancel: "Cancel this send",
  sent: "Sent",
  cancelled: "Cancelled by you",
  replay: "Run it again",
  hint: "Not a video.",
  region: "A demonstration",
};

const tab = (id: string) => document.querySelector(`[data-demo-tab="${id}"]`) as HTMLButtonElement;
const panelText = () => document.querySelector(".demo-scene")?.textContent ?? "";
const selected = () =>
  [...document.querySelectorAll("[data-demo-tab]")]
    .filter((node) => node.getAttribute("aria-selected") === "true")
    .map((node) => node.getAttribute("data-demo-tab"));

/** The draft lands and the delay starts: one tick is enough under reduced motion. */
function settle() {
  act(() => {
    vi.advanceTimersByTime(50);
  });
}

/**
 * All the way through the delay, to a send.
 *
 * Two advances, not one, and the reason is worth keeping: the countdown's interval is created by an
 * effect that only mounts once React commits the move into `waiting`, and React commits when the `act`
 * scope *exits*. A single `act` with one long advance therefore runs the draft's timer, never sees the
 * interval that the resulting state change creates, and leaves the panel waiting forever. It failed
 * exactly that way first.
 */
function runToSend() {
  settle();
  act(() => {
    vi.advanceTimersByTime(7000);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", (query: string) => ({
    // Reduced motion, so the draft lands in one tick rather than one character at a time. The typing
    // animation has its own coverage; what is under test here is which text arrives.
    matches: query.includes("reduced-motion"),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the hero's example conversations", () => {
  it("offers one tab per trade, with the first one live", () => {
    render(<CancelWindow copy={copy} />);

    expect(screen.getByRole("tablist", { name: "Example conversations" })).toBeDefined();
    expect([...document.querySelectorAll("[data-demo-tab]")].map((node) => node.textContent)).toEqual([
      "Dental clinic",
      "Travel agency",
      "Food delivery",
    ]);
    expect(selected()).toEqual(["dental"]);
  });

  it("changes the conversation, not just the label", () => {
    // The failure this catches is a tab row wired to nothing: three names over one fixed conversation.
    render(<CancelWindow copy={copy} />);
    settle();
    expect(panelText()).toContain("Do you place implants?");

    fireEvent.click(tab("travel"));
    settle();

    expect(selected()).toEqual(["travel"]);
    expect(panelText()).toContain("Is the trip still open?");
    expect(panelText()).toContain("Two rooms left.");
    expect(panelText(), "the previous trade must be gone, not merely covered").not.toContain("implants");
  });

  it("starts the new conversation from the beginning instead of inheriting the old one's progress", () => {
    // The draft is revealed by character count. Switching from a long draft to a short one without a
    // reset shows the new text already finished — or, the other way round, truncated to the old length.
    render(<CancelWindow copy={copy} />);
    runToSend();
    expect(document.querySelector(".demo-state")?.textContent).toBe("Sent");

    fireEvent.click(tab("order"));

    // Back to drafting the moment the trade changes, before any timer runs.
    expect(document.querySelector(".demo-scene")?.getAttribute("data-phase")).toBe("drafting");
    settle();
    expect(panelText()).toContain("Got it, 1,890 ₽.");
    expect(panelText(), "and not a word of the trade before it").not.toContain("implants");
  });

  it("says which platform each conversation arrived on", () => {
    // The owner asked for one of the three to be a WhatsApp order. A page that only *describes* the
    // channel is making a claim; showing it is the claim being kept.
    render(<CancelWindow copy={copy} />);
    expect(document.querySelector(".demo-channel")?.textContent).toBe("Instagram Direct");

    fireEvent.click(tab("order"));

    expect(document.querySelector(".demo-channel")?.textContent).toBe("WhatsApp Business");
  });

  it("names the facts behind the draft, per trade", () => {
    render(<CancelWindow copy={copy} />);
    expect(document.querySelector(".demo-why")?.textContent).toBe("Facts: Procedures");

    fireEvent.click(tab("travel"));

    expect(document.querySelector(".demo-why")?.textContent).toBe("Facts: Availability");
  });

  it("moves along the trades with the arrow keys, and wraps", () => {
    render(<CancelWindow copy={copy} />);

    fireEvent.keyDown(tab("dental"), { key: "ArrowRight" });
    expect(selected()).toEqual(["travel"]);

    fireEvent.keyDown(tab("travel"), { key: "ArrowRight" });
    expect(selected()).toEqual(["order"]);

    // Past the end is the beginning, which is what makes a tablist feel like a ring rather than a dead end.
    fireEvent.keyDown(tab("order"), { key: "ArrowRight" });
    expect(selected()).toEqual(["dental"]);

    fireEvent.keyDown(tab("dental"), { key: "ArrowLeft" });
    expect(selected()).toEqual(["order"]);

    fireEvent.keyDown(tab("order"), { key: "Home" });
    expect(selected()).toEqual(["dental"]);

    fireEvent.keyDown(tab("dental"), { key: "End" });
    expect(selected()).toEqual(["order"]);
  });

  it("keeps one tab stop, so the row is not three stops on the way past", () => {
    render(<CancelWindow copy={copy} />);

    expect([...document.querySelectorAll("[data-demo-tab]")].map((node) => node.getAttribute("tabindex"))).toEqual([
      "0",
      "-1",
      "-1",
    ]);

    fireEvent.click(tab("order"));

    expect([...document.querySelectorAll("[data-demo-tab]")].map((node) => node.getAttribute("tabindex"))).toEqual([
      "-1",
      "-1",
      "0",
    ]);
  });

  it("leaves a key it does not handle to the browser", () => {
    // A `preventDefault` on everything is how a tablist swallows Tab and traps a keyboard user.
    render(<CancelWindow copy={copy} />);
    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    tab("dental").dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(selected()).toEqual(["dental"]);
  });

  it("puts the chooser under the demonstration, where it does not push it down", () => {
    // Not a cosmetic preference. Above the panel are the character, which overhangs its top edge, and
    // the alignment with the headline that the owner asked for; a row written first pushed the panel
    // 46px down and broke it. The stylesheet already said "under the demonstration" in a comment while
    // the markup put it over the top — the comment is not enforcement, so this is.
    render(<CancelWindow copy={copy} />);
    const panel = document.querySelector('[role="tabpanel"]');
    const tabs = document.querySelector('[role="tablist"]');
    expect(panel).not.toBeNull();
    expect(tabs).not.toBeNull();

    // `compareDocumentPosition` returns a bit field; FOLLOWING set means the tablist comes after.
    const order = panel?.compareDocumentPosition(tabs as Node) ?? 0;
    expect(Boolean(order & Node.DOCUMENT_POSITION_FOLLOWING), "the tablist must follow the panel").toBe(true);
  });

  it("ties the panel to the live tab both ways", () => {
    render(<CancelWindow copy={copy} />);
    const panel = document.querySelector('[role="tabpanel"]');

    expect(panel?.getAttribute("aria-labelledby")).toBe("demo-tab-dental");
    expect(tab("dental").getAttribute("aria-controls")).toBe(panel?.getAttribute("id"));

    fireEvent.click(tab("travel"));

    expect(document.querySelector('[role="tabpanel"]')?.getAttribute("aria-labelledby")).toBe("demo-tab-travel");
  });

  it("still cancels a send, whichever trade is on screen", () => {
    // The demonstration's one real claim. Three conversations must not cost it.
    render(<CancelWindow copy={copy} />);
    fireEvent.click(tab("order"));
    settle();

    const cancel = screen.getByRole("button", { name: "Cancel this send" });
    fireEvent.click(cancel);

    expect(document.querySelector(".demo-scene")?.getAttribute("data-phase")).toBe("cancelled");
    expect(document.querySelector(".demo-live")?.textContent).toBe("Cancelled by you");
  });
});
