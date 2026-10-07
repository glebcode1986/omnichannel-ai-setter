/**
 * Customer identity and durable memory, inside one Business Profile (Issue #54).
 *
 * Four refusals shape this file, and each one is somewhere it cannot be forgotten rather than in a
 * comment asking the next writer to be careful.
 *
 * **Nothing crosses a Business Profile.** Every function takes an authorized `BusinessProfileContext` and
 * every query is scoped by it. The same phone number in two profiles is two unrelated customers, which is
 * the product decision and not a limitation: a shared identity graph across businesses is exactly the
 * creepy thing this task exists to avoid.
 *
 * **Only a person makes memory authoritative.** A model may propose; `confirmFact` is what makes an entry
 * ACTIVE, and a CHECK requires the confirming member. Model output therefore sits at `SUGGESTED` where
 * nothing reading memory as authority can see it.
 *
 * **Weak matches suggest, they never merge.** A provider-verified contact point may associate two
 * identities automatically because the provider vouched for it. Anything softer — a number somebody typed
 * into a chat, a name that looks similar — produces a duplicate *candidate* for a person to judge.
 *
 * **Search is authorization-first.** There is no function here that takes a raw workspace id. A caller
 * without a context cannot ask, and a caller with one cannot ask about anybody else.
 */
import type { DbClient, DbExecutor } from "./client";
import { profileScopeOf, requireRole, WORKSPACE_ADMIN_ROLES, type BusinessProfileContext } from "./tenancy";

export type FactCategory = "CONTACT_PREFERENCE" | "SERVICE_HISTORY" | "STATED_REQUIREMENT" | "LOGISTICS" | "CONSENT";
export type MemorySource = "CUSTOMER_STATED" | "HUMAN_RECORDED" | "AI_SUGGESTED";
export type MemoryStatus = "SUGGESTED" | "ACTIVE" | "SUPERSEDED" | "EXPIRED";

export type MemoryOutcome =
  | { readonly status: "RECORDED"; readonly id: string }
  | { readonly status: "CONFIRMED"; readonly id: string }
  | { readonly status: "SUPERSEDED"; readonly id: string }
  | { readonly status: "ASSOCIATED" }
  | { readonly status: "SUGGESTED_DUPLICATE"; readonly candidateId: string }
  | { readonly status: "GONE" }
  | { readonly status: "REFUSED"; readonly reason: string };

/**
 * A phone number or email, normalized so two spellings of one value are one contact point.
 *
 * Deliberately simple: digits for a phone, lowercased and trimmed for an email. Not a full parser —
 * `MVP scope guard` in the issue rules out an advanced resolver, and a half-clever normalizer is worse
 * than an obvious one because its mistakes are hard to predict.
 */
export function normalizeContactPoint(kind: "PHONE" | "EMAIL", value: string): string {
  const trimmed = value.trim();
  return kind === "EMAIL" ? trimmed.toLowerCase() : `+${trimmed.replace(/\D/gu, "")}`;
}

export interface ContactPointView {
  readonly id: string;
  readonly kind: string;
  readonly rawValue: string;
  readonly normalizedValue: string;
  readonly verification: string;
  readonly contactId: string;
}

/**
 * Records a contact point, and associates or suggests depending on how good the evidence is.
 *
 * `PROVIDER_VERIFIED` is the only level that auto-associates, because it is the only one where somebody
 * other than the customer vouched for the value. Everything softer creates a duplicate candidate: a
 * customer typing a number is worth recording and is not proof — people mistype, and people give a
 * partner's number.
 */
