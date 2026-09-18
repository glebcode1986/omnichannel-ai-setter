/**
 * PostgreSQL implementations of the application's `KnowledgeRetriever` and `StyleRetriever` ports.
 *
 * This file runs SQL. It never calls an AI provider: query vectors arrive as data on the query, which is
 * what keeps `packages/db` free of any embedding dependency (ADR-010 as amended, enforced by
 * `pnpm lint:boundaries`).
 *
 * Both retrievers follow the same shape — run the lexical list, run the semantic list, fuse by reciprocal
 * rank — but they stay separate functions returning separate types. Factoring them into one generic
 * "retrieve anything" helper would produce exactly the shared code path along which a style example could
 * one day be returned as factual support.
 */
import {
  fuseByReciprocalRank,
  RetrievalUnavailableError,
  type EmbeddingVector,
  type KnowledgeHit,
  type KnowledgeRetrievalResult,
  type KnowledgeRetriever,
  type RankedCandidate,
  type RetrievalDiagnostics,
  type RetrievalQuery,
  type StyleHit,
  type StyleRetrievalResult,
  type StyleRetriever,
} from "@omnichannel/application";

import type { DbClient } from "./../client";
import {
  candidateLimit,
  DEFAULT_MIN_LEXICAL_SCORE,
  DEFAULT_MIN_SIMILARITY,
  EMBEDDING_DIMENSIONS,
  knowledgeLexicalSql,
  knowledgeProfileProbeSql,
  knowledgeSemanticSql,
  styleLexicalSql,
  styleProfileProbeSql,
  styleSemanticSql,
  toVectorLiteral,
} from "./sql";

interface KnowledgeRow {
  readonly chunk_id: string;
  readonly document_id: string;
  readonly document_version: number;
  readonly content: string;
  readonly document_title: string;
  readonly source_type: string;
  readonly profile_scoped: boolean;
  readonly score: number;
}

interface StyleRow {
  readonly example_id: string;
  readonly inbound_context: string;
  readonly outbound_text: string;
  readonly provenance: string;
  readonly profile_scoped: boolean;
  readonly score: number;
}

export function createKnowledgeRetriever(db: DbClient): KnowledgeRetriever {
  return {
    async search(query: RetrievalQuery): Promise<KnowledgeRetrievalResult> {
      const { lexical, semantic, diagnostics } = await runLists<KnowledgeRow>(db, query, {
        lexical: knowledgeLexicalSql(),
        semantic: knowledgeSemanticSql(),
        probe: knowledgeProfileProbeSql(),
      });

      const byId = new Map<string, KnowledgeRow>();
      for (const row of [...lexical, ...semantic]) {
        byId.set(row.chunk_id, row);
      }
      const fused = fuseByReciprocalRank([lexical.map(knowledgeCandidate), semantic.map(knowledgeCandidate)], { limit: query.limit });

      const hits: KnowledgeHit[] = [];
      for (const entry of fused) {
        const row = byId.get(entry.id);
        if (row === undefined) {
          continue;
        }
        hits.push({
          chunkId: row.chunk_id,
          documentId: row.document_id,
          documentTitle: row.document_title,
          documentVersion: row.document_version,
          sourceType: row.source_type,
          scopeLevel: row.profile_scoped ? "BUSINESS_PROFILE" : "WORKSPACE",
          text: row.content,
          score: entry.score,
          ...(entry.ranks[0] === undefined ? {} : { lexicalRank: entry.ranks[0] }),
          ...(entry.ranks[1] === undefined ? {} : { semanticRank: entry.ranks[1] }),
        });
      }
      return { hits, diagnostics };
    },
  };
}

export function createStyleRetriever(db: DbClient): StyleRetriever {
  return {
    async search(query: RetrievalQuery): Promise<StyleRetrievalResult> {
      const { lexical, semantic, diagnostics } = await runLists<StyleRow>(db, query, {
        lexical: styleLexicalSql(),
        semantic: styleSemanticSql(),
        probe: styleProfileProbeSql(),
      });

      const byId = new Map<string, StyleRow>();
      for (const row of [...lexical, ...semantic]) {
        byId.set(row.example_id, row);
      }
      const fused = fuseByReciprocalRank([lexical.map(styleCandidate), semantic.map(styleCandidate)], { limit: query.limit });

      const hits: StyleHit[] = [];
      for (const entry of fused) {
        const row = byId.get(entry.id);
        // The database enum admits only verified human sources, so no provenance filter is needed here.
        // A value outside it would mean the enum grew; dropping the row is safer than trusting the name.
        if (row === undefined || (row.provenance !== "HUMAN_TYPED" && row.provenance !== "HUMAN_EDITED_DRAFT")) {
          continue;
        }
        hits.push({
          exampleId: row.example_id,
          scopeLevel: row.profile_scoped ? "BUSINESS_PROFILE" : "WORKSPACE",
          inboundContext: row.inbound_context,
          outboundText: row.outbound_text,
          provenance: row.provenance,
          score: entry.score,
        });
      }
      return { hits, diagnostics };
    },
  };
}

