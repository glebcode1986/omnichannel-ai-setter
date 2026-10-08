/**
 * Deleting a customer's data, and proving it happened (#57, P3-04).
 *
 * Nothing in this schema cascades — 96 of its 99 foreign keys are `RESTRICT`, and a test holds it there
 * on purpose. That is the right rule everywhere else and it is what makes this file necessary: a
 * deletion has to name every table, in an order the database will accept, and say afterwards what it
 * actually removed. A `contact.delete()` on its own fails and removes nothing.
 *
 * Three things shape the order.
 *
 * **There is a cycle in the middle of it.** `ai_drafts.anchor_message_id` is a non-null reference to
 * `messages`, while `messages.ai_draft_id` is a nullable reference back. Neither table can go first, so
 * the link is broken with an update before either is touched.
 *
 * **Derived data is the point, not an afterthought.** A reply engine that still has the transcript of a
 * voice note, the summary of a thread, the facts learned from it, or a style example quoting the
 * customer verbatim has not forgotten them — it has only stopped showing them. Those tables are deleted
 * in the same transaction as the correspondence, and `style_examples` is swept by its own scope as well
 * as by its foreign keys, because a hand-written example can quote a customer with no link back to them.
 *
 * **You cannot both forget somebody and remember not to contact them.** `followup_suppressions` records
 * that somebody asked never to be messaged again, and honouring that means keeping enough to recognise
 * them. So a contact with a standing opt-out is *anonymised* rather than deleted: the correspondence,
 * the derived data, the names, the phone numbers and the addresses all go, and what remains is the
 * contact row, the provider's own id for them, and the opt-out itself. That is the minimum that keeps
 * the promise they actually made, and the request records which of the two happened.
 *
 * The provider's own copy of any media is deleted *before* the rows that name it, because the media id
 * is the only handle on it. The caller supplies that port; without one the step is recorded as a failure
 * rather than skipped silently.
 */
import type { DeletionScopeValue } from "@omnichannel/domain";

import { recordSystemAuditEvent } from "./audit-store";
import type { DbClient, DbExecutor } from "./client";
import { profileScopeOf, requireRole, scopeOf, WORKSPACE_ADMIN_ROLES, type BusinessProfileContext, type WorkspaceContext } from "./tenancy";

/** Rows removed, per table. "We deleted your data" is a claim that should be countable. */
export type RemovalCounts = Readonly<Record<string, number>>;

/** A step that did not finish, named by a fixed code. Never a provider's prose. */
export interface DeletionFailure {
  readonly step: string;
  readonly reason: string;
}

export interface DeletionRequestRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly businessProfileId: string | undefined;
  readonly scope: DeletionScopeValue;
  readonly targetId: string | undefined;
  readonly state: "REQUESTED" | "PROCESSING" | "COMPLETED" | "PARTIAL_FAILURE";
  readonly removed: RemovalCounts;
  readonly failures: readonly DeletionFailure[];
  readonly requestedAt: Date;
  readonly completedAt: Date | undefined;
}

/**
 * Asks the provider to forget its own copy of a recording.
 *
 * Supplied by the caller because reaching a provider needs credentials this package does not hold. A
 * deployment with no port cannot honour the provider half of a deletion request, and that is recorded as
 * a failure — a `COMPLETED` deletion that left a customer's voice note on Meta's servers would be a lie.
 */
export interface ProviderMediaPort {
  delete(input: {
    readonly workspaceId: string;
    readonly businessProfileId: string;
    readonly channelAccountId: string;
    readonly providerMediaId: string;
  }): Promise<boolean>;
}

export interface RequestDeletionInput {
  readonly scope: DeletionScopeValue;
  readonly targetId?: string;
  readonly reason?: string;
}

/**
 * Records that somebody asked, before anything is removed.
 *
 * Deliberately separate from executing it. The request is the durable promise; the execution is work
 * that can crash, and a crash must leave the promise visible rather than take it down too.
 *
 * Admin or owner only. A deletion is irreversible and workspace-wide in its consequences even when its
 * scope is one person, so it is not something an agent handling conversations can trigger.
 */
