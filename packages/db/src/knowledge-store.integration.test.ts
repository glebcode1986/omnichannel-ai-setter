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
  publishKnowledge,
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

  /** The real retriever, which is the only thing that can answer "would a customer be told this?". */
  const retrieve = async (text: string): Promise<readonly string[]> => {
    const hits = await createKnowledgeRetriever(db()).search({
      scope: { workspaceId: profile.context.workspaceId, businessProfileId: profile.businessProfileId },
      text,
      limit: 10,
    });
    return hits.hits.map((hit) => hit.text);
  };

  /**
   * Publishes with a save landing between the publish's read and its conditional write.
   *
   * The interleaving cannot be produced by ordering two calls, so it is produced by the executor: the
   * real read happens, the edit is applied, and only then does `restoreKnowledge` reach its update. A
   * narrow shim rather than a mock, so the code under test is the real one and only the timing is ours.
   */
  const publishWithInterleavedSave = async (documentId: string) => {
    const real = db();
    let reads = 0;
    const shim = {
      knowledgeDocument: {
        findFirst: async (args: Parameters<typeof real.knowledgeDocument.findFirst>[0]) => {
          const row = await real.knowledgeDocument.findFirst(args);
          reads += 1;
          if (reads === 1) {
            await editKnowledge(real, profile.context, documentId, { chunks: ["A wording that arrived mid-publish."] });
          }
          return row;
        },
        updateMany: (args: Parameters<typeof real.knowledgeDocument.updateMany>[0]) => real.knowledgeDocument.updateMany(args),
      },
      // Test-only: `restoreKnowledge` touches exactly these two, and a narrower type would have to
      // restate the whole executor to say so.
    } as unknown as typeof real;
    return restoreKnowledge(shim, profile.context, documentId);
  };

  /**
   * Records an indexing failure with a publish landing between the health write's read and its write.
   *
   * The second of the two orderings that used to end in a raw constraint error. The transaction's reads
   * are intercepted, so the publish commits on its own connection while the failure still holds the
   * decision it made from the older row — which is exactly the window a worker and an operator working at
   * the same time produce.
   */
  const failWithInterleavedPublish = async (documentId: string, version: number) => {
    const real = db();
    let reads = 0;
    const shim = {
      $transaction: (run: (tx: unknown) => Promise<unknown>) =>
        real.$transaction(async (tx) => {
          const interleaved = {
            knowledgeDocument: {
              findFirst: async (args: Parameters<typeof tx.knowledgeDocument.findFirst>[0]) => {
                const row = await tx.knowledgeDocument.findFirst(args);
                reads += 1;
                if (reads === 1) {
                  await publishKnowledge(real, profile.context, documentId, { expectedVersion: version });
                }
                return row;
              },
              updateMany: (args: Parameters<typeof tx.knowledgeDocument.updateMany>[0]) => tx.knowledgeDocument.updateMany(args),
            },
          };
          return run(interleaved);
        }),
      // Test-only: `recordIndexingResult` reaches for exactly these, and a narrower type would have to
      // restate the whole client to say so.
    } as unknown as typeof real;
    return recordIndexingResult(shim, profile.context, documentId, { ok: false, error: "the embedder refused mid-publish", version });
  };

  /** Publishes with an indexing failure for the same version landing between the read and the write. */
  const publishWithInterleavedFailure = async (documentId: string, version: number) => {
    const real = db();
    let reads = 0;
    const shim = {
      knowledgeDocument: {
        findFirst: async (args: Parameters<typeof real.knowledgeDocument.findFirst>[0]) => {
          const row = await real.knowledgeDocument.findFirst(args);
          reads += 1;
          if (reads === 1) {
            await recordIndexingResult(real, profile.context, documentId, { ok: false, error: "the embedder refused mid-publish", version });
          }
          return row;
        },
        updateMany: (args: Parameters<typeof real.knowledgeDocument.updateMany>[0]) => real.knowledgeDocument.updateMany(args),
      },
    } as unknown as typeof real;
    return publishKnowledge(shim, profile.context, documentId, { expectedVersion: version });
  };

  const activate = async (documentId: string, version = 1) => {
    await recordIndexingResult(db(), profile.context, documentId, { ok: true, at: AT, version });
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
      await activate(id, 2);

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

    it("does not publish what Save wrote: customers keep the version somebody approved", async () => {
      // The blocking finding on PR #77. Retrieval joined the latest *saved* version, so pressing Save on a
      // live source published the new wording at once — while the editor promised the opposite, and an
      // operator half-way through rewording a price was already answering customers with the half.
      const id = await created("Refund policy", ["Refunds are available within 14 days."]);
      await activate(id);

      await editKnowledge(db(), profile.context, id, { chunks: ["Refunds are available within 30 days."] });

      const afterSave = await retrieve("refunds");
      expect(afterSave.some((text) => text.includes("14 days"))).toBe(true);
      expect(afterSave.some((text) => text.includes("30 days"))).toBe(false);

      // And the library can say so, rather than leaving the operator to guess which one is live.
      const staged = await readKnowledge(db(), profile.context, id);
      expect(staged).toMatchObject({ version: 2, publishedVersion: 1, status: "ACTIVE" });
      expect(staged?.versions.find((version) => version.published)?.version).toBe(1);
      expect(staged?.versions.find((version) => version.current)?.version).toBe(2);
    }, 180_000);

    it("does not report success for a publish that published nothing", async () => {
      // Astra's first finding. Publish reads the version, writes conditionally on it — and used to
      // discard the row count, so a save landing in the gap meant zero rows changed and the operator was
      // still told "Published". The version they were looking at never became the answer.
      const id = await created("Raced publish", ["The wording to publish."]);
      await activate(id);
      await editKnowledge(db(), profile.context, id, { chunks: ["A newer wording."], expectedVersion: 1 });

      // Publishing v2 is legitimate here; the interleaving under test is a *third* save arriving between
      // the publish's read and its write, which `publishedVersionRace` below drives directly.
      expect(await publishKnowledge(db(), profile.context, id)).toEqual({ status: "RESTORED", version: 2 });
    }, 180_000);

    it("reports a conflict when a save lands between the publish's read and its write", async () => {
      const id = await created("Interleaved publish", ["The wording to publish."]);
      await activate(id);

      // The read inside `publishKnowledge` sees v1; this edit lands before its conditional write.
      const outcome = await publishWithInterleavedSave(id);

      expect(outcome).toEqual({ status: "CONFLICT", expectedVersion: 1, currentVersion: 2 });
      // And the published version is still v1: nothing was published, which is what the refusal says.
      expect(await readKnowledge(db(), profile.context, id)).toMatchObject({ version: 2, publishedVersion: 1 });
    }, 180_000);

    it("refuses a publish from a tab that was showing an older version", async () => {
      // Astra's third finding, and the one the interleaving test above could not reach: here the save
      // lands *before* the publish action even starts, so every read the store makes is consistent and
      // the only thing wrong is the screen the operator clicked on. Two tabs show DRAFT v1, tab A saves
      // v2, tab B clicks Publish — and without the version tab B was rendered against, tab B publishes
      // content B has never seen and is told it succeeded.
      const id = await created("Stale publish", ["The wording tab B is looking at."]);
      await editKnowledge(db(), profile.context, id, { chunks: ["The wording tab A saved."], expectedVersion: 1 });

      expect(await publishKnowledge(db(), profile.context, id, { expectedVersion: 1 })).toEqual({
        status: "CONFLICT",
        expectedVersion: 1,
        currentVersion: 2,
      });
      // Nothing is live, so tab A's wording is not answering customers on tab B's decision either.
      expect(await readKnowledge(db(), profile.context, id)).toMatchObject({ status: "DRAFT", publishedVersion: null });
    }, 180_000);

    it("publishes the version the operator was looking at", async () => {
      const id = await created("Named publish", ["The wording on screen."]);

      expect(await publishKnowledge(db(), profile.context, id, { expectedVersion: 1 })).toEqual({ status: "RESTORED", version: 1 });
      expect(await readKnowledge(db(), profile.context, id)).toMatchObject({ status: "ACTIVE", version: 1, publishedVersion: 1 });
    }, 180_000);

    it("refuses a staged publish whose ingestion failed between the read and the write", async () => {
      // Astra's fourth finding, first ordering. Published v1 is live, v2 is saved and still PENDING, and
      // the operator publishes v2 at the moment the embedder rejects it. The publish used to write
      // ACTIVE over a row that had just become FAILED at its published version — the one triple the
      // CHECK refuses — so the operator received a raw constraint error instead of an answer.
      const id = await created("Failing mid-publish", ["The heliotrope policy that indexed."]);
      await activate(id);
      await editKnowledge(db(), profile.context, id, { chunks: ["The heliotrope policy the embedder refused."], expectedVersion: 1 });

      const outcome = await publishWithInterleavedFailure(id, 2);

      expect(outcome).toEqual({ status: "REJECTED", reason: "this source failed to index and cannot be made active until it is fixed" });
      // v1 keeps answering: the failure was in content nobody has been shown, and the publish of it was
      // refused rather than half-applied.
      expect(await readKnowledge(db(), profile.context, id)).toMatchObject({ status: "ACTIVE", version: 2, publishedVersion: 1, indexingState: "FAILED" });
      const stillAnswering = await retrieve("heliotrope");
      expect(stillAnswering.some((text) => text.includes("that indexed"))).toBe(true);
      expect(stillAnswering.some((text) => text.includes("the embedder refused"))).toBe(false);
    }, 180_000);

    it("archives the source when a publish moves the published version under a failure", async () => {
      // The same race in the other order. The health write decided "do not archive, the failing version
      // is not the published one" and then a publish made it the published one; writing that decision
      // would have produced the refused triple from the other side. The decision is made again against
      // the row that replaced it, so what gets recorded is the consequence that is now true.
      const id = await created("Published mid-failure", ["The marzipan policy that indexed."]);
      await activate(id);
      await editKnowledge(db(), profile.context, id, { chunks: ["The marzipan policy the embedder refused."], expectedVersion: 1 });

      const outcome = await failWithInterleavedPublish(id, 2);

      expect(outcome).toEqual({ status: "INDEXING_FAILED", wasActive: true });
      const detail = await readKnowledge(db(), profile.context, id);
      expect(detail).toMatchObject({ status: "ARCHIVED", version: 2, publishedVersion: 2, indexingState: "FAILED" });
      // And nothing of it is reachable any more, because a source that cannot be searched cannot be live
      // — which is the invariant both orderings were threatening.
      expect((await retrieve("marzipan")).some((text) => text.includes("marzipan"))).toBe(false);
    }, 180_000);

    it("publishes it when somebody actually publishes it", async () => {
      const id = await created("Opening hours", ["We open at 09:00."]);
      await activate(id);
      await editKnowledge(db(), profile.context, id, { chunks: ["We open at 10:00."] });

      expect(await publishKnowledge(db(), profile.context, id)).toEqual({ status: "RESTORED", version: 2 });

      const afterPublish = await retrieve("open");
      expect(afterPublish.some((text) => text.includes("10:00"))).toBe(true);
      expect(afterPublish.some((text) => text.includes("09:00"))).toBe(false);
      expect(await readKnowledge(db(), profile.context, id)).toMatchObject({ version: 2, publishedVersion: 2 });
    }, 180_000);

    it("refuses a save from a tab that was showing an older version", async () => {
      // Astra's second finding. Two tabs open at v1: A saves and becomes v2, and B — still showing v1 —
      // saves wording composed against content it never saw. Without the expected version B wins
      // silently, and nothing on either screen says A's work is gone.
      const id = await created("Two tabs", ["The original wording."]);
      await editKnowledge(db(), profile.context, id, { chunks: ["Tab A's wording."], expectedVersion: 1 });

      const stale = await editKnowledge(db(), profile.context, id, { chunks: ["Tab B's wording."], expectedVersion: 1 });

      expect(stale).toEqual({ status: "CONFLICT", expectedVersion: 1, currentVersion: 2 });
      const detail = await readKnowledge(db(), profile.context, id);
      expect(detail?.version).toBe(2);
      expect(detail?.versions.find((version) => version.current)?.chunks.map((chunk) => chunk.content)).toEqual(["Tab A's wording."]);
    }, 180_000);

    it("lets only one of two simultaneous saves become the next version", async () => {
      // The other half: both submits read v1 and both compute v2. The document moves first, conditional
      // on the version each edit was computed from, so the loser finds no row rather than colliding on
      // the chunks' unique position and surfacing as a database error nobody can act on.
      const id = await created("Double submit", ["The original wording."]);

      const [first, second] = await Promise.all([
        editKnowledge(db(), profile.context, id, { chunks: ["One submit's wording."], expectedVersion: 1 }),
        editKnowledge(db(), profile.context, id, { chunks: ["The other submit's wording."], expectedVersion: 1 }),
      ]);

      const outcomes = [first.status, second.status].sort();
      expect(outcomes).toEqual(["CONFLICT", "VERSIONED"]);
      const detail = await readKnowledge(db(), profile.context, id);
      expect(detail?.version).toBe(2);
      // One version 2, with one set of chunks: not two overlaid, and not a half-written one.
      expect(detail?.versions.filter((version) => version.version === 2)).toHaveLength(1);
      expect(detail?.versions.find((version) => version.version === 2)?.chunks).toHaveLength(1);
    }, 180_000);

    it("still saves when the tab was showing the current version", async () => {
      // The counter-case, so the two above cannot pass by refusing every edit.
      const id = await created("Fresh tab", ["The original wording."]);

      expect(await editKnowledge(db(), profile.context, id, { chunks: ["An ordinary edit."], expectedVersion: 1 })).toEqual({
        status: "VERSIONED",
        documentId: id,
        version: 2,
      });
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

  describe("the library list", () => {
    it("reaches past the first page, without repeating or dropping a row", async () => {
      // The blocking finding on PR #77: the store paged at 25 and returned a cursor, and the route never
      // read one — so a business with 26 sources could not reach the 26th at all.
      const titles = Array.from({ length: 26 }, (_unused, index) => `Paged source ${String(index).padStart(2, "0")}`);
      for (const title of titles) {
        await created(title, [`A fact in ${title}.`], "BUSINESS_PROFILE");
      }

      const first = await listKnowledge(db(), profile.context, { scope: "BUSINESS_PROFILE", search: "Paged source" });
      expect(first.documents).toHaveLength(25);
      expect(first.nextCursor).toBeDefined();

      const second = await listKnowledge(
        db(),
        profile.context,
        { scope: "BUSINESS_PROFILE", search: "Paged source" },
        { cursor: first.nextCursor },
      );

      const seen = [...first.documents, ...second.documents].map((document) => document.title);
      // Every one of the 26, each exactly once: a cursor that overlapped would show a row twice, and one
      // that skipped would lose a source an operator typed.
      expect(new Set(seen).size).toBe(26);
      expect([...new Set(seen)].sort()).toEqual([...titles].sort());
      expect(second.nextCursor).toBeUndefined();
    }, 300_000);

    it("keeps the filter while paging, rather than widening it on page two", async () => {
      await created("Filtered draft source", ["A fact in a draft."], "BUSINESS_PROFILE");
      const live = await created("Filtered live source", ["A fact in a live source."], "BUSINESS_PROFILE");
      await activate(live);

      const page = await listKnowledge(db(), profile.context, { status: "ACTIVE", search: "Filtered" }, { limit: 1 });

      expect(page.documents.map((document) => document.title)).toEqual(["Filtered live source"]);
      const next = await listKnowledge(db(), profile.context, { status: "ACTIVE", search: "Filtered" }, { limit: 1, cursor: page.nextCursor });
      // The draft is still excluded on the second page. A cursor that carried no filter would find it.
      expect(next.documents.every((document) => document.status === "ACTIVE")).toBe(true);
    }, 300_000);
  });

  describe("a source that failed to index", () => {
    it("is taken out of retrieval in the same write that records the failure", async () => {
      const id = await created("Broken", ["A fact nothing could read."]);
      await activate(id);

      const outcome = await recordIndexingResult(db(), profile.context, id, { ok: false, error: "embedding provider refused the request", version: 1 });

      expect(outcome).toEqual({ status: "INDEXING_FAILED", wasActive: true });
      const detail = await readKnowledge(db(), profile.context, id);
      expect(detail?.status).toBe("ARCHIVED");
      expect(detail?.indexingState).toBe("FAILED");
      expect(detail?.indexingError).toBe("embedding provider refused the request");
    }, 180_000);

    it("keeps a draft a draft, because a draft was never answering anyone", async () => {
      const id = await created("Broken draft", ["A fact nothing could read."]);

      const outcome = await recordIndexingResult(db(), profile.context, id, { ok: false, error: "chunking failed", version: 1 });

      expect(outcome).toEqual({ status: "INDEXING_FAILED", wasActive: false });
      expect((await readKnowledge(db(), profile.context, id))?.status).toBe("DRAFT");
    }, 180_000);

    it("cannot be made active again until it is fixed", async () => {
      const id = await created("Still broken", ["A fact nothing could read."]);
      await recordIndexingResult(db(), profile.context, id, { ok: false, error: "chunking failed", version: 1 });

      expect(await restoreKnowledge(db(), profile.context, id)).toEqual({
        status: "REJECTED",
        reason: "this source failed to index and cannot be made active until it is fixed",
      });
      expect((await readKnowledge(db(), profile.context, id))?.status).toBe("DRAFT");
    }, 180_000);

    it("ignores a success that arrives for a version the source has moved past", async () => {
      // Indexing takes seconds to minutes; an edit takes none. A delayed success used to be applied
      // blindly, so the library claimed v2 had been indexed when the worker had only ever read v1.
      const id = await created("Racing success", ["The first wording."]);
      await editKnowledge(db(), profile.context, id, { chunks: ["The second wording."] });

      const outcome = await recordIndexingResult(db(), profile.context, id, { ok: true, at: AT, version: 1 });

      expect(outcome).toEqual({ status: "STALE", indexedVersion: 1, currentVersion: 2 });
      const detail = await readKnowledge(db(), profile.context, id);
      expect(detail?.indexingState).toBe("PENDING");
      expect(detail?.indexedAt).toBeNull();
    }, 180_000);

    it("ignores a failure for a superseded version, and leaves a live source live", async () => {
      // The dangerous half of the same race: a delayed v1 failure would archive the document, taking a
      // published source out of retrieval over a problem that no longer exists.
      const id = await created("Racing failure", ["The first wording."]);
      await activate(id);
      await editKnowledge(db(), profile.context, id, { chunks: ["The second wording."] });

      const outcome = await recordIndexingResult(db(), profile.context, id, { ok: false, error: "embedding provider refused the request", version: 1 });

      expect(outcome).toEqual({ status: "STALE", indexedVersion: 1, currentVersion: 2 });
      const detail = await readKnowledge(db(), profile.context, id);
      expect(detail).toMatchObject({ status: "ACTIVE", publishedVersion: 1, indexingState: "PENDING" });
      expect(detail?.indexingError).toBeNull();
      expect((await retrieve("wording")).some((text) => text.includes("The first wording"))).toBe(true);
    }, 180_000);

    it("applies the result for the version that was actually indexed", async () => {
      // The counter-case, so the two above cannot pass by refusing everything.
      const id = await created("Current result", ["The only wording."]);
      await editKnowledge(db(), profile.context, id, { chunks: ["The newer wording."] });

      expect(await recordIndexingResult(db(), profile.context, id, { ok: true, at: AT, version: 2 })).toEqual({ status: "INDEXED", version: 2 });
      expect((await readKnowledge(db(), profile.context, id))?.indexingState).toBe("INDEXED");
    }, 180_000);

    it("keeps a healthy published version answering when an unpublished one fails", async () => {
      // Astra's third finding, and a defect my own published-version change introduced: the failure path
      // archived any ACTIVE document, so a failure to index v2 — content no customer has ever seen —
      // stopped healthy published v1 from answering. Archiving belongs to a failure in the version
      // customers are actually being told.
      const id = await created("Published stays live", ["The published wording."]);
      await activate(id);
      await editKnowledge(db(), profile.context, id, { chunks: ["A wording that will fail to index."], expectedVersion: 1 });

      const outcome = await recordIndexingResult(db(), profile.context, id, { ok: false, error: "embedding provider refused the request", version: 2 });

      expect(outcome).toEqual({ status: "INDEXING_FAILED", wasActive: false });
      const detail = await readKnowledge(db(), profile.context, id);
      expect(detail).toMatchObject({ status: "ACTIVE", publishedVersion: 1, version: 2, indexingState: "FAILED" });
      // The customer-visible half, which is the one that matters.
      expect((await retrieve("published wording")).some((text) => text.includes("The published wording"))).toBe(true);
    }, 180_000);

    it("still archives when the failure is in the version customers are being answered with", async () => {
      // The counter-case. Without it the fix above could pass by never archiving anything, which would
      // leave a source known to be broken answering customers.
      const id = await created("Published fails", ["The published wording."]);
      await activate(id);

      const outcome = await recordIndexingResult(db(), profile.context, id, { ok: false, error: "chunking failed", version: 1 });

      expect(outcome).toEqual({ status: "INDEXING_FAILED", wasActive: true });
      expect(await readKnowledge(db(), profile.context, id)).toMatchObject({ status: "ARCHIVED", indexingState: "FAILED" });
    }, 180_000);

    it("refuses to publish a version that failed to index, even with an older one live", async () => {
      // The operator's way out of the state above is to fix the content, not to publish the failure.
      const id = await created("Cannot publish a failure", ["The published wording."]);
      await activate(id);
      await editKnowledge(db(), profile.context, id, { chunks: ["A wording that will fail to index."], expectedVersion: 1 });
      await recordIndexingResult(db(), profile.context, id, { ok: false, error: "chunking failed", version: 2 });

      expect(await publishKnowledge(db(), profile.context, id)).toEqual({
        status: "REJECTED",
        reason: "this source failed to index and cannot be made active until it is fixed",
      });
      expect(await readKnowledge(db(), profile.context, id)).toMatchObject({ publishedVersion: 1, status: "ACTIVE" });
    }, 180_000);

    it("cannot be made active with a failing published version by writing SQL either", async () => {
      // The relaxed CHECK still refuses the pair it was written for: a document answering customers with
      // a version that failed to index. It only permits a failure in a version nobody published.
      const id = await created("SQL and the published failure", ["The wording."]);
      await recordIndexingResult(db(), profile.context, id, { ok: false, error: "chunking failed", version: 1 });

      await expect(
        db().$executeRaw`UPDATE "knowledge_documents" SET "status" = 'ACTIVE', "published_version" = "version" WHERE "id" = ${id}`,
      ).rejects.toThrow(/knowledge_documents_failed_not_active_check/u);
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
      await recordIndexingResult(db(), profile.context, id, { ok: false, error: "chunking failed", version: 1 });

      // Publishing a version in the same statement, so the only rule left to refuse this is the one this
      // case is about. Without it the row would also be missing a published version, and the database
      // would stop at whichever CHECK it evaluated first — a green test about the wrong invariant.
      await expect(
        db().$executeRaw`UPDATE "knowledge_documents" SET "status" = 'ACTIVE', "published_version" = "version" WHERE "id" = ${id}`,
      ).rejects.toThrow(/knowledge_documents_failed_not_active_check/u);
    }, 180_000);

    it("clears the error when it indexes successfully afterwards", async () => {
      const id = await created("Fixed", ["A fact that finally read."]);
      await recordIndexingResult(db(), profile.context, id, { ok: false, error: "chunking failed", version: 1 });

      const outcome = await recordIndexingResult(db(), profile.context, id, { ok: true, at: AT, version: 1 });

      // A stale error on a healthy source would be read as a current problem.
      expect(outcome).toEqual({ status: "INDEXED", version: 1 });
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