const knowledgeCandidate = (row: KnowledgeRow): RankedCandidate => ({
  id: row.chunk_id,
  scopeLevel: row.profile_scoped ? "BUSINESS_PROFILE" : "WORKSPACE",
});

const styleCandidate = (row: StyleRow): RankedCandidate => ({
  id: row.example_id,
  scopeLevel: row.profile_scoped ? "BUSINESS_PROFILE" : "WORKSPACE",
});

/**
 * Runs both lists in one transaction and reports what each contributed.
 *
 * A database failure becomes `RetrievalUnavailableError` rather than an empty list, because the caller's
 * whole safety argument rests on telling "the business has no such fact" apart from "we could not look".
 */
async function runLists<Row>(
  db: DbClient,
  query: RetrievalQuery,
  sql: { readonly lexical: string; readonly semantic: string; readonly probe: string },
): Promise<{ lexical: Row[]; semantic: Row[]; diagnostics: RetrievalDiagnostics }> {
  const take = candidateLimit(query.limit);
  const minLexical = query.thresholds?.minLexicalScore ?? DEFAULT_MIN_LEXICAL_SCORE;
  const minSimilarity = query.thresholds?.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
  const vector = vectorLiteral(query.embedding);

  try {
    // One transaction so both lists and the probe see the same snapshot: a document activated between the
    // two queries would otherwise produce a fused result that never existed at any single instant.
    const { lexical, semantic, profilePresent } = await db.$transaction(async (tx) => {
      const lexicalRows =
        query.text === ""
          ? []
          : await tx.$queryRawUnsafe<Row[]>(sql.lexical, query.scope.workspaceId, query.scope.businessProfileId, query.text, minLexical, take);
      const semanticRows =
        vector === undefined || query.embedding === undefined
          ? []
          : await tx.$queryRawUnsafe<Row[]>(
              sql.semantic,
              query.scope.workspaceId,
              query.scope.businessProfileId,
              vector,
              query.embedding.profile,
              // The floor is a similarity; the query orders by distance, so it travels as a distance ceiling.
              1 - minSimilarity,
              take,
            );
      // Only on the empty path, and only when a vector was actually supplied: one cheap existence check
      // that separates "nothing was similar enough" from "this corpus is not embedded under this profile".
      const probed =
        query.embedding === undefined || semanticRows.length > 0
          ? undefined
          : await tx.$queryRawUnsafe<{ present: boolean }[]>(
              sql.probe,
              query.scope.workspaceId,
              query.scope.businessProfileId,
              query.embedding.profile,
            );
      return { lexical: lexicalRows, semantic: semanticRows, profilePresent: probed?.[0]?.present };
    });

    return {
      lexical,
      semantic,
      diagnostics: {
        lexicalCandidates: lexical.length,
        semanticCandidates: semantic.length,
        ...(query.embedding === undefined
          ? { semanticSkipped: "NO_EMBEDDING" as const }
          : profilePresent === false
            ? { semanticSkipped: "PROFILE_MISMATCH" as const }
            : {}),
      },
    };
  } catch (error) {
    throw new RetrievalUnavailableError(error instanceof Error ? error.name : "query_failed");
  }
}

/**
 * A vector of the wrong width cannot be compared with the stored column at all; pgvector would raise, and
 * an unhandled raise here would be reported as an outage. Catching it at the boundary names the real cause.
 */
function vectorLiteral(embedding: EmbeddingVector | undefined): string | undefined {
  if (embedding === undefined) {
    return undefined;
  }
  if (embedding.values.length !== EMBEDDING_DIMENSIONS) {
    throw new RetrievalUnavailableError("embedding_dimension_mismatch");
  }
  return toVectorLiteral(embedding.values);
}
