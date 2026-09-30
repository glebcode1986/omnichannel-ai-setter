/**
 * The Knowledge Library's reads and writes (KNOWLEDGE_STYLE_UX.md, RETRIEVAL.md, ADR-011, Issue #31).
 *
 * Facts are *stated*, never learned. Nothing in this file can be reached from a message, a draft or a
 * style example: a knowledge document is created by a person who typed or pasted it, and the separation
 * is structural rather than a matter of care — there is no call here that takes a conversation.
 *
 * **Editing creates a version; it never overwrites one.** A document row carries the current version
 * number and the chunks carry theirs, so an edit writes a new set of chunks at `version + 1` and leaves
 * the old set in place. Retrieval already joins `chunk.document_version = document.version`, which is what
 * makes a superseded fact unreachable the instant the new version lands — and what makes last month's
 * prices auditable rather than gone.
 *
 * **A failed ingestion cannot look active.** The database refuses it: a CHECK forbids the combination, so
 * the invariant holds against this store, a migration, a console and anything written later.
 */
import { createHash } from "node:crypto";

import type { DbClient, DbExecutor } from "./client";
import { profileScopeOf, type BusinessProfileContext } from "./tenancy";

const DEFAULT_PAGE = 25;
const MAX_PAGE = 100;

export type KnowledgeScope = "WORKSPACE" | "BUSINESS_PROFILE";

export interface KnowledgeSummary {
  readonly id: string;
  readonly title: string;
  readonly sourceType: string;
  readonly sourceUri: string | null;
  readonly version: number;
  readonly status: string;
  /**
   * Whose knowledge this is. `WORKSPACE` is base knowledge every profile sees; `BUSINESS_PROFILE` belongs
   * to this profile alone. The distinction is what makes an agency's shared facts shareable.
   */
  readonly scope: KnowledgeScope;
  readonly indexingState: string;
  readonly indexingError: string | null;
  readonly indexedAt: Date | null;
  readonly chunkCount: number;
  readonly createdByName: string | null;
  readonly updatedAt: Date;
}

export interface KnowledgeFilter {
  readonly status?: "DRAFT" | "ACTIVE" | "ARCHIVED";
  readonly scope?: KnowledgeScope;
  readonly indexingState?: "PENDING" | "INDEXED" | "FAILED";
  /** Matches the title. Never chunk content: see the note on `searchTitles` below. */
  readonly search?: string;
}

export interface KnowledgeCursor {
  readonly updatedAt: Date;
  readonly id: string;
}

export interface KnowledgeLibraryPage {
  readonly documents: readonly KnowledgeSummary[];
  readonly nextCursor?: KnowledgeCursor;
}

/**
 * The library list.
 *
 * Search matches the title only. Matching chunk content would be a second retrieval implementation with
 * none of retrieval's scoping or ranking, and an operator who searched the library and found nothing
 * would reasonably conclude the fact is missing — when what happened is that a different matcher looked.
 * Finding *facts* is what the retrieval tester is for, and it uses the real retriever.
 */