export async function recordContactPoint(
  db: DbClient,
  context: BusinessProfileContext,
  input: {
    readonly contactId: string;
    readonly kind: "PHONE" | "EMAIL";
    readonly value: string;
    readonly verification: "UNVERIFIED" | "CUSTOMER_STATED" | "PROVIDER_VERIFIED";
  },
): Promise<MemoryOutcome> {
  const scope = profileScopeOf(context);
  const normalized = normalizeContactPoint(input.kind, input.value);
  if (normalized === "" || normalized === "+" || input.value.trim() === "") {
    return { status: "REFUSED", reason: "that is not a usable contact point" };
  }

  return db.$transaction(async (tx) => {
    const contact = await tx.contact.findFirst({ where: { ...scope, id: input.contactId }, select: { id: true } });
    if (contact === null) {
      return { status: "GONE" };
    }

    const existing = await tx.contactPoint.findFirst({
      where: { ...scope, kind: input.kind, normalizedValue: normalized },
      select: { id: true, contactId: true, verification: true },
    });

    if (existing === null) {
      const created = await tx.contactPoint.create({
        data: {
          ...scope,
          contactId: input.contactId,
          kind: input.kind,
          normalizedValue: normalized,
          rawValue: input.value.trim(),
          verification: input.verification,
        },
        select: { id: true },
      });
      return { status: "RECORDED", id: created.id };
    }

    if (existing.contactId === input.contactId) {
      // The same contact again. Verification may only strengthen: a provider vouching for a number a
      // customer typed is news; a customer retyping a provider-verified number is not.
      if (input.verification === "PROVIDER_VERIFIED" && existing.verification !== "PROVIDER_VERIFIED") {
        await tx.contactPoint.update({ where: { id: existing.id }, data: { verification: "PROVIDER_VERIFIED" } });
      }
      return { status: "RECORDED", id: existing.id };
    }

    // Two contacts, one value. How that resolves depends entirely on the evidence.
    if (input.verification === "PROVIDER_VERIFIED" && existing.verification === "PROVIDER_VERIFIED") {
      // Both sides vouched for by a provider: a strong deterministic link, which the issue allows to
      // associate automatically. Associating is *not* merging — the contacts stay separate records and
      // the link is a candidate marked as already evidenced.
      await suggestDuplicateInside(tx, scope, input.contactId, existing.contactId, `both sides have a provider-verified ${input.kind.toLowerCase()}`);
      return { status: "ASSOCIATED" };
    }

    const candidateId = await suggestDuplicateInside(
      tx,
      scope,
      input.contactId,
      existing.contactId,
      `the same ${input.kind.toLowerCase()} was recorded for both, and only one side is provider-verified at most`,
    );
    return { status: "SUGGESTED_DUPLICATE", candidateId };
  });
}

/**
 * Records that two contacts might be the same person.
 *
 * Ordered by id so one pair is one row however it was discovered, which a CHECK also insists on. An
 * existing candidate is left alone rather than re-created: offering the same guess repeatedly is how a
 * suggestion queue becomes noise somebody stops reading.
 */
async function suggestDuplicateInside(
  tx: DbExecutor,
  scope: { readonly workspaceId: string; readonly businessProfileId: string },
  left: string,
  right: string,
  reason: string,
): Promise<string> {
  // The two are never the same contact: the only caller returns early for that, and
  // `duplicate_contact_candidates_distinct_check` refuses it in the database regardless.
  const [contactId, otherContactId] = left < right ? [left, right] : [right, left];
  const existing = await tx.duplicateContactCandidate.findFirst({
    where: { ...scope, contactId, otherContactId },
    select: { id: true },
  });
  if (existing !== null) {
    return existing.id;
  }
  const created = await tx.duplicateContactCandidate.create({
    data: { ...scope, contactId, otherContactId, reason },
    select: { id: true },
  });
  return created.id;
}

export interface DuplicateCandidateView {
  readonly id: string;
  readonly contactId: string;
  readonly otherContactId: string;
  readonly reason: string;
  readonly dismissedByName: string | null;
  readonly createdAt: Date;
}

