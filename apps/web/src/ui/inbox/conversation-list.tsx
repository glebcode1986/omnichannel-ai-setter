/**
 * The Inbox's left pane (PRODUCT_UX.md, Issue #28).
 *
 * Search and filters are links and a GET form rather than client state. Three reasons, in order of
 * importance: the view survives a reload, the URL can be sent to a colleague or kept as a bookmark, and
 * everything works before JavaScript arrives. A filter bar held in React state has none of those and is
 * no easier to read.
 *
 * Paging is "load older", not numbered pages. The list reorders itself every time a customer writes, so a
 * page number would point at different conversations a minute later; a cursor in the URL points at the
 * same place it did when it was written.
 */
import Link from "next/link";
import type { InboxRow } from "@omnichannel/db";

import type { MessageKey } from "@/i18n/catalogue";
import type { Translator } from "@/i18n/translate";
import { Select } from "@/ui/select";
import { inboxQueryString, isFilteredView, type InboxView } from "./view";

/** A channel account as the filter needs it: an id and a label. Deliberately not the stored record — see
 * the note in `no-provider-payloads.test.ts` — because that carries a provider-shaped capabilities blob
 * the Inbox has no business knowing about. */
export interface ChannelAccountOption {
  readonly id: string;
  readonly channel: string;
  readonly label: string;
}

export interface ConversationListProps {
  readonly t: Translator;
  readonly rows: readonly InboxRow[];
  readonly view: InboxView;
  /** `/workspaces/…/inbox`; every link and the search form post back to it. */
  readonly basePath: string;
  readonly selectedId?: string;
  /** The profile's connected accounts, for the channel filter. Empty is a valid state: nothing connected. */
  readonly accounts?: readonly ChannelAccountOption[];
  /** When this page was rendered, so the pane can say how old it is rather than looking live. */
  readonly loadedAt?: Date;
  /** Opaque cursor for the next page, already encoded. Absent means this is the end of the list. */
  readonly nextCursor?: string;
}

const FILTERS = [
  { key: undefined, label: "inbox.filterAll" },
  { key: "awaitingReply", label: "inbox.filterAwaitingReply" },
  { key: "reviewNeeded", label: "inbox.filterReviewNeeded" },
  { key: "humanActive", label: "inbox.filterHumanActive" },
  { key: "mine", label: "inbox.filterMine" },
] as const;

const LEAD_STAGES = ["NEW", "ENGAGED", "QUALIFYING", "QUALIFIED", "BOOKED", "WON", "LOST"] as const;


/**
 * How old a conversation is, in as few characters as say it.
 *
 * Every row showed `22.10.2026, 20:17`. Sixteen characters, identical down the whole list, in a column
 * where the one thing a reader wants from a timestamp is *which of these is recent* — and it took the
 * widest part of the row to answer that worst.
 *
 * Three forms, chosen against the moment the page was rendered: today is a time, this year is a day and
 * a month, anything older carries the year. Resolved on the server, from `loadedAt`, so the list a
 * reader is handed and the list the server rendered say the same thing — reading the clock in the
 * browser instead would disagree with the markup on the very first paint.
 */
function listTime(t: Translator, at: Date, now: Date): string {
  const sameDay =
    at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
  if (sameDay) {
    return t.date(at, { timeStyle: "short" });
  }
  if (at.getFullYear() === now.getFullYear()) {
    return t.date(at, { day: "numeric", month: "short" });
  }
  return t.date(at, { dateStyle: "short" });
}

