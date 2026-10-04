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
  /**
   * The version customers are answered with, or `null` for a source that has never been published.
   *
   * Separate from `version` because Save and Publish are separate acts. When they differ, somebody has
   * edited a live source and not published it yet — which the library has to be able to show, or the
   * promise that Save is never a live change is kept by the database and broken by the screen.
   */
  readonly publishedVersion: number | null;
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
      publishedVersion: true,
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
  publishedVersion: number | null;
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
    publishedVersion: row.publishedVersion,
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
  /** The latest saved one. Not necessarily the one customers get. */
  readonly current: boolean;
  /** The one retrieval answers with. */
  readonly published: boolean;
  readonly chunks: readonly { readonly id: string; readonly ordinal: number; readonly content: string }[];
}

export interface KnowledgeDetail extends KnowledgeSummary {
  /** Every stored version, newest first. The published one is the only one retrieval can reach. */
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
      publishedVersion: true,
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
      .map(([version, chunks]) => ({ version, current: version === row.version, published: version === row.publishedVersion, chunks })),
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
  /** Published. `version` is what customers are now answered with. */
  | { readonly status: "RESTORED"; readonly version: number }
  | { readonly status: "INDEXED"; readonly version: number }
  /** Indexing failed. `wasActive` says whether this also took a live source out of retrieval. */
  | { readonly status: "INDEXING_FAILED"; readonly wasActive: boolean }
  /**
   * The result described a version the document has moved past, so nothing was written.
   *
   * Indexing takes seconds to minutes and an edit takes none, so this is ordinary rather than
   * exceptional. The alternative is worse than it sounds: a delayed success would certify content the
   * worker never read, and a delayed failure would archive a live source over a problem that no longer
   * exists.
   */
  | { readonly status: "STALE"; readonly indexedVersion: number; readonly currentVersion: number }
  /**
   * Somebody changed this document between the version the caller was looking at and the write.
   *
   * Returned rather than applied, and never reported as success. A publish that quietly published
   * nothing, or a save that overwrote a colleague's wording with content derived from an older version,
   * are the two failures this exists to make impossible — and both of them look exactly like success
   * from the operator's side, which is why the answer has to be a different word.
   */
  | { readonly status: "CONFLICT"; readonly expectedVersion: number; readonly currentVersion: number }
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
  input: {
    readonly title?: string;
    readonly chunks?: readonly string[];
    /**
     * The version the editor was showing when this was submitted.
     *
     * Optional only so a system caller with no screen behind it can omit it; every human edit carries it,
     * because without it two tabs opened at v1 both save and the second one wins with wording derived
     * from content it never saw. Optional or not, the write below is conditional, so two simultaneous
     * submits cannot both become the same next version.
     */
    readonly expectedVersion?: number;
  },
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

