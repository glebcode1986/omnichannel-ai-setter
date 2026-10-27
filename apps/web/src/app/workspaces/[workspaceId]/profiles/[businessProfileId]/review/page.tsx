/**
 * The Review queue (PRODUCT_UX.md, HUMAN_HANDOFF.md, Issue #29).
 *
 * Oldest first, because a review queue is work and the customer who has waited longest is the most
 * overdue — the opposite of the Inbox, which is a view of what is happening now.
 *
 * Every decision is one item at a time. There is no select-all and no bulk approve: a person approving
 * twenty customer-facing replies with one click has not reviewed twenty replies, and the contract makes
 * that a hard invariant rather than a preference.
 */
import Link from "next/link";
import { REASON_CODES } from "@omnichannel/domain";

import { ReviewCard } from "@/ui/review/review-card";
import { OutcomeNotice } from "@/ui/outcome-notice";
import { approveDraftAction, claimDraftAction, dismissDraftAction, editAndSendAction } from "@/server/review-actions";
import { loadReviewScreen } from "@/server/review-page";
import type { RawSearchParams } from "@/server/inbox-view";
import { isFilteredReviewView, reviewQueryString } from "@/server/review-view";

function one(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined || first === "" ? undefined : first;
}

export default async function ReviewPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly workspaceId: string; readonly businessProfileId: string }>;
  readonly searchParams: Promise<RawSearchParams>;
}) {
  const { workspaceId, businessProfileId } = await params;
  const query = await searchParams;
  // Every read this screen needs, assembled where a test can call it: the route used to do it here, and
  // that is where the queue quietly lost everything after its twenty-fifth item.
  const { t, view, page, basePath, reviewPath, nextHref } = await loadReviewScreen(workspaceId, businessProfileId, query);
  // Filter links drop the cursor by construction — `reviewQueryString` does not serialize it — because
  // changing what the queue shows means starting from the top of it.
  const href = (changes: Partial<typeof view>) => `${reviewPath}${reviewQueryString({ ...view, ...changes })}`;

  return (
    <>
      <div className="page-header">
        <h1>{t.t("review.title")}</h1>
        <p className="muted">{t.t("review.noBulk")}</p>
      </div>

      <OutcomeNotice t={t} outcome={one(query["outcome"])} />

      <form action={reviewPath} method="get" className="inbox-search" role="search">
        <div className="field">
          <label htmlFor="review-reason">{t.t("review.filterReason")}</label>
          <select id="review-reason" name="reason" defaultValue={view.reasonCode ?? ""}>
            <option value="">{t.t("review.allReasons")}</option>
            {REASON_CODES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </div>
        {view.view === undefined ? undefined : <input type="hidden" name="view" value={view.view} />}
        <button className="button" type="submit">
          {t.t("inbox.applyFilters")}
        </button>
      </form>

      <ul className="filter-row">
        {(
          [
            { key: undefined, label: "review.filterAll" },
            { key: "answerable", label: "review.filterAnswerable" },
            { key: "stale", label: "review.filterStale" },
          ] as const
        ).map((entry) => (
          <li key={entry.label}>
            <Link
              className="chip"
              href={href({ view: entry.key })}
              data-active={String(view.view === entry.key)}
              {...(view.view === entry.key ? { "aria-current": "true" as const } : {})}
            >
              {t.t(entry.label)}
            </Link>
          </li>
        ))}
      </ul>

      {page.items.length === 0 ? (
        <p className="muted" data-empty="true">
          {isFilteredReviewView(view) ? t.t("review.emptyFiltered") : t.t("review.empty")}
        </p>
      ) : (
        <div className="review-queue" aria-label={t.t("review.queueLabel")}>
          {page.items.map((item) => (
            <ReviewCard
              key={item.draftId}
              t={t}
              item={item}
              basePath={basePath}
              from="review"
              target={{ workspaceId, businessProfileId }}
              actions={{
                approve: approveDraftAction,
                editAndSend: editAndSendAction,
                dismiss: dismissDraftAction,
                claim: claimDraftAction,
              }}
            />
          ))}
          {nextHref === undefined ? undefined : (
            <Link className="button" href={nextHref} data-load-more="true">
              {t.t("review.loadMore")}
            </Link>
          )}
        </div>
      )}
    </>
  );
}
