/**
 * Which conversation a delivery belongs to, as a query predicate (ADR-018 Option B).
 *
 * A delivery carries its words from exactly one of two origins, and a CHECK guarantees it: an AI delivery
 * points at an `ai_drafts` row and reaches its conversation through it, while a human-composed one has no
 * draft and names the conversation directly. `delivery_jobs_one_origin_check` makes "both" and "neither"
 * impossible, so the two branches below are mutually exclusive and together exhaustive.
 *
 * It lives in one file because the alternative was tried and failed. When `draft_id` became nullable, two
 * read paths kept filtering through `draft: { conversationId }` — the Inbox's pending sends and the
 * cancellation lookup — so a reply a person had just written was invisible in the thread and could not be
 * stopped, while the row sat `SCHEDULED` and went out. Both queries were individually reasonable; what was
 * missing was a single place that knew what "belongs to this conversation" means. Every new query that
 * needs that answer should spread this rather than write the relation again.
 *
 * Scope is deliberately not included: the caller's Workspace and Business Profile filter belongs with the
 * caller's other conditions, and folding it in here would make it easy to forget which of the two a query
 * has already applied.
 */
import type { Prisma } from "./generated/prisma/client";

export function deliveryOfConversation(conversationId: string): Prisma.DeliveryJobRecordWhereInput {
  return { OR: [{ draft: { conversationId } }, { conversationId }] };
}
