// @vitest-environment jsdom
/**
 * The Inbox's left pane (Issue #28).
 *
 * The cases worth writing down are the ones where a plausible implementation is silently wrong: a filter
 * link that carries the old page's cursor (showing page two of a view nobody selected), a search that
 * drops the active filter (widening the list without saying so), and a "load older" control that appears
 * when there is nothing older to load.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
const LEAD_STAGES = ["NEW", "ENGAGED", "QUALIFYING", "QUALIFIED", "BOOKED", "WON", "LOST"];
const ACCOUNTS = [
  { id: "ca_ig", channel: "INSTAGRAM", label: "@studio" },
  { id: "ca_wa", channel: "WHATSAPP", label: "+34600111222" },
] as const;

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
  modeOverride: "DRAFT",
  effectiveMode: "DRAFT",
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

  it("shows the AI mode in force on each row", () => {
    render(
      <ConversationList
        t={t}
        rows={[row({ id: "cv_a", modeOverride: null, effectiveMode: "AUTOPILOT" }), row({ id: "cv_b", modeOverride: "OFF", effectiveMode: "OFF" })]}
        view={{}}
        basePath={BASE}
      />,
    );

    // Inherited AUTOPILOT has to show as AUTOPILOT: a badge built from the override would say OFF here,
    // on the one conversation that is replying to customers unattended.
    expect(document.querySelector('.conversation-row[data-selected="false"] [data-mode="AUTOPILOT"]')).not.toBeNull();
    expect(document.querySelectorAll('[data-mode="OFF"]')).toHaveLength(1);
  });

  it("shows the lead stage as a word, not a code", () => {
    render(<ConversationList t={t} rows={[row({ leadStage: "QUALIFIED" })]} view={{}} basePath={BASE} />);

    // Scoped to the row: the stage filter's own options carry the same words.
    const rowElement = document.querySelector<HTMLElement>(".conversation-row") as HTMLElement;
    expect(within(rowElement).getByText(text("leadStage.QUALIFIED"))).toBeDefined();
    expect(within(rowElement).queryByText("QUALIFIED")).toBeNull();
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
    render(
      <ConversationList
        t={t}
        rows={mixedChannels}
        view={{ filter: "mine", channelAccountId: "ca_wa", leadStage: "QUALIFIED" }}
        basePath={BASE}
        accounts={ACCOUNTS}
      />,
    );

    const form = screen.getByRole("search");
    // The state filter is a link, so it rides along as a hidden field; the account and the stage are the
    // form's own controls and have to come back pre-selected or applying a search would reset them.
    //
    // Read off the hidden inputs because the two filters are the product's own select now: what the form
    // submits is that input, and what the reader sees is the combobox's label. Both are asserted — a
    // value the form carries while the control shows something else is the failure this pair exists for.
    expect(form.querySelector('input[name="filter"]')?.getAttribute("value")).toBe("mine");
    expect(form.querySelector('input[name="account"]')).toHaveProperty("value", "ca_wa");
    expect(form.querySelector('input[name="stage"]')).toHaveProperty("value", "QUALIFIED");
    expect(screen.getByLabelText(text("inbox.filterChannel")).textContent).toContain(ACCOUNTS[1]?.label ?? "");
    expect(screen.getByLabelText(text("inbox.filterLeadStage")).textContent).toContain(text("leadStage.QUALIFIED"));
  });

  it("offers every connected account, and every channel as the default", () => {
    render(<ConversationList t={t} rows={mixedChannels} view={{}} basePath={BASE} accounts={ACCOUNTS} />);

    // The listbox renders its options only while open, so the choices are read after opening it. They
    // carry `data-value` for exactly this reason — a native `<select>` put the value in the markup and a
    // listbox does not, and without it this assertion would weaken into one about words on screen.
    const select = screen.getByLabelText(text("inbox.filterChannel"));
    fireEvent.click(select);
    const options = [...screen.getByRole("listbox").querySelectorAll('[role="option"]')];
    expect(options.map((option) => option.getAttribute("data-value"))).toEqual(["", "ca_ig", "ca_wa"]);
    // The default is the empty value, asserted where the form reads it and where the reader sees it.
    expect(screen.getByRole("search").querySelector('input[name="account"]')).toHaveProperty("value", "");
    expect(options.find((option) => option.getAttribute("aria-selected") === "true")?.getAttribute("data-value")).toBe("");
  });

  it("hides the channel filter when the profile has no connected account to filter by", () => {
    render(<ConversationList t={t} rows={[]} view={{}} basePath={BASE} accounts={[]} />);

    expect(screen.queryByLabelText(text("inbox.filterChannel"))).toBeNull();
  });

  it("offers every lead stage the domain defines, in the domain's order", () => {
    render(<ConversationList t={t} rows={mixedChannels} view={{}} basePath={BASE} />);

    // Opened first: a listbox has no options in the markup until it is. The order is the assertion —
    // the domain's order, not an alphabetical one a component happened to produce.
    fireEvent.click(screen.getByLabelText(text("inbox.filterLeadStage")));
    const options = [...screen.getByRole("listbox").querySelectorAll('[role="option"]')];
    expect(options.map((option) => option.getAttribute("data-value"))).toEqual(["", ...LEAD_STAGES]);
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

/**
 * The states that are not "here are your conversations" (Issue #28).
 *
 * A server-rendered list is a snapshot, and the failure it invites is an operator watching a screen that
 * looks live while a customer waits in a conversation that is not on it. So the pane says when it was
 * rendered and offers the same URL back — reloading keeps the filters, which a browser refresh would too,
 * but the link makes it something a person can find.
 */