/** Candidates a person has not yet judged. Dismissed ones are kept and not offered again. */
export async function listDuplicateCandidates(
  db: DbExecutor,
  context: BusinessProfileContext,
): Promise<readonly DuplicateCandidateView[]> {
  const scope = profileScopeOf(context);
  const rows = await db.duplicateContactCandidate.findMany({
    where: { ...scope, dismissedAt: null },
    orderBy: [{ createdAt: "desc" }],
    take: 100,
    select: { id: true, contactId: true, otherContactId: true, reason: true, createdAt: true, dismissedBy: { select: { name: true } } },
  });
  return rows.map((row) => ({
    id: row.id,
    contactId: row.contactId,
    otherContactId: row.otherContactId,
    reason: row.reason,
    dismissedByName: row.dismissedBy?.name ?? null,
    createdAt: row.createdAt,
  }));
}

/** Judged and declined. Kept, so the same guess is not offered forever. */
export async function dismissDuplicateCandidate(
  db: DbExecutor,
  context: BusinessProfileContext,
  candidateId: string,
  at = new Date(),
): Promise<MemoryOutcome> {
  const scope = profileScopeOf(context);
  const changed = await db.duplicateContactCandidate.updateMany({
    where: { ...scope, id: candidateId, dismissedAt: null },
    data: { dismissedByUserId: context.userId, dismissedAt: at },
  });
  return changed.count === 0 ? { status: "GONE" } : { status: "CONFIRMED", id: candidateId };
}

export interface MemoryEntry {
  readonly id: string;
  readonly subject: string;
  readonly value: string;
  readonly source: string;
  readonly status: string;
  readonly category?: string;
  readonly confirmedByName: string | null;
  readonly confirmedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly sourceMessageId: string | null;
  readonly sourceDraftId: string | null;
  readonly createdAt: Date;
}

/**
 * Proposes a fact. It is never authoritative when it arrives.
 *
 * `HUMAN_RECORDED` and `CUSTOMER_STATED` entries are still `SUGGESTED` until somebody confirms them,
 * which sounds pedantic and is not: a colleague typing something into a box is recording a claim, and the
 * act of making it the business's memory is a separate one the row can name.
 */
export async function proposeFact(
  db: DbClient,
  context: BusinessProfileContext,
  input: {
    readonly contactId: string;
    readonly category: FactCategory;
    readonly subject: string;
    readonly value: string;
    readonly source: MemorySource;
    readonly sourceMessageId?: string;
    readonly sourceDraftId?: string;
    readonly expiresAt?: Date;
  },
): Promise<MemoryOutcome> {
  const scope = profileScopeOf(context);
  if (input.subject.trim() === "" || input.value.trim() === "") {
    return { status: "REFUSED", reason: "a fact needs both a subject and a value" };
  }
  if (input.source === "AI_SUGGESTED" && input.sourceDraftId === undefined) {
    // A model's proposal has to name the draft it came from, or an operator cannot read the reply that
    // produced it before believing it. A CHECK enforces this too.
    return { status: "REFUSED", reason: "a model's proposal must name the draft it came from" };
  }

  const contact = await db.contact.findFirst({ where: { ...scope, id: input.contactId }, select: { id: true } });
  if (contact === null) {
    return { status: "GONE" };
  }

  const created = await db.customerFact.create({
    data: {
      ...scope,
      contactId: input.contactId,
      category: input.category,
      subject: input.subject.trim(),
      value: input.value.trim(),
      source: input.source,
      status: "SUGGESTED",
      ...(input.sourceMessageId === undefined ? {} : { sourceMessageId: input.sourceMessageId }),
      ...(input.sourceDraftId === undefined ? {} : { sourceDraftId: input.sourceDraftId }),
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    },
    select: { id: true },
  });
  return { status: "RECORDED", id: created.id };
}

/**
 * Makes a proposed fact the business's memory, superseding whatever it replaces.
 *
 * One transaction: the older entry for the same subject becomes `SUPERSEDED` and this one becomes
 * `ACTIVE`, because a partial unique index allows exactly one ACTIVE per subject and two statements would
 * either collide or leave memory contradicting itself between them.
 */
