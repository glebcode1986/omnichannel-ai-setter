// @vitest-environment jsdom
/**
 * The thread, and specifically who is shown as having said each thing (Issue #28).
 *
 * This is the pane where being wrong is expensive rather than untidy. An assistant reply presented as a
 * colleague's is a claim the product made on its operator's behalf, and an audit trail that cannot tell
 * the two apart is not an audit trail. So most of these cases are about attribution, and the rest are
 * about not inventing delivery state the data does not have.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationDetail, ThreadMessage } from "@omnichannel/db";

import { MessageThread } from "./message-thread";
import { catalogues, type MessageKey } from "@/i18n/catalogue";
import { createTranslator } from "@/i18n/translate";

const t = createTranslator("en");
const text = (key: MessageKey) => catalogues.en[key];

afterEach(cleanup);

const message = (overrides: Partial<ThreadMessage> = {}): ThreadMessage => ({
  id: "ms_1",
  direction: "INBOUND",
  source: "PARTICIPANT",
  kind: "TEXT",
  text: "Is Saturday free?",
  occurredAt: new Date("2026-09-30T10:00:00.000Z"),
  deliveryStatus: null,
  transportPath: null,
  sentByUserName: null,
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
  mode: "DRAFT",
  aiEnabled: true,
  takeoverState: "NONE",
  takeoverReason: null,
  takeoverReviewMode: null,
  takeoverByName: null,
  humanTakeoverAt: null,
  lastInboundAt: new Date("2026-09-30T10:00:00.000Z"),
  lastOutboundAt: null,
  messages: [message()],
  ...overrides,
});

const find = (id: string) => document.querySelector<HTMLElement>(`[data-message-id="${id}"]`) as HTMLElement;

describe("attribution in the thread", () => {
  const authored = conversation({
    messages: [
      message({ id: "ms_in", source: "PARTICIPANT", direction: "INBOUND" }),
      message({ id: "ms_ai", source: "AI", direction: "OUTBOUND", text: "Saturday at 3pm works." }),
      message({ id: "ms_human", source: "HUMAN", direction: "OUTBOUND", text: "I can move that.", sentByUserName: "Marina" }),
      message({ id: "ms_system", source: "SYSTEM", direction: "OUTBOUND", text: "Conversation reopened." }),
    ],
  });

  it("tells the customer, the assistant and the team apart in words", () => {
    render(<MessageThread t={t} conversation={authored} />);

    expect(within(find("ms_in")).getByText(text("messageSource.PARTICIPANT"))).toBeDefined();
    expect(within(find("ms_ai")).getByText(text("messageSource.AI"))).toBeDefined();
    expect(within(find("ms_system")).getByText(text("messageSource.SYSTEM"))).toBeDefined();
  });

  it("names the colleague who replied, rather than calling them 'your team'", () => {
    render(<MessageThread t={t} conversation={authored} />);

    expect(within(find("ms_human")).getByText("Marina")).toBeDefined();
  });

  it("falls back to the role when a human message has no name on it", () => {
    render(<MessageThread t={t} conversation={conversation({ messages: [message({ source: "HUMAN", sentByUserName: null })] })} />);

    expect(screen.getByText(text("messageSource.HUMAN"))).toBeDefined();
  });

  it("still calls an assistant reply the assistant, even if a name is attached to the row", () => {
    // `sentByUserName` comes from a join that does not know which source it is describing. Letting a
    // stray name win would put a colleague's name on words the assistant wrote — the one mistake this
    // pane exists to prevent.
    render(<MessageThread t={t} conversation={conversation({ messages: [message({ source: "AI", direction: "OUTBOUND", sentByUserName: "Marina" })] })} />);

    expect(screen.getByText(text("messageSource.AI"))).toBeDefined();
    expect(screen.queryByText("Marina")).toBeNull();
  });

  it("does not blank out a thread over a source it has never heard of", () => {
    // A future enum member arrives in the database before it arrives here. Showing the raw value beats
    // throwing and losing the whole conversation.
    render(<MessageThread t={t} conversation={conversation({ messages: [message({ source: "ESCALATION" })] })} />);

    expect(screen.getByText("ESCALATION")).toBeDefined();
    expect(screen.getByText("Is Saturday free?")).toBeDefined();
  });

  it("does not rely on position alone to say who spoke", () => {
    render(<MessageThread t={t} conversation={authored} />);

    // Every bubble carries a source word; inbound/outbound placement is decoration on top of that.
    for (const id of ["ms_in", "ms_ai", "ms_human", "ms_system"]) {
      expect(find(id).querySelector(".badge")?.textContent).toBeTruthy();
    }
  });
});

describe("delivery state", () => {
  it("shows a delivery status when the platform reported one", () => {
    render(<MessageThread t={t} conversation={conversation({ messages: [message({ source: "AI", direction: "OUTBOUND", deliveryStatus: "DELIVERED" })] })} />);

    expect(screen.getByText(text("deliveryStatus.DELIVERED"))).toBeDefined();
  });

  it("says nothing at all when no status is known", () => {
    // "Sent" on a message nobody confirmed would be the product asserting something it cannot see.
    render(<MessageThread t={t} conversation={conversation({ messages: [message({ source: "AI", direction: "OUTBOUND", deliveryStatus: null })] })} />);

    expect(find("ms_1").querySelector("[data-delivery]")).toBeNull();
  });

  it("calls out a failed send", () => {
    render(<MessageThread t={t} conversation={conversation({ messages: [message({ source: "AI", direction: "OUTBOUND", deliveryStatus: "FAILED" })] })} />);

    expect(screen.getByText(text("deliveryStatus.FAILED"))).toBeDefined();
  });

  it("leaves the status line genuinely empty when nothing is known, not merely blank-looking", () => {
    // An empty element still takes up the layout and is still announced as a thing with no content.
    render(<MessageThread t={t} conversation={conversation({ messages: [message({ deliveryStatus: null, transportPath: null })] })} />);

    expect(find("ms_1").querySelector(".message-status")?.children).toHaveLength(0);
  });

  it("names the human-agent transport, because it has different platform rules", () => {
    render(<MessageThread t={t} conversation={conversation({ messages: [message({ source: "HUMAN", direction: "OUTBOUND", transportPath: "HUMAN_AGENT" })] })} />);

    expect(screen.getByText(text("transportPath.HUMAN_AGENT"))).toBeDefined();
  });

  it("does not label the standard transport, which is every other message", () => {
    render(<MessageThread t={t} conversation={conversation({ messages: [message({ source: "AI", direction: "OUTBOUND", transportPath: "STANDARD" })] })} />);

    expect(find("ms_1").querySelector("[data-transport]")).toBeNull();
  });
});

describe("messages that are not text", () => {
  it("describes an attachment instead of rendering an empty bubble", () => {
    render(<MessageThread t={t} conversation={conversation({ messages: [message({ kind: "IMAGE", text: null })] })} />);

    expect(screen.getByText(text("messageKind.IMAGE"))).toBeDefined();
  });

  it("describes a voice message the assistant cannot read", () => {
    render(<MessageThread t={t} conversation={conversation({ messages: [message({ kind: "AUDIO", text: null })] })} />);

    expect(screen.getByText(text("messageKind.AUDIO"))).toBeDefined();
  });
});

describe("the thread as a whole", () => {
  it("heads the thread with the customer and the channel", () => {
    render(<MessageThread t={t} conversation={conversation()} />);

    expect(screen.getByRole("heading", { name: "Ann Petrova" })).toBeDefined();
    expect(screen.getByText(`${text("channel.INSTAGRAM")} · @ann`)).toBeDefined();
  });

  it("heads an unnamed contact with their handle", () => {
    render(<MessageThread t={t} conversation={conversation({ contactName: null, handle: "+34600111222" })} />);

    expect(screen.getByRole("heading", { name: "+34600111222" })).toBeDefined();
  });

  it("says a conversation has no messages rather than showing an empty frame", () => {
    render(<MessageThread t={t} conversation={conversation({ messages: [] })} />);

    expect(screen.getByText(text("inbox.threadEmpty"))).toBeDefined();
  });

  it("keeps the order it was given, oldest first", () => {
    render(
      <MessageThread
        t={t}
        conversation={conversation({
          messages: [
            message({ id: "ms_old", text: "first", occurredAt: new Date("2026-09-30T09:00:00.000Z") }),
            message({ id: "ms_new", text: "second", occurredAt: new Date("2026-09-30T10:00:00.000Z") }),
          ],
        })}
      />,
    );

    const texts = [...document.querySelectorAll(".message-text")].map((node) => node.textContent);
    expect(texts).toEqual(["first", "second"]);
  });

  it("gives each message a machine-readable timestamp as well as a formatted one", () => {
    render(<MessageThread t={t} conversation={conversation()} />);

    expect(find("ms_1").querySelector("time")?.getAttribute("datetime")).toBe("2026-09-30T10:00:00.000Z");
  });

  it("reads as a conversation in Russian too", () => {
    render(<MessageThread t={createTranslator("ru")} conversation={conversation({ messages: [message({ kind: "AUDIO", text: null })] })} />);

    expect(screen.getByText(catalogues.ru["messageKind.AUDIO"])).toBeDefined();
    expect(screen.getByText(catalogues.ru["messageSource.PARTICIPANT"])).toBeDefined();
  });
});