export function ConversationList({ t, rows, view, basePath, selectedId, nextCursor, accounts = [], loadedAt }: ConversationListProps) {
  // The page's own instant, so every row in one render is measured against the same moment.
  const now = loadedAt ?? new Date();
  const href = (changes: Partial<InboxView>) => `${basePath}${inboxQueryString({ ...view, ...changes })}`;

  return (
    <section className="inbox-list" aria-labelledby="inbox-list-heading">
      <h2 className="visually-hidden" id="inbox-list-heading">
        {t.t("inbox.listLabel")}
      </h2>

      {/*
        Search, channel and lead stage are one form, submitted together. They are the filters with many
        values, and turning each into a row of links would be a wall of chips; the state filters below
        stay links because there are five of them and a link is shareable.

        The two selects sit inside a disclosure, and the search box does not. In a rail that is at most
        320px wide this form resolves to one column, so every control was a row of its own: a search
        box, two menus and a button, four rows deep, before the chips and the list a person came here to
        read. Searching is what an inbox is for; narrowing by channel or by stage is a refinement, and a
        refinement can be folded away. It is a `details` and not a script — a control inside a closed
        one still belongs to the form and is still submitted, so nothing about the filter changes — and
        it opens itself whenever either filter is set, because a filter nobody can see is a list that
        looks wrong for no reason.
      */}
      <div className="inbox-toolbar">
        <form action={basePath} method="get" role="search" className="inbox-search">
          <div className="field">
            <label htmlFor="inbox-q">{t.t("inbox.searchLabel")}</label>
            <input id="inbox-q" name="q" type="search" defaultValue={view.search ?? ""} placeholder={t.t("inbox.searchPlaceholder")} />
          </div>

          {/* Open for a filter this group actually holds. Keyed to `view.channelAccountId` alone, a
              profile with no connected accounts opened the group on a URL carrying `?account=…` and
              showed only the stage select — the group announcing a filter it does not contain. */}
          <details
            className="inbox-refine"
            open={(accounts.length > 0 && view.channelAccountId !== undefined) || view.leadStage !== undefined}
          >
            {/* No mark of its own. This stylesheet already draws one for every `summary` — a triangle
                that turns a quarter when the group opens — and a component that adds a second gets two
                marks side by side, which is exactly what the first attempt here shipped to dev. */}
            <summary>{t.t("inbox.refine")}</summary>

            {accounts.length === 0 ? undefined : (
              <div className="field">
                <label htmlFor="inbox-account">{t.t("inbox.filterChannel")}</label>
                <Select
                  id="inbox-account"
                  name="account"
                  value={view.channelAccountId ?? ""}
                  options={[
                    { value: "", label: t.t("inbox.allChannels") },
                    ...accounts.map((account) => ({
                      value: account.id,
                      label: `${t.t(`channel.${account.channel}` as MessageKey)} · ${account.label}`,
                    })),
                  ]}
                />
              </div>
            )}

            <div className="field">
              <label htmlFor="inbox-stage">{t.t("inbox.filterLeadStage")}</label>
              <Select
                id="inbox-stage"
                name="stage"
                value={view.leadStage ?? ""}
                options={[
                  { value: "", label: t.t("inbox.allStages") },
                  ...LEAD_STAGES.map((stage) => ({ value: stage, label: t.t(`leadStage.${stage}` as MessageKey) })),
                ]}
              />
            </div>
          </details>

          {/* The state filter travels with the form, or applying a search would silently widen the view. */}
          {view.filter === undefined ? undefined : <input type="hidden" name="filter" value={view.filter} />}
          <button className="button" type="submit">
            {t.t("inbox.applyFilters")}
          </button>
        </form>

      <nav aria-label={t.t("inbox.filtersLabel")}>
        <ul className="filter-row">
          {FILTERS.map((entry) => {
            const active = view.filter === entry.key;
            return (
              <li key={entry.label}>
                <Link
                  className="chip"
                  // A new filter starts a new list, so the cursor is dropped rather than carried into a
                  // view it does not describe.
                  href={href({ filter: entry.key, cursor: undefined })}
                  {...(active ? { "aria-current": "true" as const } : {})}
                  data-active={String(active)}
                >
                  {t.t(entry.label)}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      </div>

      {rows.length === 0 ? (
        /* An empty state rather than a line of grey text. The thread beside this one already says
           nothing-here with a mark and a sentence in the middle of its pane; the list said it in a
           paragraph tucked under the filters, which reads as a caption on the controls above it. */
        <p className="inbox-list-empty muted" data-empty="true">
          {isFilteredView(view) ? t.t("inbox.empty") : t.t("inbox.emptyUnfiltered")}
        </p>
      ) : (
        <ul className="conversation-rows">
          {rows.map((row) => (
            <li key={row.id}>
              <Link
                className="conversation-row"
                href={`${basePath}/${row.id}`}
                data-selected={String(row.id === selectedId)}
                {...(row.id === selectedId ? { "aria-current": "page" as const } : {})}
              >
                {/*
                  Who and when on one line, what they said on the next, and what is true of this
                  conversation in particular on the third.

                  It used to be five pills between the name and the preview, wrapping onto two lines and
                  carrying almost nothing: channel, awaiting, lead stage and mode were drawn for every
                  row, and on a real inbox most rows hold the same four values. A row ran about 200px and
                  four conversations filled the window.

                  What differs between rows is the *state*, so the state keeps a badge and the context —
                  which channel, which stage — becomes quiet text. The badges are written first for a
                  reason that is not visual: the meta line truncates rather than wraps, and the things
                  that must never be the part that disappears are the ones saying a customer is waiting,
                  a person has taken over, or this conversation can send unattended.
                */}
                <span className="conversation-row-top">
                  <span className="conversation-name">{row.contactName ?? row.handle}</span>
                  <time className="conversation-time" dateTime={row.lastMessageAt.toISOString()}>
                    {listTime(t, row.lastMessageAt, now)}
                  </time>
                </span>

                {row.preview === null ? undefined : <span className="conversation-preview muted">{row.preview}</span>}

                <span className="conversation-meta">
                  {row.awaitingReply ? (
                    <span className="badge" data-tone="warn" data-awaiting="true">
                      {t.t("inbox.awaitingReplyBadge")}
                    </span>
                  ) : undefined}
                  {row.takeoverState === "REVIEW_REQUIRED" ? (
                    <span className="badge" data-tone="warn" data-takeover="REVIEW_REQUIRED">
                      {t.t("inbox.filterReviewNeeded")}
                    </span>
                  ) : undefined}
                  {row.takeoverState === "HUMAN_ACTIVE" ? (
                    <span className="badge" data-tone="ok" data-takeover="HUMAN_ACTIVE">
                      {t.t("inbox.filterHumanActive")}
                    </span>
                  ) : undefined}
                  {/* The mode in force, not the conversation's override: a row that showed the override
                      would read as "off" for every conversation that simply inherits its channel's
                      policy. Only `AUTOPILOT` keeps a badge — it is the one that sends unattended, and
                      the other two are the quiet default this list is full of. */}
                  {row.effectiveMode === "AUTOPILOT" ? (
                    <span className="badge" data-tone="ok" data-mode={row.effectiveMode}>
                      {t.t(`aiMode.${row.effectiveMode}` as MessageKey)}
                    </span>
                  ) : (
                    <span className="visually-hidden" data-mode={row.effectiveMode}>
                      {t.t(`aiMode.${row.effectiveMode}` as MessageKey)}
                    </span>
                  )}
                  <span className="conversation-channel" data-channel={row.channel}>
                    {t.t(`channel.${row.channel}` as MessageKey)}
                  </span>
                  <span className="conversation-meta-dot" aria-hidden="true" />
                  <span data-lead={row.leadStage}>{t.t(`leadStage.${row.leadStage}` as MessageKey)}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {nextCursor === undefined ? undefined : (
        <Link className="button" href={href({ cursor: nextCursor })} data-load-more="true">
          {t.t("inbox.loadMore")}
        </Link>
      )}

      {loadedAt === undefined ? undefined : (
        // A server-rendered list is a snapshot, and the honest thing is to say when it was taken rather
        // than let it look live. Reloading is the same URL, so the view survives it.
        //
        // Last, under the hairline, and after the pager rather than before it: the rule says the rail
        // has ended, and a control that fetches more of the list belongs above it. It used to sit
        // between the two, flush against the note with no space at all.
        <p className="muted inbox-loaded-at">
          <time dateTime={loadedAt.toISOString()}>{t.t("inbox.loadedAt", { time: t.date(loadedAt, { timeStyle: "short" }) })}</time>{" "}
          <a href={`${basePath}${inboxQueryString(view)}`} data-inbox-reload="true">
            {t.t("inbox.reload")}
          </a>
        </p>
      )}
    </section>
  );
}
