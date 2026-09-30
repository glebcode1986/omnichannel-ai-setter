/**
 * Seeding for retrieval tests. Chunks and style examples are written with raw SQL because the vector column
 * is `Unsupported` in the Prisma schema and therefore invisible to the generated client — the same reason
 * the retrievers themselves use raw SQL.
 */
import { randomUUID } from "node:crypto";

import { EMBEDDING_DIMENSIONS } from "../retrieval/sql";

import type { DbClient } from "../client";

export const TEST_EMBEDDING_PROFILE = "test-embed:1024:v1";

/**
 * A unit vector with weight on the given axes. Cosine similarity between two such vectors is the overlap of
 * their weights, so tests can state "these are close" and "these are unrelated" exactly rather than hoping.
 */
export function testVector(weights: Readonly<Record<number, number>>): number[] {
  const values = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  for (const [axis, weight] of Object.entries(weights)) {
    values[Number(axis)] = weight;
  }
  const norm = Math.sqrt(values.reduce((total, value) => total + value * value, 0));
  if (norm === 0) {
    throw new Error("a zero vector has no direction");
  }
  return values.map((value) => value / norm);
}

export interface SeedChunk {
  readonly content: string;
  /** Absent leaves the chunk lexical-only, which the profile CHECK constraint requires to be consistent. */
  readonly embedding?: readonly number[];
  readonly embeddingProfile?: string;
}

export interface SeedDocumentInput {
  readonly workspaceId: string;
  readonly businessProfileId?: string;
  readonly title: string;
  readonly status?: "DRAFT" | "ACTIVE" | "ARCHIVED";
  readonly version?: number;
  readonly chunks: readonly SeedChunk[];
  /** Chunks left behind by an earlier version: still present for audit, never retrievable. */
  readonly supersededChunks?: readonly SeedChunk[];
}

export interface SeededDocument {
  readonly documentId: string;
  readonly chunkIds: readonly string[];
  readonly supersededChunkIds: readonly string[];
}

export async function seedKnowledgeDocument(db: DbClient, input: SeedDocumentInput): Promise<SeededDocument> {
  const version = input.version ?? 1;
  const document = await db.knowledgeDocument.create({
    data: {
      workspaceId: input.workspaceId,
      businessProfileId: input.businessProfileId ?? null,
      title: input.title,
      sourceType: "MANUAL",
      version,
      status: input.status ?? "ACTIVE",
    },
    select: { id: true },
  });

  const chunkIds = await insertChunks(db, input.workspaceId, document.id, version, input.chunks, 0);
  const supersededChunkIds = await insertChunks(db, input.workspaceId, document.id, version - 1, input.supersededChunks ?? [], 0);
  return { documentId: document.id, chunkIds, supersededChunkIds };
}

async function insertChunks(
  db: DbClient,
  workspaceId: string,
  documentId: string,
  version: number,
  chunks: readonly SeedChunk[],
  firstOrdinal: number,
): Promise<string[]> {
  const ids: string[] = [];
  for (const [index, chunk] of chunks.entries()) {
    const id = randomUUID();
    await db.$executeRawUnsafe(
      `INSERT INTO "knowledge_chunks"
         ("id", "workspace_id", "document_id", "document_version", "ordinal", "content", "embedding_profile", "embedding", "created_at", "updated_at")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector, NOW(), NOW())`,
      id,
      workspaceId,
      documentId,
      version,
      firstOrdinal + index,
      chunk.content,
      chunk.embedding === undefined ? null : (chunk.embeddingProfile ?? TEST_EMBEDDING_PROFILE),
      chunk.embedding === undefined ? null : `[${chunk.embedding.join(",")}]`,
    );
    ids.push(id);
  }
  return ids;
}

export interface SeedStyleInput {
  readonly workspaceId: string;
  readonly businessProfileId?: string;
  readonly inboundContext: string;
  readonly outboundText: string;
  readonly provenance?: "HUMAN_TYPED" | "HUMAN_EDITED_DRAFT";
  readonly status?: "ACTIVE" | "SUGGESTED" | "REJECTED" | "ARCHIVED";
  /** Who approved it. Required for ACTIVE by a CHECK; resolved from the workspace's members when absent. */
  readonly approvedByUserId?: string;
  readonly embedding?: readonly number[];
  readonly embeddingProfile?: string;
  /** Stored exactly as given, so a test can also plant a spelling production would have normalized. */
  readonly language?: string;
}

export async function seedStyleExample(db: DbClient, input: SeedStyleInput): Promise<string> {
  const id = randomUUID();
  const status = input.status ?? "ACTIVE";
  // An ACTIVE example names its approver, because a CHECK insists: "verified" with nobody's name on it is
  // unattributed rather than verified. A fixture that named nobody would be testing a state production
  // cannot reach, so it borrows a member of the workspace it is seeding into.
  const approvedByUserId = input.approvedByUserId ?? (status === "ACTIVE" ? await anyMemberOf(db, input.workspaceId) : null);
  await db.$executeRawUnsafe(
    `INSERT INTO "style_examples"
       ("id", "workspace_id", "business_profile_id", "inbound_context", "outbound_text", "provenance", "status",
        "approved_by_user_id", "embedding_profile", "embedding", "language", "created_at", "updated_at")
     VALUES ($1, $2, $3, $4, $5, $6::"StyleExampleProvenance", $7::"StyleExampleStatus", $8, $9, $10::vector, $11, NOW(), NOW())`,
    id,
    input.workspaceId,
    input.businessProfileId ?? null,
    input.inboundContext,
    input.outboundText,
    input.provenance ?? "HUMAN_TYPED",
    status,
    approvedByUserId,
    input.embedding === undefined ? null : (input.embeddingProfile ?? TEST_EMBEDDING_PROFILE),
    input.embedding === undefined ? null : `[${input.embedding.join(",")}]`,
    input.language ?? null,
  );
  return id;
}

/** A member of this workspace, preferring its owner, so a seeded approval names somebody who exists. */
async function anyMemberOf(db: DbClient, workspaceId: string): Promise<string | null> {
  const member = await db.workspaceMember.findFirst({
    where: { workspaceId },
    orderBy: [{ role: "asc" }, { createdAt: "asc" }],
    select: { userId: true },
  });
  return member?.userId ?? null;
}
