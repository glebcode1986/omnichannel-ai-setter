/**
 * What a URL is allowed to ask the Review queue for (Issue #29).
 *
 * The same discipline as the Inbox's view: the query string is the one part of this surface an operator
 * edits by hand, so a reason nobody defined and a view nobody defined both fall back to the whole queue
 * rather than failing. Showing more than was asked for is visible; a query built from an invented enum
 * value is a 500 on a shared link.
 */
import { REASON_CODES, type ReasonCode } from "@omnichannel/domain";
import type { ReviewQueueFilter } from "@omnichannel/db";

import type { RawSearchParams } from "./inbox-view";

export interface ReviewView {
  readonly reasonCode?: ReasonCode;
  /** Whether to show only the items a person can still act on, or only the ones already overtaken. */
  readonly view?: "answerable" | "stale";
}

function one(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined || first === "" ? undefined : first;
}

function isReasonCode(value: string | undefined): value is ReasonCode {
  return value !== undefined && (REASON_CODES as readonly string[]).includes(value);
}

export function parseReviewView(params: RawSearchParams): ReviewView {
  const reason = one(params["reason"]);
  const view = one(params["view"]);
  return {
    ...(isReasonCode(reason) ? { reasonCode: reason } : {}),
    ...(view === "answerable" || view === "stale" ? { view } : {}),
  };
}

export function reviewFilterOf(view: ReviewView): ReviewQueueFilter {
  return {
    ...(view.reasonCode === undefined ? {} : { reasonCode: view.reasonCode }),
    ...(view.view === "stale" ? { stale: true } : view.view === "answerable" ? { stale: false } : {}),
  };
}

/** `?reason=…&view=…`, or the empty string, so `${base}${query}` is always a URL. */
export function reviewQueryString(view: ReviewView): string {
  const params = new URLSearchParams();
  if (view.reasonCode !== undefined) {
    params.set("reason", view.reasonCode);
  }
  if (view.view !== undefined) {
    params.set("view", view.view);
  }
  const query = params.toString();
  return query === "" ? "" : `?${query}`;
}

/** Whether the queue is being narrowed, which decides which "nothing here" sentence is true. */
export function isFilteredReviewView(view: ReviewView): boolean {
  return view.reasonCode !== undefined || view.view !== undefined;
}
