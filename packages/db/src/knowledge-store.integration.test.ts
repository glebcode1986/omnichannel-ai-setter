/**
 * The Knowledge Library's writes, against a real server (Issue #31).
 *
 * Two invariants carry this file. **Editing creates a version rather than replacing one** — and the proof
 * is not that a number went up, it is that the old wording is still readable and the new wording is the
 * only one retrieval can reach. **A failed ingestion cannot look active** — enforced by a CHECK, so the
 * test that matters is the one that tries to break it directly in SQL and is refused.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  archiveKnowledge,
  createKnowledge,
  editKnowledge,
  listKnowledge,
  readKnowledge,
  recordIndexingResult,
  restoreKnowledge,
} from "./knowledge-store";
import { createKnowledgeRetriever } from "./retrieval/retrievers";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { seedWorkspace, type SeededProfile, type SeededWorkspace } from "./testing/fixtures";

const AT = new Date("2026-09-30T12:00:00.000Z");

describe.skipIf(!databaseTestsEnabled())("the Knowledge Library", () => {
  let database: TestDatabase;
  let workspace: SeededWorkspace;
  let profile: SeededProfile;
  let sibling: SeededProfile;
  let neighbour: SeededWorkspace;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    workspace = await seedWorkspace(database.db, "knowledge", ["main", "sibling"]);
    [profile, sibling] = workspace.profiles as [SeededProfile, SeededProfile];
    neighbour = await seedWorkspace(database.db, "knowledge-neighbour");
  }, 180_000);

  afterAll(async () => {
    await database?.dispose();
  });

  const db = () => database.db;

  const created = async (title: string, chunks: readonly string[], scope?: "WORKSPACE" | "BUSINESS_PROFILE") => {
    const outcome = await createKnowledge(db(), profile.context, { title, chunks: [...chunks], ...(scope === undefined ? {} : { scope }) });
    if (outcome.status !== "CREATED") {
      throw new Error(`expected CREATED, got ${outcome.status}`);
    }
    return outcome.documentId;
  };

  const activate = async (documentId: string) => {
    await recordIndexingResult(db(), profile.context, documentId, { ok: true, at: AT });
    return restoreKnowledge(db(), profile.context, documentId);
  };

  describe("creating a source", () => {
    it("starts as a draft, so half-written facts do not answer customers", async () => {
      const id = await created("Opening hours", ["We open at 10 on Saturday."]);

      const detail = await readKnowledge(db(), profile.context, id);

      expect(detail?.status).toBe("DRAFT");
      expect(detail?.version).toBe(1);
      expect(detail?.indexingState).toBe("PENDING");
      expect(detail?.versions[0]?.chunks.map((chunk) => chunk.content)).toEqual(["We open at 10 on Saturday."]);
    }, 180_000);

    it("records who wrote it", async () => {
      const id = await created("Attributed", ["A stated fact."]);

      // Attribution is the point of provenance: a fact with no author is a fact nobody can ask about.
      expect((await readKnowledge(db(), profile.context, id))?.createdByName).toBe("Test knowledge-owner");
    }, 180_000);

    it("refuses a source with no facts in it", async () => {
      // An empty document is one the assistant can never cite, with nothing on screen to explain why.
      expect(await createKnowledge(db(), profile.context, { title: "Empty", chunks: [] })).toEqual({
        status: "REJECTED",
        reason: "a knowledge source needs at least one fact",
      });
      expect(await createKnowledge(db(), profile.context, { title: "Blank", chunks: ["   ", ""] })).toEqual({
        status: "REJECTED",
        reason: "a knowledge source needs at least one fact",
      });
    }, 180_000);

    it("refuses a source with no title", async () => {
      expect(await createKnowledge(db(), profile.context, { title: "  ", chunks: ["A fact."] })).toEqual({
        status: "REJECTED",
        reason: "a knowledge source needs a title",
      });
    }, 180_000);
  });

  describe("editing", () => {
    it("creates a version and keeps the old wording readable", async () => {
      const id = await created("Prices", ["A haircut is 30 euros."]);

      const outcome = await editKnowledge(db(), profile.context, id, { chunks: ["A haircut is 35 euros."] });
      const detail = await readKnowledge(db(), profile.context, id);

      expect(outcome).toEqual({ status: "VERSIONED", documentId: id, version: 2 });
      expect(detail?.version).toBe(2);
      // Both versions are there, and only the newer one is current. This is the audit trail: last month's
      // price is still answerable as a question about what we used to say.
      expect(detail?.versions.map((version) => version.version)).toEqual([2, 1]);
      expect(detail?.versions[0]?.chunks.map((chunk) => chunk.content)).toEqual(["A haircut is 35 euros."]);
      expect(detail?.versions[1]?.chunks.map((chunk) => chunk.content)).toEqual(["A haircut is 30 euros."]);
      expect(detail?.versions.filter((version) => version.current).map((version) => version.version)).toEqual([2]);
    }, 180_000);

    it("makes the superseded version unreachable by retrieval", async () => {
      const id = await created("Superseded prices", ["A manicure is 20 euros."]);
      await activate(id);
      await editKnowledge(db(), profile.context, id, { chunks: ["A manicure is 25 euros."] });
      await activate(id);

      const hits = await createKnowledgeRetriever(db()).search({
        scope: { workspaceId: profile.context.workspaceId, businessProfileId: profile.businessProfileId },
        text: "manicure",
        limit: 10,
      });
      const contents = hits.hits.map((hit) => hit.text);

      // The old row still exists for audit, and retrieval joins on the current version, so it cannot be
      // served. Filtering on status alone would keep answering with last month's price.
      expect(contents.some((content) => content.includes("25 euros"))).toBe(true);
      expect(contents.some((content) => content.includes("20 euros"))).toBe(false);
    }, 180_000);

    it("treats an identical save as no edit at all", async () => {
      const id = await created("Unchanged", ["Nothing moved."]);

      const outcome = await editKnowledge(db(), profile.context, id, { chunks: ["Nothing moved."] });

      // A history where every save is a version is a history nobody reads.
      expect(outcome).toEqual({ status: "UNCHANGED", documentId: id, version: 1 });
      expect((await readKnowledge(db(), profile.context, id))?.versions).toHaveLength(1);
    }, 180_000);

    it("versions a rename, because the title is how an operator finds a source", async () => {
      const id = await created("Old name", ["A stated fact."]);

      const outcome = await editKnowledge(db(), profile.context, id, { title: "New name" });

      expect(outcome.status).toBe("VERSIONED");
      expect((await readKnowledge(db(), profile.context, id))?.title).toBe("New name");
    }, 180_000);

    it("sends the document back to PENDING, whatever the previous version had managed", async () => {
      const id = await created("Reindexed", ["First wording."]);
      await activate(id);
      expect((await readKnowledge(db(), profile.context, id))?.indexingState).toBe("INDEXED");

      await editKnowledge(db(), profile.context, id, { chunks: ["Second wording."] });

      // Otherwise the library shows a green source whose current wording nothing has ever read.
      const detail = await readKnowledge(db(), profile.context, id);
      expect(detail?.indexingState).toBe("PENDING");
      expect(detail?.indexedAt).toBeNull();
    }, 180_000);

    it("refuses to empty a source through an edit", async () => {
      const id = await created("Not emptied", ["A stated fact."]);

      expect(await editKnowledge(db(), profile.context, id, { chunks: [] })).toEqual({
        status: "REJECTED",
        reason: "a knowledge source needs at least one fact",
      });
      expect((await readKnowledge(db(), profile.context, id))?.version).toBe(1);
    }, 180_000);

    it("cannot edit another Workspace's source", async () => {
      const [theirProfile] = neighbour.profiles as [SeededProfile];
      const theirs = await createKnowledge(db(), theirProfile.context, { title: "Theirs", chunks: ["Their fact."] });
      const theirId = theirs.status === "CREATED" ? theirs.documentId : "";

      expect(await editKnowledge(db(), profile.context, theirId, { chunks: ["Hijacked."] })).toEqual({ status: "GONE" });
      expect((await readKnowledge(db(), theirProfile.context, theirId))?.versions[0]?.chunks[0]?.content).toBe("Their fact.");
    }, 180_000);
  });

  describe("archiving and restoring", () => {
    it("takes an archived source out of retrieval, and brings it back", async () => {
      const id = await created("Seasonal", ["We close for August."]);
      await activate(id);

      await archiveKnowledge(db(), profile.context, id);
      const whileArchived = await createKnowledgeRetriever(db()).search({
        scope: { workspaceId: profile.context.workspaceId, businessProfileId: profile.businessProfileId },
        text: "August",
        limit: 10,
      });

      await restoreKnowledge(db(), profile.context, id);
      const whenRestored = await createKnowledgeRetriever(db()).search({
        scope: { workspaceId: profile.context.workspaceId, businessProfileId: profile.businessProfileId },
        text: "August",
        limit: 10,
      });

      expect(whileArchived.hits.some((hit) => hit.text.includes("August"))).toBe(false);
      expect(whenRestored.hits.some((hit) => hit.text.includes("August"))).toBe(true);
    }, 180_000);

    it("keeps an archived source readable, so it can be reviewed before it comes back", async () => {
      const id = await created("Archived but readable", ["A stated fact."]);
      await archiveKnowledge(db(), profile.context, id);

      const detail = await readKnowledge(db(), profile.context, id);
      expect(detail?.status).toBe("ARCHIVED");
      expect(detail?.versions[0]?.chunks).toHaveLength(1);
    }, 180_000);

    it("says GONE rather than pretending, for a source that is not ours", async () => {
      const [theirProfile] = neighbour.profiles as [SeededProfile];
      const theirs = await createKnowledge(db(), theirProfile.context, { title: "Not ours", chunks: ["Their fact."] });
      const theirId = theirs.status === "CREATED" ? theirs.documentId : "";

      expect(await archiveKnowledge(db(), profile.context, theirId)).toEqual({ status: "GONE" });
      expect((await readKnowledge(db(), theirProfile.context, theirId))?.status).toBe("DRAFT");
    }, 180_000);
  });

  describe("a source that failed to index", () => {
    it("is taken out of retrieval in the same write that records the failure", async () => {
      const id = await created("Broken", ["A fact nothing could read."]);
      await activate(id);

      const outcome = await recordIndexingResult(db(), profile.context, id, { ok: false, error: "embedding provider refused the request" });

      expect(outcome).toEqual({ status: "INDEXING_FAILED", wasActive: true });
      const detail = await readKnowledge(db(), profile.context, id);
      expect(detail?.status).toBe("ARCHIVED");
      expect(detail?.indexingState).toBe("FAILED");
      expect(detail?.indexingError).toBe("embedding provider refused the request");
    }, 180_000);

    it("keeps a draft a draft, because a draft was never answering anyone", async () => {
      const id = await created("Broken draft", ["A fact nothing could read."]);

      const outcome = await recordIndexingResult(db(), profile.context, id, { ok: false, error: "chunking failed" });

      expect(outcome).toEqual({ status: "INDEXING_FAILED", wasActive: false });
      expect((await readKnowledge(db(), profile.context, id))?.status).toBe("DRAFT");
    }, 180_000);

    it("cannot be made active again until it is fixed", async () => {
      const id = await created("Still broken", ["A fact nothing could read."]);
      await recordIndexingResult(db(), profile.context, id, { ok: false, error: "chunking failed" });

      expect(await restoreKnowledge(db(), profile.context, id)).toEqual({
        status: "REJECTED",
        reason: "this source failed to index and cannot be made active until it is fixed",
      });
      expect((await readKnowledge(db(), profile.context, id))?.status).toBe("DRAFT");
    }, 180_000);

    /**
     * The invariant, tested against the database rather than against this file.
     *
     * "Failed ingestion cannot look active" has to hold for a migration, a console session and any code
     * written after this one — so it is a CHECK, and the test that means anything is the one that tries to
     * violate it directly in SQL.
     */
    it("cannot be made active by writing SQL either", async () => {
      const id = await created("SQL cannot help", ["A fact nothing could read."]);
      await recordIndexingResult(db(), profile.context, id, { ok: false, error: "chunking failed" });

      await expect(db().$executeRaw`UPDATE "knowledge_documents" SET "status" = 'ACTIVE' WHERE "id" = ${id}`).rejects.toThrow(
        /knowledge_documents_failed_not_active_check/u,
      );
    }, 180_000);

    it("clears the error when it indexes successfully afterwards", async () => {
      const id = await created("Fixed", ["A fact that finally read."]);
      await recordIndexingResult(db(), profile.context, id, { ok: false, error: "chunking failed" });

      const outcome = await recordIndexingResult(db(), profile.context, id, { ok: true, at: AT });

      // A stale error on a healthy source would be read as a current problem.
      expect(outcome).toEqual({ status: "INDEXED" });
      const detail = await readKnowledge(db(), profile.context, id);
      expect(detail?.indexingError).toBeNull();
      expect(detail?.indexedAt?.toISOString()).toBe(AT.toISOString());
    }, 180_000);
  });

  describe("scope", () => {
    it("shows Workspace knowledge to every profile, and profile knowledge to one", async () => {
      const shared = await created("Shared policy", ["Deposits are non-refundable."], "WORKSPACE");
      const mine = await created("My policy", ["We take walk-ins."], "BUSINESS_PROFILE");

      const here = (await listKnowledge(db(), profile.context)).documents.map((document) => document.id);
      const nextdoor = (await listKnowledge(db(), sibling.context)).documents.map((document) => document.id);

      expect(here).toEqual(expect.arrayContaining([shared, mine]));
      expect(nextdoor).toContain(shared);
      expect(nextdoor).not.toContain(mine);
    }, 180_000);

    it("can be asked for only the shared knowledge, or only this profile's", async () => {
      const shared = await created("Filtered shared", ["Shared fact."], "WORKSPACE");
      const mine = await created("Filtered mine", ["My fact."], "BUSINESS_PROFILE");

      const workspaceOnly = (await listKnowledge(db(), profile.context, { scope: "WORKSPACE" })).documents;
      const profileOnly = (await listKnowledge(db(), profile.context, { scope: "BUSINESS_PROFILE" })).documents;

      // An agency needs to see which facts it is sharing across every client, and which belong to one.
      expect(workspaceOnly.map((document) => document.id)).toContain(shared);
      expect(workspaceOnly.map((document) => document.id)).not.toContain(mine);
      expect(workspaceOnly.every((document) => document.scope === "WORKSPACE")).toBe(true);
      expect(profileOnly.map((document) => document.id)).toContain(mine);
      expect(profileOnly.map((document) => document.id)).not.toContain(shared);
      expect(profileOnly.every((document) => document.scope === "BUSINESS_PROFILE")).toBe(true);
    }, 180_000);

    it("reports which scope each source belongs to", async () => {
      const shared = await created("Scoped shared", ["Shared fact."], "WORKSPACE");
      const mine = await created("Scoped mine", ["My fact."], "BUSINESS_PROFILE");
      const byId = new Map((await listKnowledge(db(), profile.context)).documents.map((document) => [document.id, document]));

      expect(byId.get(shared)?.scope).toBe("WORKSPACE");
      expect(byId.get(mine)?.scope).toBe("BUSINESS_PROFILE");
    }, 180_000);

    it("filters by status and by indexing state, and searches the title", async () => {
      const draft = await created("Searchable draft", ["A fact."]);
      const live = await created("Searchable live", ["Another fact."]);
      await activate(live);

      const drafts = (await listKnowledge(db(), profile.context, { status: "DRAFT", search: "Searchable" })).documents.map((document) => document.id);
      const indexed = (await listKnowledge(db(), profile.context, { indexingState: "INDEXED", search: "Searchable" })).documents.map((document) => document.id);
      const byTitle = (await listKnowledge(db(), profile.context, { search: "searchable LIVE" })).documents.map((document) => document.id);

      expect(drafts).toContain(draft);
      expect(drafts).not.toContain(live);
      expect(indexed).toContain(live);
      expect(indexed).not.toContain(draft);
      // Case-insensitive, and matching the title rather than the facts inside — finding facts is the
      // retrieval tester's job, and it uses the real retriever.
      expect(byTitle).toEqual([live]);
      expect((await listKnowledge(db(), profile.context, { search: "Another fact" })).documents).toEqual([]);
    }, 180_000);

    it("never shows another Workspace's knowledge", async () => {
      const [theirProfile] = neighbour.profiles as [SeededProfile];
      const theirs = await createKnowledge(db(), theirProfile.context, { title: "Elsewhere", chunks: ["Their fact."] });
      const theirId = theirs.status === "CREATED" ? theirs.documentId : "";

      expect((await listKnowledge(db(), profile.context)).documents.map((document) => document.id)).not.toContain(theirId);
      expect(await readKnowledge(db(), profile.context, theirId)).toBeUndefined();
    }, 180_000);
  });
});
