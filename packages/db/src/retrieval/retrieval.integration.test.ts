import type { EmbeddingVector, RetrievalQuery } from "@omnichannel/application";
import { RetrievalUnavailableError, retrieveDraftContext } from "@omnichannel/application";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDbClient } from "../client";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "../testing/database";
import { seedWorkspace, type SeededProfile } from "../testing/fixtures";
import { seedKnowledgeDocument, seedStyleExample, testVector, TEST_EMBEDDING_PROFILE } from "../testing/retrieval-fixtures";
import { createKnowledgeRetriever, createStyleRetriever } from "./retrievers";
import {
  DEFAULT_MIN_LEXICAL_SCORE,
  knowledgeLexicalSql,
  knowledgeSemanticSql,
  searchableExpression,
  styleLexicalSql,
  toVectorLiteral,
} from "./sql";

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
  let constraintDocumentId: string;

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
    constraintDocumentId = semantic.documentId;

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

    it("reads the similarity floor as a similarity, not as a distance", async () => {
      // Cosine 0.5 to the query vector: comfortably below the 0.55 floor, and comfortably above the 0.45
      // that the same number would mean if it were sent as a distance ceiling by mistake. That mistake is
      // invisible in ordinary use — it only ever admits *more* than it should, which looks like working
      // retrieval right up until it quotes something unrelated as a fact.
      const halfway = await seedKnowledgeDocument(database.db, {
        workspaceId,
        businessProfileId: profileB.businessProfileId,
        title: "Halfway",
        chunks: [{ content: "zamboni quokka xylitol", embedding: testVector({ 0: 1, 1: Math.sqrt(3) }) }],
      });

      const facts = await knowledge().search(
        query({ scope: { workspaceId, businessProfileId: profileB.businessProfileId }, text: "zzzznomatch", embedding: vector(HOURS_AXIS) }),
      );

      expect(facts.hits.map((hit) => hit.chunkId)).not.toContain(halfway.chunkIds[0]);
    });

    it("fetches more candidates per list than it returns, or fusion has nothing to fuse", async () => {
      const scope = { workspaceId, businessProfileId: profileB.businessProfileId };
      // Three chunks, arranged so the right answer is second on both lists and first on neither.
      const lexicalOnly = await seedKnowledgeDocument(database.db, { workspaceId, businessProfileId: profileB.businessProfileId, title: "Lexical", chunks: [{ content: "korrigan korrigan korrigan" }] });
      const semanticOnly = await seedKnowledgeDocument(database.db, { workspaceId, businessProfileId: profileB.businessProfileId, title: "Semantic", chunks: [{ content: "utterly different wording", embedding: HOURS_AXIS }] });
      const agreedOn = await seedKnowledgeDocument(database.db, { workspaceId, businessProfileId: profileB.businessProfileId, title: "Both", chunks: [{ content: "korrigan and a good deal of other text to dilute the rank", embedding: NEARLY_HOURS }] });

      const wide = await knowledge().search(query({ scope, text: "korrigan", embedding: vector(HOURS_AXIS), limit: 8 }));
      expect(wide.hits[0]?.chunkId).toBe(agreedOn.chunkIds[0]);
      expect(wide.hits.map((hit) => hit.chunkId)).toEqual(expect.arrayContaining([lexicalOnly.chunkIds[0], semanticOnly.chunkIds[0]]));

      const narrow = await knowledge().search(query({ scope, text: "korrigan", embedding: vector(HOURS_AXIS), limit: 1 }));

      // Asking for one answer must not make each list fetch only one candidate: the chunk both lists
      // agree on is first on neither, so it would never be seen, and the reply would be built on whatever
      // one list happened to rank highest on its own.
      expect(narrow.hits).toHaveLength(1);
      expect(narrow.hits[0]?.chunkId).toBe(agreedOn.chunkIds[0]);
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

    it("has no inert default floor: every matching row clears zero, and a set floor really filters", async () => {
      const rows = (threshold: number) =>
        database.db.$queryRawUnsafe<{ score: number }[]>(
          knowledgeLexicalSql(),
          workspaceId,
          profileA.businessProfileId,
          "saturday opening hours",
          threshold,
          20,
        );

      // `ts_rank_cd` has no IDF, so no floor can separate a stopword match from the key term. The default
      // is zero rather than a small number that would look protective while never excluding anything.
      expect(DEFAULT_MIN_LEXICAL_SCORE).toBe(0);
      const scores = (await rows(DEFAULT_MIN_LEXICAL_SCORE)).map((row) => row.score);
      expect(scores.length).toBeGreaterThan(0);
      expect(Math.min(...scores)).toBeGreaterThan(DEFAULT_MIN_LEXICAL_SCORE);
    });

    it("applies the relevance floor to the lexical list, on a bounded score", async () => {
      const rows = (threshold: number) =>
        database.db.$queryRawUnsafe<{ score: number }[]>(
          knowledgeLexicalSql(),
          workspaceId,
          profileA.businessProfileId,
          "saturday opening hours",
          threshold,
          20,
        );

      const all = await rows(0);
      expect(all.length).toBeGreaterThan(0);
      // Normalized to 0-1, which is what lets one floor mean the same for a long chunk and a short one.
      for (const row of all) {
        expect(row.score).toBeGreaterThan(0);
        expect(row.score).toBeLessThan(1);
      }
      // And the floor is a filter, not decoration: raise it and the same matching text is excluded.
      expect(await rows(0.99)).toHaveLength(0);
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

    it("survives a customer pasting a link, which is where the lexemes themselves carry operators", async () => {
      // The cases above are punctuation the tokenizer discards. These are different and worse: the
      // tokenizer keeps a URL as one lexeme, operators and all, so `a.com/b:z` re-enters the query as
      // `'a.com/b' : 'z'` unless each lexeme is quoted on its way back in — and PostgreSQL then raises a
      // syntax error rather than returning nothing. One customer link would become a retrieval outage.
      for (const link of ["see a.com/b:z now", "see a.com/b!c now", "check a.com/p(1 please", "https://x.io/a?b=1&c=2"]) {
        await expect(knowledge().search(query({ text: link }))).resolves.toHaveProperty("hits");
      }
    });

    it("keeps the lexical score on a 0-1 scale even when a chunk repeats the query many times", async () => {
      const repetitive = await seedKnowledgeDocument(database.db, {
        workspaceId,
        businessProfileId: profileB.businessProfileId,
        title: "Repetitive",
        // Unnormalized `ts_rank_cd` grows without bound with coverage; this body scores about 24 raw.
        chunks: [{ content: "saturday opening hours price booking studio ".repeat(40) }],
      });

      const rows = await database.db.$queryRawUnsafe<{ chunk_id: string; score: number }[]>(
        knowledgeLexicalSql(),
        workspaceId,
        profileB.businessProfileId,
        "saturday opening hours price booking studio",
        0,
        20,
      );

      const hit = rows.find((row) => row.chunk_id === repetitive.chunkIds[0]);
      // Without normalization this is ~24, and every floor a caller sets becomes meaningless: the same
      // number means "barely relevant" for one chunk and "excluded" for another.
      expect(hit?.score).toBeGreaterThan(0);
      expect(hit?.score).toBeLessThanOrEqual(1);
      for (const row of rows) {
        expect(row.score).toBeLessThanOrEqual(1);
      }
    });

    it("breaks a tie by identifier, so the same question twice gives the same answer twice", async () => {
      // Identical content scores identically, and PostgreSQL is then free to return either order. Rows
      // are inserted in descending identifier order on purpose: if the query simply followed the scan,
      // the result would come back in the order below rather than sorted.
      const ids = ["01a0d100-0000-7000-8000-0000000000ff", "01a0d100-0000-7000-8000-0000000000aa", "01a0d100-0000-7000-8000-00000000005c"];
      const document = await seedKnowledgeDocument(database.db, {
        workspaceId,
        businessProfileId: profileB.businessProfileId,
        title: "Tied",
        chunks: [{ content: "tiebreak marker phrase" }],
      });
      for (const [position, id] of ids.entries()) {
        await database.db.$executeRawUnsafe(
          `INSERT INTO "knowledge_chunks" ("id", "workspace_id", "document_id", "document_version", "ordinal", "content", "updated_at")
           VALUES ($1, $2, $3, 1, $4, 'tiebreak marker phrase', NOW())`,
          id,
          workspaceId,
          document.documentId,
          position + 10,
        );
      }

      const first = await database.db.$queryRawUnsafe<{ chunk_id: string }[]>(
        knowledgeLexicalSql(),
        workspaceId,
        profileB.businessProfileId,
        "tiebreak marker phrase",
        0,
        20,
      );
      const returned = first.map((row) => row.chunk_id).filter((id) => ids.includes(id));

      expect(returned).toEqual([...ids].sort());
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

    it("degrades to words when handed a vector of the wrong width, rather than losing the answer", async () => {
      const facts = await knowledge().search(query({ embedding: vector([0.1, 0.2, 0.3]) }));

      // A misconfigured width is not a reason to throw away a lexical list that works perfectly well, and
      // pgvector would otherwise raise on the comparison and have it reported as a corpus outage.
      expect(facts.hits.map((hit) => hit.chunkId)).toContain(baseChunkId);
      expect(facts.diagnostics.semanticCandidates).toBe(0);
      expect(facts.diagnostics.semanticSkipped).toBe("PROVIDER_ERROR");
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

    it("never teaches from an example somebody withdrew", async () => {
      const marker = "withdrawn phrasing nobody should copy";
      await seedStyleExample(database.db, {
        workspaceId,
        businessProfileId: profileB.businessProfileId,
        inboundContext: "zylophone quokka inquiry",
        outboundText: marker,
        status: "ARCHIVED",
      });
      await seedStyleExample(database.db, {
        workspaceId,
        businessProfileId: profileB.businessProfileId,
        inboundContext: "zylophone quokka inquiry",
        outboundText: "the phrasing that is still approved",
      });

      const tone = await style().search(query({ scope: { workspaceId, businessProfileId: profileB.businessProfileId }, text: "zylophone quokka inquiry" }));

      // Archiving an example is how a business retracts a way of speaking. An archived example that still
      // reaches the model is the retraction failing silently, in the one place nobody re-reads.
      expect(tone.hits.length).toBeGreaterThan(0);
      expect(tone.hits.map((hit) => hit.outboundText)).not.toContain(marker);
    });
  });

  describe("style language", () => {
    // A dedicated profile and a phrase nothing else in the suite uses, so each result below is about
    // language and nothing else. Seeded canonical, as the production write path stores it.
    const phrase = "glockenspiel booking question";
    let english: string;
    let french: string;
    let agnostic: string;
    let archivedFrench: string;
    let otherProfileFrench: string;

    beforeAll(async () => {
      const scope = { workspaceId, businessProfileId: profileB.businessProfileId };
      english = await seedStyleExample(database.db, { ...scope, inboundContext: phrase, outboundText: "EN reply", language: "en-US" });
      french = await seedStyleExample(database.db, { ...scope, inboundContext: phrase, outboundText: "FR reply", language: "fr" });
      agnostic = await seedStyleExample(database.db, { ...scope, inboundContext: phrase, outboundText: "agnostic reply" });
      archivedFrench = await seedStyleExample(database.db, { ...scope, inboundContext: phrase, outboundText: "archived FR", language: "fr", status: "ARCHIVED" });
      // Another profile in the same workspace, in the requested language: a language match must never widen scope.
      otherProfileFrench = await seedStyleExample(database.db, {
        workspaceId,
        businessProfileId: profileA.businessProfileId,
        inboundContext: phrase,
        outboundText: "other profile FR",
        language: "fr",
      });
    });

    const ids = async (language?: string) =>
      (
        await retrieveDraftContext(
          { knowledge: knowledge(), style: style(), log: { info: () => undefined, warn: () => undefined }, styleLimit: 20 },
          {
            scope: { workspaceId, businessProfileId: profileB.businessProfileId },
            inbound: [{ kind: "INBOUND", provenance: "m1", text: phrase, occurredAt: new Date() }],
            ...(language === undefined ? {} : { language }),
          },
        )
      ).style.map((hit) => hit.exampleId);

    it("keeps the requested language and the language-agnostic examples, and nothing else", async () => {
      const found = await ids("fr");

      expect(found).toEqual(expect.arrayContaining([french, agnostic]));
      // An example written in another language teaches the wrong rhythm for this reply.
      expect(found).not.toContain(english);
    });

    it("behaves the same way for another language", async () => {
      const found = await ids("en-US");

      expect(found).toEqual(expect.arrayContaining([english, agnostic]));
      expect(found).not.toContain(french);
    });

    it("keeps the whole eligible corpus when no language is requested", async () => {
      // Filtering on a preference nobody expressed would silently shrink it.
      expect(await ids()).toEqual(expect.arrayContaining([english, french, agnostic]));
    });

    it("still excludes archived examples and other Business Profiles, whatever their language", async () => {
      const found = [...(await ids("fr")), ...(await ids())];

      expect(found).not.toContain(archivedFrench);
      expect(found).not.toContain(otherProfileFrench);
    });

    it("does not let a language shape knowledge retrieval", async () => {
      const facts = await retrieveDraftContext(
        { knowledge: knowledge(), style: style(), log: { info: () => undefined, warn: () => undefined } },
        {
          scope: { workspaceId, businessProfileId: profileA.businessProfileId },
          inbound: [{ kind: "INBOUND", provenance: "m1", text: "saturday opening hours", occurredAt: new Date() }],
          language: "fr",
        },
      );

      // The English opening-hours fact still answers a French reply: a fact is a fact whatever language
      // it was written in.
      expect(facts.knowledge.map((hit) => hit.chunkId)).toContain(baseChunkId);
    });
  });

  describe("embedding profile constraints", () => {
    let ordinal = 90;
    const insertChunk = (profile: string | null, embedding: string | null) => {
      ordinal += 1;
      return database.db.$executeRawUnsafe(
        `INSERT INTO "knowledge_chunks"
           ("id", "workspace_id", "document_id", "document_version", "ordinal", "content", "embedding_profile", "embedding", "created_at", "updated_at")
         VALUES (gen_random_uuid()::text, $1, $2, 1, $5, 'probe', $3, $4::vector, NOW(), NOW())`,
        workspaceId,
        constraintDocumentId,
        profile,
        embedding,
        ordinal,
      );
    };

    it("refuses a vector with no profile, and a profile with no vector", async () => {
      // Without this, a vector could outlive the model that produced it and be compared with another
      // model's — the exact silent quality failure ADR-011 asks the profile to prevent.
      await expect(insertChunk(null, `[${testVector({ 0: 1 }).join(",")}]`)).rejects.toThrow(/embedding_profile_check/);
      await expect(insertChunk(TEST_EMBEDDING_PROFILE, null)).rejects.toThrow(/embedding_profile_check/);
      // Both set, or neither, is accepted.
      await expect(insertChunk(TEST_EMBEDDING_PROFILE, `[${testVector({ 0: 1 }).join(",")}]`)).resolves.toBeGreaterThan(0);
      await expect(insertChunk(null, null)).resolves.toBeGreaterThan(0);
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
