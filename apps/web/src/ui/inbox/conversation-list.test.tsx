// @vitest-environment jsdom
/**
 * The Inbox's left pane (Issue #28).
 *
 * The cases worth writing down are the ones where a plausible implementation is silently wrong: a filter
 * link that carries the old page's cursor (showing page two of a view nobody selected), a search that
 * drops the active filter (widening the list without saying so), and a "load older" control that appears
 * when there is nothing older to load.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { InboxRow } from "@omnichannel/db";

import { ConversationList } from "./conversation-list";
import { inboxQueryString } from "./view";
import { catalogues, type MessageKey } from "@/i18n/catalogue";
import { createTranslator } from "@/i18n/translate";

const t = createTranslator("en");
const text = (key: MessageKey) => catalogues.en[key];
const BASE = "/workspaces/ws_1/profiles/bp_1/inbox";

afterEach(cleanup);

const row = (overrides: Partial<InboxRow> = {}): InboxRow => ({
  id: "cv_1",
  channelAccountId: "ca_ig",
  channel: "INSTAGRAM",
  contactName: "Ann Petrova",
  handle: "@ann",
  status: "OPEN",
  leadStage: "ENGAGED",
  takeoverState: "NONE",
  takeoverReviewMode: null,
  mode: "DRAFT",
  aiEnabled: true,
  lastMessageAt: new Date("2026-09-30T10:00:00.000Z"),
  awaitingReply: false,
  preview: "Is Saturday free?",
  ...overrides,
});

/** Instagram and WhatsApp side by side: the pane is one list over both channels, not a tab per channel. */
const mixedChannels: readonly InboxRow[] = [
  row({ id: "cv_ig", channel: "INSTAGRAM", channelAccountId: "ca_ig", contactName: "Ann Petrova", handle: "@ann" }),
  row({
    id: "cv_wa",
    channel: "WHATSAPP",
    channelAccountId: "ca_wa",
    contactName: null,
    handle: "+34600111222",
    lastMessageAt: new Date("2026-09-30T09:00:00.000Z"),
    awaitingReply: true,
    leadStage: "QUALIFIED",
  }),
];

describe("the conversation list", () => {
  it("shows conversations from every channel in one list", () => {
    render(<ConversationList t={t} rows={mixedChannels} view={{}} basePath={BASE} />);

    // Scoped to the conversation rows: the filter chips are list items too, and counting both would
    // make this assertion pass for the wrong reason.
    const rows = [...document.querySelectorAll<HTMLElement>(".conversation-row")];
    expect(rows).toHaveLength(2);
    expect(screen.getByText("Ann Petrova")).toBeDefined();
    expect(within(rows[0] as HTMLElement).getByText(text("channel.INSTAGRAM"))).toBeDefined();
    expect(within(rows[1] as HTMLElement).getByText(text("channel.WHATSAPP"))).toBeDefined();
  });

  it("falls back to the channel handle when the contact has no name", () => {
    // A WhatsApp contact often has no profile name at all, and a blank row is unusable.
    render(<ConversationList t={t} rows={mixedChannels} view={{}} basePath={BASE} />);

    expect(screen.getByText("+34600111222")).toBeDefined();
  });

  it("names the conversations waiting on us, and only those", () => {
    render(<ConversationList t={t} rows={mixedChannels} view={{}} basePath={BASE} />);

    const badges = screen.getAllByText(text("inbox.awaitingReplyBadge"));
    // One badge on the waiting row; the filter chip carries the same words, hence the count of two.
    expect(badges).toHaveLength(2);
    expect(document.querySelectorAll('[data-awaiting="true"]')).toHaveLength(1);
  });

  it("marks who is holding a conversation", () => {
    render(
      <ConversationList
        t={t}
        rows={[row({ id: "cv_h", takeoverState: "HUMAN_ACTIVE" }), row({ id: "cv_r", takeoverState: "REVIEW_REQUIRED" })]}
        view={{}}
        basePath={BASE}
      />,
    );

    expect(document.querySelectorAll('[data-takeover="HUMAN_ACTIVE"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-takeover="REVIEW_REQUIRED"]')).toHaveLength(1);
  });

  it("shows the lead stage as a word, not a code", () => {
    render(<ConversationList t={t} rows={[row({ leadStage: "QUALIFIED" })]} view={{}} basePath={BASE} />);

    expect(screen.getByText(text("leadStage.QUALIFIED"))).toBeDefined();
    expect(screen.queryByText("QUALIFIED")).toBeNull();
  });

  it("links each row to its own URL", () => {
    render(<ConversationList t={t} rows={mixedChannels} view={{}} basePath={BASE} />);

    expect(screen.getByRole("link", { name: /Ann Petrova/u }).getAttribute("href")).toBe(`${BASE}/cv_ig`);
  });

  it("marks the open conversation for a screen reader, not only visually", () => {
    render(<ConversationList t={t} rows={mixedChannels} view={{}} basePath={BASE} selectedId="cv_wa" />);

    const current = screen.getByRole("link", { current: "page" });
    expect(current.getAttribute("href")).toBe(`${BASE}/cv_wa`);
  });
});

