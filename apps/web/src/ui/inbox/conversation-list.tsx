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

export interface ConversationListProps {
  readonly t: Translator;
  readonly rows: readonly InboxRow[];
  readonly view: InboxView;
  /** `/workspaces/…/inbox`; every link and the search form post back to it. */
  readonly basePath: string;
  readonly selectedId?: string;
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

export function ConversationList({ t, rows, view, basePath, selectedId, nextCursor }: ConversationListProps) {
  const href = (changes: Partial<InboxView>) => `${basePath}${inboxQueryString({ ...view, ...changes })}`;

  return (
    <section className="inbox-list" aria-labelledby="inbox-list-heading">
      <h2 className="visually-hidden" id="inbox-list-heading">
        {t.t("inbox.listLabel")}
      </h2>

      <form action={basePath} method="get" role="search" className="inbox-search">
        <label htmlFor="inbox-q">{t.t("inbox.searchLabel")}</label>
        <input id="inbox-q" name="q" type="search" defaultValue={view.search ?? ""} placeholder={t.t("inbox.searchPlaceholder")} />
        {/* The current filter travels with the search, or searching would silently widen the view. */}
        {view.filter === undefined ? undefined : <input type="hidden" name="filter" value={view.filter} />}
        {view.channelAccountId === undefined ? undefined : <input type="hidden" name="account" value={view.channelAccountId} />}
        <button className="button" type="submit">
          {t.t("inbox.searchApply")}
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

      {nextCursor === undefined ? undefined : (
        <Link className="button" href={href({ cursor: nextCursor })} data-load-more="true">
          {t.t("inbox.loadMore")}
        </Link>
      )}
    </section>
  );
}