export async function confirmFact(
  db: DbClient,
  context: BusinessProfileContext,
  factId: string,
  at = new Date(),
): Promise<MemoryOutcome> {
  const scope = profileScopeOf(context);

  return db.$transaction(async (tx) => {
    const fact = await tx.customerFact.findFirst({
      where: { ...scope, id: factId, status: "SUGGESTED" },
      select: { id: true, contactId: true, category: true, subject: true },
    });
    if (fact === null) {
      return { status: "GONE" };
    }

    await tx.customerFact.updateMany({
      where: { ...scope, contactId: fact.contactId, category: fact.category, subject: fact.subject, status: "ACTIVE" },
      data: { status: "SUPERSEDED" },
    });
    await tx.customerFact.update({
      where: { id: factId },
      // The confirmer and the time together, which the CHECK requires for ACTIVE.
      data: { status: "ACTIVE", confirmedByUserId: context.userId, confirmedAt: at },
    });
    return { status: "CONFIRMED", id: factId };
  });
}

/**
 * The memory a caller may treat as the business's own.
 *
 * ACTIVE only, and expiry is applied on read rather than trusted to a sweeper: a fact whose `expiresAt`
 * has passed is not returned even if nothing has marked it `EXPIRED` yet. A background job that was late
 * would otherwise make stale memory authoritative for as long as it was behind.
 */
export async function readAuthoritativeMemory(
  db: DbExecutor,
  context: BusinessProfileContext,
  contactId: string,
  at = new Date(),
): Promise<{ readonly facts: readonly MemoryEntry[]; readonly preferences: readonly MemoryEntry[] }> {
  const scope = profileScopeOf(context);
  const live = { status: "ACTIVE" as const, OR: [{ expiresAt: null }, { expiresAt: { gt: at } }] };

  const [facts, preferences] = await Promise.all([
    db.customerFact.findMany({
      where: { ...scope, contactId, ...live },
      orderBy: [{ category: "asc" }, { subject: "asc" }],
      select: factSelect,
    }),
    db.customerPreference.findMany({
      where: { ...scope, contactId, ...live },
      orderBy: [{ subject: "asc" }],
      select: preferenceSelect,
    }),
  ]);

  return { facts: facts.map(toEntry), preferences: preferences.map(toEntry) };
}

/** Everything recorded, including suggestions and superseded history, for a person to review. */
export async function readMemoryHistory(
  db: DbExecutor,
  context: BusinessProfileContext,
  contactId: string,
): Promise<{ readonly facts: readonly MemoryEntry[]; readonly preferences: readonly MemoryEntry[] }> {
  const scope = profileScopeOf(context);
  const [facts, preferences] = await Promise.all([
    db.customerFact.findMany({ where: { ...scope, contactId }, orderBy: [{ createdAt: "desc" }], take: 200, select: factSelect }),
    db.customerPreference.findMany({ where: { ...scope, contactId }, orderBy: [{ createdAt: "desc" }], take: 200, select: preferenceSelect }),
  ]);
  return { facts: facts.map(toEntry), preferences: preferences.map(toEntry) };
}

const factSelect = {
  id: true,
  category: true,
  subject: true,
  value: true,
  source: true,
  status: true,
  confirmedAt: true,
  expiresAt: true,
  sourceMessageId: true,
  sourceDraftId: true,
  createdAt: true,
  confirmedBy: { select: { name: true } },
} as const;

const preferenceSelect = {
  id: true,
  subject: true,
  value: true,
  source: true,
  status: true,
  confirmedAt: true,
  expiresAt: true,
  sourceMessageId: true,
  sourceDraftId: true,
  createdAt: true,
  confirmedBy: { select: { name: true } },
} as const;

