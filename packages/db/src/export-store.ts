/**
 * Reading one customer's data out of the product (#57, P3-04).
 *
 * A subject-access request is the only reason this exists, and that shapes every decision in it.
 *
 * **It is admin work, and the read is the event.** Everything else in this product audits what somebody
 * *changed*; an export changes nothing and is still the most sensitive thing a member can do, because it
 * takes a customer's correspondence somewhere this product can no longer account for. So the audit row is
 * written in the same transaction as the read, and it is admin-only to read back.
 *
 * **It is bounded.** One contact, their conversations, and a cap on messages. An export with no ceiling
 * is a way to take a Business Profile's entire history out through a URL, which is the shape of a data
 * breach rather than a subject-access request. The cap is reported with the data so a truncated export
 * cannot be mistaken for a complete one.
 *
 * **It carries what was stored, not what was inferred.** Retrieval scores, embeddings and the model's
 * internal reasoning are not the customer's data and would mean nothing to them; what they asked for is
 * what the business holds about them, which is the correspondence, the identifiers and the facts.
 */
import type { DbClient } from "./client";
import { recordAuditEvent } from "./audit-store";
import { profileScopeOf, requireRole, WORKSPACE_ADMIN_ROLES, type BusinessProfileContext } from "./tenancy";

/** The ceiling on one export. Reported alongside the data, so truncation is never silent. */
export const EXPORT_MESSAGE_LIMIT = 1_000;

export interface ContactExport {
  readonly contact: { readonly id: string; readonly displayName: string | null; readonly createdAt: Date };
  readonly identities: readonly { readonly channel: string; readonly externalUserId: string; readonly username: string | null; readonly displayName: string | null }[];
  readonly contactPoints: readonly { readonly kind: string; readonly value: string }[];
  readonly conversations: readonly {
    readonly id: string;
    readonly status: string;
    readonly createdAt: Date;
    readonly messages: readonly {
      readonly direction: string;
      readonly source: string;
      readonly kind: string;
      readonly text: string | null;
      readonly occurredAt: Date;
      /** The machine's reading of a voice note, which is as much the customer's data as the recording. */
      readonly transcripts: readonly string[];
    }[];
  }[];
  readonly facts: readonly { readonly category: string; readonly subject: string; readonly value: string; readonly status: string }[];
  readonly preferences: readonly { readonly subject: string; readonly value: string; readonly status: string }[];
  /** True when the message cap was reached, so a partial export cannot read as a complete one. */
  readonly truncated: boolean;
  readonly exportedAt: Date;
}

/**
 * Everything this product holds about one customer, with the read recorded.
 *
 * Admin or owner only. An agent handling conversations can already read a thread on screen; what they
 * cannot do is take the whole of somebody's history out in one action, which is a different capability
 * with different consequences and so a different gate.
 */
export async function exportContact(
  db: DbClient,
  context: BusinessProfileContext,
  contactId: string,
  now: Date,
): Promise<ContactExport | undefined> {
  requireRole(context, WORKSPACE_ADMIN_ROLES, "export a customer's data");
  const scope = profileScopeOf(context);

  return db.$transaction(async (tx) => {
    const contact = await tx.contact.findFirst({
      where: { ...scope, id: contactId },
      select: {
        id: true,
        displayName: true,
        createdAt: true,
        channelIdentities: { select: { externalUserId: true, username: true, displayName: true, channelAccount: { select: { channel: true } } } },
        contactPoints: { select: { kind: true, rawValue: true, normalizedValue: true } },
      },
    });
    if (contact === null) {
      // The same answer a contact in another Business Profile gets: an export must not be a way to find
      // out that somebody exists somewhere this member cannot see.
      return undefined;
    }

    const conversations = await tx.conversation.findMany({
      where: { ...scope, contactId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, status: true, createdAt: true },
    });
    const messages = await tx.message.findMany({
      where: { ...scope, conversationId: { in: conversations.map((conversation) => conversation.id) } },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
      // One over the cap, so "there was more" is a fact rather than a guess.
      take: EXPORT_MESSAGE_LIMIT + 1,
      select: {
        id: true,
        conversationId: true,
        direction: true,
        source: true,
        kind: true,
        text: true,
        occurredAt: true,
        transcripts: { select: { text: true, state: true } },
      },
    });
    const truncated = messages.length > EXPORT_MESSAGE_LIMIT;
    const included = truncated ? messages.slice(0, EXPORT_MESSAGE_LIMIT) : messages;

    const [facts, preferences] = await Promise.all([
      tx.customerFact.findMany({ where: { ...scope, contactId }, select: { category: true, subject: true, value: true, status: true } }),
      tx.customerPreference.findMany({ where: { ...scope, contactId }, select: { subject: true, value: true, status: true } }),
    ]);

    // In the same transaction as the read. An export that happened without a record of it happening is
    // the one case this whole module exists to prevent.
    await recordAuditEvent(tx, context, {
      kind: "DATA_EXPORTED",
      summary: `Exported customer data for contact ${contactId}`,
      subjectType: "Contact",
      subjectId: contactId,
      actorUserId: context.userId,
      occurredAt: now,
      // Counts, never content: an audit row that quoted the export would be a second copy of it.
      detail: { conversations: conversations.length, messages: included.length, truncated },
    });

    return {
      contact: { id: contact.id, displayName: contact.displayName, createdAt: contact.createdAt },
      identities: contact.channelIdentities.map((identity) => ({
        channel: identity.channelAccount.channel,
        externalUserId: identity.externalUserId,
        username: identity.username,
        displayName: identity.displayName,
      })),
      // The raw value as the customer gave it; the normalized one is this product's own bookkeeping.
      contactPoints: contact.contactPoints.map((point) => ({ kind: point.kind, value: point.rawValue ?? point.normalizedValue })),
      conversations: conversations.map((conversation) => ({
        id: conversation.id,
        status: conversation.status,
        createdAt: conversation.createdAt,
        messages: included
          .filter((message) => message.conversationId === conversation.id)
          .map((message) => ({
            direction: message.direction,
            source: message.source,
            kind: message.kind,
            text: message.text,
            occurredAt: message.occurredAt,
            transcripts: message.transcripts.filter((transcript) => transcript.state === "READY" && transcript.text !== null).map((transcript) => transcript.text ?? ""),
          })),
      })),
      facts,
      preferences,
      truncated,
      exportedAt: now,
    };
  });
}