export async function listKnowledge(
  db: DbExecutor,
  context: BusinessProfileContext,
  filter: KnowledgeFilter = {},
  page: { readonly limit?: number; readonly cursor?: KnowledgeCursor } = {},
): Promise<KnowledgeLibraryPage> {
  const scope = profileScopeOf(context);
  const limit = Math.min(Math.max(Math.trunc(page.limit ?? DEFAULT_PAGE), 1), MAX_PAGE);

  const rows = await db.knowledgeDocument.findMany({
    where: {
      workspaceId: scope.workspaceId,
      // Base knowledge (no profile) and this profile's own. Never another profile's, which is the whole
      // of tenancy here: `businessProfileId: null` is shared on purpose, anything else is not ours.
      ...scopeFilter(filter.scope, scope.businessProfileId),
      ...(filter.status === undefined ? {} : { status: filter.status }),
      ...(filter.indexingState === undefined ? {} : { indexingState: filter.indexingState }),
      ...(filter.search === undefined || filter.search.trim() === ""
        ? {}
        : { title: { contains: filter.search.trim(), mode: "insensitive" as const } }),
      ...(page.cursor === undefined
        ? {}
        : {
            OR: [
              { updatedAt: { lt: page.cursor.updatedAt } },
              { updatedAt: page.cursor.updatedAt, id: { lt: page.cursor.id } },
            ],
          }),
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: {
      id: true,
      title: true,
      sourceType: true,
      sourceUri: true,
      version: true,
      status: true,
      businessProfileId: true,
      indexingState: true,
      indexingError: true,
      indexedAt: true,
      updatedAt: true,
      createdByUser: { select: { name: true } },
      _count: { select: { chunks: true } },
    },
  });

  const window = rows.slice(0, limit);
  const last = window.at(-1);
  return {
    documents: window.map(toSummary),
    ...(rows.length > limit && last !== undefined ? { nextCursor: { updatedAt: last.updatedAt, id: last.id } } : {}),
  };
}

function scopeFilter(wanted: KnowledgeScope | undefined, businessProfileId: string) {
  if (wanted === "WORKSPACE") {
    return { businessProfileId: null };
  }
  if (wanted === "BUSINESS_PROFILE") {
    return { businessProfileId };
  }
  return { OR: [{ businessProfileId: null }, { businessProfileId }] };
}

type LibraryRow = {
  id: string;
  title: string;
  sourceType: string;
  sourceUri: string | null;
  version: number;
  status: string;
  businessProfileId: string | null;
  indexingState: string;
  indexingError: string | null;
  indexedAt: Date | null;
  updatedAt: Date;
  createdByUser: { name: string | null } | null;
  _count: { chunks: number };
};

function toSummary(row: LibraryRow): KnowledgeSummary {
  return {
    id: row.id,
    title: row.title,
    sourceType: row.sourceType,
    sourceUri: row.sourceUri,
    version: row.version,
    status: row.status,
    scope: row.businessProfileId === null ? "WORKSPACE" : "BUSINESS_PROFILE",
    indexingState: row.indexingState,
    indexingError: row.indexingError,
    indexedAt: row.indexedAt,
    chunkCount: row._count.chunks,
    createdByName: row.createdByUser?.name ?? null,
    updatedAt: row.updatedAt,
  };
}

/** One stored version's content, for the history a reviewer reads. */
export interface KnowledgeVersion {
  readonly version: number;
  readonly current: boolean;
  readonly chunks: readonly { readonly id: string; readonly ordinal: number; readonly content: string }[];
}

export interface KnowledgeDetail extends KnowledgeSummary {
  /** Every stored version, newest first. The current one is the only one retrieval can reach. */
  readonly versions: readonly KnowledgeVersion[];
}

/** `undefined` for a document that is not this profile's to read. */
export async function readKnowledge(
  db: DbExecutor,
  context: BusinessProfileContext,
  documentId: string,
): Promise<KnowledgeDetail | undefined> {
  const scope = profileScopeOf(context);
  const row = await db.knowledgeDocument.findFirst({
    where: { workspaceId: scope.workspaceId, id: documentId, ...scopeFilter(undefined, scope.businessProfileId) },
    select: {
      id: true,
      title: true,
      sourceType: true,
      sourceUri: true,
      version: true,
      status: true,
      businessProfileId: true,
      indexingState: true,
      indexingError: true,
      indexedAt: true,
      updatedAt: true,
      createdByUser: { select: { name: true } },
      _count: { select: { chunks: true } },
      chunks: { orderBy: [{ documentVersion: "desc" }, { ordinal: "asc" }], select: { id: true, documentVersion: true, ordinal: true, content: true } },
    },
  });
  if (row === null) {
    return undefined;
  }

  const byVersion = new Map<number, { id: string; ordinal: number; content: string }[]>();
  for (const chunk of row.chunks) {
    const bucket = byVersion.get(chunk.documentVersion) ?? [];
    bucket.push({ id: chunk.id, ordinal: chunk.ordinal, content: chunk.content });
    byVersion.set(chunk.documentVersion, bucket);
  }

  return {
    ...toSummary(row),
    versions: [...byVersion.entries()]
      .sort(([left], [right]) => right - left)
      .map(([version, chunks]) => ({ version, current: version === row.version, chunks })),
  };
}

export interface NewKnowledge {
  readonly title: string;
  /** One chunk per fact or FAQ answer. Splitting is the caller's decision, not a hidden one. */
  readonly chunks: readonly string[];
  readonly sourceType?: "MANUAL" | "FILE" | "URL";
  readonly sourceUri?: string;
  /** `WORKSPACE` creates base knowledge every profile sees. Defaults to this profile alone. */
  readonly scope?: KnowledgeScope;
}

export type KnowledgeWriteOutcome =
  | { readonly status: "CREATED"; readonly documentId: string; readonly version: number }
  | { readonly status: "VERSIONED"; readonly documentId: string; readonly version: number }
  | { readonly status: "UNCHANGED"; readonly documentId: string; readonly version: number }
  | { readonly status: "ARCHIVED" }
  | { readonly status: "RESTORED" }
  | { readonly status: "INDEXED" }
  /** Indexing failed. `wasActive` says whether this also took a live source out of retrieval. */
  | { readonly status: "INDEXING_FAILED"; readonly wasActive: boolean }
  | { readonly status: "GONE" }
  | { readonly status: "REJECTED"; readonly reason: string };

/**
 * A new document, as a DRAFT.
 *
 * DRAFT rather than ACTIVE because retrieval reads ACTIVE documents, and a source that became answerable
 * the instant it was typed would put half-written facts in front of customers. Publishing is a separate,
 * deliberate act.
 */
export async function createKnowledge(
  db: DbClient,
  context: BusinessProfileContext,
  input: NewKnowledge,
): Promise<KnowledgeWriteOutcome> {
  const scope = profileScopeOf(context);
  const chunks = input.chunks.map((content) => content.trim()).filter((content) => content !== "");
  if (input.title.trim() === "") {
    return { status: "REJECTED", reason: "a knowledge source needs a title" };
  }
  if (chunks.length === 0) {
    // An empty source is not a source. Storing one would show an operator a document the assistant can
    // never cite, with nothing on screen to explain why.
    return { status: "REJECTED", reason: "a knowledge source needs at least one fact" };
  }

  const document = await db.knowledgeDocument.create({
    data: {
      workspaceId: scope.workspaceId,
      businessProfileId: input.scope === "WORKSPACE" ? null : scope.businessProfileId,
      title: input.title.trim(),
      sourceType: input.sourceType ?? "MANUAL",
      ...(input.sourceUri === undefined ? {} : { sourceUri: input.sourceUri }),
      version: 1,
      status: "DRAFT",
      contentHash: hashOf(chunks),
      createdByUserId: context.userId,
    },
    select: { id: true },
  });
  await writeChunks(db, scope.workspaceId, document.id, 1, chunks);

  return { status: "CREATED", documentId: document.id, version: 1 };
}

/**
 * An edit, as a new version.
 *
 * Identical content is not an edit: it returns `UNCHANGED` rather than creating a version that differs
 * from its predecessor in nothing but its number. A history where every save is a version is a history
 * nobody reads.
 */
export async function editKnowledge(
  db: DbClient,
  context: BusinessProfileContext,
  documentId: string,
  input: { readonly title?: string; readonly chunks?: readonly string[] },
): Promise<KnowledgeWriteOutcome> {
  const scope = profileScopeOf(context);

  return db.$transaction(async (tx) => {
    const document = await tx.knowledgeDocument.findFirst({
      where: { workspaceId: scope.workspaceId, id: documentId, ...scopeFilter(undefined, scope.businessProfileId) },
      select: { id: true, version: true, title: true, contentHash: true, status: true },
    });
    if (document === null) {
      return { status: "GONE" };
    }

    const title = input.title === undefined ? document.title : input.title.trim();
    if (title === "") {
      return { status: "REJECTED", reason: "a knowledge source needs a title" };
    }

    const current = await tx.knowledgeChunk.findMany({
      where: { workspaceId: scope.workspaceId, documentId, documentVersion: document.version },
      orderBy: { ordinal: "asc" },
      select: { content: true },
    });
    const chunks = (input.chunks ?? current.map((chunk) => chunk.content)).map((content) => content.trim()).filter((content) => content !== "");
    if (chunks.length === 0) {
      return { status: "REJECTED", reason: "a knowledge source needs at least one fact" };
    }

    const hash = hashOf(chunks);
    if (hash === document.contentHash && title === document.title) {
      return { status: "UNCHANGED", documentId, version: document.version };
    }

    const version = document.version + 1;
    // A title-only change still makes a version: the title is what an operator searches by, and a history
    // that recorded content but not naming would not explain why a source became hard to find.
    await writeChunks(tx, scope.workspaceId, documentId, version, chunks);
    await tx.knowledgeDocument.update({
      where: { workspaceId_id: { workspaceId: scope.workspaceId, id: documentId } },
      data: {
        title,
        version,
        contentHash: hash,
        // New content has not been indexed yet, whatever the previous version managed. Saying otherwise
        // would show a green source whose current wording nothing has ever read.
        indexingState: "PENDING",
        indexingError: null,
        indexedAt: null,
      },
    });
    return { status: "VERSIONED", documentId, version };
  });
}

/** Out of retrieval immediately: the query filters on ACTIVE, so this is the stop button for one source. */
export async function archiveKnowledge(db: DbExecutor, context: BusinessProfileContext, documentId: string): Promise<KnowledgeWriteOutcome> {
  const scope = profileScopeOf(context);
  const changed = await db.knowledgeDocument.updateMany({
    where: { workspaceId: scope.workspaceId, id: documentId, ...scopeFilter(undefined, scope.businessProfileId) },
    data: { status: "ARCHIVED" },
  });
  return changed.count === 0 ? { status: "GONE" } : { status: "ARCHIVED" };
}

/**
 * Back into retrieval — but only if it is actually searchable.
 *
 * A document that failed to index cannot be restored to ACTIVE; the database refuses the combination and
 * this refuses it with a sentence first. Restoring it as DRAFT would silently do something other than what
 * was asked, so the answer is a refusal and the fix is to re-index it.
 */
export async function restoreKnowledge(db: DbExecutor, context: BusinessProfileContext, documentId: string): Promise<KnowledgeWriteOutcome> {
  const scope = profileScopeOf(context);
  const document = await db.knowledgeDocument.findFirst({
    where: { workspaceId: scope.workspaceId, id: documentId, ...scopeFilter(undefined, scope.businessProfileId) },
    select: { indexingState: true },
  });
  if (document === null) {
    return { status: "GONE" };
  }
  if (document.indexingState === "FAILED") {
    return { status: "REJECTED", reason: "this source failed to index and cannot be made active until it is fixed" };
  }
  await db.knowledgeDocument.updateMany({
    where: { workspaceId: scope.workspaceId, id: documentId, ...scopeFilter(undefined, scope.businessProfileId) },
    data: { status: "ACTIVE" },
  });
  return { status: "RESTORED" };
}

/** Publishes a DRAFT, under the same rule: nothing that failed to index becomes answerable. */
export const publishKnowledge = restoreKnowledge;

/**
 * What ingestion actually managed, recorded where an operator can see it.
 *
 * A failure takes a live source out of retrieval in the *same* write. Doing it in a second statement
 * leaves a window in which a source known to be broken is still answering customers — and the CHECK would
 * reject the pair anyway, which is the database making the same point.
 *
 * A source that was not live keeps whatever status it had. Archiving a DRAFT that failed to index would
 * throw away the operator's own state to satisfy a rule that was never about drafts: they are not
 * answering anyone.
 */
export async function recordIndexingResult(
  db: DbClient,
  context: BusinessProfileContext,
  documentId: string,
  result: { readonly ok: true; readonly at: Date } | { readonly ok: false; readonly error: string },
): Promise<KnowledgeWriteOutcome> {
  const scope = profileScopeOf(context);
  const where = { workspaceId: scope.workspaceId, id: documentId, ...scopeFilter(undefined, scope.businessProfileId) };

  return db.$transaction(async (tx) => {
    const document = await tx.knowledgeDocument.findFirst({ where, select: { status: true } });
    if (document === null) {
      return { status: "GONE" };
    }
    if (result.ok) {
      await tx.knowledgeDocument.updateMany({ where, data: { indexingState: "INDEXED", indexedAt: result.at, indexingError: null } });
      return { status: "INDEXED" };
    }
    const wasActive = document.status === "ACTIVE";
    await tx.knowledgeDocument.updateMany({
      where,
      data: {
        indexingState: "FAILED",
        indexingError: result.error,
        indexedAt: null,
        ...(wasActive ? { status: "ARCHIVED" as const } : {}),
      },
    });
    return { status: "INDEXING_FAILED", wasActive };
  });
}

async function writeChunks(db: DbExecutor, workspaceId: string, documentId: string, version: number, chunks: readonly string[]): Promise<void> {
  await db.knowledgeChunk.createMany({
    data: chunks.map((content, ordinal) => ({ workspaceId, documentId, documentVersion: version, ordinal, content })),
  });
}

/** Content identity, so an edit that changed nothing can be recognised as one. */
function hashOf(chunks: readonly string[]): string {
  const hash = createHash("sha256");
  for (const chunk of chunks) {
    hash.update(chunk);
    hash.update("\u0000");
  }
  return hash.digest("hex");
}