function toEntry(row: {
  id: string;
  category?: string;
  subject: string;
  value: string;
  source: string;
  status: string;
  confirmedAt: Date | null;
  expiresAt: Date | null;
  sourceMessageId: string | null;
  sourceDraftId: string | null;
  createdAt: Date;
  confirmedBy: { name: string | null } | null;
}): MemoryEntry {
  return {
    id: row.id,
    ...(row.category === undefined ? {} : { category: row.category }),
    subject: row.subject,
    value: row.value,
    source: row.source,
    status: row.status,
    confirmedByName: row.confirmedBy?.name ?? null,
    confirmedAt: row.confirmedAt,
    expiresAt: row.expiresAt,
    sourceMessageId: row.sourceMessageId,
    sourceDraftId: row.sourceDraftId,
    createdAt: row.createdAt,
  };
}

/**
 * Records a model's reading of a conversation, which is assistive and nothing more.
 *
 * Replaces whatever was there: one current summary per conversation, because two would leave a reader
 * choosing between a model's two opinions. It carries no confirmation and cannot become memory — there is
 * no function here that turns a summary into a fact.
 */
export async function recordConversationSummary(
  db: DbExecutor,
  context: BusinessProfileContext,
  input: {
    readonly conversationId: string;
    readonly summary: string;
    readonly modelProvider: string;
    readonly modelName: string;
    readonly coversMessageId?: string;
    readonly expiresAt?: Date;
  },
): Promise<MemoryOutcome> {
  const scope = profileScopeOf(context);
  if (input.summary.trim() === "") {
    return { status: "REFUSED", reason: "an empty summary says nothing" };
  }
  const conversation = await db.conversation.findFirst({ where: { ...scope, id: input.conversationId }, select: { id: true } });
  if (conversation === null) {
    return { status: "GONE" };
  }

  const data = {
    summary: input.summary.trim(),
    modelProvider: input.modelProvider,
    modelName: input.modelName,
    ...(input.coversMessageId === undefined ? {} : { coversMessageId: input.coversMessageId }),
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
  };
  const created = await db.conversationSummary.upsert({
    where: { workspaceId_businessProfileId_conversationId: { ...scope, conversationId: input.conversationId } },
    create: { ...scope, conversationId: input.conversationId, ...data },
    update: data,
    select: { id: true },
  });
  return { status: "RECORDED", id: created.id };
}

export interface SummaryView {
  readonly summary: string;
  readonly modelProvider: string;
  readonly modelName: string;
  readonly coversMessageId: string | null;
  readonly expiresAt: Date | null;
  readonly updatedAt: Date;
}

/** `undefined` for a conversation with no summary, or one whose summary has expired. */
export async function readConversationSummary(
  db: DbExecutor,
  context: BusinessProfileContext,
  conversationId: string,
  at = new Date(),
): Promise<SummaryView | undefined> {
  const scope = profileScopeOf(context);
  const row = await db.conversationSummary.findFirst({
    where: { ...scope, conversationId, OR: [{ expiresAt: null }, { expiresAt: { gt: at } }] },
    select: { summary: true, modelProvider: true, modelName: true, coversMessageId: true, expiresAt: true, updatedAt: true },
  });
  return row ?? undefined;
}

export interface CustomerSearchHit {
  readonly contactId: string;
  readonly displayName: string | null;
  /** Which field matched, so an operator can see why somebody came up. */
  readonly matchedOn: "NAME" | "CONTACT_POINT" | "CHANNEL_IDENTIFIER" | "EXTERNAL_ID" | "MESSAGE_TEXT";
  readonly matchedValue: string;
}

/**
 * Finds customers of *this* Business Profile.
 *
 * Authorization-first by construction: the only way in is an authorized context, and the scope comes from
 * it rather than from an argument. There is no parameter a caller could set to widen the search, which is
 * what "cross-BP data is invisible by default" has to mean at this layer — not a filter somebody could
 * forget, but no way to express the question.
 *
 * Message text is searched only when the caller asks for it. The issue lists it among the fields, and a
 * business searching its own correspondence is ordinary — but it is a different question from "who is
 * this", with different consequences, so it is a separate decision at the call site rather than something
 * that happens to everybody's words whenever somebody types a name. The Inbox's own search never does it.
 */
