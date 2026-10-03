/**
 * One conversation, with the list still beside it (Issue #28).
 *
 * A conversation that is not this profile's renders `notFound()`. The store already returns `undefined`
 * rather than throwing for that case, and this keeps the distinction the store was careful about: a
 * bookmarked id from a profile the viewer lost access to is a 404, not a stack trace that confirms the
 * row exists.
 */
import { notFound } from "next/navigation";
import Link from "next/link";
import { readConversation } from "@omnichannel/db";

import { ConversationList } from "@/ui/inbox/conversation-list";
import { MessageThread } from "@/ui/inbox/message-thread";
import { ContextPanel } from "@/ui/inbox/context-panel";
import { getDb } from "@/server/db";
import { loadInboxScreen } from "@/server/inbox-page";
import type { RawSearchParams } from "@/server/inbox-view";
import { inboxQueryString } from "@/ui/inbox/view";

export default async function ConversationPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{
    readonly workspaceId: string;
    readonly businessProfileId: string;
    readonly conversationId: string;
  }>;
  readonly searchParams: Promise<RawSearchParams>;
}) {
  const { workspaceId, businessProfileId, conversationId } = await params;
  const screen = await loadInboxScreen(workspaceId, businessProfileId, await searchParams);
  const conversation = await readConversation(getDb(), screen.context, conversationId);
  if (conversation === undefined) {
    notFound();
  }

  return (
    <div className="inbox" data-pane="thread">
      <ConversationList
        t={screen.t}
        rows={screen.page.rows}
        view={screen.view}
        basePath={screen.basePath}
        accounts={screen.accounts}
        loadedAt={screen.loadedAt}
        selectedId={conversationId}
        {...(screen.nextCursor === undefined ? {} : { nextCursor: screen.nextCursor })}
      />
      <div className="inbox-thread-column">
        {/* Only reachable on a phone, where the list is a separate screen; harmless on a desktop, where
            the list is already on screen and this reads as a redundant but truthful link. */}
        <Link className="inbox-back" href={`${screen.basePath}${inboxQueryString(screen.view)}`} data-inbox-back="true">
          {screen.t.t("inbox.backToList")}
        </Link>
        <MessageThread t={screen.t} conversation={conversation} />
      </div>
      <ContextPanel t={screen.t} conversation={conversation} />
    </div>
  );
}

