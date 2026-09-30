/**
 * What both Inbox routes need before they can render anything (Issue #28).
 *
 * `/inbox` and `/inbox/[conversationId]` show the same left pane over the same query, and the second one
 * adds a thread. Loading that once here keeps the two routes from drifting — the version where the list
 * page and the detail page disagree about what "Awaiting reply" selects is a bug nobody would think to
 * look for.
 */
import { listChannelAccounts, listInbox, type InboxPage } from "@omnichannel/db";

import { getDb } from "@/server/db";
import { requireBusinessProfileContext } from "@/server/request-context";
import { decodeInboxCursor, encodeInboxCursor, inboxFilterOf, parseInboxView, type RawSearchParams } from "@/server/inbox-view";
import { requestTranslator } from "@/i18n/request-locale";
import type { InboxView } from "@/ui/inbox/view";
import type { ChannelAccountOption } from "@/ui/inbox/conversation-list";
import { channelAccountOptions } from "@/server/inbox-accounts";
import type { Translator } from "@/i18n/translate";

export interface InboxScreenData {
  readonly t: Translator;
  readonly view: InboxView;
  readonly page: InboxPage;
  readonly basePath: string;
  readonly nextCursor?: string;
  readonly accounts: readonly ChannelAccountOption[];
  /** When this page was rendered. The list says so, because a snapshot should not look live. */
  readonly loadedAt: Date;
  readonly context: Awaited<ReturnType<typeof requireBusinessProfileContext>>;
}

export async function loadInboxScreen(
  workspaceId: string,
  businessProfileId: string,
  searchParams: RawSearchParams,
): Promise<InboxScreenData> {
  // Authorization first, and before any customer data is read. A list that loaded and then checked would
  // be one thrown render away from leaking a row count.
  const context = await requireBusinessProfileContext(workspaceId, businessProfileId);
  const t = await requestTranslator();
  const view = parseInboxView(searchParams);

  const [page, accounts] = await Promise.all([
    listInbox(getDb(), context, inboxFilterOf(view, context.userId), { cursor: decodeInboxCursor(view.cursor) }),
    listChannelAccounts(getDb(), context),
  ]);

  return {
    t,
    view,
    page,
    basePath: `/workspaces/${workspaceId}/profiles/${businessProfileId}/inbox`,
    ...(page.nextCursor === undefined ? {} : { nextCursor: encodeInboxCursor(page.nextCursor) }),
    accounts: channelAccountOptions(accounts),
    loadedAt: new Date(),
    context,
  };
}