/**
 * How many hits a search may return.
 *
 * A floor of one because a caller that computed a nonsense limit should get an answer rather than a blank
 * screen it will read as "no such customer". A ceiling of a hundred because no operator reads more, and
 * without one a caller can pull every contact the business has in a single query.
 */
export function searchLimit(limit: number): number {
  if (!Number.isFinite(limit)) {
    return 25;
  }
  return Math.min(Math.max(Math.trunc(limit), 1), 100);
}

export async function searchCustomers(
  db: DbExecutor,
  context: BusinessProfileContext,
  term: string,
  options: { readonly limit?: number; readonly includeMessageText?: boolean } = {},
): Promise<readonly CustomerSearchHit[]> {
  const scope = profileScopeOf(context);
  const limit = options.limit ?? 25;
  const needle = term.trim();
  if (needle === "") {
    return [];
  }
  const take = searchLimit(limit);
  const contains = { contains: needle, mode: "insensitive" as const };

  const [byName, byPoint, byIdentity, byExternal, byMessage] = await Promise.all([
    db.contact.findMany({ where: { ...scope, displayName: contains }, take, select: { id: true, displayName: true } }),
    db.contactPoint.findMany({
      // Matched against both spellings: an operator pastes what the customer sent, not what we stored.
      where: { ...scope, OR: [{ rawValue: contains }, { normalizedValue: { contains: needle.replace(/\D/gu, "") === "" ? needle : needle.replace(/\D/gu, "") } }] },
      take,
      select: { contactId: true, rawValue: true, contact: { select: { displayName: true } } },
    }),
    db.channelIdentity.findMany({
      where: { ...scope, OR: [{ username: contains }, { externalUserId: contains }] },
      take,
      select: { contactId: true, username: true, externalUserId: true, contact: { select: { displayName: true } } },
    }),
    db.externalIdentity.findMany({
      where: { ...scope, externalId: contains },
      take,
      select: { contactId: true, externalId: true, contact: { select: { displayName: true } } },
    }),
    options.includeMessageText === true
      ? db.message.findMany({
          where: { ...scope, text: contains },
          orderBy: [{ occurredAt: "desc" }],
          take,
          select: { text: true, conversation: { select: { contactId: true, contact: { select: { displayName: true } } } } },
        })
      : Promise.resolve([]),
  ]);

  const hits: CustomerSearchHit[] = [
    ...byName.map((row) => ({ contactId: row.id, displayName: row.displayName, matchedOn: "NAME" as const, matchedValue: row.displayName ?? "" })),
    ...byPoint.map((row) => ({ contactId: row.contactId, displayName: row.contact.displayName, matchedOn: "CONTACT_POINT" as const, matchedValue: row.rawValue })),
    ...byIdentity.map((row) => ({
      contactId: row.contactId,
      displayName: row.contact.displayName,
      matchedOn: "CHANNEL_IDENTIFIER" as const,
      matchedValue: row.username ?? row.externalUserId,
    })),
    ...byExternal.map((row) => ({ contactId: row.contactId, displayName: row.contact.displayName, matchedOn: "EXTERNAL_ID" as const, matchedValue: row.externalId })),
    // Last, so a customer whose *name* matches is never pushed below one whose words happen to.
    ...byMessage.map((row) => ({
      contactId: row.conversation.contactId,
      displayName: row.conversation.contact.displayName,
      matchedOn: "MESSAGE_TEXT" as const,
      matchedValue: row.text ?? "",
    })),
  ];

  // One row per contact, keeping the first reason it matched: four rows for one customer is the same
  // answer four times.
  const seen = new Set<string>();
  const unique: CustomerSearchHit[] = [];
  for (const hit of hits) {
    if (!seen.has(hit.contactId)) {
      seen.add(hit.contactId);
      unique.push(hit);
    }
  }
  return unique.slice(0, take);
}

