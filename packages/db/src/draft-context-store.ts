/**
 * Everything the draft engine needs to know about a conversation before it asks a model for a reply.
 *
 * Like webhook ingestion, this is a system flow driven by a queue job, so the scope comes from the job's
 * Workspace + Business Profile. It reads only what generation needs: the conversation's current state, the
 * messages that make up the burst being answered, and a bounded slice of history.
 *
 * Retrieval of knowledge and style belongs to P2-04 and is deliberately absent.
 */
import type { ConversationSegment, DraftConversationSnapshot } from "@omnichannel/application";
import type { AiMode } from "@omnichannel/domain";

import { resolveEffectiveMode } from "./automation-mode";
import type { DbClient } from "./client";

const DEFAULT_HISTORY_LIMIT = 20;

export interface DraftContextQuery {
  readonly workspaceId: string;
  readonly businessProfileId: string;
  readonly conversationId: string;
  /** The newest inbound message the draft answers. */
  readonly anchorMessageId: string;
  readonly historyLimit?: number;
}

export interface DraftContext {
  readonly snapshot: DraftConversationSnapshot;
  readonly channelAccountId: string;
  /** The customer messages this draft is answering, oldest first. */
  readonly inbound: readonly ConversationSegment[];
  /** Bounded earlier turns, oldest first, excluding the inbound burst. */
  readonly history: readonly ConversationSegment[];
}

export interface DraftContextStore {
  load(query: DraftContextQuery): Promise<DraftContext | undefined>;
}

export function createDraftContextStore(db: DbClient): DraftContextStore {
  return {
    async load(query) {
      const scope = { workspaceId: query.workspaceId, businessProfileId: query.businessProfileId };
      const conversation = await db.conversation.findUnique({
        where: { workspaceId_businessProfileId_id: { ...scope, id: query.conversationId } },
        select: { id: true, channelAccountId: true, status: true, aiEnabled: true, takeoverState: true, stateVersion: true, modeOverride: true },
      });
      if (conversation === null) {
        return undefined;
      }

      const anchor = await db.message.findUnique({
        where: { workspaceId_businessProfileId_id: { ...scope, id: query.anchorMessageId } },
        select: { id: true, conversationId: true, occurredAt: true },
      });
      if (anchor === null || anchor.conversationId !== conversation.id) {
        return undefined;
      }

      // A customer message newer than the anchor means the burst this draft answers is already out of date.
      const newerInbound = await db.message.findFirst({
        where: {
          ...scope,
          conversationId: conversation.id,
          direction: "IN",
          OR: [{ occurredAt: { gt: anchor.occurredAt } }, { occurredAt: anchor.occurredAt, id: { gt: anchor.id } }],
        },
        select: { id: true },
      });

      const limit = Math.min(Math.max(Math.trunc(query.historyLimit ?? DEFAULT_HISTORY_LIMIT), 1), 100);
      const messages = await db.message.findMany({
        where: { ...scope, conversationId: conversation.id, occurredAt: { lte: anchor.occurredAt } },
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        take: limit,
        select: { id: true, direction: true, source: true, kind: true, text: true, occurredAt: true },
      });
      const ordered = [...messages].reverse();

      // The burst is the run of customer messages at the end: those are what the reply answers.
      const burstStart = findBurstStart(ordered);
      const toSegment = (message: (typeof ordered)[number]): ConversationSegment => ({
        kind: message.direction === "IN" ? "INBOUND" : "OUTBOUND",
        provenance: message.id,
        // A message without text (media we cannot read) still matters as a turn, so it is labelled, not dropped.
        text: message.text ?? `[${message.kind.toLowerCase()} with no text]`,
        occurredAt: message.occurredAt,
      });

      return {
        snapshot: {
          conversationId: conversation.id,
          status: conversation.status === "OPEN" ? "OPEN" : "CLOSED",
          aiEnabled: conversation.aiEnabled,
          takeoverState: conversation.takeoverState,
          mode: await resolveMode(db, scope, conversation.channelAccountId, conversation.modeOverride),
          stateVersion: conversation.stateVersion,
          anchorSuperseded: newerInbound !== null,
        },
        channelAccountId: conversation.channelAccountId,
        inbound: ordered.slice(burstStart).map(toSegment),
        history: ordered.slice(0, burstStart).map(toSegment),
      };
    },
  };
}

function findBurstStart(messages: readonly { readonly direction: string }[]): number {
  let index = messages.length;
  while (index > 0 && messages[index - 1]?.direction === "IN") {
    index -= 1;
  }
  // If the newest message is not inbound there is no burst; everything is history.
  return index === messages.length ? messages.length : index;
}

/**
 * Conversation override first, then a channel-account policy, then the Business Profile default, then OFF.
 *
 * The rule itself lives in `automation-mode.ts`, because the Inbox has to display the same answer this
 * uses to decide whether to draft, and two implementations of that would eventually disagree.
 */
async function resolveMode(
  db: DbClient,
  scope: { readonly workspaceId: string; readonly businessProfileId: string },
  channelAccountId: string,
  override: AiMode | null,
): Promise<AiMode> {
  if (override !== null) {
    return override;
  }
  const policies = await db.automationPolicy.findMany({
    where: { ...scope, OR: [{ channelAccountId }, { channelAccountId: null }] },
    select: { channelAccountId: true, mode: true },
  });
  return resolveEffectiveMode(override, channelAccountId, policies);
}
