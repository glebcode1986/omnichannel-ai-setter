/**
 * The internal seeding path (product-owner decision on PR #66): enough to let #16 and CI exercise real
 * retrieval before Phase 5 builds the Knowledge and Style screens, and no more than that.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createKnowledgeRetriever, createStyleRetriever } from "./retrievers";
import { seedKnowledge, seedStyleExample } from "./seed";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "../testing/database";
import { seedWorkspace, type SeededProfile } from "../testing/fixtures";
import { testVector, TEST_EMBEDDING_PROFILE } from "../testing/retrieval-fixtures";

describe.skipIf(!databaseTestsEnabled())("internal knowledge and style seeding (PostgreSQL)", () => {
  let database: TestDatabase;
  let profile: SeededProfile;
  let other: SeededProfile;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    const workspace = await seedWorkspace(database.db, "seeding", ["alpha", "beta"]);
    [profile, other] = workspace.profiles as [SeededProfile, SeededProfile];
  }, 120_000);

  afterAll(async () => {
    await database?.dispose();
  });

  const query = (overrides: Record<string, unknown> = {}) => ({
    scope: { workspaceId: profile.context.workspaceId, businessProfileId: profile.businessProfileId },
    text: "saturday opening hours",
    limit: 8,
    ...overrides,
  });

  it("seeds knowledge that retrieval can actually find, with its version and provenance", async () => {
    const seeded = await seedKnowledge(database.db, profile.context, {
      title: "Opening hours",
      version: 3,
      chunks: [{ content: "Saturday opening hours are 10:00 to 18:00." }],
    });

    const hits = await createKnowledgeRetriever(database.db).search(query());

    const hit = hits.hits.find((candidate) => candidate.chunkId === seeded.chunkIds[0]);
    expect(hit).toBeDefined();
    // Versioned and provenanced, exactly as the real editor will write it — not a shortcut around it.
    expect(hit?.documentVersion).toBe(3);
    expect(hit?.documentTitle).toBe("Opening hours");
    expect(hit?.sourceType).toBe("MANUAL");
    expect(hit?.scopeLevel).toBe("WORKSPACE");
  }, 120_000);

  it("keeps profile-scoped seeding inside its own Business Profile", async () => {
    const seeded = await seedKnowledge(database.db, profile.context, {
      title: "Alpha studio hours",
      businessProfileScoped: true,
      chunks: [{ content: "The alpha studio keeps saturday hours from 09:00." }],
    });

    const mine = await createKnowledgeRetriever(database.db).search(query());
    const theirs = await createKnowledgeRetriever(database.db).search(
      query({ scope: { workspaceId: other.context.workspaceId, businessProfileId: other.businessProfileId } }),
    );

    expect(mine.hits.map((hit) => hit.chunkId)).toContain(seeded.chunkIds[0]);
    expect(theirs.hits.map((hit) => hit.chunkId)).not.toContain(seeded.chunkIds[0]);
  }, 120_000);

  it("seeds embedded chunks that semantic retrieval can reach", async () => {
    const axis = testVector({ 5: 1 });
    const seeded = await seedKnowledge(database.db, profile.context, {
      title: "Weekend schedule",
      chunks: [{ content: "Le weekend nous ouvrons a dix heures.", embedding: axis, embeddingProfile: TEST_EMBEDDING_PROFILE }],
    });

    const hits = await createKnowledgeRetriever(database.db).search(
      query({ text: "zzzznomatch", embedding: { profile: TEST_EMBEDDING_PROFILE, values: axis } }),
    );

    expect(hits.hits.map((hit) => hit.chunkId)).toContain(seeded.chunkIds[0]);
  }, 120_000);

  it("refuses a vector without the profile that produced it", async () => {
    // The CHECK constraint is the reason a stored vector can never outlive the model that made it.
    await expect(
      seedKnowledge(database.db, profile.context, {
        title: "Broken",
        chunks: [{ content: "x", embedding: testVector({ 0: 1 }) }],
      }),
    ).rejects.toThrow(/embedding_profile_check/);
  }, 120_000);
});

describe.skipIf(!databaseTestsEnabled())("style language preference (PostgreSQL)", () => {
  let database: TestDatabase;
  let profile: SeededProfile;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    [profile] = (await seedWorkspace(database.db, "language")).profiles as [SeededProfile];

    await seedStyleExample(database.db, profile.context, {
      inboundContext: "are you open on saturday?",
      outboundText: "Hey! Yes — 10 till 6 on Saturdays",
      language: "en",
    });
    await seedStyleExample(database.db, profile.context, {
      inboundContext: "are you open on saturday?",
      outboundText: "Hallo! Ja — Samstags 10 bis 18 Uhr",
      language: "de",
    });
    await seedStyleExample(database.db, profile.context, {
      inboundContext: "are you open on saturday?",
      outboundText: "10-18 :)",
    });
  }, 120_000);

  afterAll(async () => {
    await database?.dispose();
  });

  const search = (language?: string) =>
    createStyleRetriever(database.db).search({
      scope: { workspaceId: profile.context.workspaceId, businessProfileId: profile.businessProfileId },
      text: "are you open on saturday",
      limit: 8,
      ...(language === undefined ? {} : { language }),
    });

  it("keeps the asked-for language and the examples that claim none", async () => {
    const hits = await search("en");
    const texts = hits.hits.map((hit) => hit.outboundText);

    expect(texts).toContain("Hey! Yes — 10 till 6 on Saturdays");
    // A language-agnostic example is a deliberate fallback, not an unknown to be filtered out.
    expect(texts).toContain("10-18 :)");
    // A German example would teach the wrong rhythm for an English reply.
    expect(texts).not.toContain("Hallo! Ja — Samstags 10 bis 18 Uhr");
  }, 120_000);

  it("keeps the whole corpus when no language was asked for", async () => {
    const hits = await search();

    // Filtering on a preference nobody expressed would silently shrink the corpus.
    expect(hits.hits).toHaveLength(3);
  }, 120_000);

  it("returns only the language-agnostic example for a language nobody has written in", async () => {
    const hits = await search("ja");

    expect(hits.hits.map((hit) => hit.outboundText)).toEqual(["10-18 :)"]);
  }, 120_000);

  it("never lets a style example become factual support, whatever its language", async () => {
    const facts = await createKnowledgeRetriever(database.db).search({
      scope: { workspaceId: profile.context.workspaceId, businessProfileId: profile.businessProfileId },
      text: "are you open on saturday",
      limit: 8,
    });

    // Three human examples answer this exact question, and the factual corpus still has nothing to say.
    expect(facts.hits).toHaveLength(0);
  }, 120_000);
});