describe("the filters", () => {
  it("marks the active filter for a screen reader", () => {
    render(<ConversationList t={t} rows={mixedChannels} view={{ filter: "mine" }} basePath={BASE} />);

    expect(screen.getByRole("link", { current: true }).textContent).toBe(text("inbox.filterMine"));
  });

  it("keeps the search when switching filter", () => {
    render(<ConversationList t={t} rows={mixedChannels} view={{ search: "ann" }} basePath={BASE} />);

    const href = screen.getByRole("link", { name: text("inbox.filterReviewNeeded") }).getAttribute("href");
    expect(href).toBe(`${BASE}?q=ann&filter=reviewNeeded`);
  });

  it("drops the cursor when switching filter", () => {
    // Carrying it would open a new view at the page position of the old one: rows missing from the top,
    // and no way to tell from the screen that anything was skipped.
    render(<ConversationList t={t} rows={mixedChannels} view={{ filter: "mine", cursor: "Q1" }} basePath={BASE} />);

    const href = screen.getByRole("link", { name: text("inbox.filterHumanActive") }).getAttribute("href");
    expect(href).toBe(`${BASE}?filter=humanActive`);
  });

  it("links 'All' back to the plain inbox", () => {
    render(<ConversationList t={t} rows={mixedChannels} view={{ filter: "mine", cursor: "Q1" }} basePath={BASE} />);

    expect(screen.getByRole("link", { name: text("inbox.filterAll") }).getAttribute("href")).toBe(BASE);
  });

  it("carries the active filter through a search, so searching does not widen the view", () => {
    render(<ConversationList t={t} rows={mixedChannels} view={{ filter: "mine", channelAccountId: "ca_wa" }} basePath={BASE} />);

    const form = screen.getByRole("search");
    expect(form.querySelector('input[name="filter"]')?.getAttribute("value")).toBe("mine");
    expect(form.querySelector('input[name="account"]')?.getAttribute("value")).toBe("ca_wa");
  });

  it("does not carry the cursor through a search", () => {
    render(<ConversationList t={t} rows={mixedChannels} view={{ cursor: "Q1" }} basePath={BASE} />);

    expect(screen.getByRole("search").querySelector('input[name="cursor"]')).toBeNull();
  });
});

describe("paging", () => {
  it("offers older conversations only when there are older conversations", () => {
    const { rerender } = render(<ConversationList t={t} rows={mixedChannels} view={{}} basePath={BASE} />);
    expect(screen.queryByRole("link", { name: text("inbox.loadMore") })).toBeNull();

    rerender(<ConversationList t={t} rows={mixedChannels} view={{}} basePath={BASE} nextCursor="Q2" />);
    expect(screen.getByRole("link", { name: text("inbox.loadMore") }).getAttribute("href")).toBe(`${BASE}?cursor=Q2`);
  });

  it("keeps the search and the filter on the next page", () => {
    render(
      <ConversationList t={t} rows={mixedChannels} view={{ search: "ann", filter: "awaitingReply" }} basePath={BASE} nextCursor="Q2" />,
    );

    expect(screen.getByRole("link", { name: text("inbox.loadMore") }).getAttribute("href")).toBe(
      `${BASE}?q=ann&filter=awaitingReply&cursor=Q2`,
    );
  });

  /**
   * The performance strategy, stated as a test.
   *
   * The pane renders the rows it was given and nothing else — no accumulating client store, no "fetch
   * all and filter in the browser". A long-lived inbox stays a fixed amount of DOM per page, and the
   * cursor is the only thing that grows.
   */
  it("renders exactly the rows it was handed, however many exist behind them", () => {
    const many = Array.from({ length: 30 }, (_, index) => row({ id: `cv_${String(index)}`, contactName: `Person ${String(index)}` }));
    render(<ConversationList t={t} rows={many} view={{}} basePath={BASE} nextCursor="Q2" />);

    expect(document.querySelectorAll(".conversation-row")).toHaveLength(30);
  });
});

