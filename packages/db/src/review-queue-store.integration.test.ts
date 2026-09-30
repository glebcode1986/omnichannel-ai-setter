/**
 * Reading the Review queue (Issue #29).
 *
 * The case that decides whether this queue is safe is staleness. A draft answers a conversation as it was
 * at one state version; the moment the customer writes again, that answer is about a question they have
 * already replaced. The flag is derived on read from the two version numbers, so these tests move the
 * conversation forward and check the queue notices — including that it keeps showing the item rather than
 * hiding it, because a review item that vanishes is a decision nobody gets to make.
 */
import { noRetrieval } from "@omnichannel/application";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAiDraftStore } from "./ai-draft-store";
import { listReviewQueue } from "./review-queue-store";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { seedWorkspace, type SeededProfile, type SeededWorkspace } from "./testing/fixtures";

describe.skipIf(!databaseTestsEnabled())("the Review queue", () => {
  let database: TestDatabase;
  let workspace: SeededWorkspace;
  let profile: SeededProfile;
  let neighbour: SeededWorkspace;
  let seq = 0;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    workspace = await seedWorkspace(database.db, "queue");
    [profile] = workspace.profiles as [SeededProfile];
    neighbour = await seedWorkspace(database.db, "queue-neighbour");
  }, 120_000);

  afterAll(async () => {
    await database?.dispose();
  });

  const db = () => database.db;
  const scopeOf = (target: SeededProfile) => ({ workspaceId: target.context.workspaceId, businessProfileId: target.businessProfileId });

  const draft = async (
    options: {
      readonly target?: SeededProfile;
      readonly text?: string | null;
      readonly reasonCodes?: readonly string[];
      readonly confidence?: number;
      readonly anchorStateVersion?: number;
      readonly status?: "PENDING" | "HELD";
      readonly retrieval?: Parameters<ReturnType<typeof createAiDraftStore>["saveDraft"]>[0]["retrieval"];
      readonly factualSourceIds?: readonly string[];
    } = {},
  ): Promise<string> => {
    seq += 1;
    const target = options.target ?? profile;
    const { aiDraftId } = await createAiDraftStore(db()).saveDraft({
      scope: { ...scopeOf(target), conversationId: target.conversationId },
      generationKey: `queue_${String(seq)}`,
      trigger: "AUTOMATIC",
      anchorMessageId: target.messageId,
      anchorStateVersion: options.anchorStateVersion ?? 1,
      text: options.text === undefined ? `Reply ${String(seq)}` : options.text,
      structuredOutput: { reply: "x" },
      confidence: options.confidence ?? 0.72,
      modelSuggestsSend: false,
      needsReview: true,
      reasonCodes: [...(options.reasonCodes ?? ["LOW_CONFIDENCE"])],
      factualSourceIds: [...(options.factualSourceIds ?? [])],
      retrieval: options.retrieval ?? noRetrieval("OK"),
      status: options.status ?? "PENDING",
      provider: "anthropic",
      model: "claude-opus-5",
      promptVersion: "reply.v1",
      schemaVersion: "ai-draft.v1",
    });
    return aiDraftId;
  };

  const setStateVersion = (target: SeededProfile, version: number) =>
    db().conversation.update({
      where: { workspaceId_businessProfileId_id: { ...scopeOf(target), id: target.conversationId } },
      data: { stateVersion: version },
    });

  it("lists the drafts waiting for a person, oldest first", async () => {
    const first = await draft();
    const second = await draft();

    const page = await listReviewQueue(db(), profile.context);

    // Oldest first: a review queue is work, and the customer who has waited longest is the most overdue.
    expect(page.items.map((item) => item.draftId)).toEqual([first, second]);
    expect(page.items[0]?.text).toContain("Reply");
    expect(page.items[0]?.reasonCodes).toEqual(["LOW_CONFIDENCE"]);
  }, 120_000);

  it("shows only what is still waiting", async () => {
    const pending = await draft();
    const settled = await draft();
    await db().aiDraft.update({ where: { workspaceId_businessProfileId_id: { ...scopeOf(profile), id: settled } }, data: { status: "DISMISSED" } });

    const ids = (await listReviewQueue(db(), profile.context)).items.map((item) => item.draftId);

    expect(ids).toContain(pending);
    expect(ids).not.toContain(settled);
  }, 120_000);

  it("never shows another Workspace's review items", async () => {
    const [theirProfile] = neighbour.profiles as [SeededProfile];
    const theirs = await draft({ target: theirProfile });

    const mine = (await listReviewQueue(db(), profile.context)).items.map((item) => item.draftId);

    expect(mine).not.toContain(theirs);
    expect((await listReviewQueue(db(), theirProfile.context)).items.map((item) => item.draftId)).toContain(theirs);
  }, 120_000);

  describe("staleness", () => {
    it("marks an item whose conversation has moved on, and keeps showing it", async () => {
      await setStateVersion(profile, 1);
      const answerable = await draft({ anchorStateVersion: 1 });
      const overtaken = await draft({ anchorStateVersion: 1 });
      await setStateVersion(profile, 2);
      // A draft written for the new state is still answerable.
      const fresh = await draft({ anchorStateVersion: 2 });

      const items = new Map((await listReviewQueue(db(), profile.context)).items.map((item) => [item.draftId, item]));

      expect(items.get(overtaken)?.stale).toBe(true);
      expect(items.get(answerable)?.stale).toBe(true);
      expect(items.get(fresh)?.stale).toBe(false);
      // Still listed. An item that disappeared would leave a person wondering where their queue went,
      // and the draft still needs dismissing by someone.
      expect(items.has(overtaken)).toBe(true);
      expect(items.get(overtaken)?.anchorStateVersion).toBe(1);
      expect(items.get(overtaken)?.conversationStateVersion).toBe(2);
    }, 120_000);

    it("can be asked for only the answerable items, or only the overtaken ones", async () => {
      await setStateVersion(profile, 5);
      const fresh = await draft({ anchorStateVersion: 5 });
      const old = await draft({ anchorStateVersion: 4 });

      const answerable = (await listReviewQueue(db(), profile.context, { stale: false })).items.map((item) => item.draftId);
      const overtaken = (await listReviewQueue(db(), profile.context, { stale: true })).items.map((item) => item.draftId);

      expect(answerable).toContain(fresh);
      expect(answerable).not.toContain(old);
      expect(overtaken).toContain(old);
      expect(overtaken).not.toContain(fresh);
    }, 120_000);
  });

  describe("provenance", () => {
    it("says the corpus was consulted, and how much it supplied", async () => {
      const id = await draft({ retrieval: noRetrieval("OK"), factualSourceIds: ["kd_1"] });

      const item = (await listReviewQueue(db(), profile.context)).items.find((row) => row.draftId === id);

      expect(item?.retrieval.status).toBe("OK");
      expect(item?.citedSourceIds).toEqual(["kd_1"]);
    }, 120_000);

    it("distinguishes 'we could not look' from 'there was nothing to find'", async () => {
      const blind = await draft({ retrieval: noRetrieval("UNAVAILABLE") });
      const empty = await draft({ retrieval: noRetrieval("OK") });

      const items = new Map((await listReviewQueue(db(), profile.context)).items.map((row) => [row.draftId, row]));

      // Same empty citation list, opposite meaning: one is a business that has not written this down, the
      // other is a retrieval outage. Collapsing them would put the wrong sentence on the same screen.
      expect(items.get(blind)?.retrieval.status).toBe("UNAVAILABLE");
      expect(items.get(empty)?.retrieval.status).toBe("OK");
      expect(items.get(blind)?.citedSourceIds).toEqual([]);
      expect(items.get(empty)?.citedSourceIds).toEqual([]);
    }, 120_000);

    it("reads an unrecognisable retrieval record as 'could not look', not as 'nothing found'", async () => {
      const id = await draft();
      await db().aiDraft.update({ where: { workspaceId_businessProfileId_id: { ...scopeOf(profile), id } }, data: { retrieval: { shape: "from an older version" } } });

      const item = (await listReviewQueue(db(), profile.context)).items.find((row) => row.draftId === id);

      // The safer of the two readings: it tells an operator to check, where the other tells them the
      // knowledge base is empty.
      expect(item?.retrieval.status).toBe("UNAVAILABLE");
    }, 120_000);

    it("reads a missing retrieval record as 'could not look' too", async () => {
      const id = await draft();
      // Raw, because a Prisma `undefined` means "leave it alone" — the column has to actually become NULL.
      await db().$executeRaw`UPDATE "ai_drafts" SET "retrieval" = NULL WHERE "id" = ${id}`;

      const item = (await listReviewQueue(db(), profile.context)).items.find((row) => row.draftId === id);

      // A draft that predates the current shape, or a migration that left the column empty. Neither means
      // the business had nothing to say.
      expect(item?.retrieval.status).toBe("UNAVAILABLE");
      expect(item?.retrieval.suppliedCount).toBe(0);
    }, 120_000);

    it("counts what retrieval supplied, which is not what the model then cited", async () => {
      const id = await draft({ factualSourceIds: ["kd_used"] });
      await db().aiDraft.update({
        where: { workspaceId_businessProfileId_id: { ...scopeOf(profile), id } },
        data: {
          retrieval: {
            status: "OK",
            knowledge: [
              { chunkId: "kd_used", documentId: "doc_1", documentVersion: 1, scopeLevel: "BUSINESS_PROFILE", score: 0.9 },
              { chunkId: "kd_offered", documentId: "doc_2", documentVersion: 1, scopeLevel: "BUSINESS_PROFILE", score: 0.4 },
            ],
            style: [],
            knowledgeDiagnostics: { lexicalCandidates: 2, semanticCandidates: 2 },
          },
        },
      });

      const item = (await listReviewQueue(db(), profile.context)).items.find((row) => row.draftId === id);

      // Two facts were available and the model used one. A reviewer needs both numbers to tell "it had
      // nothing to go on" from "it ignored what it had".
      expect(item?.retrieval.suppliedCount).toBe(2);
      expect(item?.citedSourceIds).toEqual(["kd_used"]);
    }, 120_000);
  });

  describe("filters", () => {
    it("narrows to one reason code", async () => {
      const missing = await draft({ reasonCodes: ["MISSING_FACT"] });
      const low = await draft({ reasonCodes: ["LOW_CONFIDENCE"] });

      const ids = (await listReviewQueue(db(), profile.context, { reasonCode: "MISSING_FACT" })).items.map((item) => item.draftId);

      expect(ids).toContain(missing);
      expect(ids).not.toContain(low);
    }, 120_000);

    it("matches an item carrying the reason among several", async () => {
      const both = await draft({ reasonCodes: ["LOW_CONFIDENCE", "HUMAN_AGENT_REVIEW_REQUIRED"] });

      const ids = (await listReviewQueue(db(), profile.context, { reasonCode: "HUMAN_AGENT_REVIEW_REQUIRED" })).items.map((item) => item.draftId);

      expect(ids).toContain(both);
    }, 120_000);

    it("narrows to one channel account", async () => {
      const mine = await draft();

      const onThisAccount = (await listReviewQueue(db(), profile.context, { channelAccountId: profile.channelAccount.id })).items.map((item) => item.draftId);
      const onAnother = (await listReviewQueue(db(), profile.context, { channelAccountId: "ca_not_here" })).items.map((item) => item.draftId);

      expect(onThisAccount).toContain(mine);
      expect(onAnother).toEqual([]);
    }, 120_000);

    it("narrows to the items whose send would use the provider's human-support path", async () => {
      const id = await draft();
      await db().conversation.update({
        where: { workspaceId_businessProfileId_id: { ...scopeOf(profile), id: profile.conversationId } },
        // The schema's CHECK requires a reason, a review mode *and* a timestamp for REVIEW_REQUIRED: a
        // conversation cannot be waiting on a person without recording since when.
        data: {
          takeoverState: "REVIEW_REQUIRED",
          takeoverReason: "HUMAN_AGENT_REVIEW",
          takeoverReviewMode: "HUMAN_AGENT",
          humanTakeoverAt: new Date("2026-09-30T12:00:00.000Z"),
        },
      });

      const items = (await listReviewQueue(db(), profile.context, { reviewMode: "HUMAN_AGENT" })).items;

      expect(items.map((item) => item.draftId)).toContain(id);
      expect(items.every((item) => item.reviewMode === "HUMAN_AGENT")).toBe(true);

      await db().conversation.update({
        where: { workspaceId_businessProfileId_id: { ...scopeOf(profile), id: profile.conversationId } },
        data: { takeoverState: "NONE", takeoverReason: null, takeoverReviewMode: null, humanTakeoverAt: null },
      });
    }, 120_000);

    it("reports an ordinary reply as NORMAL rather than leaving the mode unsaid", async () => {
      const id = await draft();

      const item = (await listReviewQueue(db(), profile.context)).items.find((row) => row.draftId === id);

      expect(item?.reviewMode).toBe("NORMAL");
    }, 120_000);
  });

  describe("paging", () => {
    it("walks the whole queue without repeating or skipping an item", async () => {
      const created: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        created.push(await draft({ reasonCodes: ["PAYMENT_DISPUTE"] }));
      }

      const seen: string[] = [];
      let cursor = undefined as Awaited<ReturnType<typeof listReviewQueue>>["nextCursor"];
      for (let request = 0; request < 10; request += 1) {
        const page = await listReviewQueue(db(), profile.context, { reasonCode: "PAYMENT_DISPUTE" }, { limit: 2, cursor });
        seen.push(...page.items.map((item) => item.draftId));
        if (page.nextCursor === undefined) {
          break;
        }
        cursor = page.nextCursor;
      }

      expect(seen).toEqual(created);
      expect(new Set(seen).size).toBe(seen.length);
    }, 120_000);

    it("offers no next page when the queue ends exactly on a page boundary", async () => {
      for (let index = 0; index < 4; index += 1) {
        await draft({ reasonCodes: ["LEGAL_INTERPRETATION"] });
      }

      const first = await listReviewQueue(db(), profile.context, { reasonCode: "LEGAL_INTERPRETATION" }, { limit: 2 });
      const second = await listReviewQueue(db(), profile.context, { reasonCode: "LEGAL_INTERPRETATION" }, { limit: 2, cursor: first.nextCursor });

      expect(first.nextCursor).toBeDefined();
      expect(second.items).toHaveLength(2);
      // Offering a cursor here is the "load more" that loads nothing.
      expect(second.nextCursor).toBeUndefined();
    }, 120_000);

    it("clamps a page size below one and above the ceiling", async () => {
      await draft({ reasonCodes: ["MEDICAL_OR_HIGH_RISK"] });

      expect((await listReviewQueue(db(), profile.context, { reasonCode: "MEDICAL_OR_HIGH_RISK" }, { limit: 0 })).items).toHaveLength(1);
      expect((await listReviewQueue(db(), profile.context, { reasonCode: "MEDICAL_OR_HIGH_RISK" }, { limit: 10_000 })).items).toHaveLength(1);
    }, 120_000);
  });
});