export async function requestDeletion(
  db: DbClient,
  context: WorkspaceContext,
  input: RequestDeletionInput,
  /**
   * When it was asked for.
   *
   * Taken from the caller rather than from the column default, so that one run's whole timeline comes from
   * one clock. The lifecycle CHECK requires `started_at >= requested_at`, and a request stamped by the
   * database while the execution is stamped by an injected clock is two clocks that can disagree — which
   * made a suite pass or fail depending on the hour it ran at.
   */
  at = new Date(),
): Promise<DeletionRequestRecord> {
  requireRole(context, WORKSPACE_ADMIN_ROLES, "request a deletion");
  const workspaceId = scopeOf(context);
  const row = await db.deletionRequest.create({
    data: {
      workspaceId,
      scope: input.scope,
      ...(input.targetId === undefined ? {} : { targetId: input.targetId }),
      ...(input.reason === undefined || input.reason.trim() === "" ? {} : { reason: input.reason.trim() }),
      requestedByUserId: context.userId,
      requestedAt: at,
    },
  });
  await auditRequest(db, row, context.userId);
  return toRecord(row);
}

/**
 * Records a request scoped to one Business Profile's customer, from a profile-scoped caller.
 *
 * The same row, reached from the context a conversation screen already holds. The scope columns come
 * from the authorized context rather than from the caller's arguments, so a profile a member may not see
 * cannot be named in a request they can make.
 */
export async function requestProfileDeletion(
  db: DbClient,
  context: BusinessProfileContext,
  input: { readonly scope: Extract<DeletionScopeValue, "CONTACT" | "CONVERSATION" | "BUSINESS_PROFILE">; readonly targetId?: string; readonly reason?: string },
  /** As above: one run, one clock. */
  at = new Date(),
): Promise<DeletionRequestRecord> {
  requireRole(context, WORKSPACE_ADMIN_ROLES, "request a deletion");
  const scope = profileScopeOf(context);
  const row = await db.deletionRequest.create({
    data: {
      ...scope,
      scope: input.scope,
      ...(input.targetId === undefined ? {} : { targetId: input.targetId }),
      ...(input.reason === undefined || input.reason.trim() === "" ? {} : { reason: input.reason.trim() }),
      requestedByUserId: context.userId,
      requestedAt: at,
    },
  });
  await auditRequest(db, row, context.userId);
  return toRecord(row);
}

export interface ExecuteDeletionOptions {
  /** Absent means the provider half cannot be honoured, which is recorded rather than skipped. */
  readonly media?: ProviderMediaPort;
  readonly now: () => Date;
}

/**
 * Carries out one recorded request.
 *
 * Claims the row first, conditionally on it still being `REQUESTED`, so two runners cannot both delete
 * the same thing and disagree about what they removed. Everything after the claim happens in one
 * transaction: a deletion that removed the messages but not the transcripts is worse than one that
 * removed nothing, because the second can be retried and the first cannot be understood.
 */
export async function executeDeletion(db: DbClient, requestId: string, options: ExecuteDeletionOptions): Promise<DeletionRequestRecord> {
  const at = options.now();
  const claimed = await db.deletionRequest.updateMany({
    where: { id: requestId, state: "REQUESTED" },
    data: { state: "PROCESSING", startedAt: at },
  });
  const row = await db.deletionRequest.findUniqueOrThrow({ where: { id: requestId } });
  if (claimed.count !== 1) {
    // Another runner owns it, or it already finished. Either way not ours to carry out.
    return toRecord(row);
  }

  const failures: DeletionFailure[] = [];
  // Before the rows that name it: the provider media id is the only handle on the provider's copy, and
  // deleting the row first would leave that copy unreachable for ever.
  const removed = await forgetProviderMedia(db, row, options.media, failures);

  try {
    const counts = await db.$transaction(async (tx) => purge(tx, row));
    for (const [table, count] of Object.entries(counts)) {
      removed[table] = (removed[table] ?? 0) + count;
    }
  } catch (error) {
    failures.push({ step: "DATABASE", reason: error instanceof Error ? error.name : "UNKNOWN" });
  }

  const finished = options.now();
  await recordSystemAuditEvent(
    db,
    { workspaceId: row.workspaceId, ...(row.businessProfileId === null ? {} : { businessProfileId: row.businessProfileId }) },
    {
      kind: "DELETION_COMPLETED",
      summary: `Deletion ${failures.length === 0 ? "completed" : "partially failed"} for ${row.scope.toLowerCase()} ${row.targetId ?? row.workspaceId}`,
      subjectType: "DeletionRequest",
      subjectId: row.id,
      // The person who asked, not the process that ran: a deletion is always somebody's decision.
      actorUserId: row.requestedByUserId,
      occurredAt: finished,
      // Counts and reason codes. Never what was in the rows — an audit of a deletion that quoted the
      // data would be the one copy of it nobody asked to keep.
      detail: { removed, failures },
    },
  );
  const updated = await db.deletionRequest.update({
    where: { id: requestId },
    data: {
      state: failures.length === 0 ? "COMPLETED" : "PARTIAL_FAILURE",
      removed,
      // Spread into plain objects: the JSON column takes a value, not a typed array.
      failures: failures.map((failure) => ({ step: failure.step, reason: failure.reason })),
      completedAt: finished,
    },
  });
  return toRecord(updated);
}