describe("the empty list", () => {
  it("says the filters matched nothing when filters are on", () => {
    render(<ConversationList t={t} rows={[]} view={{ filter: "mine" }} basePath={BASE} />);

    expect(screen.getByText(text("inbox.empty"))).toBeDefined();
  });

  it("says conversations will arrive when nothing is filtered", () => {
    // "No conversations match this view" on a brand-new profile reads as a broken product.
    render(<ConversationList t={t} rows={[]} view={{}} basePath={BASE} />);

    expect(screen.getByText(text("inbox.emptyUnfiltered"))).toBeDefined();
  });

  it("treats a search with no matches as filtered", () => {
    render(<ConversationList t={t} rows={[]} view={{ search: "nobody" }} basePath={BASE} />);

    expect(screen.getByText(text("inbox.empty"))).toBeDefined();
  });
});

/**
 * The builder both panes share (Issue #28).
 *
 * The left pane's links and the thread's back link are the same URL question asked twice. These cases are
 * about the boring half — that an absent field produces no parameter at all, so `${base}${query}` is
 * always a URL rather than sometimes a `?` with nothing after it.
 */
describe("the shared query string", () => {
  it("is empty for the default view", () => {
    expect(inboxQueryString({})).toBe("");
  });

  it("keeps the whole view, in a stable order", () => {
    expect(inboxQueryString({ search: "ann", filter: "mine", channelAccountId: "ca_1", cursor: "Q1" })).toBe(
      "?q=ann&filter=mine&account=ca_1&cursor=Q1",
    );
  });

  it("escapes a search someone typed by hand", () => {
    expect(inboxQueryString({ search: "ann & co" })).toBe("?q=ann+%26+co");
  });

  it("treats a blank search as no search", () => {
    expect(inboxQueryString({ search: "" })).toBe("");
  });
});

describe("keyboard operation", () => {
  it("reaches the search, the filters and the conversations by tabbing, in that order", async () => {
    const user = userEvent.setup();
    render(<ConversationList t={t} rows={mixedChannels} view={{}} basePath={BASE} nextCursor="Q2" />);

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("searchbox"));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: text("inbox.searchApply") }));
    await user.tab();
    expect(document.activeElement?.textContent).toBe(text("inbox.filterAll"));

    // Past the five filters and onto the conversations, then the pager: nothing is mouse-only.
    for (let step = 0; step < 5; step += 1) {
      await user.tab();
    }
    expect(document.activeElement?.getAttribute("href")).toBe(`${BASE}/cv_ig`);
  });

  it("gives the search box a real label rather than only a placeholder", () => {
    // A placeholder disappears on the first keystroke and is not reliably announced.
    render(<ConversationList t={t} rows={mixedChannels} view={{}} basePath={BASE} />);

    expect(screen.getByLabelText(text("inbox.searchLabel"))).toBe(screen.getByRole("searchbox"));
  });

  it("names its regions, so a screen reader can move between the panes", () => {
    render(<ConversationList t={t} rows={mixedChannels} view={{}} basePath={BASE} />);

    expect(screen.getByRole("region", { name: text("inbox.listLabel") })).toBeDefined();
    expect(screen.getByRole("navigation", { name: text("inbox.filtersLabel") })).toBeDefined();
  });
});

describe("the same list in Russian", () => {
  it("translates the chrome and leaves the customer's own words alone", () => {
    render(<ConversationList t={createTranslator("ru")} rows={mixedChannels} view={{}} basePath={BASE} />);

    expect(screen.getByText(catalogues.ru["inbox.filterAwaitingReply"])).toBeDefined();
    expect(screen.getByText(catalogues.ru["leadStage.QUALIFIED"])).toBeDefined();
    // The preview is what the customer wrote. Translating it would be a lie about the conversation.
    expect(screen.getAllByText("Is Saturday free?").length).toBeGreaterThan(0);
  });
});
