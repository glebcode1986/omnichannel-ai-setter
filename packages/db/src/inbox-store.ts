/**
 * Reading the unified Inbox (PRODUCT_UX.md, Issue #28).
 *
 * `listInboxConversations` answers "the newest open conversations" and nothing more. The Inbox needs to
 * page through them, search them and filter them the way the spec describes, so the query lives here
 * rather than growing options onto a repository function that other callers rely on staying simple.
 *
 * Three decisions worth stating, because each is the kind a UI could get wrong quietly:
 *
 * **Paging is by cursor, not by offset.** An inbox reorders itself constantly — every inbound message
 * moves a row to the top — so page 2 of an offset query can repeat and skip conversations that page 1
 * already showed. The cursor is `(lastMessageAt, id)`, which is exactly the index the profile inbox is
 * already served by, and the tuple comparison is what makes ties deterministic.
 *
 * **There is no unread state in this product.** No `lastReadAt`, no per-user read markers. What the spec
 * calls "unread" in an operational inbox is "the customer spoke last and nobody has answered", and that
 * *is* in the data: `lastInboundAt > lastOutboundAt`. This exposes it under that name rather than
 * inventing a read receipt, which would be a product feature with its own multi-operator semantics and
 * not something a query layer should decide.
 *
 * **Search matches the contact, never the message text.** Searching customers' words is a different
 * feature with different privacy and indexing consequences (and no index today, so it would table-scan a
 * profile's whole message history). Matching the display name and the channel handle is what makes the
 * left pane usable, and it is honest about what it searched.
 */
import type { ConversationStatus, LeadStage } from "@omnichannel/domain";

import { readModePolicies, resolveEffectiveMode, type ModePolicyRow } from "./automation-mode";
import type { DbExecutor } from "./client";
import { profileScopeOf, type BusinessProfileContext } from "./tenancy";

const DEFAULT_PAGE = 30;
const MAX_PAGE = 100;
/** How many batches one page may read while a two-column filter thins them out. */
const MAX_FILL_ROUNDS = 5;

/** Where the previous page stopped. Opaque to callers, and only meaningful for the same filters. */
export interface InboxCursor {
  readonly lastMessageAt: Date;
  readonly id: string;
}

export interface InboxFilter {
  readonly status?: ConversationStatus;
  readonly channelAccountId?: string;
  readonly leadStage?: LeadStage;
  /** The customer spoke last and nobody has replied. The honest form of "unread" — see the note above. */
  readonly awaitingReply?: boolean;
  /** Conversations a person is holding, or that are queued for one. */
  readonly takeover?: "HUMAN_ACTIVE" | "REVIEW_REQUIRED" | "NONE";
  /** Held by this specific person; the closest thing the data has to an assignee. */
  readonly takenOverByUserId?: string;
  /** Matches the contact's display name or the channel username. Never message text. */
  readonly search?: string;
}

export interface InboxRow {
  readonly id: string;
  readonly channelAccountId: string;
  readonly channel: string;
  readonly contactName: string | null;
  readonly handle: string;
  readonly status: ConversationStatus;
  readonly leadStage: LeadStage;
  readonly takeoverState: string;
  readonly takeoverReviewMode: string | null;
  /** The conversation's own override, or `null` when it inherits. Not the mode in force — see below. */
  readonly modeOverride: string | null;
  /** The mode actually in force: the override, else this account's policy, else the profile's, else OFF. */
  readonly effectiveMode: string;
  readonly aiEnabled: boolean;
  readonly lastMessageAt: Date;
  readonly awaitingReply: boolean;
  /** The latest message's text, for the list preview. Absent when the latest carried no text. */
  readonly preview: string | null;
}

export interface InboxPage {
  readonly rows: readonly InboxRow[];
  /** Present when another page exists. Absent means this is the end, not "unknown". */
  readonly nextCursor?: InboxCursor;
}

/**
 * One page of the Inbox.
 *
 * `awaitingReply` cannot be a `where` clause — it compares two columns, which Prisma does not express —
 * so it is applied to each batch after reading. That would leave a page of thirty showing three rows, so
 * the query refills from the cursor until the page is full or the data runs out. Bounded, because an
 * unbounded loop over a sparse filter would walk a whole profile's history to fill one screen; hitting
 * the bound returns a short page with a cursor, which is the same thing the caller already handles.
 */
