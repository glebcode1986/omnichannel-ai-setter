import { describe, expect, it } from "vitest";

import type { ConversationSegment } from "../ai/ports";
import {
  RetrievalUnavailableError,
  type EmbeddingProvider,
  type KnowledgeHit,
  type KnowledgeRetriever,
  type StyleHit,
  type StyleRetriever,
} from "./ports";
import { retrieveDraftContext, type DraftRetrievalDependencies } from "./retrieve-draft-context";

const NOW = new Date("2026-09-18T10:00:00.000Z");
const SCOPE = { workspaceId: "ws_1", businessProfileId: "bp_1" };

const inbound = (...texts: string[]): ConversationSegment[] =>
  texts.map((text, index) => ({ kind: "INBOUND", provenance: `msg_${String(index)}`, text, occurredAt: NOW }));

const knowledgeHit = (chunkId: string): KnowledgeHit => ({
  chunkId,
  documentId: "doc_1",
  documentTitle: "Hours",
  documentVersion: 2,
  sourceType: "MANUAL",
  scopeLevel: "WORKSPACE",
  text: "Saturday hours are 10:00-18:00.",
  score: 0.03,
  lexicalRank: 1,
  semanticRank: 2,
});

const styleHit = (exampleId: string): StyleHit => ({
  exampleId,
  scopeLevel: "WORKSPACE",
  inboundContext: "open saturday?",
  outboundText: "Hey! 10 till 6 😊",
  provenance: "HUMAN_TYPED",
  score: 0.016,
});

interface HarnessOptions {
  readonly knowledge?: KnowledgeHit[] | Error;
  readonly style?: StyleHit[] | Error;
  readonly embeddings?: EmbeddingProvider | "none";
}

function harness(options: HarnessOptions = {}) {
  const logs: { event: string; fields?: Readonly<Record<string, unknown>> }[] = [];
  const queries: { text: string; embedded: boolean }[] = [];
  const record = (event: string, fields?: Readonly<Record<string, unknown>>) => logs.push({ event, ...(fields ? { fields } : {}) });

  const knowledge: KnowledgeRetriever = {
    search: (query) => {
      queries.push({ text: query.text, embedded: query.embedding !== undefined });
      const result = options.knowledge ?? [knowledgeHit("chunk_1")];
      return result instanceof Error ? Promise.reject(result) : Promise.resolve({ hits: result, diagnostics: { lexicalCandidates: result.length, semanticCandidates: 0 } });
    },
  };
  const style: StyleRetriever = {
    search: () => {
      const result = options.style ?? [styleHit("style_1")];
      return result instanceof Error ? Promise.reject(result) : Promise.resolve({ hits: result, diagnostics: { lexicalCandidates: result.length, semanticCandidates: 0 } });
    },
  };

  const embeddings: EmbeddingProvider =
    options.embeddings !== undefined && options.embeddings !== "none"
      ? options.embeddings
      : {
          profile: "test:1024:v1",
          dimensions: 1_024,
          embed: (texts) => Promise.resolve(texts.map(() => ({ profile: "test:1024:v1", values: [0.1] }))),
        };

  const dependencies: DraftRetrievalDependencies = {
    knowledge,
    style,
    ...(options.embeddings === "none" ? {} : { embeddings }),
    log: { info: record, warn: record },
  };
  return { dependencies, logs, queries };
}