describe("the stale view", () => {
  it("says when it was loaded and offers the same view again", () => {
    render(
      <ConversationList
        t={t}
        rows={mixedChannels}
        view={{ filter: "mine" }}
        basePath={BASE}
        loadedAt={new Date("2026-09-30T10:30:00.000Z")}
      />,
    );

    expect(screen.getByRole("link", { name: text("inbox.reload") }).getAttribute("href")).toBe(`${BASE}?filter=mine`);
    expect(document.querySelector(".inbox-loaded-at time")?.getAttribute("datetime")).toBe("2026-09-30T10:30:00.000Z");
  });

  it("keeps the cursor on the reload link, so the page someone is on is the page they get back", () => {
    render(<ConversationList t={t} rows={mixedChannels} view={{ cursor: "Q2" }} basePath={BASE} loadedAt={new Date()} />);

    expect(screen.getByRole("link", { name: text("inbox.reload") }).getAttribute("href")).toBe(`${BASE}?cursor=Q2`);
  });

  it("says nothing about freshness when it was not told when it loaded", () => {
    render(<ConversationList t={t} rows={mixedChannels} view={{}} basePath={BASE} />);

    expect(document.querySelector(".inbox-loaded-at")).toBeNull();
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
    render(<ConversationList t={t} rows={mixedChannels} view={{}} basePath={BASE} accounts={ACCOUNTS} nextCursor="Q2" />);

    // The two value filters are folded into a disclosure, so the summary is a stop between the search box
    // and them. Everything is still in reading order, which is the invariant: search, the control that
    // reveals the refinements, the refinements, the submit, then the state filters.
    //
    // What this cannot tell you is whether a *closed* disclosure takes its contents out of the tab order.
    // jsdom does not implement the rendering that makes a browser skip them, so they are focusable here
    // whatever `open` says, and asserting that they are skipped would be asserting the environment rather
    // than the markup. The order below is the DOM's order, and that is all it claims.
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("searchbox"));
    await user.tab();
    expect(document.activeElement?.tagName.toLowerCase()).toBe("summary");
    expect(document.activeElement?.textContent).toBe(text("inbox.refine"));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByLabelText(text("inbox.filterChannel")));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByLabelText(text("inbox.filterLeadStage")));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: text("inbox.applyFilters") }));
    await user.tab();
    expect(document.activeElement?.textContent).toBe(text("inbox.filterAll"));

    // Past the five filters and onto the conversations, then the pager: nothing is mouse-only.
    for (let step = 0; step < 5; step += 1) {
      await user.tab();
    }
    expect(document.activeElement?.getAttribute("href")).toBe(`${BASE}/cv_ig`);
  });

  /*
   * There is no test here that the summary opens the group from the keyboard, and that is a measured
   * absence rather than an oversight: jsdom does not implement `details` toggling at all. Probed both
   * ways — a click at the summary and Enter on it leave `open` unset — so a test of either would be
   * asserting the environment, and would pass or fail for reasons that have nothing to do with this
   * markup. What is ours to get right is which state the group is rendered in, and that is below.
   */
  it("opens the disclosure itself when a filter inside it is set, so a narrowed list is not unexplained", () => {
    render(
      <ConversationList t={t} rows={mixedChannels} view={{ leadStage: "QUALIFIED" }} basePath={BASE} accounts={ACCOUNTS} />,
    );

    // A list showing three of thirty conversations with the reason folded away reads as a broken list.
    expect(screen.getByText(text("inbox.refine")).closest("details")?.hasAttribute("open")).toBe(true);
  });

  it("leaves the disclosure closed when nothing inside it is set", () => {
    render(<ConversationList t={t} rows={mixedChannels} view={{ filter: "mine" }} basePath={BASE} accounts={ACCOUNTS} />);

    // The control above is the other half: without it, a disclosure hard-coded open would satisfy that
    // one and this suite would never notice that the fold had stopped folding.
    expect(screen.getByText(text("inbox.refine")).closest("details")?.hasAttribute("open")).toBe(false);
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
    const waRow = document.querySelectorAll<HTMLElement>(".conversation-row")[1] as HTMLElement;
    expect(within(waRow).getByText(catalogues.ru["leadStage.QUALIFIED"])).toBeDefined();
    // The preview is what the customer wrote. Translating it would be a lie about the conversation.
    expect(screen.getAllByText("Is Saturday free?").length).toBeGreaterThan(0);
  });
});