export async function listInbox(
  db: DbExecutor,
  context: BusinessProfileContext,
  filter: InboxFilter = {},
  page: { readonly limit?: number; readonly cursor?: InboxCursor } = {},
): Promise<InboxPage> {
  const scope = profileScopeOf(context);
  const limit = Math.min(Math.max(Math.trunc(page.limit ?? DEFAULT_PAGE), 1), MAX_PAGE);

  // One read for the page: the precedence rule needs the profile's policies, and asking per row would
  // be a query per conversation on every screen.
  const policies = await readModePolicies(db, scope);

  const kept: InboxRow[] = [];
  let cursor = page.cursor;
  let more = false;

  for (let round = 0; round < MAX_FILL_ROUNDS; round += 1) {
    const batch = await readBatch(db, scope, filter, cursor, limit);
    // One more than asked for: whether another page exists is a fact, and answering it with "maybe"
    // produces a "load more" button that sometimes loads nothing.
    more = batch.length > limit;
    const window = batch.slice(0, limit);
    const last = window.at(-1);
    if (last === undefined) {
      more = false;
      break;
    }
    cursor = { lastMessageAt: last.lastMessageAt, id: last.id };

    for (const [index, row] of window.entries()) {
      if (filter.awaitingReply === true && !isAwaitingReply(row)) {
        continue;
      }
      kept.push(toInboxRow(row, policies));
      if (kept.length === limit) {
        // The page is full. The cursor is this row, not the batch's end, or the next page would skip
        // whatever sat between them.
        //
        // Full is not the same as "there is more", though. Rows left unexamined in this window are more;
        // so is the extra row the batch was read with. Neither being true means the data ended exactly on
        // the page boundary, and offering a cursor there is the "load more" button that loads nothing.
        const remains = more || index < window.length - 1;
        return { rows: kept, ...(remains ? { nextCursor: { lastMessageAt: row.lastMessageAt, id: row.id } } : {}) };
      }
    }
    if (!more) {
      break;
    }
  }

  return { rows: kept, ...(more && cursor !== undefined ? { nextCursor: cursor } : {}) };
}

type InboxRecord = Awaited<ReturnType<typeof readBatch>>[number];

function isAwaitingReply(row: { lastInboundAt: Date | null; lastOutboundAt: Date | null }): boolean {
  return row.lastInboundAt !== null && (row.lastOutboundAt === null || row.lastInboundAt.getTime() > row.lastOutboundAt.getTime());
}

function toInboxRow(row: InboxRecord, policies: readonly ModePolicyRow[]): InboxRow {
  return {
    id: row.id,
    channelAccountId: row.channelAccountId,
    channel: row.channelIdentity.channelAccount.channel,
    contactName: row.contact.displayName,
    handle: row.channelIdentity.username ?? row.channelIdentity.externalUserId,
    status: row.status,
    leadStage: row.leadStage,
    takeoverState: row.takeoverState,
    takeoverReviewMode: row.takeoverReviewMode,
    modeOverride: row.modeOverride,
    effectiveMode: resolveEffectiveMode(row.modeOverride, row.channelAccountId, policies),
    aiEnabled: row.aiEnabled,
    lastMessageAt: row.lastMessageAt,
    awaitingReply: isAwaitingReply(row),
    preview: row.messages[0]?.text ?? null,
  };
}

