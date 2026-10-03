/**
 * Reading the Review queue (PRODUCT_UX.md, HUMAN_HANDOFF.md, Issue #29).
 *
 * A review item is an AI draft waiting for a person: `status = PENDING`. Everything else about it — why it
 * is waiting, what it relied on, whether it is still answerable — is read alongside it here, because the
 * queue is where someone decides whether a customer gets these words, and a decision made without the
 * reason and the provenance in front of you is a guess.
 *
 * Three things this is careful about:
 *
 * **Staleness is computed, never stored.** A draft is stale the moment its conversation moves on, which is
 * `draft.anchorStateVersion !== conversation.stateVersion`. Storing a flag would mean a writer somewhere
 * has to remember to set it on every inbound message, and the one time it is forgotten a person approves
 * an answer to a question the customer has already replaced. So it is derived on read, from the two
 * numbers that cannot disagree with themselves.
 *
 * **The reason codes are what the gates wrote.** They are not re-derived, re-ranked or summarised. A
 * second implementation of the same judgement eventually disagrees with the one that actually ran, and
 * then the queue explains a decision the system did not make.
 *
 * **Retrieval provenance distinguishes "no such fact" from "we could not look".** The draft records both
 * what the corpus supplied and whether it was reachable, and collapsing them would let a retrieval outage
 * read as an empty knowledge base — the same screen, and the opposite problem.
 */
import type { ReasonCode } from "@omnichannel/domain";

import type { Prisma } from "./generated/prisma/client";
import type { DbExecutor } from "./client";
import { profileScopeOf, type BusinessProfileContext } from "./tenancy";

/** Read once, named once: the query and the row type both come from this. */
const reviewItemSelect = {
  id: true,
  conversationId: true,
  text: true,
  confidence: true,
  needsReview: true,
  reasonCodes: true,
  factualSourceIds: true,
  retrieval: true,
  intent: true,
  suggestedLeadStage: true,
  anchorStateVersion: true,
  createdAt: true,
  conversation: {
    select: {
      channelAccountId: true,
      stateVersion: true,
      takeoverState: true,
      takeoverReason: true,
      takeoverReviewMode: true,
      lastInboundAt: true,
      contact: { select: { displayName: true } },
      channelIdentity: {
        select: { externalUserId: true, username: true, channelAccount: { select: { channel: true, status: true } } },
      },
    },
  },
} satisfies Prisma.AiDraftSelect;

type ReviewRecord = Prisma.AiDraftGetPayload<{ select: typeof reviewItemSelect }>;

const DEFAULT_PAGE = 25;
const MAX_PAGE = 100;

/** Where the previous page stopped. Oldest first, so the queue is worked in the order it arrived. */
export interface ReviewCursor {
  readonly createdAt: Date;
  readonly id: string;
}

export interface ReviewQueueFilter {
  readonly channelAccountId?: string;
  /** Only items carrying this reason. The codes are the gates' own, so this is an exact match. */
  readonly reasonCode?: ReasonCode;
  /** Only items whose send would go out on the provider's human-support path. */
  readonly reviewMode?: "NORMAL" | "HUMAN_AGENT";
  /** Only items that can still be acted on, or only those a newer message has overtaken. */
  readonly stale?: boolean;
}

/**
 * What retrieval was able to supply, kept apart from what the model cited.
 *
 * `reachable: false` means the corpus could not be consulted at all. An operator reading "no facts cited"
 * needs to know which of the two happened before deciding the assistant was wrong rather than blinded.
 */
export interface RetrievalProvenance {
  /** Whether the factual corpus was actually consulted, as the draft engine recorded it. */
  readonly status: "OK" | "UNAVAILABLE";
  /** How many facts retrieval put in front of the model — not how many the model then cited. */
  readonly suppliedCount: number;
}

export interface ReviewItem {
  readonly draftId: string;
  readonly conversationId: string;
  readonly channelAccountId: string;
  readonly channel: string;
  readonly accountStatus: string;
  readonly contactName: string | null;
  readonly handle: string;
  /** The wording awaiting a decision. `null` for a generation whose output was unusable. */
  readonly text: string | null;
  readonly confidence: number;
  readonly needsReview: boolean;
  readonly reasonCodes: readonly string[];
  readonly citedSourceIds: readonly string[];
  readonly retrieval: RetrievalProvenance;
  readonly intent: string | null;
  readonly suggestedLeadStage: string | null;
  readonly createdAt: Date;
  /** Which send a decision here would authorize: an ordinary reply or the provider's human-support path. */
  readonly reviewMode: "NORMAL" | "HUMAN_AGENT";
  readonly takeoverState: string;
  readonly takeoverReason: string | null;
  /**
   * A newer inbound message has moved the conversation past what this draft answers.
   *
   * Derived from the two versions rather than stored. A stale item is still shown — hiding it would leave
   * a person wondering where their queue went — but acting on it is refused by the store, and the UI says
   * so before they try.
   */
  readonly stale: boolean;
  readonly anchorStateVersion: number;
  readonly conversationStateVersion: number;
  readonly lastInboundAt: Date | null;
}

