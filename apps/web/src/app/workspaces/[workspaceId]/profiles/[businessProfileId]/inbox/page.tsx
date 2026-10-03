/**
 * The Inbox (PRODUCT_UX.md, Issue #28).
 *
 * Three panes on a desktop, one at a time on a phone. This route is the list; opening a conversation
 * navigates to `/inbox/[conversationId]`, which renders the same list beside the thread. That is a real
 * navigation rather than client state on purpose: the conversation someone is reading is part of where
 * they are, so it belongs in the URL where a reload, a back button and a pasted link all agree about it.
 *
 * On a phone the list and the thread are separate screens, which falls out of the same decision — the
 * layout hides the pane the route is not about instead of maintaining a second, mobile-only state
 * machine.
 */
import { ConversationList } from "@/ui/inbox/conversation-list";
import { loadInboxScreen } from "@/server/inbox-page";
import type { RawSearchParams } from "@/server/inbox-view";

export default async function InboxPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly workspaceId: string; readonly businessProfileId: string }>;
  readonly searchParams: Promise<RawSearchParams>;
}) {
  const { workspaceId, businessProfileId } = await params;
  const screen = await loadInboxScreen(workspaceId, businessProfileId, await searchParams);

  return (
    <div className="inbox" data-pane="list">
      <ConversationList
        t={screen.t}
        rows={screen.page.rows}
        view={screen.view}
        basePath={screen.basePath}
        accounts={screen.accounts}
        loadedAt={screen.loadedAt}
        {...(screen.nextCursor === undefined ? {} : { nextCursor: screen.nextCursor })}
      />
      {/* Holds the middle column open on a desktop so choosing a conversation does not shift the list. */}
      <section className="inbox-thread inbox-thread-empty" aria-live="polite">
        <p className="muted">{screen.t.t("inbox.chooseConversation")}</p>
      </section>
    </div>
  );
}