/** The requests an operator can look at, newest first. Scoped, like every other read. */
export async function listDeletionRequests(db: DbClient, context: WorkspaceContext, limit = 50): Promise<readonly DeletionRequestRecord[]> {
  const workspaceId = scopeOf(context);
  const rows = await db.deletionRequest.findMany({
    where: { workspaceId },
    orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
    take: Math.min(Math.max(limit, 1), 200),
  });
  return rows.map(toRecord);
}

/**
 * Asks the provider to forget every recording inside the request's scope.
 *
 * Best effort per recording, and honest about it: a recording the provider refused to delete is a named
 * failure, which makes the whole request `PARTIAL_FAILURE`. A deployment with no port at all is one
 * failure rather than one per recording, because the fact to report is the configuration.
 */
async function forgetProviderMedia(
  db: DbClient,
  row: { workspaceId: string; businessProfileId: string | null; scope: string; targetId: string | null },
  media: ProviderMediaPort | undefined,
  failures: DeletionFailure[],
): Promise<Record<string, number>> {
  const transcripts = await db.messageTranscript.findMany({
    where: { workspaceId: row.workspaceId, ...messageFilter(row), mediaDeletedAt: null },
    select: { id: true, businessProfileId: true, providerMediaId: true, message: { select: { channelAccountId: true } } },
  });
  if (transcripts.length === 0) {
    return {};
  }
  if (media === undefined) {
    failures.push({ step: "PROVIDER_MEDIA", reason: "NO_MEDIA_PORT" });
    return {};
  }
  let deleted = 0;
  for (const transcript of transcripts) {
    const ok = await media.delete({
      workspaceId: row.workspaceId,
      businessProfileId: transcript.businessProfileId,
      channelAccountId: transcript.message.channelAccountId,
      providerMediaId: transcript.providerMediaId,
    });
    if (ok) {
      deleted += 1;
      continue;
    }
    failures.push({ step: "PROVIDER_MEDIA", reason: "PROVIDER_REFUSED" });
  }
  return { providerMedia: deleted };
}

/** Which messages a request covers, as a `where` fragment the transcript and message queries share. */
function messageFilter(row: { businessProfileId: string | null; scope: string; targetId: string | null }): Record<string, unknown> {
  if (row.scope === "CONVERSATION") {
    return { businessProfileId: row.businessProfileId, message: { conversationId: row.targetId } };
  }
  if (row.scope === "CONTACT") {
    return { businessProfileId: row.businessProfileId, message: { conversation: { contactId: row.targetId } } };
  }
  if (row.scope === "BUSINESS_PROFILE") {
    return { businessProfileId: row.businessProfileId };
  }
  return {};
}

/**
 * Everything the request covers, in an order the database will accept.
 *
 * The order is not a preference. Ninety-six of this schema's foreign keys are `RESTRICT`, so a child
 * that still points at a row prevents that row from going — and the sequence below is the only one that
 * leaves nothing pointing at anything. Step 0 is the exception that proves it: `ai_drafts` and
 * `messages` reference each other, so the nullable side is cleared before either is deleted.
 *
 * Every step is counted, including the ones that remove nothing, because a count of zero is evidence
 * that the step ran rather than that it was forgotten.
 */
