import type { EmbeddingVector, RetrievalQuery } from "@omnichannel/application";
import { RetrievalUnavailableError } from "@omnichannel/application";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDbClient } from "../client";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "../testing/database";
import { seedWorkspace, type SeededProfile } from "../testing/fixtures";
import { seedKnowledgeDocument, seedStyleExample, testVector, TEST_EMBEDDING_PROFILE } from "../testing/retrieval-fixtures";
import { createKnowledgeRetriever, createStyleRetriever } from "./retrievers";
import { knowledgeLexicalSql, knowledgeSemanticSql, searchableExpression, styleLexicalSql, toVectorLiteral } from "./sql";

/** Axis 0 is "opening hours"; axis 1 is an unrelated topic. Their overlap is exactly zero. */
const HOURS_AXIS = testVector({ 0: 1 });
const UNRELATED_AXIS = testVector({ 1: 1 });
/** Mostly "hours" with a little of something else: similar, but not identical. */
const NEARLY_HOURS = testVector({ 0: 0.9, 2: 0.2 });

describe.skipIf(!databaseTestsEnabled())("factual and style retrieval (PostgreSQL)", () => {
  let database: TestDatabase;
  let workspaceId: string;
  let profileA: SeededProfile;
  let profileB: SeededProfile;
  let otherWorkspaceId: string;
  let otherProfile: SeededProfile;

  let baseChunkId: string;
  let profileChunkId: string;
  let staleChunkIds: readonly string[];
  let archivedChunkId: string;
  let semanticOnlyChunkId: string;

  const knowledge = () => createKnowledgeRetriever(database.db);
  const style = () => createStyleRetriever(database.db);

  const query = (overrides: Partial<RetrievalQuery> = {}): RetrievalQuery => ({
    scope: { workspaceId, businessProfileId: profileA.businessProfileId },
    text: "saturday opening hours",
    limit: 8,
    ...overrides,
  });

  const vector = (values: readonly number[], profile = TEST_EMBEDDING_PROFILE): EmbeddingVector => ({ profile, values });

  beforeAll(async () => {
    database = await createMigratedTestDatabase();

    const workspace = await seedWorkspace(database.db, "retrieval", ["alpha", "beta"]);
    workspaceId = workspace.workspaceId;
    [profileA, profileB] = workspace.profiles as [SeededProfile, SeededProfile];

    const other = await seedWorkspace(database.db, "rival", ["main"]);
    otherWorkspaceId = other.workspaceId;
    [otherProfile] = other.profiles as [SeededProfile];

    // Workspace-wide knowledge: visible to every profile in this workspace.
    const base = await seedKnowledgeDocument(database.db, {
      workspaceId,
      title: "Opening hours",
      chunks: [{ content: "Saturday opening hours are 10:00 to 18:00.", embedding: HOURS_AXIS }],
    });
    baseChunkId = base.chunkIds[0] ?? "";

    // Profile-specific knowledge: visible only inside profile A.
    const specific = await seedKnowledgeDocument(database.db, {
      workspaceId,
      businessProfileId: profileA.businessProfileId,
      title: "Studio alpha hours",
      chunks: [{ content: "The alpha studio keeps saturday hours from 09:00.", embedding: NEARLY_HOURS }],
    });
    profileChunkId = specific.chunkIds[0] ?? "";

    // Version 2 is current; version 1's chunks stay for audit and must never be retrievable.
    const versioned = await seedKnowledgeDocument(database.db, {
      workspaceId,
      title: "Pricing",
      version: 2,
      chunks: [{ content: "A saturday session costs 40 euro." }],
      supersededChunks: [{ content: "A saturday session costs 25 euro." }],
    });
    staleChunkIds = versioned.supersededChunkIds;

    const archived = await seedKnowledgeDocument(database.db, {
      workspaceId,
      title: "Withdrawn policy",
      status: "ARCHIVED",
      chunks: [{ content: "Saturday refunds are unconditional." }],
    });
    archivedChunkId = archived.chunkIds[0] ?? "";

    await seedKnowledgeDocument(database.db, {
      workspaceId,
      title: "Draft policy",
      status: "DRAFT",
      chunks: [{ content: "Saturday deposits will be refundable." }],
    });

    // Shares no words with the query: only a vector can find it.
    const semantic = await seedKnowledgeDocument(database.db, {
      workspaceId,
      title: "Weekend schedule",
      chunks: [{ content: "Le weekend nous ouvrons a dix heures.", embedding: HOURS_AXIS }],
    });
    semanticOnlyChunkId = semantic.chunkIds[0] ?? "";

    // Another workspace holds a better-matching fact, which must never surface.
    await seedKnowledgeDocument(database.db, {
      workspaceId: otherWorkspaceId,
      title: "Rival hours",
      chunks: [{ content: "Saturday opening hours are 07:00 to 23:00.", embedding: HOURS_AXIS }],
    });

    await seedStyleExample(database.db, {
      workspaceId,
      inboundContext: "are you open on saturday?",
      outboundText: "Hey! Yes — 10 till 6 on Saturdays 😊",
      embedding: HOURS_AXIS,
    });
    await seedStyleExample(database.db, {
      workspaceId: otherWorkspaceId,
      inboundContext: "are you open on saturday?",
      outboundText: "Rival tone.",
      embedding: HOURS_AXIS,
    });
  }, 180_000);

  afterAll(async () => {
    await database?.dispose();
  });

  describe("scope", () => {
    it("never returns another workspace's knowledge or style, however well it matches", async () => {
      const facts = await knowledge().search(query());
      const tone = await style().search(query());

      expect(facts.hits.length).toBeGreaterThan(0);
      for (const hit of facts.hits) {
        expect(hit.text).not.toContain("07:00");
      }
      expect(tone.hits.map((hit) => hit.outboundText)).not.toContain("Rival tone.");

      // And the same query from the other workspace sees only its own.
      const rival = await knowledge().search(
        query({ scope: { workspaceId: otherWorkspaceId, businessProfileId: otherProfile.businessProfileId } }),
      );
      expect(rival.hits).toHaveLength(1);
      expect(rival.hits[0]?.text).toContain("07:00");
    });

    it("shares workspace-wide knowledge but keeps profile-specific knowledge inside its profile", async () => {
      const fromA = await knowledge().search(query());
      const fromB = await knowledge().search(query({ scope: { workspaceId, businessProfileId: profileB.businessProfileId } }));

      expect(fromA.hits.map((hit) => hit.chunkId)).toContain(profileChunkId);
      expect(fromB.hits.map((hit) => hit.chunkId)).not.toContain(profileChunkId);
      // The workspace base is shared, so both profiles can answer from it.
      expect(fromA.hits.map((hit) => hit.chunkId)).toContain(baseChunkId);
      expect(fromB.hits.map((hit) => hit.chunkId)).toContain(baseChunkId);
      expect(fromA.hits.find((hit) => hit.chunkId === profileChunkId)?.scopeLevel).toBe("BUSINESS_PROFILE");
      expect(fromA.hits.find((hit) => hit.chunkId === baseChunkId)?.scopeLevel).toBe("WORKSPACE");
    });
  });

  describe("provenance and staleness", () => {
    it("excludes superseded versions, archived and draft documents", async () => {
      const facts = await knowledge().search(query({ text: "saturday", limit: 20 }));
      const ids = facts.hits.map((hit) => hit.chunkId);

      // The words are there in every one of them; only the provenance rules keep them out.
      for (const staleId of staleChunkIds) {
        expect(ids).not.toContain(staleId);
      }
      expect(ids).not.toContain(archivedChunkId);
      expect(facts.hits.map((hit) => hit.text)).not.toContain("A saturday session costs 25 euro.");
      expect(facts.hits.map((hit) => hit.text)).not.toContain("Saturday deposits will be refundable.");
      // The current version of the same document is returned.
      expect(facts.hits.map((hit) => hit.text)).toContain("A saturday session costs 40 euro.");
      expect(facts.hits.find((hit) => hit.text.includes("40 euro"))?.documentVersion).toBe(2);
    });
  });

  describe("hybrid retrieval", () => {
    it("finds a chunk on words alone", async () => {
      const facts = await knowledge().search(query({ text: "10:00 18:00" }));

      expect(facts.hits.map((hit) => hit.chunkId)).toContain(baseChunkId);
      expect(facts.diagnostics.lexicalCandidates).toBeGreaterThan(0);
      expect(facts.diagnostics.semanticCandidates).toBe(0);
      expect(facts.diagnostics.semanticSkipped).toBe("NO_EMBEDDING");
    });

    it("finds a chunk that shares no words with the query, on the vector alone", async () => {
      const facts = await knowledge().search(query({ text: "zzzznomatch", embedding: vector(HOURS_AXIS) }));
      const ids = facts.hits.map((hit) => hit.chunkId);

      expect(ids).toContain(semanticOnlyChunkId);
      expect(facts.diagnostics.lexicalCandidates).toBe(0);
      expect(facts.diagnostics.semanticCandidates).toBeGreaterThan(0);
      expect(facts.hits.find((hit) => hit.chunkId === semanticOnlyChunkId)?.lexicalRank).toBeUndefined();
      expect(facts.hits.find((hit) => hit.chunkId === semanticOnlyChunkId)?.semanticRank).toBeGreaterThan(0);
    });

    it("keeps unrelated vectors out: a floor, not merely an ordering", async () => {
      const facts = await knowledge().search(query({ text: "zzzznomatch", embedding: vector(UNRELATED_AXIS) }));

      // Orthogonal to everything stored, so similarity is 0 and nothing clears the threshold.
      expect(facts.hits).toHaveLength(0);
      expect(facts.diagnostics.semanticCandidates).toBe(0);
      // A vector was supplied and the corpus does carry this profile, so this is "nothing was close enough",
      // not "we could not search semantically".
      expect(facts.diagnostics.semanticSkipped).toBeUndefined();
    });

    it("orders a fused result identically on every run", async () => {
      const runs = await Promise.all(
        Array.from({ length: 5 }, () => knowledge().search(query({ embedding: vector(HOURS_AXIS), limit: 10 }))),
      );
      const orders = runs.map((run) => run.hits.map((hit) => hit.chunkId).join(","));

      expect(new Set(orders).size).toBe(1);
      expect(runs[0]?.hits.length).toBeGreaterThan(1);
      // A chunk found by both lists outranks one found by a single list, which is the whole point of fusing.
      const both = runs[0]?.hits.find((hit) => hit.lexicalRank !== undefined && hit.semanticRank !== undefined);
      expect(both).toBeDefined();
      expect(runs[0]?.hits[0]?.chunkId).toBe(both?.chunkId);
    });

    it("returns nothing at all when the business has no such fact", async () => {
      const facts = await knowledge().search(query({ text: "do you sell helicopters" }));

      expect(facts.hits).toHaveLength(0);
      expect(facts.diagnostics.lexicalCandidates).toBe(0);
    });

    it("treats customer text as terms, never as query syntax", async () => {
      // `to_tsquery` would raise a syntax error on any of these, turning a message into an outage.
      for (const hostile of ['" & | ! (', "saturday & ! hours", "'unbalanced", "<->"]) {
        await expect(knowledge().search(query({ text: hostile }))).resolves.toHaveProperty("hits");
      }
    });
  });

  describe("embedding profiles", () => {
    it("never compares vectors from a different embedding profile, and says so", async () => {
      const facts = await knowledge().search(query({ text: "zzzznomatch", embedding: vector(HOURS_AXIS, "other-model:1024:v1") }));

      expect(facts.hits).toHaveLength(0);
      expect(facts.diagnostics.semanticCandidates).toBe(0);
      expect(facts.diagnostics.semanticSkipped).toBe("PROFILE_MISMATCH");
    });

    it("still answers lexically while the corpus is embedded under another profile", async () => {
      const facts = await knowledge().search(query({ embedding: vector(HOURS_AXIS, "other-model:1024:v1") }));

      // Re-embedding is a controlled migration, not an outage: words keep working throughout.
      expect(facts.hits.map((hit) => hit.chunkId)).toContain(baseChunkId);
      expect(facts.diagnostics.semanticSkipped).toBe("PROFILE_MISMATCH");
    });

    it("refuses a vector of the wrong width instead of letting the driver fail", async () => {
      await expect(knowledge().search(query({ embedding: vector([0.1, 0.2, 0.3]) }))).rejects.toBeInstanceOf(RetrievalUnavailableError);
      await expect(knowledge().search(query({ embedding: vector([0.1, 0.2, 0.3]) }))).rejects.toThrow(/dimension_mismatch/);
    });
  });

  describe("style", () => {
    it("retrieves tone examples through a port that cannot express a factual claim", async () => {
      const tone = await style().search(query());

      expect(tone.hits.length).toBeGreaterThan(0);
      const hit = tone.hits[0];
      expect(hit?.outboundText).toContain("10 till 6");
      expect(hit?.provenance).toBe("HUMAN_TYPED");
      // There is nowhere on a style hit to put a document, a version or a source type: it is not evidence.
      expect(hit).not.toHaveProperty("documentId");
      expect(hit).not.toHaveProperty("documentVersion");
      expect(hit).not.toHaveProperty("sourceType");
    });

    it("does not let a style example answer a factual query", async () => {
      // Only the style corpus knows about deposits; the factual corpus does not.
      await seedStyleExample(database.db, {
        workspaceId,
        businessProfileId: profileA.businessProfileId,
        inboundContext: "is the deposit refundable?",
        outboundText: "Of course — deposits are always fully refundable!",
      });

      const facts = await knowledge().search(query({ text: "deposit refundable" }));
      const tone = await style().search(query({ text: "deposit refundable" }));

      expect(tone.hits.length).toBeGreaterThan(0);
      // The factual answer is "we do not know", even though a human once wrote one down as an example.
      expect(facts.hits).toHaveLength(0);
    });
  });

  describe("outage", () => {
    it("reports an unreachable corpus as an outage rather than as an empty result", async () => {
      const unreachable = createDbClient({ connectionString: database.url.replace(/\/[^/]+$/, "/omnichannel_absent_db") });
      try {
        await expect(createKnowledgeRetriever(unreachable).search(query())).rejects.toBeInstanceOf(RetrievalUnavailableError);
        await expect(createStyleRetriever(unreachable).search(query())).rejects.toBeInstanceOf(RetrievalUnavailableError);
      } finally {
        await unreachable.$disconnect();
      }
    });
  });

  describe("query plan", () => {
    it("matches text through the expression the index was built on", async () => {
      // Two halves of one property. First: the expression really is index-usable — on a table this small
      // the planner would never choose the index on cost, so it is nudged into showing that it can.
      const plan = await database.db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
        return tx.$queryRawUnsafe<{ "QUERY PLAN": string }[]>(
          `EXPLAIN (COSTS OFF) SELECT "id" FROM "knowledge_chunks" WHERE ${searchableExpression('"content"')} @@ 'saturday'::tsquery`,
        );
      });
      expect(plan.map((row) => row["QUERY PLAN"]).join("\n")).toContain("knowledge_chunks_search_idx");

      // Second: the real queries use that same expression, character for character. Change one side only
      // and PostgreSQL quietly falls back to a full scan — same answers, no failure, just slower forever.
      expect(knowledgeLexicalSql()).toContain(searchableExpression('c."content"'));
      expect(styleLexicalSql()).toContain(searchableExpression('s."inbound_context"'));
    });

    it("keeps semantic search exact, because an index scan above the scope join would leak or lose rows", async () => {
      const plan = await database.db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
        return tx.$queryRawUnsafe<{ "QUERY PLAN": string }[]>(
          `EXPLAIN (COSTS OFF) ${knowledgeSemanticSql()}`,
          workspaceId,
          profileA.businessProfileId,
          toVectorLiteral(HOURS_AXIS),
          TEST_EMBEDDING_PROFILE,
          0.45,
          8,
        );
      });
      const text = plan.map((row) => row["QUERY PLAN"]).join("\n");

      // Every candidate is scored, then ordered: no approximate index decides which tenant's rows survive.
      expect(text).toContain("Sort");
      expect(text).not.toContain("hnsw");
    });
  });
});
