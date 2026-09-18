/**
 * A minimal internal seeding path for trusted Knowledge and approved Style (product-owner decision on
 * PR #66).
 *
 * This exists so the Instagram vertical slice (#16) and CI can exercise real retrieval before Phase 5
 * builds the Knowledge Library and Style Training screens. It is deliberately *not* a customer API: it is
 * exported for internal and test composition only, it takes an authorized `BusinessProfileContext` like
 * every other customer-data write, and it creates versioned, provenanced rows under normal Workspace and
 * Business Profile scope — the same rows the real UI will later create, not a shortcut around them.
 *
 * Two things it will not do, because they are the invariants retrieval rests on:
 *
 * - a style example may only claim a verified human provenance, because the schema admits nothing else;
 * - nothing here writes a knowledge chunk from a message or a draft. Style is learned from human writing;
 *   facts are not learned at all, they are stated.
 */
import { randomUUID } from "node:crypto";

import type { DbClient } from "../client";
import { profileScopeOf, type BusinessProfileContext } from "../tenancy";

export interface SeedKnowledgeInput {
  readonly title: string;
  /** Absent seeds Workspace-wide knowledge; set seeds it for this Business Profile only. */
  readonly businessProfileScoped?: boolean;
  readonly version?: number;
  readonly chunks: readonly {
    readonly content: string;
    /** Must match the `vector(N)` column width; a profile is required alongside it. */
    readonly embedding?: readonly number[];
    readonly embeddingProfile?: string;
  }[];
}

export interface SeededKnowledge {
  readonly documentId: string;
  readonly chunkIds: readonly string[];
}

/** Creates one ACTIVE, versioned knowledge document and its chunks. */
export async function seedKnowledge(
  db: DbClient,
  context: BusinessProfileContext,
  input: SeedKnowledgeInput,
): Promise<SeededKnowledge> {
  const scope = profileScopeOf(context);
  const version = input.version ?? 1;
  const document = await db.knowledgeDocument.create({
    data: {
      workspaceId: scope.workspaceId,
      businessProfileId: input.businessProfileScoped === true ? scope.businessProfileId : null,
      title: input.title,
      sourceType: "MANUAL",
      version,
      status: "ACTIVE",
    },
    select: { id: true },
  });

  const chunkIds: string[] = [];
  for (const [ordinal, chunk] of input.chunks.entries()) {
    const id = randomUUID();
    // Raw SQL because the vector column is `Unsupported` in the Prisma schema and so invisible to the
    // generated client — the same reason the retrievers use raw SQL.
    await db.$executeRawUnsafe(
      `INSERT INTO "knowledge_chunks"
         ("id", "workspace_id", "document_id", "document_version", "ordinal", "content", "embedding_profile", "embedding", "created_at", "updated_at")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector, NOW(), NOW())`,
      id,
      scope.workspaceId,
      document.id,
      version,
      ordinal,
      chunk.content,
      chunk.embedding === undefined ? null : (chunk.embeddingProfile ?? null),
      chunk.embedding === undefined ? null : `[${chunk.embedding.join(",")}]`,
    );
    chunkIds.push(id);
  }
  return { documentId: document.id, chunkIds };
}

export interface SeedStyleExampleInput {
  readonly inboundContext: string;
  readonly outboundText: string;
  /** Only verified human writing; the database enum admits nothing else. */
  readonly provenance?: "HUMAN_TYPED" | "HUMAN_EDITED_DRAFT";
  readonly businessProfileScoped?: boolean;
  /** BCP-47 tag; absent means the example is language-agnostic. */
  readonly language?: string;
  readonly embedding?: readonly number[];
  readonly embeddingProfile?: string;
}

export async function seedStyleExample(db: DbClient, context: BusinessProfileContext, input: SeedStyleExampleInput): Promise<string> {
  const scope = profileScopeOf(context);
  const id = randomUUID();
  await db.$executeRawUnsafe(
    `INSERT INTO "style_examples"
       ("id", "workspace_id", "business_profile_id", "inbound_context", "outbound_text", "provenance", "status",
        "language", "embedding_profile", "embedding", "created_at", "updated_at")
     VALUES ($1, $2, $3, $4, $5, $6::"StyleExampleProvenance", 'ACTIVE', $7, $8, $9::vector, NOW(), NOW())`,
    id,
    scope.workspaceId,
    input.businessProfileScoped === true ? scope.businessProfileId : null,
    input.inboundContext,
    input.outboundText,
    input.provenance ?? "HUMAN_TYPED",
    input.language ?? null,
    input.embedding === undefined ? null : (input.embeddingProfile ?? null),
    input.embedding === undefined ? null : `[${input.embedding.join(",")}]`,
  );
  return id;
}