function readBatch(
  db: DbExecutor,
  scope: { readonly workspaceId: string; readonly businessProfileId: string },
  filter: InboxFilter,
  cursor: InboxCursor | undefined,
  limit: number,
) {
  return db.conversation.findMany({
    where: {
      ...scope,
      status: filter.status ?? "OPEN",
      ...(filter.channelAccountId === undefined ? {} : { channelAccountId: filter.channelAccountId }),
      ...(filter.leadStage === undefined ? {} : { leadStage: filter.leadStage }),
      ...(filter.takeover === undefined ? {} : { takeoverState: filter.takeover }),
      ...(filter.takenOverByUserId === undefined ? {} : { takeoverActorUserId: filter.takenOverByUserId }),
      // `AND`, not two spreads. Search and the cursor are both disjunctions, and spreading them would
      // put `OR` in the object twice — the second silently replacing the first, so a search would stop
      // being applied the moment a second page was asked for. This is the bug the integration tests
      // found, and the reason every disjunction here is a member of one `AND` instead of a bare key.
      AND: [
        ...(filter.search === undefined || filter.search.trim() === "" ? [] : [searchFilter(filter.search.trim())]),
        ...(cursor === undefined ? [] : [cursorFilter(cursor)]),
      ],
    },
    // The same order the profile inbox index is built for, and the tie-break that makes a cursor
    // deterministic when two conversations share a timestamp.
    orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: {
      id: true,
      channelAccountId: true,
      status: true,
      leadStage: true,
      takeoverState: true,
      takeoverReviewMode: true,
      modeOverride: true,
      aiEnabled: true,
      lastMessageAt: true,
      lastInboundAt: true,
      lastOutboundAt: true,
      contact: { select: { displayName: true } },
      channelIdentity: {
        select: { externalUserId: true, username: true, channelAccount: { select: { channel: true } } },
      },
      messages: { orderBy: [{ occurredAt: "desc" }, { id: "desc" }], take: 1, select: { text: true } },
    },
  });
}

/** Everything after the cursor in `(lastMessageAt desc, id desc)` order. */
function cursorFilter(cursor: InboxCursor) {
  return {
    OR: [
      { lastMessageAt: { lt: cursor.lastMessageAt } },
      // The tie-break half: same instant, lower id. Without it two conversations sharing a timestamp
      // could be shown twice or skipped entirely, depending on which side of the boundary they landed.
      { lastMessageAt: cursor.lastMessageAt, id: { lt: cursor.id } },
    ],
  };
}

/** The contact and the username, case-insensitively. Never message text — see the note at the top. */
function searchFilter(term: string) {
  return {
    OR: [
      { contact: { displayName: { contains: term, mode: "insensitive" as const } } },
      { channelIdentity: { username: { contains: term, mode: "insensitive" as const } } },
      { channelIdentity: { externalUserId: { contains: term, mode: "insensitive" as const } } },
    ],
  };
}

/** One message as the thread renders it. `source` is what distinguishes customer, AI, human and system. */
export interface ThreadMessage {
  readonly id: string;
  readonly direction: string;
  readonly source: string;
  readonly kind: string;
  readonly text: string | null;
  readonly occurredAt: Date;
  readonly deliveryStatus: string | null;
  readonly transportPath: string | null;
  readonly sentByUserName: string | null;
}

/**
 * The latest AI decision, for the context panel.
 *
 * Read for display only. The reason codes and the cited sources are why a reply was held or sent, and
 * showing them is the difference between an operator trusting the assistant and guessing at it.
 */
export interface LatestDraft {
  readonly id: string;
  readonly status: string;
  readonly confidence: number;
  readonly needsReview: boolean;
  readonly reasonCodes: readonly string[];
  readonly citedSourceIds: readonly string[];
  readonly intent: string | null;
  readonly suggestedLeadStage: string | null;
  readonly createdAt: Date;
}

export interface ConversationDetail {
  readonly id: string;
  readonly channel: string;
  readonly channelAccountId: string;
  readonly accountStatus: string;
  readonly contactName: string | null;
  readonly handle: string;
  readonly status: string;
  readonly leadStage: string;
  /** The conversation's own override, or `null` when it inherits. */
  readonly modeOverride: string | null;
  /** The mode actually in force. See `automation-mode.ts` for the precedence. */
  readonly effectiveMode: string;
  readonly aiEnabled: boolean;
  readonly takeoverState: string;
  readonly takeoverReason: string | null;
  readonly takeoverReviewMode: string | null;
  readonly takeoverByName: string | null;
  readonly humanTakeoverAt: Date | null;
  readonly lastInboundAt: Date | null;
  readonly lastOutboundAt: Date | null;
  readonly messages: readonly ThreadMessage[];
  readonly latestDraft?: LatestDraft;
}

