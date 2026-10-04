/**
 * What the Review queue route needs before it can render anything (Issue #29).
 *
 * It exists for the reason `knowledge-page.ts` does, learned the same way. The store pages the queue at 25
 * and returns a cursor; the route called it without one and rendered no next link, so the twenty-sixth
 * item waiting for a person was unreachable — and approve, edit-and-send, dismiss and claim exist only on
 * this screen, so unreachable there meant unreachable anywhere. Nothing failed: the first 25 were correct.
 *
 * A route component is the one thing a test in this app cannot call, so the assembly lives here, where
 * `review-screen.integration.test.ts` drives it against a real database and follows the link it produces.
 */
import { listReviewQueue, type ReviewQueuePage } from "@omnichannel/db";

import { requestTranslator } from "@/i18n/request-locale";
import type { Translator } from "@/i18n/translate";
import { getDb } from "@/server/db";
import type { RawSearchParams } from "@/server/inbox-view";
import { decodeReviewCursor, parseReviewView, reviewFilterOf, reviewNextHref, type ReviewView } from "@/server/review-view";
import { requireBusinessProfileContext } from "@/server/request-context";

export interface ReviewScreenData {
  readonly t: Translator;
  readonly view: ReviewView;
  readonly page: ReviewQueuePage;
  readonly basePath: string;
  readonly reviewPath: string;
  /** Where the rest of the queue is, or `undefined` when this is all of it. */
  readonly nextHref?: string;
  readonly context: Awaited<ReturnType<typeof requireBusinessProfileContext>>;
}

export async function loadReviewScreen(
  workspaceId: string,
  businessProfileId: string,
  searchParams: RawSearchParams,
): Promise<ReviewScreenData> {
  // Authorization first, and before any customer-facing draft is read.
  const context = await requireBusinessProfileContext(workspaceId, businessProfileId);
  const t = await requestTranslator();
  // Parsed and validated in one place, tested there, so a reason nobody defined cannot reach a query.
  const view = parseReviewView(searchParams);
  const basePath = `/workspaces/${workspaceId}/profiles/${businessProfileId}`;
  const reviewPath = `${basePath}/review`;

  const page = await listReviewQueue(getDb(), context, reviewFilterOf(view), { cursor: decodeReviewCursor(view.cursor) });

  return {
    t,
    view,
    page,
    basePath,
    reviewPath,
    ...(page.nextCursor === undefined ? {} : { nextHref: reviewNextHref(reviewPath, view, page.nextCursor) }),
    context,
  };
}