async function purge(tx: DbExecutor, row: { workspaceId: string; businessProfileId: string | null; scope: string; targetId: string | null }): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const count = async (table: string, run: Promise<{ count: number }>): Promise<void> => {
    counts[table] = (counts[table] ?? 0) + (await run).count;
  };

  // Says, for this transaction only, that what follows is a customer erasure.
  //
  // `style_example_decisions` is append-only — a style example's lifecycle is evidence about who approved
  // and who withdrew it — and its trigger refuses a `DELETE` unless a session has declared this. Without
  // the declaration the `DELETE` below was refused, this whole transaction aborted, and every deletion
  // request ended `PARTIAL_FAILURE`: a privacy deletion that silently removed nothing.
  //
  // `SET LOCAL` rather than `SET`, and set here rather than by the caller, so the permission lives for
  // exactly the transaction that does the work and cannot be left switched on. `UPDATE` on that table
  // stays refused either way: an erasure removes rows, it never rewrites a verdict.
  await tx.$executeRaw`SET LOCAL "omnichannel.erasing_customer_data" = 'on'`;

  const conversations = await tx.conversation.findMany({ where: conversationFilter(row), select: { id: true, contactId: true } });
  const conversationIds = conversations.map((conversation) => conversation.id);
  const contactIds =
    row.scope === "CONTACT" && row.targetId !== null
      ? [row.targetId]
      : [...new Set(conversations.map((conversation) => conversation.contactId))];
  const messages = await tx.message.findMany({ where: { conversationId: { in: conversationIds } }, select: { id: true } });
  const messageIds = messages.map((message) => message.id);
  const drafts = await tx.aiDraft.findMany({ where: { conversationId: { in: conversationIds } }, select: { id: true } });
  const draftIds = drafts.map((draft) => draft.id);

  // Step 0 — break the `messages` ⇄ `ai_drafts` cycle. Neither side can be deleted while the other
  // points at it, and only this one is nullable.
  counts["messagesUnlinked"] = (await tx.message.updateMany({ where: { id: { in: messageIds } }, data: { aiDraftId: null } })).count;

  // Which contacts must survive as tombstones. An opt-out is a promise that needs an identity to keep:
  // deleting the person it names would leave the business free to message them again tomorrow.
  const suppressed = new Set(
    (
      await tx.followUpSuppression.findMany({
        where: { contactId: { in: contactIds }, liftedAt: null },
        select: { contactId: true },
      })
    ).map((row) => row.contactId),
  );
  // The opt-out keeps the contact, not the conversation that produced it.
  counts["suppressionsDetached"] = (
    await tx.followUpSuppression.updateMany({ where: { contactId: { in: contactIds } }, data: { sourceMessageId: null } })
  ).count;

  const deliveries = await tx.deliveryJobRecord.findMany({
    where: { OR: [{ conversationId: { in: conversationIds } }, { draftId: { in: draftIds } }] },
    select: { operationId: true },
  });
  const operationIds = deliveries.map((delivery) => delivery.operationId);

  // Operational rows that name the conversation without a foreign key to it. They would survive as
  // dangling ids, and a queued job naming a deleted conversation wakes up and fails.
  await count("reconciliations", tx.deliveryReconciliation.deleteMany({ where: { operationId: { in: operationIds } } }));
  await count("followUps", tx.followUp.deleteMany({ where: { conversationId: { in: conversationIds } } }));
  await count("humanTasks", tx.humanTask.deleteMany({ where: { conversationId: { in: conversationIds } } }));
  await count("goals", tx.conversationGoal.deleteMany({ where: { conversationId: { in: conversationIds } } }));

  // Derived AI data. This is the half that makes a deletion a deletion rather than a hiding: a reply
  // engine still holding the transcript, the summary or the facts has not forgotten anybody.
  await count("transcripts", tx.messageTranscript.deleteMany({ where: { messageId: { in: messageIds } } }));
  await count("summaries", tx.conversationSummary.deleteMany({ where: { conversationId: { in: conversationIds } } }));
  // Scoped to what this request actually covers. A fact belongs to the person, not to the thread it was
  // learned in, so deleting one conversation removes only what came *out of* it — while deleting the
  // person removes everything, whichever conversation taught it.
  const memoryFilter =
    row.scope === "CONVERSATION"
      ? { OR: [{ sourceMessageId: { in: messageIds } }, { sourceDraftId: { in: draftIds } }] }
      : { contactId: { in: contactIds } };
  await count("facts", tx.customerFact.deleteMany({ where: memoryFilter }));
  await count("preferences", tx.customerPreference.deleteMany({ where: memoryFilter }));
  // By source *and* by the contact's own conversations: a hand-written example carries no source id, so
  // the foreign key alone would leave a customer's words, and their embedding, on disk.
  const styleFilter = { OR: [{ sourceMessageId: { in: messageIds } }, { sourceDraftId: { in: draftIds } }] };
  // Its lifecycle first. The decision rows reference the example with ON DELETE RESTRICT, so without this
  // the delete below is refused outright — and the trail would in any case be pointing at an example
  // nobody can see. What the rows record is operator activity rather than customer data, but they only
  // exist to explain one example, and that example is going.
  const styleExampleIds = (await tx.styleExample.findMany({ where: styleFilter, select: { id: true } })).map((example) => example.id);
  await count("styleDecisions", tx.styleExampleDecision.deleteMany({ where: { styleExampleId: { in: styleExampleIds } } }));
  await count("styleExamples", tx.styleExample.deleteMany({ where: styleFilter }));
  await count("qualificationAnswers", tx.leadQualificationAnswer.deleteMany({ where: { conversationId: { in: conversationIds } } }));
  await count("stageTransitions", tx.leadStageTransition.deleteMany({ where: { conversationId: { in: conversationIds } } }));
  await count("deliveries", tx.deliveryJobRecord.deleteMany({ where: { operationId: { in: operationIds } } }));
  await count("drafts", tx.aiDraft.deleteMany({ where: { id: { in: draftIds } } }));
  await count("messages", tx.message.deleteMany({ where: { id: { in: messageIds } } }));
  await count("conversations", tx.conversation.deleteMany({ where: { id: { in: conversationIds } } }));

  if (row.scope === "CONVERSATION") {
    // The contact survives, and so does everything learned from their other threads.
    return counts;
  }

  await count("contactPoints", tx.contactPoint.deleteMany({ where: { contactId: { in: contactIds } } }));
  await count("externalIdentities", tx.externalIdentity.deleteMany({ where: { contactId: { in: contactIds } } }));
  await count(
    "duplicateCandidates",
    tx.duplicateContactCandidate.deleteMany({ where: { OR: [{ contactId: { in: contactIds } }, { otherContactId: { in: contactIds } }] } }),
  );

  const removable = contactIds.filter((contactId) => !suppressed.has(contactId));
  const tombstones = contactIds.filter((contactId) => suppressed.has(contactId));
  await count("channelIdentities", tx.channelIdentity.deleteMany({ where: { contactId: { in: removable } } }));
  await count("contacts", tx.contact.deleteMany({ where: { id: { in: removable } } }));

  if (tombstones.length > 0) {
    // What a tombstone keeps is deliberately the least that still recognises them: the provider's own id
    // for the person, and nothing a human would read as their identity.
    counts["contactsAnonymised"] = (
      await tx.contact.updateMany({ where: { id: { in: tombstones } }, data: { displayName: null } })
    ).count;
    counts["identitiesAnonymised"] = (
      await tx.channelIdentity.updateMany({ where: { contactId: { in: tombstones } }, data: { displayName: null, username: null, metadata: {} } })
    ).count;
  }
  return counts;
}