describe("retrieveDraftContext", () => {
  it("supplies facts and tone through separate, differently shaped channels", async () => {
    const { dependencies } = harness();

    const context = await retrieveDraftContext(dependencies, { scope: SCOPE, inbound: inbound("Are you open Saturday?") });

    expect(context.knowledge).toEqual([{ chunkId: "chunk_1", text: "Saturday hours are 10:00-18:00." }]);
    expect(context.style).toEqual([{ exampleId: "style_1", text: "Hey! 10 till 6 😊" }]);
    // The audit record keeps the provenance the model is never shown.
    expect(context.supplied.knowledge[0]).toMatchObject({ chunkId: "chunk_1", documentId: "doc_1", documentVersion: 2, lexicalRank: 1, semanticRank: 2 });
    expect(context.supplied.status).toBe("OK");
  });

  it("searches on the newest words of the burst, capped from the end", async () => {
    const { dependencies, queries } = harness();

    await retrieveDraftContext(dependencies, { scope: SCOPE, inbound: inbound("Hi there", "  ", "Are you open Saturday?") });
    expect(queries[0]?.text).toBe("Hi there\nAre you open Saturday?");

    const long = "x".repeat(2_000);
    await retrieveDraftContext(dependencies, { scope: SCOPE, inbound: inbound(long, "and Saturday?") });
    const text = queries[1]?.text ?? "";
    expect(text.length).toBe(1_000);
    // The end of the burst is the question being answered, so that is the end that is kept.
    expect(text.endsWith("and Saturday?")).toBe(true);
  });

  it("marks an unreachable factual corpus as an outage instead of reporting no facts", async () => {
    const { dependencies, logs } = harness({ knowledge: new RetrievalUnavailableError("connection") });

    const context = await retrieveDraftContext(dependencies, { scope: SCOPE, inbound: inbound("What does a session cost?") });

    // "We found nothing" and "we could not look" must never collapse into the same empty array.
    expect(context.knowledge).toEqual([]);
    expect(context.supplied.status).toBe("UNAVAILABLE");
    expect(logs.map((entry) => entry.event)).toContain("ai.knowledge_retrieval_failed");
    // The failure is named by class, never by a driver message that could quote stored customer data.
    expect(JSON.stringify(logs)).not.toContain("connection");
  });

  it("treats losing tone as a cosmetic loss, not an outage", async () => {
    const { dependencies, logs } = harness({ style: new RetrievalUnavailableError("timeout") });

    const context = await retrieveDraftContext(dependencies, { scope: SCOPE, inbound: inbound("Are you open Saturday?") });

    expect(context.style).toEqual([]);
    // A missing example cannot make a false statement, so the draft is not held for it.
    expect(context.supplied.status).toBe("OK");
    expect(context.knowledge).toHaveLength(1);
    expect(logs.map((entry) => entry.event)).toContain("ai.style_retrieval_failed");
  });

  it("degrades to lexical-only when embedding fails, and records that it happened", async () => {
    const failing: EmbeddingProvider = {
      profile: "test:1024:v1",
      dimensions: 1_024,
      embed: () => Promise.reject(new Error("provider down")),
    };
    const { dependencies, queries, logs } = harness({ embeddings: failing });

    const context = await retrieveDraftContext(dependencies, { scope: SCOPE, inbound: inbound("Are you open Saturday?") });

    // Lexical-only is a configuration this system already ships in, so an embedding blip lands somewhere
    // already known to be safe — but the audit record still says which run was missing its vectors.
    expect(queries[0]?.embedded).toBe(false);
    expect(context.supplied.status).toBe("OK");
    expect(context.knowledge).toHaveLength(1);
    expect(context.supplied.knowledgeDiagnostics.semanticSkipped).toBe("PROVIDER_ERROR");
    expect(logs.map((entry) => entry.event)).toContain("ai.embedding_unavailable");
  });

  it("treats an empty batch from the embedding provider as a failure, not as a lexical-only run", async () => {
    const silent: EmbeddingProvider = { profile: "test:1024:v1", dimensions: 1_024, embed: () => Promise.resolve([]) };
    const { dependencies } = harness({ embeddings: silent });

    const context = await retrieveDraftContext(dependencies, { scope: SCOPE, inbound: inbound("Are you open Saturday?") });

    expect(context.supplied.knowledgeDiagnostics.semanticSkipped).toBe("PROVIDER_ERROR");
  });

  it("runs lexical-only with no embedding provider configured at all", async () => {
    const { dependencies, queries } = harness({ embeddings: "none" });

    const context = await retrieveDraftContext(dependencies, { scope: SCOPE, inbound: inbound("Are you open Saturday?") });

    expect(queries[0]?.embedded).toBe(false);
    expect(context.supplied.status).toBe("OK");
    expect(context.supplied.knowledgeDiagnostics.semanticSkipped).toBeUndefined();
  });

  it("searches nothing when the burst carries no text", async () => {
    const { dependencies, queries } = harness({ embeddings: "none" });

    const context = await retrieveDraftContext(dependencies, { scope: SCOPE, inbound: inbound("   ", "") });

    expect(queries).toHaveLength(0);
    expect(context.knowledge).toEqual([]);
    expect(context.supplied.status).toBe("OK");
  });

  it("drops a style example that shares an ID with a knowledge chunk", async () => {
    // Impossible with distinct ID spaces, which is why it is worth failing loudly if it ever happens: the
    // draft engine decides what is a real source by membership in the knowledge set.
    const { dependencies, logs } = harness({ knowledge: [knowledgeHit("shared_id")], style: [styleHit("shared_id")] });

    const context = await retrieveDraftContext(dependencies, { scope: SCOPE, inbound: inbound("Are you open Saturday?") });

    expect(context.style).toEqual([]);
    expect(context.knowledge.map((chunk) => chunk.chunkId)).toEqual(["shared_id"]);
    expect(logs.map((entry) => entry.event)).toContain("ai.retrieval_id_collision");
  });
});