    if (input.expectedVersion !== undefined && input.expectedVersion !== document.version) {
      // A stale tab. Refusing is the whole point: the wording in that form was composed against a
      // version somebody has already replaced, and saving it would silently undo their work.
      return { status: "CONFLICT", expectedVersion: input.expectedVersion, currentVersion: document.version };
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
    // The document moves first, conditional on the version this edit was computed from, and the chunks
    // are written only if it did. Two simultaneous submits therefore cannot both become version 2: the
    // second one matches no row and stops here, instead of colliding on the chunks' unique position and
    // surfacing as a database error with nothing an operator can do about it.
    const claimed = await tx.knowledgeDocument.updateMany({
      where: { workspaceId: scope.workspaceId, id: documentId, ...scopeFilter(undefined, scope.businessProfileId), version: document.version },
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
    if (claimed.count !== 1) {
      return { status: "CONFLICT", expectedVersion: document.version, currentVersion: document.version + 1 };
    }
    // A title-only change still makes a version: the title is what an operator searches by, and a history
    // that recorded content but not naming would not explain why a source became hard to find.
    await writeChunks(tx, scope.workspaceId, documentId, version, chunks);
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
    select: { indexingState: true, version: true },
  });
  if (document === null) {
    return { status: "GONE" };
  }
  if (document.indexingState === "FAILED") {
    return { status: "REJECTED", reason: "this source failed to index and cannot be made active until it is fixed" };
  }
  const published = await db.knowledgeDocument.updateMany({
    where: { workspaceId: scope.workspaceId, id: documentId, ...scopeFilter(undefined, scope.businessProfileId), version: document.version },
    // This is the deliberate act the editor promises. It is the only write that moves
    // `publishedVersion`, so what customers are told changes here and nowhere else — and it names the
    // version it read, so a save landing in between publishes nothing by accident.
    data: { status: "ACTIVE", publishedVersion: document.version },
  });
  if (published.count !== 1) {
    // The condition did its job and nothing was written, so saying "published" would be a lie about the
    // one thing an operator came here to do. A save landed in the gap; they need to look at it and
    // publish again.
    const current = await db.knowledgeDocument.findFirst({
      where: { workspaceId: scope.workspaceId, id: documentId, ...scopeFilter(undefined, scope.businessProfileId) },
      select: { version: true },
    });
    if (current === null) {
      return { status: "GONE" };
    }
    return { status: "CONFLICT", expectedVersion: document.version, currentVersion: current.version };
  }
  return { status: "RESTORED", version: document.version };
}

/** Publishes a DRAFT, under the same rule: nothing that failed to index becomes answerable. */
export const publishKnowledge = restoreKnowledge;

/**
 * What ingestion actually managed, recorded where an operator can see it.
 *
 * A failure in the **published** version takes a live source out of retrieval in the *same* write. Doing
 * it in a second statement leaves a window in which a source known to be broken is still answering
 * customers — and the CHECK would reject the pair anyway, which is the database making the same point.
 *
 * A failure in a version nobody published does not. After publish/index v1 and Save v2, a failure to index
 * v2 is a failure of content no customer has ever seen; archiving the document would stop healthy
 * published v1 over a problem in a draft. The failure is recorded and the published version keeps
 * answering, which is the pair the CHECK now permits.
 *
 * A source that was not live keeps whatever status it had. Archiving a DRAFT that failed to index would
 * throw away the operator's own state to satisfy a rule that was never about drafts: they are not
 * answering anyone.
 */
export async function recordIndexingResult(
  db: DbClient,
  context: BusinessProfileContext,
  documentId: string,
  result:
    | { readonly ok: true; readonly at: Date; readonly version: number }
    | { readonly ok: false; readonly error: string; readonly version: number },
): Promise<KnowledgeWriteOutcome> {
  const scope = profileScopeOf(context);
  const where = { workspaceId: scope.workspaceId, id: documentId, ...scopeFilter(undefined, scope.businessProfileId) };
  // The version this result is about, in the database rather than in a prior read. Indexing is slow and
  // an edit is instant, so a result is always a statement about a version that may no longer be current.
  const versioned = { ...where, version: result.version };

  return db.$transaction(async (tx) => {
    const document = await tx.knowledgeDocument.findFirst({ where, select: { status: true, version: true, publishedVersion: true } });
    if (document === null) {
      return { status: "GONE" };
    }
    if (document.version !== result.version) {
      return { status: "STALE", indexedVersion: result.version, currentVersion: document.version };
    }
    if (result.ok) {
      const indexed = await tx.knowledgeDocument.updateMany({ where: versioned, data: { indexingState: "INDEXED", indexedAt: result.at, indexingError: null } });
      return indexed.count === 1 ? { status: "INDEXED", version: result.version } : { status: "STALE", indexedVersion: result.version, currentVersion: document.version };
    }
    // Archiving is for a failure in the version customers are being answered with. After publish/index
    // v1 and Save v2, a failure to index v2 is a failure of content nobody has ever been shown, and
    // taking the whole document out of retrieval would stop healthy published v1 over a problem in a
    // draft. The failure is still recorded, and the CHECK permits exactly this pair.
    const failingIsPublished = document.publishedVersion === null || document.publishedVersion === result.version;
    const wasActive = document.status === "ACTIVE" && failingIsPublished;
    const failed = await tx.knowledgeDocument.updateMany({
      where: versioned,
      data: {
        indexingState: "FAILED",
        indexingError: result.error,
        indexedAt: null,
        ...(wasActive ? { status: "ARCHIVED" as const } : {}),
      },
    });
    return failed.count === 1 ? { status: "INDEXING_FAILED", wasActive } : { status: "STALE", indexedVersion: result.version, currentVersion: document.version };
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
