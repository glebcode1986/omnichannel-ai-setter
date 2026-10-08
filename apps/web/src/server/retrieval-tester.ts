/**
 * Asking the real retriever what it would find (RETRIEVAL.md, ADR-011, Issue #31).
 *
 * The tester's only value is that it is not a simulation. It calls the same `createKnowledgeRetriever` the
 * draft engine calls, in the same scope, with the same thresholds — so "no results" here means the
 * assistant would also find nothing, which is the answer an operator is actually asking for.
 *
 * That is also why the embedding configuration is read rather than assumed. A tester running lexical-only
 * against a deployment whose worker runs hybrid would report a fact unreachable that the assistant finds
 * every day. Where this deployment has no embedding key, retrieval genuinely is lexical-only — and the
 * result says so, because "we searched the words only" and "we searched properly" are different answers
 * to the same empty list.
 *
 * It reads and returns provenance. It cannot write, publish or index anything.
 */
import { createVoyageEmbeddingProvider } from "@omnichannel/ai";
import { createKnowledgeRetriever, createStyleRetriever, EMBEDDING_DIMENSIONS, type BusinessProfileContext } from "@omnichannel/db";
import type { KnowledgeHit, StyleHit } from "@omnichannel/application";

import { loadWebEnv } from "../env";
import { getDb } from "./db";
import { getLogger } from "./logger";

export type RetrievalMode = "HYBRID" | "LEXICAL_ONLY";

export interface RetrievalTrial {
  readonly mode: RetrievalMode;
  readonly hits: readonly KnowledgeHit[];
  /** True when the factual corpus could not be consulted at all, which is not the same as finding nothing. */
  readonly unavailable: boolean;
}

const MAX_RESULTS = 10;

export async function runRetrievalTrial(context: BusinessProfileContext, text: string): Promise<RetrievalTrial> {
  const query = text.trim();
  if (query === "") {
    return { mode: modeOf(), hits: [], unavailable: false };
  }

  const embedding = await embed(query);
  try {
    const result = await createKnowledgeRetriever(getDb()).search({
      scope: { workspaceId: context.workspaceId, businessProfileId: context.businessProfileId },
      text: query,
      ...(embedding === undefined ? {} : { embedding }),
      limit: MAX_RESULTS,
    });
    return { mode: embedding === undefined ? "LEXICAL_ONLY" : "HYBRID", hits: result.hits, unavailable: false };
  } catch (error) {
    // A retrieval outage is reported as one. Rendering it as an empty result would tell an operator their
    // knowledge base is empty at the moment it is merely unreachable.
    getLogger().warn("knowledge.retrieval_trial_failed", { message: error instanceof Error ? error.message : "unknown" });
    return { mode: modeOf(), hits: [], unavailable: true };
  }
}

function modeOf(): RetrievalMode {
  const env = loadWebEnv();
  return env.VOYAGE_API_KEY !== undefined && env.AI_EMBEDDING_DIMENSIONS === EMBEDDING_DIMENSIONS ? "HYBRID" : "LEXICAL_ONLY";
}

/**
 * The query's vector, or nothing.
 *
 * A width that disagrees with the `vector(N)` column can never match a stored vector, so every semantic
 * query would return nothing and the tester would report a healthy corpus as empty. Refusing to embed at
 * all is the honest failure: the trial then says it searched lexically, which is what happened.
 */
async function embed(text: string) {
  const env = loadWebEnv();
  if (env.VOYAGE_API_KEY === undefined || env.AI_EMBEDDING_DIMENSIONS !== EMBEDDING_DIMENSIONS) {
    return undefined;
  }
  try {
    const provider = createVoyageEmbeddingProvider({
      apiKey: env.VOYAGE_API_KEY,
      model: env.AI_EMBEDDING_MODEL,
      dimensions: env.AI_EMBEDDING_DIMENSIONS,
      revision: env.AI_EMBEDDING_REVISION,
      logger: getLogger(),
    });
    // `QUERY`, not `DOCUMENT`: the two are embedded differently, and using the wrong one compares a
    // question against vectors built for passages — which quietly degrades every score.
    const [vector] = await provider.embed([text], "QUERY");
    return vector;
  } catch (error) {
    // An embeddings outage degrades the trial to lexical rather than failing it, which is exactly what
    // the worker does with the same outage.
    getLogger().warn("knowledge.embedding_unavailable", { message: error instanceof Error ? error.message : "unknown" });
    return undefined;
  }
}

export interface StyleTrial {
  readonly mode: RetrievalMode;
  readonly hits: readonly StyleHit[];
  readonly unavailable: boolean;
}

/**
 * The same trial, for style (Issue #32).
 *
 * Also the real retriever, for the same reason — and worth saying explicitly: style retrieval matches the
 * *customer's message* against the inbound half of each example, not against the replies. So the question
 * this answers is "which of our replies would the assistant look at, given a customer saying this?", which
 * is what an operator wants to know and not what a naive implementation would have searched.
 *
 * Only verified examples can appear: the query filters `status = 'ACTIVE'`, and an ACTIVE example names
 * its approver by CHECK. A suggestion is therefore absent from this surface until somebody activates it,
 * which makes the tester an honest preview of what the assistant will actually draw on.
 */
export async function runStyleTrial(context: BusinessProfileContext, text: string): Promise<StyleTrial> {
  const query = text.trim();
  if (query === "") {
    return { mode: modeOf(), hits: [], unavailable: false };
  }

  const embedding = await embed(query);
  try {
    const result = await createStyleRetriever(getDb()).search({
      scope: { workspaceId: context.workspaceId, businessProfileId: context.businessProfileId },
      text: query,
      ...(embedding === undefined ? {} : { embedding }),
      limit: MAX_RESULTS,
    });
    return { mode: embedding === undefined ? "LEXICAL_ONLY" : "HYBRID", hits: result.hits, unavailable: false };
  } catch (error) {
    getLogger().warn("style.retrieval_trial_failed", { message: error instanceof Error ? error.message : "unknown" });
    return { mode: modeOf(), hits: [], unavailable: true };
  }
}