/**
 * One conversation, with its thread and the context the right pane shows.
 *
 * Returns `undefined` rather than throwing for a conversation that is not this profile's: a URL someone
 * typed or kept in a bookmark should produce "not found", and a thrown tenancy error rendered as a stack
 * trace tells an attacker the row exists.
 */
export async function readConversation(
  db: DbExecutor,
  context: BusinessProfileContext,
  conversationId: string,
  options: { readonly messageLimit?: number } = {},
): Promise<ConversationDetail | undefined> {
  const scope = profileScopeOf(context);
  const limit = Math.min(Math.max(Math.trunc(options.messageLimit ?? 100), 1), 200);

  // The policies depend only on the profile, so they are read alongside the conversation rather than
  // after it: two sequential round trips for one screen is a round trip too many.
  const policiesPromise = readModePolicies(db, scope);
  const row = await db.conversation.findFirst({
    where: { ...scope, id: conversationId },
    select: {
      id: true,
      channelAccountId: true,
      status: true,
      leadStage: true,
      modeOverride: true,
      aiEnabled: true,
      takeoverState: true,
      takeoverReason: true,
      takeoverReviewMode: true,
      humanTakeoverAt: true,
      lastInboundAt: true,
      lastOutboundAt: true,
      takeoverActorUser: { select: { name: true } },
      contact: { select: { displayName: true } },
      channelIdentity: {
        select: { externalUserId: true, username: true, channelAccount: { select: { channel: true, status: true } } },
      },
      messages: {
        // Newest last, the way a thread reads. The limit takes the *latest* window, so a long
        // conversation opens where the work is rather than where it started.
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        take: limit,
        select: {
          id: true,
          direction: true,
          source: true,
          kind: true,
          text: true,
          occurredAt: true,
          deliveryStatus: true,
          transportPath: true,
          sentByUser: { select: { name: true } },
        },
      },
      aiDrafts: {
        orderBy: [{ createdAt: "desc" }],
        take: 1,
        select: {
          id: true,
          status: true,
          confidence: true,
          needsReview: true,
          reasonCodes: true,
          factualSourceIds: true,
          intent: true,
          suggestedLeadStage: true,
          createdAt: true,
        },
      },
    },
  });
  const policies = await policiesPromise;
  if (row === null) {
    return undefined;
  }

  const draft = row.aiDrafts[0];
  return {
    id: row.id,
    channel: row.channelIdentity.channelAccount.channel,
    channelAccountId: row.channelAccountId,
    accountStatus: row.channelIdentity.channelAccount.status,
    contactName: row.contact.displayName,
    handle: row.channelIdentity.username ?? row.channelIdentity.externalUserId,
    status: row.status,
    leadStage: row.leadStage,
    modeOverride: row.modeOverride,
    effectiveMode: resolveEffectiveMode(row.modeOverride, row.channelAccountId, policies),
    aiEnabled: row.aiEnabled,
    takeoverState: row.takeoverState,
    takeoverReason: row.takeoverReason,
    takeoverReviewMode: row.takeoverReviewMode,
    takeoverByName: row.takeoverActorUser?.name ?? null,
    humanTakeoverAt: row.humanTakeoverAt,
    lastInboundAt: row.lastInboundAt,
    lastOutboundAt: row.lastOutboundAt,
    // Reversed here rather than in SQL: the query takes the newest window, the thread reads oldest first.
    messages: [...row.messages].reverse().map((message) => ({
      id: message.id,
      direction: message.direction,
      source: message.source,
      kind: message.kind,
      text: message.text,
      occurredAt: message.occurredAt,
      deliveryStatus: message.deliveryStatus,
      transportPath: message.transportPath,
      sentByUserName: message.sentByUser?.name ?? null,
    })),
    ...(draft === undefined
      ? {}
      : {
          latestDraft: {
            id: draft.id,
            status: draft.status,
            confidence: draft.confidence,
            needsReview: draft.needsReview,
            reasonCodes: draft.reasonCodes,
            citedSourceIds: draft.factualSourceIds,
            intent: draft.intent,
            suggestedLeadStage: draft.suggestedLeadStage,
            createdAt: draft.createdAt,
          },
        }),
  };
}
