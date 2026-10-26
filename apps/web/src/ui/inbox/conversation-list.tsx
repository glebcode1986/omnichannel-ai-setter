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

export function ConversationList({ t, rows, view, basePath, selectedId, nextCursor, accounts = [], loadedAt }: ConversationListProps) {
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
      */}
      <form action={basePath} method="get" role="search" className="inbox-search">
        <div className="field">
          <label htmlFor="inbox-q">{t.t("inbox.searchLabel")}</label>
          <input id="inbox-q" name="q" type="search" defaultValue={view.search ?? ""} placeholder={t.t("inbox.searchPlaceholder")} />
        </div>

        {accounts.length === 0 ? undefined : (
          <>
            <div className="field">
              <label htmlFor="inbox-account">{t.t("inbox.filterChannel")}</label>
              <select id="inbox-account" name="account" defaultValue={view.channelAccountId ?? ""}>
                <option value="">{t.t("inbox.allChannels")}</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {`${t.t(`channel.${account.channel}` as MessageKey)} · ${account.label}`}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}

        <div className="field">
          <label htmlFor="inbox-stage">{t.t("inbox.filterLeadStage")}</label>
          <select id="inbox-stage" name="stage" defaultValue={view.leadStage ?? ""}>
            <option value="">{t.t("inbox.allStages")}</option>
            {LEAD_STAGES.map((stage) => (
              <option key={stage} value={stage}>
                {t.t(`leadStage.${stage}` as MessageKey)}
              </option>
            ))}
          </select>
        </div>

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

      {rows.length === 0 ? (
        <p className="muted" data-empty="true">
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
                <span className="conversation-name">{row.contactName ?? row.handle}</span>
                <span className="conversation-badges">
                  <span className="badge" data-tone="muted" data-channel={row.channel}>
                    {t.t(`channel.${row.channel}` as MessageKey)}
                  </span>
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
                  <span className="badge" data-tone="muted" data-lead={row.leadStage}>
                    {t.t(`leadStage.${row.leadStage}` as MessageKey)}
                  </span>
                  {/* The mode in force, not the conversation's override: a row that showed the override
                      would read as "off" for every conversation that simply inherits its channel's
                      policy. `AUTOPILOT` is called out because it is the one that sends unattended. */}
                  <span className="badge" data-tone={row.effectiveMode === "AUTOPILOT" ? "ok" : "muted"} data-mode={row.effectiveMode}>
                    {t.t(`aiMode.${row.effectiveMode}` as MessageKey)}
                  </span>
                </span>
                {row.preview === null ? undefined : <span className="conversation-preview muted">{row.preview}</span>}
                <time className="muted" dateTime={row.lastMessageAt.toISOString()}>
                  {t.date(row.lastMessageAt, { dateStyle: "short", timeStyle: "short" })}
                </time>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {loadedAt === undefined ? undefined : (
        // A server-rendered list is a snapshot, and the honest thing is to say when it was taken rather
        // than let it look live. Reloading is the same URL, so the view survives it.
        <p className="muted inbox-loaded-at">
          <time dateTime={loadedAt.toISOString()}>{t.t("inbox.loadedAt", { time: t.date(loadedAt, { timeStyle: "short" }) })}</time>{" "}
          <a href={`${basePath}${inboxQueryString(view)}`} data-inbox-reload="true">
            {t.t("inbox.reload")}
          </a>
        </p>
      )}

      {nextCursor === undefined ? undefined : (
        <Link className="button" href={href({ cursor: nextCursor })} data-load-more="true">
          {t.t("inbox.loadMore")}
        </Link>
      )}
    </section>
  );
}