/**
 * Everything stored about one customer, for a deletion request.
 *
 * The only way memory goes away. Nothing cascades from the contact — `constraints.integration.test.ts`
 * holds the whole schema to that, and it is the right rule here: a stray `contact.delete()` should fail
 * loudly rather than quietly vaporize what a business remembers about somebody.
 *
 * It returns what it removed, because "we deleted your data" is a claim that should be countable.
 */
export async function forgetCustomer(
  db: DbClient,
  context: BusinessProfileContext,
  contactId: string,
): Promise<{ readonly status: "FORGOTTEN" | "GONE"; readonly removed: Readonly<Record<string, number>> }> {
  // Admin or owner, like every other irreversible act on a customer's data (#57). Everything else in
  // this file is a read or a proposal an agent may legitimately make; this one destroys what a business
  // remembers about somebody, and it was the only destructive function in the package with no role gate.
  requireRole(context, WORKSPACE_ADMIN_ROLES, "forget a customer");
  const scope = profileScopeOf(context);

  return db.$transaction(async (tx) => {
    const contact = await tx.contact.findFirst({ where: { ...scope, id: contactId }, select: { id: true } });
    if (contact === null) {
      return { status: "GONE", removed: {} };
    }
    const removed = {
      contactPoints: await tx.contactPoint.count({ where: { ...scope, contactId } }),
      externalIdentities: await tx.externalIdentity.count({ where: { ...scope, contactId } }),
      facts: await tx.customerFact.count({ where: { ...scope, contactId } }),
      preferences: await tx.customerPreference.count({ where: { ...scope, contactId } }),
      duplicateCandidates: await tx.duplicateContactCandidate.count({
        where: { ...scope, OR: [{ contactId }, { otherContactId: contactId }] },
      }),
    };
    // Each table explicitly, because none of them cascade. Conversations and messages are deliberately
    // absent: deleting a customer's record is not the same as deleting the business's own correspondence,
    // and conflating them would destroy an audit trail somebody may be legally required to keep.
    await tx.contactPoint.deleteMany({ where: { ...scope, contactId } });
    await tx.externalIdentity.deleteMany({ where: { ...scope, contactId } });
    await tx.customerFact.deleteMany({ where: { ...scope, contactId } });
    await tx.customerPreference.deleteMany({ where: { ...scope, contactId } });
    await tx.duplicateContactCandidate.deleteMany({ where: { ...scope, OR: [{ contactId }, { otherContactId: contactId }] } });
    return { status: "FORGOTTEN", removed };
  });
}

/**
 * Proposes a preference, on the same terms as a fact.
 *
 * Its own pair of functions rather than a flag on the fact ones, because the two are different kinds of
 * claim and a shared code path invites a shared table — at which point a preference can be cited as
 * evidence, which is the confusion the separate tables exist to prevent.
 */
export async function proposePreference(
  db: DbClient,
  context: BusinessProfileContext,
  input: {
    readonly contactId: string;
    readonly subject: string;
    readonly value: string;
    readonly source: MemorySource;
    readonly sourceMessageId?: string;
    readonly sourceDraftId?: string;
    readonly expiresAt?: Date;
  },
): Promise<MemoryOutcome> {
  const scope = profileScopeOf(context);
  if (input.subject.trim() === "" || input.value.trim() === "") {
    return { status: "REFUSED", reason: "a preference needs both a subject and a value" };
  }
  if (input.source === "AI_SUGGESTED" && input.sourceDraftId === undefined) {
    return { status: "REFUSED", reason: "a model's proposal must name the draft it came from" };
  }
  const contact = await db.contact.findFirst({ where: { ...scope, id: input.contactId }, select: { id: true } });
  if (contact === null) {
    return { status: "GONE" };
  }

  const created = await db.customerPreference.create({
    data: {
      ...scope,
      contactId: input.contactId,
      subject: input.subject.trim(),
      value: input.value.trim(),
      source: input.source,
      status: "SUGGESTED",
      ...(input.sourceMessageId === undefined ? {} : { sourceMessageId: input.sourceMessageId }),
      ...(input.sourceDraftId === undefined ? {} : { sourceDraftId: input.sourceDraftId }),
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    },
    select: { id: true },
  });
  return { status: "RECORDED", id: created.id };
}

