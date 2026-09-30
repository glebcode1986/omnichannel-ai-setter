/**
 * The Inbox view, and the one place that turns it back into a query string (Issue #28).
 *
 * Both the left pane's links and the thread's "back to conversations" link have to rebuild the URL the
 * operator arrived on. Written twice they drift, and the way that shows up is a back button that quietly
 * drops the filter someone had applied. So there is one builder, and it is a pure function of the view.
 */

/** The view the URL is describing. Every field is what a query parameter said, not what React remembers. */
export interface InboxView {
  readonly search?: string;
  readonly filter?: "awaitingReply" | "reviewNeeded" | "humanActive" | "mine";
  readonly channelAccountId?: string;
  readonly leadStage?: string;
  readonly cursor?: string;
}

/** `?q=…&filter=…`, or the empty string for the default view, so `${base}${query}` is always a valid URL. */
export function inboxQueryString(view: InboxView): string {
  const params = new URLSearchParams();
  if (view.search !== undefined && view.search !== "") {
    params.set("q", view.search);
  }
  if (view.filter !== undefined) {
    params.set("filter", view.filter);
  }
  if (view.channelAccountId !== undefined) {
    params.set("account", view.channelAccountId);
  }
  if (view.leadStage !== undefined) {
    params.set("stage", view.leadStage);
  }
  if (view.cursor !== undefined) {
    params.set("cursor", view.cursor);
  }
  const query = params.toString();
  return query === "" ? "" : `?${query}`;
}

/** Whether this view is narrowing the list, which decides which "nothing here" sentence is true. */
export function isFilteredView(view: InboxView): boolean {
  return view.search !== undefined || view.filter !== undefined || view.channelAccountId !== undefined || view.leadStage !== undefined;
}
