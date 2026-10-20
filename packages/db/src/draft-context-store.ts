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
import { commercialAccessOf, type AiMode } from "@omnichannel/domain";

import { resolveEffectiveMode } from "./automation-mode";
import { readEntitlement } from "./entitlement-store";
import type { DbClient } from "./client";
import { readMessageTranscripts, type MessageTranscriptRecord } from "./transcript-store";

const DEFAULT_HISTORY_LIMIT = 20;

export interface DraftContextQuery {
  readonly workspaceId: string;
  readonly businessProfileId: string;
  readonly conversationId: string;
  /** The newest inbound message the draft answers. */
  readonly anchorMessageId: string;
  readonly historyLimit?: number;
  /**
   * When the commercial state is resolved.
   *
   * Explicit, like every other clock in this package: a plan's validity is a question about a moment, and
   * a store that read its own would answer it at a different one from the gate that uses the answer.
   */
  readonly at?: Date;
}

export interface DraftContext {
  readonly snapshot: DraftConversationSnapshot;
  readonly channelAccountId: string;
  /** The customer messages this draft is answering, oldest first. */
  readonly inbound: readonly ConversationSegment[];
  /** Bounded earlier turns, oldest first, excluding the inbound burst. */
  readonly history: readonly ConversationSegment[];
  /**
   * True when the burst this draft answers contains a recording the product could not read (Issue #21).
   *
   * About the *burst* only. An unread voice note from last week is history the reply does not have to
   * answer; one in the burst is the question itself, and drafting over it would be answering a customer
   * nobody heard. The draft engine turns this into a reason code and holds the reply for a person.
   *
   * A reading that is still pending counts too. "Not yet" and "never" are different facts about the
   * provider and the same fact about this draft: the words are not available to write a reply from.
   */
  readonly unreadableAudio: boolean;
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
        select: { id: true, direction: true, source: true, kind: true, text: true, media: true, occurredAt: true },
      });
      const ordered = [...messages].reverse();

      // One query for the whole window rather than one per message: the readings are a side table, and a
      // draft context that issued a query per turn would make history length cost round trips.
      const transcripts = await readMessageTranscripts(db, {
        workspaceId: scope.workspaceId,
        messageIds: ordered.filter((message) => message.direction === "IN").map((message) => message.id),
      });
      const readings = new Map<string, readonly MessageTranscriptRecord[]>();
      for (const transcript of transcripts) {
        readings.set(transcript.messageId, [...(readings.get(transcript.messageId) ?? []), transcript]);
      }

      // The burst is the run of customer messages at the end: those are what the reply answers.
      const burstStart = findBurstStart(ordered);
      const toSegment = (message: (typeof ordered)[number]): ConversationSegment => ({
        kind: message.direction === "IN" ? "INBOUND" : "OUTBOUND",
        provenance: message.id,
        // A transcript enters here and nowhere else, which is what makes it untrusted by construction:
        // from this point it is a segment's `text` like any other customer writing, sanitized and fenced
        // by the draft engine. Nothing about a machine having produced it gives it authority — and the
        // caption the customer typed wins over it, because they chose those words themselves.
        //
        // A message with neither still matters as a turn, so it is labelled rather than dropped.
        text: message.text ?? transcribedText(readings.get(message.id)) ?? `[${message.kind.toLowerCase()} with no text]`,
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
          // Resolved in the same read as the rest of the snapshot (#40), and before retrieval or the
          // model call, so a workspace that may not do paid work is refused before either is paid for.
          commercial: commercialAccessOf(await readEntitlement(db, scope.workspaceId, query.at ?? new Date())),
        },
        channelAccountId: conversation.channelAccountId,
        inbound: ordered.slice(burstStart).map(toSegment),
        history: ordered.slice(0, burstStart).map(toSegment),
        unreadableAudio: ordered.slice(burstStart).some((message) => hasUnreadableRecording(message, readings.get(message.id))),
      };
    },
  };
}

/** The words of every reading that produced some, joined in a stable order. */
function transcribedText(readings: readonly MessageTranscriptRecord[] | undefined): string | undefined {
  const words = (readings ?? []).filter((reading) => reading.state === "READY" && reading.text !== undefined).map((reading) => reading.text ?? "");
  return words.length === 0 ? undefined : words.join("\n");
}

/**
 * Whether this message carries a recording whose words are not available.
 *
 * Read from the message's own media list rather than from the readings, because the failure that matters
 * most is the one with *no* row at all: a voice note that arrived before this feature existed, or one
 * whose pending row was never written. Trusting the readings table to enumerate the recordings would make
 * that case look like a message with nothing in it.
 */
function hasUnreadableRecording(
  message: { readonly media: unknown },
  readings: readonly MessageTranscriptRecord[] | undefined,
): boolean {
  const attachments = Array.isArray(message.media) ? message.media : [];
  for (const attachment of attachments) {
    if (typeof attachment !== "object" || attachment === null) {
      continue;
    }
    const row = attachment as Record<string, unknown>;
    if (row["kind"] !== "AUDIO") {
      continue;
    }
    const mediaId = typeof row["providerMediaId"] === "string" ? row["providerMediaId"] : undefined;
    const reading = (readings ?? []).find((candidate) => candidate.providerMediaId === mediaId);
    if (reading === undefined || reading.state !== "READY") {
      return true;
    }
  }
  return false;
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