/** Makes a proposed preference the business's own, superseding the one it replaces. */
export async function confirmPreference(
  db: DbClient,
  context: BusinessProfileContext,
  preferenceId: string,
  at = new Date(),
): Promise<MemoryOutcome> {
  const scope = profileScopeOf(context);

  return db.$transaction(async (tx) => {
    const preference = await tx.customerPreference.findFirst({
      where: { ...scope, id: preferenceId, status: "SUGGESTED" },
      select: { id: true, contactId: true, subject: true },
    });
    if (preference === null) {
      return { status: "GONE" };
    }
    await tx.customerPreference.updateMany({
      where: { ...scope, contactId: preference.contactId, subject: preference.subject, status: "ACTIVE" },
      data: { status: "SUPERSEDED" },
    });
    await tx.customerPreference.update({
      where: { id: preferenceId },
      data: { status: "ACTIVE", confirmedByUserId: context.userId, confirmedAt: at },
    });
    return { status: "CONFIRMED", id: preferenceId };
  });
}

/**
 * Marks entries whose own expiry has passed.
 *
 * Housekeeping, not a correctness mechanism: `readAuthoritativeMemory` already excludes an expired entry
 * whatever its stored status says, so this job being late cannot make stale memory authoritative. It
 * exists so the history a person reads matches what the reader sees.
 */
export async function expireStaleMemory(
  db: DbExecutor,
  context: BusinessProfileContext,
  at = new Date(),
): Promise<{ readonly facts: number; readonly preferences: number }> {
  const scope = profileScopeOf(context);
  const stale = { status: "ACTIVE" as const, expiresAt: { lte: at } };
  const [facts, preferences] = await Promise.all([
    db.customerFact.updateMany({ where: { ...scope, ...stale }, data: { status: "EXPIRED" } }),
    db.customerPreference.updateMany({ where: { ...scope, ...stale }, data: { status: "EXPIRED" } }),
  ]);
  return { facts: facts.count, preferences: preferences.count };
}

/** An external-system id for this customer, inside this Business Profile only. */
export async function recordExternalIdentity(
  db: DbExecutor,
  context: BusinessProfileContext,
  input: { readonly contactId: string; readonly system: string; readonly externalId: string },
): Promise<MemoryOutcome> {
  const scope = profileScopeOf(context);
  if (input.system.trim() === "" || input.externalId.trim() === "") {
    return { status: "REFUSED", reason: "an external identity needs both a system and an id" };
  }
  const contact = await db.contact.findFirst({ where: { ...scope, id: input.contactId }, select: { id: true } });
  if (contact === null) {
    return { status: "GONE" };
  }
  const created = await db.externalIdentity.upsert({
    where: {
      workspaceId_businessProfileId_system_externalId: { ...scope, system: input.system.trim(), externalId: input.externalId.trim() },
    },
    create: { ...scope, contactId: input.contactId, system: input.system.trim(), externalId: input.externalId.trim() },
    update: { contactId: input.contactId },
    select: { id: true },
  });
  return { status: "RECORDED", id: created.id };
}

/** The contact points recorded for one customer. */
export async function listContactPoints(
  db: DbExecutor,
  context: BusinessProfileContext,
  contactId: string,
): Promise<readonly ContactPointView[]> {
  const scope = profileScopeOf(context);
  const rows = await db.contactPoint.findMany({
    where: { ...scope, contactId },
    orderBy: [{ kind: "asc" }, { createdAt: "asc" }],
    select: { id: true, kind: true, rawValue: true, normalizedValue: true, verification: true, contactId: true },
  });
  return rows;
}