export interface ReviewQueuePage {
  readonly items: readonly ReviewItem[];
  readonly nextCursor?: ReviewCursor;
}

/**
 * One page of the queue, oldest first.
 *
 * Oldest first because a review queue is work, and the customer who has been waiting longest is the one
 * whose reply is most overdue. The Inbox is newest first for the opposite reason: it is a view of what is
 * happening now.
 */
export async function listReviewQueue(
  db: DbExecutor,
  context: BusinessProfileContext,
  filter: ReviewQueueFilter = {},
  page: { readonly limit?: number; readonly cursor?: ReviewCursor } = {},
): Promise<ReviewQueuePage> {
  const scope = profileScopeOf(context);
  const limit = Math.min(Math.max(Math.trunc(page.limit ?? DEFAULT_PAGE), 1), MAX_PAGE);

  const rows = await db.aiDraft.findMany({
    where: {
      ...scope,
      status: "PENDING",
      ...(filter.reasonCode === undefined ? {} : { reasonCodes: { has: filter.reasonCode } }),
      ...(filter.channelAccountId === undefined ? {} : { conversation: { channelAccountId: filter.channelAccountId } }),
      ...(filter.reviewMode === undefined ? {} : { conversation: { takeoverReviewMode: filter.reviewMode } }),
      ...(page.cursor === undefined
        ? {}
        : {
            OR: [
              { createdAt: { gt: page.cursor.createdAt } },
              // Same instant, higher id: the tie-break that keeps a cursor from repeating or skipping.
              { createdAt: page.cursor.createdAt, id: { gt: page.cursor.id } },
            ],
          }),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    // One more than asked for, so "is there another page" is a fact rather than a guess.
    take: limit + 1,
    select: reviewItemSelect,
  });

  const window = rows.slice(0, limit);
  const items = window.map(toReviewItem);
  // Staleness cannot be a `where` clause — it compares two columns — so it is applied after reading. The
  // page can therefore come back short; that is honest, and the cursor still advances correctly.
  const kept = filter.stale === undefined ? items : items.filter((item) => item.stale === filter.stale);
  const last = window.at(-1);

  return {
    items: kept,
    ...(rows.length > limit && last !== undefined ? { nextCursor: { createdAt: last.createdAt, id: last.id } } : {}),
  };
}

function toReviewItem(row: ReviewRecord): ReviewItem {
  const conversation = row.conversation;
  return {
    draftId: row.id,
    conversationId: row.conversationId,
    channelAccountId: conversation.channelAccountId,
    channel: conversation.channelIdentity.channelAccount.channel,
    accountStatus: conversation.channelIdentity.channelAccount.status,
    contactName: conversation.contact.displayName,
    handle: conversation.channelIdentity.username ?? conversation.channelIdentity.externalUserId,
    text: row.text,
    confidence: row.confidence,
    needsReview: row.needsReview,
    reasonCodes: row.reasonCodes,
    citedSourceIds: row.factualSourceIds,
    retrieval: retrievalProvenanceOf(row.retrieval),
    intent: row.intent,
    suggestedLeadStage: row.suggestedLeadStage,
    createdAt: row.createdAt,
    // A conversation with no recorded review mode is an ordinary reply. `HUMAN_AGENT` is only ever set
    // deliberately, by the policy that decided the provider's human-support path was the only way to answer.
    reviewMode: conversation.takeoverReviewMode === "HUMAN_AGENT" ? "HUMAN_AGENT" : "NORMAL",
    takeoverState: conversation.takeoverState,
    takeoverReason: conversation.takeoverReason,
    stale: row.anchorStateVersion !== conversation.stateVersion,
    anchorStateVersion: row.anchorStateVersion,
    conversationStateVersion: conversation.stateVersion,
    lastInboundAt: conversation.lastInboundAt,
  };
}

/**
 * The retrieval record, read defensively and against the shape the draft engine actually writes.
 *
 * It is a JSON column, so what is in it is a runtime fact rather than a compile-time one — an older draft
 * predates the current shape, and a migration can leave `null` behind. A value this cannot read is
 * reported as `UNAVAILABLE` rather than as an empty result, because those two are the opposite problem
 * wearing the same screen: "the business has not written this down" versus "we could not look it up", and
 * only the second is a reason to check before trusting the answer.
 */
function retrievalProvenanceOf(value: unknown): RetrievalProvenance {
  if (typeof value !== "object" || value === null) {
    return { status: "UNAVAILABLE", suppliedCount: 0 };
  }
  const record = value as Record<string, unknown>;
  const knowledge = record["knowledge"];
  return {
    // Only a literal "OK" counts as consulted. Anything else — a missing field, a status this version
    // does not know — is read as not consulted, which is the reading that makes someone look.
    status: record["status"] === "OK" ? "OK" : "UNAVAILABLE",
    suppliedCount: Array.isArray(knowledge) ? knowledge.length : 0,
  };
}