/** Which conversations a request covers. Scope-leading, so a target alone can never widen it. */
function conversationFilter(row: { workspaceId: string; businessProfileId: string | null; scope: string; targetId: string | null }): Record<string, unknown> {
  const base = { workspaceId: row.workspaceId, ...(row.businessProfileId === null ? {} : { businessProfileId: row.businessProfileId }) };
  if (row.scope === "CONVERSATION") {
    return { ...base, id: row.targetId };
  }
  if (row.scope === "CONTACT") {
    return { ...base, contactId: row.targetId };
  }
  return base;
}

function toRecord(row: {
  id: string;
  workspaceId: string;
  businessProfileId: string | null;
  scope: string;
  targetId: string | null;
  state: string;
  removed: unknown;
  failures: unknown;
  requestedAt: Date;
  completedAt: Date | null;
}): DeletionRequestRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    businessProfileId: row.businessProfileId ?? undefined,
    scope: row.scope as DeletionScopeValue,
    targetId: row.targetId ?? undefined,
    state: row.state as DeletionRequestRecord["state"],
    removed: (typeof row.removed === "object" && row.removed !== null ? row.removed : {}) as RemovalCounts,
    failures: (Array.isArray(row.failures) ? row.failures : []) as readonly DeletionFailure[],
    requestedAt: row.requestedAt,
    completedAt: row.completedAt ?? undefined,
  };
}

/** The request-time audit row. Written with the request, so asking is itself on the record. */
async function auditRequest(
  db: DbClient,
  row: { id: string; workspaceId: string; businessProfileId: string | null; scope: string; targetId: string | null },
  actorUserId: string,
): Promise<void> {
  await recordSystemAuditEvent(
    db,
    { workspaceId: row.workspaceId, ...(row.businessProfileId === null ? {} : { businessProfileId: row.businessProfileId }) },
    {
      kind: "DELETION_REQUESTED",
      summary: `Deletion requested for ${row.scope.toLowerCase()} ${row.targetId ?? row.workspaceId}`,
      subjectType: "DeletionRequest",
      subjectId: row.id,
      actorUserId,
      detail: { scope: row.scope },
    },
  );
}
