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
import {
  listAssignableMembers,
  listLeads,
  pendingHumanReply,
  readConversation,
  readQualification,
  readStageDisplays,
  readStageHistory,
} from "@omnichannel/db";

import { ConversationList } from "@/ui/inbox/conversation-list";
import { MessageThread } from "@/ui/inbox/message-thread";
import { ContextPanel } from "@/ui/inbox/context-panel";
import { LeadPanel } from "@/ui/leads/lead-panel";
import { ConversationControls } from "@/ui/inbox/conversation-controls";
import { Composer } from "@/ui/inbox/composer";
import { OutcomeNotice } from "@/ui/outcome-notice";
import { cancelSendAction, composeReplyAction, handBackAction, takeOverAction } from "@/server/review-actions";
import { editLeadAction, recordAnswerAction } from "@/server/lead-actions";
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
  // The lead beside the conversation, through the same panel the board uses: "edit a lead from the
  // conversation" and "edit it from the board" have to be one edit, or they become two behaviours.
  const [conversation, pending, stages, members, history, qualification, leads] = await Promise.all([
    readConversation(getDb(), screen.context, conversationId),
    pendingHumanReply(getDb(), screen.context, conversationId),
    readStageDisplays(getDb(), screen.context),
    listAssignableMembers(getDb(), screen.context),
    readStageHistory(getDb(), screen.context, conversationId),
    readQualification(getDb(), screen.context, conversationId),
    listLeads(getDb(), screen.context),
  ]);
  if (conversation === undefined) {
    notFound();
  }
  const lead = leads.find((candidate) => candidate.conversationId === conversationId);

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
        <OutcomeNotice t={screen.t} outcome={outcomeOf(await searchParams)} />
        <MessageThread t={screen.t} conversation={conversation} />
        <Composer
          t={screen.t}
          conversation={conversation}
          target={{ workspaceId, businessProfileId }}
          hasPendingReply={pending !== undefined}
          // The provider's human-support path is only offered where the conversation is already waiting
          // on one: the policy engine decides eligibility, and a checkbox that offered it everywhere
          // would invite authorizing a send the gates will refuse.
          humanAgentAvailable={conversation.takeoverReviewMode === "HUMAN_AGENT"}
          action={composeReplyAction}
        />
        <ConversationControls
          t={screen.t}
          conversation={conversation}
          target={{ workspaceId, businessProfileId }}
          viewerUserId={screen.context.userId}
          takeoverByUserId={conversation.takeoverByUserId}
          takeoverPausedUntil={conversation.takeoverPausedUntil}
          actions={{ takeOver: takeOverAction, handBack: handBackAction, cancelSend: cancelSendAction }}
        />
      </div>
      <div className="inbox-context-column">
        <ContextPanel t={screen.t} conversation={conversation} />
        {lead === undefined ? undefined : (
          <LeadPanel
            t={screen.t}
            lead={lead}
            stages={stages}
            members={members}
            history={history}
            qualification={qualification}
            target={{ workspaceId, businessProfileId }}
            editAction={editLeadAction}
            answerAction={recordAnswerAction}
          />
        )}
      </div>
    </div>
  );
}

/** The outcome of the action that redirected here, if any. Rendered once and then gone with the URL. */
function outcomeOf(params: RawSearchParams): string | undefined {
  const value = params["outcome"];
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined || first === "" ? undefined : first;
}
