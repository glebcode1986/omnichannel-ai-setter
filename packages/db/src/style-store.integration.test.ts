/**
 * Style Training, against a real server (Issue #32).
 *
 * Two invariants carry this file, and both are enforced below the code rather than by it:
 *
 * **Only a verified human example is used.** A CHECK refuses an ACTIVE example with no approver, and the
 * style query filters `status = 'ACTIVE'` — so a suggestion is inert by construction. The test that means
 * anything is the one that tries to activate a suggestion in raw SQL without naming an approver.
 *
 * **Style cannot authorize a factual claim.** Structural: the style retriever returns a different type
 * from the knowledge retriever, and nothing in the style store touches `knowledge_documents`. What is
 * testable is the consequence — an active style example does not make its content findable as a fact.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { WorkspacePermissionError } from "./errors";
import { addWorkspaceMember } from "./repositories/workspaces";
import { authorizeBusinessProfileAccess, authorizeWorkspaceAccess } from "./tenancy";
import {
  approveStyleExample,
  archiveStyleExample,
  createStyleExample,
  listStyleExamples,
  readStyleExampleLifecycle,
  readStyleProfiles,
  rejectStyleExample,
  restoreStyleExample,
  saveStyleProfile,
  suggestStyleExample,
  type StyleDecisionCursor,
  type StyleExampleCursor,
} from "./style-store";
import { createKnowledgeRetriever, createStyleRetriever } from "./retrieval/retrievers";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { seedWorkspace, type SeededProfile, type SeededWorkspace } from "./testing/fixtures";

describe.skipIf(!databaseTestsEnabled())("Style Training", () => {
  let database: TestDatabase;
  let workspace: SeededWorkspace;
  let profile: SeededProfile;
  let sibling: SeededProfile;
  let neighbour: SeededWorkspace;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    workspace = await seedWorkspace(database.db, "style", ["main", "sibling"]);
    [profile, sibling] = workspace.profiles as [SeededProfile, SeededProfile];
    neighbour = await seedWorkspace(database.db, "style-neighbour");
  }, 180_000);

  afterAll(async () => {
    await database?.dispose();
  });

  const db = () => database.db;
  const styleQuery = (text: string) => ({
    scope: { workspaceId: profile.context.workspaceId, businessProfileId: profile.businessProfileId },
    text,
    limit: 10,
  });

  /**
   * A suggestion, with its own distinctive *inbound* wording.
   *
   * Style retrieval matches the customer's question and not the reply — you find an example by the
   * question it answers, then read its wording for tone. So every search below queries inbound text, and
   * each fixture needs a phrase no other fixture shares, or a test passes because the matcher looked
   * somewhere else rather than because the example was unreachable.
   */
  const suggested = async (inboundContext: string, outboundText: string) => {
    await suggestStyleExample(db(), profile.context, { inboundContext, outboundText });
    const page = await listStyleExamples(db(), profile.context, { status: "SUGGESTED" });
    return page.examples.find((example) => example.outboundText === outboundText)?.id ?? "";
  };

  describe("the voice", () => {
    it("returns both layers even before either has been written", async () => {
      const layers = await readStyleProfiles(db(), profile.context);

      // A layer that does not exist is still one an operator can edit; returning nothing for it would make
      // the editor guess whether the base voice is empty or simply unwritten.
      expect(layers.map((layer) => layer.scope)).toEqual(["WORKSPACE", "BUSINESS_PROFILE"]);
      expect(layers.every((layer) => layer.exists === false)).toBe(true);
    }, 180_000);

    it("saves a layer and reads it back", async () => {
      await saveStyleProfile(db(), profile.context, "WORKSPACE", {
        persona: "A calm neighbourhood salon",
        tone: "warm",
        replyLength: "SHORT",
        emoji: "SPARING",
        greeting: "Hi!",
        signOff: "See you soon",
        preferredPhrases: ["happy to help"],
        avoidedPhrases: ["cheap"],
        language: "en",
      });

      const base = (await readStyleProfiles(db(), profile.context)).find((layer) => layer.scope === "WORKSPACE");
      expect(base?.exists).toBe(true);
      expect(base?.persona).toBe("A calm neighbourhood salon");
      expect(base?.replyLength).toBe("SHORT");
      expect(base?.preferredPhrases).toEqual(["happy to help"]);
      expect(base?.avoidedPhrases).toEqual(["cheap"]);
    }, 180_000);

    it("treats a cleared field as no opinion, not as an empty instruction", async () => {
      await saveStyleProfile(db(), profile.context, "BUSINESS_PROFILE", {
        persona: "   ",
        tone: "",
        replyLength: null,
        emoji: null,
        greeting: "  Hey  ",
        signOff: null,
        preferredPhrases: [],
        avoidedPhrases: [],
        language: null,
      });

      const override = (await readStyleProfiles(db(), profile.context)).find((layer) => layer.scope === "BUSINESS_PROFILE");
      // A stored empty string would blank out the base layer's persona rather than deferring to it, which
      // is the opposite of what clearing a field looks like it does.
      expect(override?.persona).toBeNull();
      expect(override?.tone).toBeNull();
      expect(override?.greeting).toBe("Hey");
    }, 180_000);

    it("edits the same layer rather than accumulating rows", async () => {
      await saveStyleProfile(db(), profile.context, "WORKSPACE", { ...blank(), tone: "first" });
      await saveStyleProfile(db(), profile.context, "WORKSPACE", { ...blank(), tone: "second" });

      const base = (await readStyleProfiles(db(), profile.context)).find((layer) => layer.scope === "WORKSPACE");
      expect(base?.tone).toBe("second");
      expect(await db().styleProfile.count({ where: { workspaceId: profile.context.workspaceId, businessProfileId: null } })).toBe(1);
    }, 180_000);

    /**
     * Two tabs on one business's voice (R5).
     *
     * Each editor carries a *complete* profile, so the stake is not one field: a save that does not say
     * which version it started from replaces every field a colleague changed with an old copy of itself.
     * Deterministic rather than timing-dependent — the second save is given the first's instant on
     * purpose, which is precisely what a stale tab holds.
     */
    it("refuses a save made against a version somebody has already replaced", async () => {
      const bp = sibling.context;
      await saveStyleProfile(db(), bp, "BUSINESS_PROFILE", { ...blank(), tone: "as rendered" });
      const asRendered = (await readStyleProfiles(db(), bp)).find((layer) => layer.scope === "BUSINESS_PROFILE");
      const stale = asRendered?.updatedAt ?? undefined;

      // A colleague saves, which moves the layer on.
      await saveStyleProfile(db(), bp, "BUSINESS_PROFILE", { ...blank(), tone: "colleague's" }, { ...(stale === undefined ? {} : { updatedAt: stale }) });
      const afterColleague = (await readStyleProfiles(db(), bp)).find((layer) => layer.scope === "BUSINESS_PROFILE");

      const late = await saveStyleProfile(
        db(),
        bp,
        "BUSINESS_PROFILE",
        { ...blank(), tone: "stale tab's" },
        { ...(stale === undefined ? {} : { updatedAt: stale }) },
      );

      expect(late).toEqual({ status: "CONFLICT" });
      // And nothing was lost: the colleague's wording is still there, which is the whole point of
      // refusing rather than writing.
      expect(afterColleague?.tone).toBe("colleague's");
      expect((await readStyleProfiles(db(), bp)).find((layer) => layer.scope === "BUSINESS_PROFILE")?.tone).toBe("colleague's");
    }, 180_000);

    it("lets exactly one of two first saves create the layer", async () => {
      const fresh = await seedWorkspace(db(), "style-concurrent");
      const [only] = fresh.profiles as [SeededProfile];

      // Both believe there is no layer, because when they rendered there was none. The partial unique
      // index decides, and the loser is told it conflicted instead of being handed a raw constraint error
      // — or worse, of both appearing to succeed.
      const [first, second] = await Promise.all([
        saveStyleProfile(db(), only.context, "WORKSPACE", { ...blank(), tone: "first" }, {}),
        saveStyleProfile(db(), only.context, "WORKSPACE", { ...blank(), tone: "second" }, {}),
      ]);

      expect([first.status, second.status].sort()).toEqual(["CONFLICT", "SAVED"]);
      expect(await db().styleProfile.count({ where: { workspaceId: only.context.workspaceId, businessProfileId: null } })).toBe(1);
    }, 180_000);

    it("refuses a first save when the layer has appeared in the meantime", async () => {
      const fresh = await seedWorkspace(db(), "style-appeared");
      const [only] = fresh.profiles as [SeededProfile];
      await saveStyleProfile(db(), only.context, "WORKSPACE", { ...blank(), tone: "somebody else's" }, {});

      // The screen was rendered before any layer existed, so it claims none. Writing a fresh one here
      // would discard whatever the other operator wrote, which is the same lost update by another route.
      expect(await saveStyleProfile(db(), only.context, "WORKSPACE", { ...blank(), tone: "stale creator's" }, {})).toEqual({ status: "CONFLICT" });
      expect((await readStyleProfiles(db(), only.context)).find((layer) => layer.scope === "WORKSPACE")?.tone).toBe("somebody else's");
    }, 180_000);

    it("still lets a caller with no screen behind it write unconditionally", async () => {
      const fresh = await seedWorkspace(db(), "style-system-caller");
      const [only] = fresh.profiles as [SeededProfile];
      await saveStyleProfile(db(), only.context, "WORKSPACE", { ...blank(), tone: "seeded" });

      // Omitting the parameter is the system path — a seed, a migration helper — which has no stale copy
      // to carry and nothing to conflict with. Distinguished from `{}`, which is a screen's claim that
      // there was no layer, so the two cannot be confused by accident.
      expect(await saveStyleProfile(db(), only.context, "WORKSPACE", { ...blank(), tone: "seeded again" })).toEqual({ status: "SAVED" });
      expect((await readStyleProfiles(db(), only.context)).find((layer) => layer.scope === "WORKSPACE")?.tone).toBe("seeded again");
    }, 180_000);

    it("never reads another Workspace's voice", async () => {
      const [theirProfile] = neighbour.profiles as [SeededProfile];
      await saveStyleProfile(db(), theirProfile.context, "WORKSPACE", { ...blank(), tone: "theirs" });

      const mine = (await readStyleProfiles(db(), profile.context)).find((layer) => layer.scope === "WORKSPACE");
      expect(mine?.tone).not.toBe("theirs");
    }, 180_000);
  });

  describe("an example a person typed", () => {
    it("is active at once, and names them as the approval", async () => {
      await createStyleExample(db(), profile.context, { inboundContext: "how much is a trim?", outboundText: "A trim is 25 — want a slot this week?" });

      const example = (await listStyleExamples(db(), profile.context, { status: "ACTIVE" })).examples.find(
        (candidate) => candidate.outboundText.startsWith("A trim is 25"),
      );

      // The person who typed it *is* the approval. The gate exists for examples nobody has judged.
      expect(example?.provenance).toBe("HUMAN_TYPED");
      expect(example?.approvedByName).toBe("Test style-owner");
    }, 180_000);

    it("reaches style retrieval, found by the question it answers", async () => {
      await createStyleExample(db(), profile.context, {
        inboundContext: "do you open on churchday?",
        outboundText: "Sundays we rest — Monday to Saturday we are on.",
      });

      const hits = await createStyleRetriever(db()).search(styleQuery("churchday"));

      expect(hits.hits.some((hit) => hit.outboundText.includes("Sundays we rest"))).toBe(true);
    }, 180_000);

    it("refuses half an example", async () => {
      // The reply without its question cannot be matched to a later question, and the question without a
      // reply has no tone in it.
      expect(await createStyleExample(db(), profile.context, { inboundContext: "  ", outboundText: "A reply." })).toEqual({
        status: "REFUSED",
        reason: "an example needs both the customer's message and your reply",
      });
      expect(await createStyleExample(db(), profile.context, { inboundContext: "A question?", outboundText: "" })).toEqual({
        status: "REFUSED",
        reason: "an example needs both the customer's message and your reply",
      });
    }, 180_000);
  });

  describe("a suggestion the system noticed", () => {
    it("is inert until somebody activates it, and reachable the moment they do", async () => {
      const text = "Yeah we are around til six, pop in.";
      const id = await suggested("what are your latenight hours?", text);

      const whileSuggested = await createStyleRetriever(db()).search(styleQuery("latenight"));
      await approveStyleExample(db(), profile.context, id);
      const afterApproval = await createStyleRetriever(db()).search(styleQuery("latenight"));

      // The pair is the test. Without the second half this would pass against a matcher that never
      // found the example at all — which is how it first passed while proving nothing.
      expect(whileSuggested.hits.some((hit) => hit.outboundText === text)).toBe(false);
      expect(afterApproval.hits.some((hit) => hit.outboundText === text)).toBe(true);
    }, 180_000);

    it("has no approver, which is exactly why it is not in use", async () => {
      const id = await suggested("can i come thursdayish?", "Sure, see you then.");

      const example = (await listStyleExamples(db(), profile.context, { status: "SUGGESTED" })).examples.find((candidate) => candidate.id === id);
      expect(example?.approvedByName).toBeNull();
      expect(example?.status).toBe("SUGGESTED");
    }, 180_000);

    it("becomes active when a person approves it, and records who", async () => {
      const text = "We are around til six — pop in any time.";
      const id = await suggested("any chance of a slot tomorrowish?", text);

      const outcome = await approveStyleExample(db(), profile.context, id);

      expect(outcome).toEqual({ status: "ACTIVATED" });
      const hits = await createStyleRetriever(db()).search(styleQuery("tomorrowish"));
      expect(hits.hits.some((hit) => hit.outboundText === text)).toBe(true);
      const example = (await listStyleExamples(db(), profile.context, { status: "ACTIVE" })).examples.find((candidate) => candidate.id === id);
      expect(example?.approvedByName).toBe("Test style-owner");
    }, 180_000);

    it("stays out of use when rejected, and the decision is kept", async () => {
      const text = "nah were shut";
      const id = await suggested("you lot open on bankholiday?", text);

      const outcome = await rejectStyleExample(db(), profile.context, id);

      expect(outcome).toEqual({ status: "REJECTED_EXAMPLE" });
      // Kept rather than deleted: a rejection is a decision, and deleting it loses the record of it.
      const example = (await listStyleExamples(db(), profile.context, { status: "REJECTED" })).examples.find((candidate) => candidate.id === id);
      expect(example?.outboundText).toBe(text);
      // And a control: the same query does find an approved example, so "not found" means rejected
      // rather than "this query finds nothing".
      await createStyleExample(db(), profile.context, { inboundContext: "you lot open on bankholiday?", outboundText: "We are open, 10 till 4." });
      const hits = await createStyleRetriever(db()).search(styleQuery("bankholiday"));
      expect(hits.hits.some((hit) => hit.outboundText === text)).toBe(false);
      expect(hits.hits.some((hit) => hit.outboundText === "We are open, 10 till 4.")).toBe(true);
    }, 180_000);

    it("cannot be approved twice, or approved after being rejected", async () => {
      const id = await suggested("twice approved question?", "Once only.");
      expect(await approveStyleExample(db(), profile.context, id)).toEqual({ status: "ACTIVATED" });

      // Activating something already active is not an approval anybody made.
      expect(await approveStyleExample(db(), profile.context, id)).toEqual({ status: "GONE" });

      const rejected = await suggested("declined question?", "Declined once.");
      await rejectStyleExample(db(), profile.context, rejected);
      // Approving a rejected example would overturn a decision without recording that it was overturned.
      expect(await approveStyleExample(db(), profile.context, rejected)).toEqual({ status: "GONE" });
    }, 180_000);

    /**
     * The invariant, tested against the database rather than against this file.
     *
     * "Only verified human examples become active" has to hold for a migration, a console session and any
     * code written after this one — so it is a CHECK, and the test that means anything tries to break it.
     */
    it("cannot be activated in raw SQL without naming an approver", async () => {
      const id = await suggested("sql question?", "SQL cannot approve this.");

      await expect(db().$executeRaw`UPDATE "style_examples" SET "status" = 'ACTIVE' WHERE "id" = ${id}`).rejects.toThrow(
        /style_examples_verified_check/u,
      );
    }, 180_000);
  });

  describe("archive and restore", () => {
    it("takes an example out of style retrieval, and brings it back", async () => {
      const text = "Happy to squeeze you in on Friday.";
      await createStyleExample(db(), profile.context, { inboundContext: "any space on fridayish?", outboundText: text });
      const id = (await listStyleExamples(db(), profile.context, { status: "ACTIVE" })).examples.find((candidate) => candidate.outboundText === text)?.id ?? "";

      // Found before anything is archived, so the two assertions below describe archiving rather than a
      // query that never matched.
      const whileActive = await createStyleRetriever(db()).search(styleQuery("fridayish"));
      expect(whileActive.hits.some((hit) => hit.outboundText === text)).toBe(true);

      expect(await archiveStyleExample(db(), profile.context, id)).toEqual({ status: "ARCHIVED" });
      const whileArchived = await createStyleRetriever(db()).search(styleQuery("fridayish"));

      expect(await restoreStyleExample(db(), profile.context, id)).toEqual({ status: "RESTORED" });
      const whenRestored = await createStyleRetriever(db()).search(styleQuery("fridayish"));

      expect(whileArchived.hits.some((hit) => hit.outboundText === text)).toBe(false);
      expect(whenRestored.hits.some((hit) => hit.outboundText === text)).toBe(true);
    }, 180_000);

    it("can bring back a rejected suggestion, naming whoever stood behind it", async () => {
      const id = await suggested("reconsidered question?", "Reconsidered.");
      await rejectStyleExample(db(), profile.context, id);

      expect(await restoreStyleExample(db(), profile.context, id)).toEqual({ status: "RESTORED" });
      const example = (await listStyleExamples(db(), profile.context, { status: "ACTIVE" })).examples.find((candidate) => candidate.id === id);
      expect(example?.approvedByName).toBe("Test style-owner");
    }, 180_000);

    it("cannot restore a suggestion, because that would be approving it by another name", async () => {
      const id = await suggested("restore instead of approve?", "Not approved this way.");

      // One route per decision. If restore accepted a suggestion it would activate one without going
      // through the gate that exists for exactly that judgement.
      expect(await restoreStyleExample(db(), profile.context, id)).toEqual({ status: "GONE" });
      const example = (await listStyleExamples(db(), profile.context, { status: "SUGGESTED" })).examples.find((candidate) => candidate.id === id);
      expect(example?.status).toBe("SUGGESTED");
    }, 180_000);

    it("cannot reject one that is already in use — that is archiving", async () => {
      const text = "Already in use.";
      await createStyleExample(db(), profile.context, { inboundContext: "rejectable question?", outboundText: text });
      const id = (await listStyleExamples(db(), profile.context, { status: "ACTIVE" })).examples.find((candidate) => candidate.outboundText === text)?.id ?? "";

      // Rejecting means declining a suggestion. Taking a live example out of use is archiving, and the two
      // read differently in an audit trail: one is "we considered this", the other "we stopped using it".
      expect(await rejectStyleExample(db(), profile.context, id)).toEqual({ status: "GONE" });
      const example = (await listStyleExamples(db(), profile.context, { status: "ACTIVE" })).examples.find((candidate) => candidate.id === id);
      expect(example?.status).toBe("ACTIVE");
    }, 180_000);

    it("keeps the whole lifecycle, not only the last decision", async () => {
      const id = await suggested("reconsidered twice?", "Reconsidered twice.");

      await rejectStyleExample(db(), profile.context, id);
      await restoreStyleExample(db(), profile.context, id);
      await archiveStyleExample(db(), profile.context, id);

      const example = (await listStyleExamples(db(), profile.context, { status: "ARCHIVED" })).examples.find((candidate) => candidate.id === id);
      // The point of the history, stated as the thing it makes possible: an example rejected, restored and
      // archived again is a different thing from one archived on the first day, and the row's own
      // `decision` column — which each transition overwrites — cannot tell them apart.
      expect(example?.decisions.map((entry) => entry.decision)).toEqual(["REJECTED", "RESTORED", "ARCHIVED"]);
      expect(example?.decisions.map((entry) => entry.decidedByName)).toEqual(["Test style-owner", "Test style-owner", "Test style-owner"]);
      // Oldest first, and strictly ordered: a lifecycle out of order is not a lifecycle.
      const times = example?.decisions.map((entry) => entry.decidedAt.getTime()) ?? [];
      expect(times).toEqual([...times].sort((left, right) => left - right));
      // Restoring it named the person who had stood behind it; archiving it again did not erase them.
      expect(example?.approvedByName).toBe("Test style-owner");
    }, 180_000);

    it("writes no history for a decision that did not take effect", async () => {
      const id = await suggested("history of a refusal?", "Refused.");

      // Archiving a suggestion is refused — it was never in use. A history row for it would record a
      // decision nobody made, which is worse than no history at all.
      expect(await archiveStyleExample(db(), profile.context, id)).toEqual({ status: "GONE" });
      expect(await db().styleExampleDecision.count({ where: { styleExampleId: id } })).toBe(0);
    }, 180_000);

    it("records a decision that cannot be unmade, by this package or by anybody", async () => {
      const id = await suggested("append only?", "Append only.");
      await rejectStyleExample(db(), profile.context, id);
      expect(await db().styleExampleDecision.count({ where: { styleExampleId: id } })).toBe(1);

      // The example itself cannot be deleted while its history points at it. That protects the *parent*,
      // which is not the same guarantee and was previously the only one there was.
      await expect(db().$executeRaw`DELETE FROM "style_examples" WHERE "id" = ${id}`).rejects.toThrow(
        /style_example_decisions_style_example_id_fkey/u,
      );

      // And the rows themselves, at the database boundary rather than by convention. "Nothing in this
      // store does it" is a statement about one package's current source, and the case that matters is
      // precisely the one where that source is not what is running: a support script, a later migration,
      // or a hand-typed statement during an incident.
      //
      // The quiet edit is the dangerous one. Turning this REJECTED into an APPROVED leaves a history that
      // reads as complete and is not, which is the difference between an audit trail and a log somebody
      // could have tidied.
      await expect(db().$executeRaw`UPDATE "style_example_decisions" SET "decision" = 'APPROVED' WHERE "style_example_id" = ${id}`).rejects.toThrow(
        /append-only/u,
      );
      await expect(db().$executeRaw`DELETE FROM "style_example_decisions" WHERE "style_example_id" = ${id}`).rejects.toThrow(/append-only/u);
      // A row trigger never fires for TRUNCATE, and nothing references this table, so without a
      // statement-level guard the one statement that destroys every row would be the one it permitted.
      await expect(db().$executeRaw`TRUNCATE "style_example_decisions"`).rejects.toThrow(/cannot be truncated/u);

      // The control: the refusals above are refusals, not a write that silently did nothing.
      const after = await db().styleExampleDecision.findMany({ where: { styleExampleId: id }, select: { decision: true } });
      expect(after).toEqual([{ decision: "REJECTED" }]);
    }, 180_000);

    it("keeps every event of a long lifecycle reachable, and shows the current one first of all", async () => {
      // The defect this replaces: the window took the twenty *oldest* decisions, so from the
      // twenty-first onwards every later event — including the one that produced the example's current
      // state — disappeared from the history with nothing on screen to say so.
      const id = await suggested("a long argument?", "A long argument.");
      await rejectStyleExample(db(), profile.context, id);
      const expected: string[] = ["REJECTED"];
      // Twelve more round trips: 25 decisions in total, comfortably past the window of twenty.
      for (let round = 0; round < 12; round += 1) {
        await restoreStyleExample(db(), profile.context, id);
        await archiveStyleExample(db(), profile.context, id);
        expected.push("RESTORED", "ARCHIVED");
      }
      expect(expected).toHaveLength(25);

      const example = (await listStyleExamples(db(), profile.context, { status: "ARCHIVED" })).examples.find((candidate) => candidate.id === id);
      // The window is the most recent twenty, still oldest-first within itself, and it says how many it
      // left behind rather than leaving a reader to wonder.
      expect(example?.decisions).toHaveLength(20);
      expect(example?.earlierDecisions).toBe(5);
      expect(example?.earlierCursor).toBeDefined();
      // The current state's own decision is the last entry of the window, which is the part that used to
      // be missing.
      expect(example?.decisions.at(-1)?.decision).toBe("ARCHIVED");
      expect(example?.decisions.map((entry) => entry.decision)).toEqual(expected.slice(5));

      // Every page is reachable by following the cursor, and the pages reassemble into the whole
      // lifecycle in order with nothing repeated and nothing skipped.
      const collected: string[] = [...(example?.decisions.map((entry) => entry.decision) ?? [])];
      let cursor: StyleDecisionCursor | undefined = example?.earlierCursor;
      let pages = 0;
      while (cursor !== undefined) {
        const page = await readStyleExampleLifecycle(db(), profile.context, id, { limit: 7, before: cursor });
        expect(page, "a cursor the previous page offered must lead somewhere").not.toBeNull();
        expect(page?.totalDecisions).toBe(25);
        collected.unshift(...(page?.decisions.map((entry) => entry.decision) ?? []));
        cursor = page?.earlierCursor;
        pages += 1;
        expect(pages, "paging must terminate").toBeLessThan(10);
      }

      expect(collected).toEqual(expected);
      // And strictly ordered end to end: a lifecycle out of order is not a lifecycle.
      const whole = await readStyleExampleLifecycle(db(), profile.context, id, { limit: 100 });
      const times = whole?.decisions.map((entry) => entry.decidedAt.getTime()) ?? [];
      expect(times).toHaveLength(25);
      expect(times).toEqual([...times].sort((left, right) => left - right));
      expect(whole?.earlierDecisions).toBe(0);
      expect(whole?.earlierCursor).toBeUndefined();
      expect(whole?.laterDecisions).toBe(0);

      // A cursor pointing at the oldest decision yields a page with no rows. It describes itself as
      // hiding everything rather than reporting a count with no link to follow, and the screen keeps the
      // way back for exactly this case.
      const oldest = whole?.decisions[0];
      const past = await readStyleExampleLifecycle(db(), profile.context, id, {
        before: { decidedAt: oldest?.decidedAt ?? new Date(0), id: oldest?.id ?? "" },
      });
      expect(past?.decisions).toEqual([]);
      expect(past?.earlierDecisions).toBe(0);
      expect(past?.earlierCursor).toBeUndefined();
      expect(past?.laterDecisions).toBe(25);
    }, 180_000);

    it("pages a lifecycle whose decisions share one instant, because an instant is not a key", async () => {
      // `decided_at` is not unique: these are written by one transaction per decision, and two can land
      // in the same millisecond. A cursor on the instant alone would repeat or skip a row here, which on
      // a page of audit history reads as an event happening twice or not at all.
      const id = await suggested("same instant?", "Same instant.");
      await rejectStyleExample(db(), profile.context, id);
      const at = new Date("2026-10-01T09:00:00.000Z");
      // Written directly because no product path can produce a tie deliberately — and these rows cannot
      // be edited afterwards, so they are inserted with the instant they need.
      for (let index = 0; index < 6; index += 1) {
        await db().$executeRaw`
          INSERT INTO "style_example_decisions" ("id", "workspace_id", "style_example_id", "decision", "decided_by_user_id", "decided_at")
          VALUES (${`sed_tie_${index}`}, ${profile.context.workspaceId}, ${id}, 'RESTORED', ${workspace.ownerUserId}, ${at})`;
      }

      const seen: string[] = [];
      let cursor: StyleDecisionCursor | undefined;
      let pages = 0;
      do {
        const page = await readStyleExampleLifecycle(db(), profile.context, id, { limit: 2, ...(cursor === undefined ? {} : { before: cursor }) });
        // The row ids, because that is what "exactly once" has to be counted over: counting decision
        // names would pass against a cursor that returned `RESTORED` seven times from two rows.
        seen.unshift(...(page?.decisions.map((entry) => entry.id) ?? []));
        cursor = page?.earlierCursor;
        pages += 1;
        expect(pages, "paging must terminate").toBeLessThan(12);
      } while (cursor !== undefined);

      // Seven decisions, every one seen exactly once despite six of them sharing an instant.
      expect(seen).toHaveLength(7);
      expect(new Set(seen).size).toBe(7);
      expect(seen.filter((seenId) => seenId.startsWith("sed_tie_"))).toHaveLength(6);
    }, 180_000);

    it("cannot archive one that is not in use", async () => {
      const id = await suggested("never active question?", "Never active.");

      expect(await archiveStyleExample(db(), profile.context, id)).toEqual({ status: "GONE" });
    }, 180_000);
  });

  describe("scope and tenancy", () => {
    it("shares Workspace examples with every profile, and keeps profile examples to one", async () => {
      await createStyleExample(db(), profile.context, { inboundContext: "shared question", outboundText: "Shared voice reply.", scope: "WORKSPACE" });
      await createStyleExample(db(), profile.context, { inboundContext: "local question", outboundText: "Local voice reply.", scope: "BUSINESS_PROFILE" });

      const here = (await listStyleExamples(db(), profile.context)).examples.map((example) => example.outboundText);
      const nextDoor = (await listStyleExamples(db(), sibling.context)).examples.map((example) => example.outboundText);

      expect(here).toEqual(expect.arrayContaining(["Shared voice reply.", "Local voice reply."]));
      expect(nextDoor).toContain("Shared voice reply.");
      expect(nextDoor).not.toContain("Local voice reply.");
    }, 180_000);

    it("never shows or touches another Workspace's examples", async () => {
      const [theirProfile] = neighbour.profiles as [SeededProfile];
      await createStyleExample(db(), theirProfile.context, { inboundContext: "their question", outboundText: "Their voice reply." });
      const theirId =
        (await listStyleExamples(db(), theirProfile.context, { status: "ACTIVE" })).examples.find(
          (candidate) => candidate.outboundText === "Their voice reply.",
        )?.id ?? "";

      expect((await listStyleExamples(db(), profile.context)).examples.map((example) => example.id)).not.toContain(theirId);
      expect(await archiveStyleExample(db(), profile.context, theirId)).toEqual({ status: "GONE" });
      expect(await approveStyleExample(db(), profile.context, theirId)).toEqual({ status: "GONE" });
      // And the lifecycle read, which is the only one in this file that takes an id straight from a URL.
      // `null` rather than an empty page: "not yours" and "nothing has happened to it" are different
      // answers, and conflating them would leak the existence of the example.
      // Archived, not rejected: this example was created ACTIVE, and rejecting is a suggestion's
      // transition — it would have returned GONE and written no history, leaving the assertion below
      // passing against an empty lifecycle rather than against a hidden one.
      expect(await archiveStyleExample(db(), theirProfile.context, theirId)).toEqual({ status: "ARCHIVED" });
      expect(await readStyleExampleLifecycle(db(), profile.context, theirId)).toBeNull();
      expect((await readStyleExampleLifecycle(db(), theirProfile.context, theirId))?.totalDecisions).toBeGreaterThan(0);
    }, 180_000);

    it("keeps one profile's example history out of its sibling's reach", async () => {
      // The narrower boundary, inside one workspace. A workspace-scoped example is shared by design; a
      // profile-scoped one is not, and the history read must follow the same rule the list does.
      const mine = await suggested("sibling may not read this?", "Sibling may not read this.");
      await rejectStyleExample(db(), profile.context, mine);

      expect((await readStyleExampleLifecycle(db(), profile.context, mine))?.decisions).toHaveLength(1);
      expect(await readStyleExampleLifecycle(db(), sibling.context, mine)).toBeNull();
    }, 180_000);

    it("refuses an edit even in replica mode, where an ordinary trigger would not fire", async () => {
      // `SET session_replication_role = 'replica'` is a plain SET available to this connection, and an
      // origin-only trigger is silent under it — one statement would have switched the whole guarantee
      // off with no DDL and nothing recorded. Both triggers are therefore ENABLE ALWAYS.
      const id = await suggested("replica mode?", "Replica mode.");
      await rejectStyleExample(db(), profile.context, id);

      const flags = await db().$queryRaw<{ tgname: string; tgenabled: string }[]>`
        SELECT "tgname", "tgenabled"::text AS "tgenabled" FROM "pg_trigger"
        WHERE "tgrelid" = '"style_example_decisions"'::regclass AND NOT "tgisinternal"
        ORDER BY "tgname"`;
      expect(flags.map((row) => row.tgenabled)).toEqual(["A", "A"]);

      // The property itself, not only the flag: the flag could be right while the trigger does nothing.
      await expect(
        db().$transaction(async (tx) => {
          await tx.$executeRaw`SET LOCAL session_replication_role = 'replica'`;
          await tx.$executeRaw`UPDATE "style_example_decisions" SET "decision" = 'APPROVED' WHERE "style_example_id" = ${id}`;
        }),
      ).rejects.toThrow(/append-only/u);
      expect(await db().styleExampleDecision.findMany({ where: { styleExampleId: id }, select: { decision: true } })).toEqual([{ decision: "REJECTED" }]);
    }, 180_000);

    it("reads several statuses as one keyset, so a merged list can be paged", async () => {
      // The contract the retired list needs. Two queries concatenated cannot share a cursor: one of them
      // is always its own first page, and everything past it is unreachable by any link. One query over
      // both statuses is one keyset, so following the cursor visits every row exactly once whichever
      // status it has.
      const archived = await suggested("both statuses, archived half?", "Both statuses, archived half.");
      await approveStyleExample(db(), profile.context, archived);
      await archiveStyleExample(db(), profile.context, archived);
      const rejected = await suggested("both statuses, rejected half?", "Both statuses, rejected half.");
      await rejectStyleExample(db(), profile.context, rejected);

      const both = await listStyleExamples(db(), profile.context, { status: ["ARCHIVED", "REJECTED"] }, { limit: 100 });
      const ids = both.examples.map((example) => example.id);

      expect(ids).toContain(archived);
      expect(ids).toContain(rejected);
      // One list, one order: newest first across both statuses rather than one status after the other.
      const times = both.examples.map((example) => example.createdAt.getTime());
      expect(times).toEqual([...times].sort((left, right) => right - left));
      // And the single-status form still means exactly one status, which every other caller relies on.
      const onlyRejected = await listStyleExamples(db(), profile.context, { status: "REJECTED" }, { limit: 100 });
      expect(onlyRejected.examples.map((example) => example.status)).toEqual(onlyRejected.examples.map(() => "REJECTED"));
      expect(onlyRejected.examples.map((example) => example.id)).not.toContain(archived);

      // Paged two at a time, the merged set still arrives once each — the property the concatenation
      // could not have, because its second half never moved.
      const walked: string[] = [];
      let cursor: StyleExampleCursor | undefined;
      let pages = 0;
      do {
        const page = await listStyleExamples(db(), profile.context, { status: ["ARCHIVED", "REJECTED"] }, {
          limit: 2,
          ...(cursor === undefined ? {} : { cursor }),
        });
        walked.push(...page.examples.map((example) => example.id));
        cursor = page.nextCursor;
        pages += 1;
        expect(pages, "paging must terminate").toBeLessThan(40);
      } while (cursor !== undefined);

      expect(new Set(walked).size).toBe(walked.length);
      expect(walked.toSorted()).toEqual(ids.toSorted());
    }, 180_000);

    it("filters by status, provenance and scope", async () => {
      await createStyleExample(db(), profile.context, { inboundContext: "filtered question", outboundText: "Filtered typed reply." });
      const suggestedId = await suggested("filtered question?", "Filtered suggestion.");

      const active = (await listStyleExamples(db(), profile.context, { status: "ACTIVE" })).examples;
      const typed = (await listStyleExamples(db(), profile.context, { provenance: "HUMAN_TYPED" })).examples;
      const edited = (await listStyleExamples(db(), profile.context, { provenance: "HUMAN_EDITED_DRAFT" })).examples;
      const shared = (await listStyleExamples(db(), profile.context, { scope: "WORKSPACE" })).examples;

      expect(active.map((example) => example.id)).not.toContain(suggestedId);
      expect(typed.map((example) => example.id)).toContain(suggestedId);
      expect(edited.every((example) => example.provenance === "HUMAN_EDITED_DRAFT")).toBe(true);
      expect(shared.every((example) => example.scope === "WORKSPACE")).toBe(true);
    }, 180_000);
  });

  describe("style is not knowledge", () => {
    it("does not make its own wording findable as a fact", async () => {
      const text = "Our deposit is fully refundable, always.";
      await createStyleExample(db(), profile.context, { inboundContext: "is the depositol refundable?", outboundText: text });

      const asStyle = await createStyleRetriever(db()).search(styleQuery("depositol"));
      // The same words, asked of the factual corpus. Knowledge matches chunk content, so this queries the
      // reply's own wording — which is precisely what must not be findable as evidence.
      const asFact = await createKnowledgeRetriever(db()).search(styleQuery("fully refundable always"));

      // The same sentence is available as tone and unavailable as evidence. A style example that could
      // satisfy a factual requirement would let one person's phrasing become the business's policy.
      expect(asStyle.hits.some((hit) => hit.outboundText === text)).toBe(true);
      expect(asFact.hits.some((hit) => hit.text.includes("fully refundable"))).toBe(false);
    }, 180_000);
  });

  describe("who may decide a style example every profile draws on", () => {
    /**
     * All four transitions — approve, reject, archive, restore — share one private `decide`, which
     * resolved the row through `exampleScopeFilter(undefined, …)` whose `null` branch *is* the
     * Workspace-scoped example, and applied no role check. Making one needs an admin; deciding one needed
     * nothing. One guard covers all four.
     *
     * Every refusal below reads the row back. The exception alone is not enough: `decide` happens to be
     * transactional, so a misplaced guard rolls back, but `saveStyleProfile` in the sibling block is not,
     * and asserting only `rejects` let a measured 50/50 pass while the Workspace voice was rewritten. The
     * read-back is the assertion that "refused" means nothing moved.
     */
    const member = async (name: string, role: "AGENT" | "ADMIN") => {
      const user = await database.db.user.create({ data: { name, email: `${name.replace(/\W/gu, "-").toLowerCase()}@example.test` } });
      const owner = await authorizeWorkspaceAccess(database.db, { userId: workspace.ownerUserId, workspaceId: workspace.workspaceId });
      await addWorkspaceMember(database.db, owner, { userId: user.id, role, businessProfileScope: "ALL" });
      return { userId: user.id, context: await authorizeBusinessProfileAccess(database.db, { userId: user.id, workspaceId: workspace.workspaceId, businessProfileId: profile.businessProfileId }) };
    };

    const exampleFor = async (scope: "WORKSPACE" | "BUSINESS_PROFILE", marker: string) => {
      await createStyleExample(db(), profile.context, { scope, inboundContext: "a question", outboundText: marker });
      const listed = await listStyleExamples(db(), profile.context, { scope, status: "ACTIVE" });
      return { id: listed.examples.find((row) => row.outboundText === marker)?.id ?? "" };
    };

    const rowOf = async (id: string) =>
      database.db.styleExample.findFirstOrThrow({ where: { id }, select: { status: true, approvedByUserId: true, decidedByUserId: true, decision: true } });

    /**
     * Approve and reject start from `SUGGESTED`, and no writer in this repository produces a
     * Workspace-scoped suggestion: `suggestStyleExample`, the composer's learning write and
     * `recordEditedDraft` all stamp `profileScopeOf(context).businessProfileId`, and `createStyleExample`
     * lands a Workspace example straight in `ACTIVE`. So the two rows below are written directly. The
     * guard on those transitions is therefore defensive, and these cases record what it defends rather
     * than pretending the state is reachable through a production path today.
     */
    const suggestedWorkspaceExample = async (marker: string) =>
      database.db.styleExample.create({
        data: {
          workspaceId: workspace.workspaceId,
          businessProfileId: null,
          inboundContext: "a question",
          outboundText: marker,
          provenance: "HUMAN_TYPED",
          status: "SUGGESTED",
        },
        select: { id: true },
      });

    const suggestedProfileExample = async (marker: string) => {
      // The control's row comes from the production suggestion path, not a direct insert.
      await suggestStyleExample(db(), profile.context, { inboundContext: "a question", outboundText: marker });
      const listed = await listStyleExamples(db(), profile.context, { scope: "BUSINESS_PROFILE", status: "SUGGESTED" });
      return { id: listed.examples.find((row) => row.outboundText === marker)?.id ?? "" };
    };

    it("refuses an agent archiving a Workspace-scoped example, and it stays in the shared voice", async () => {
      const { id } = await exampleFor("WORKSPACE", "Shared voice one");
      const agent = await member("Decide Agent", "AGENT");

      await expect(archiveStyleExample(db(), agent.context, id)).rejects.toBeInstanceOf(WorkspacePermissionError);

      const after = await rowOf(id);
      expect(after.status).toBe("ACTIVE");
      expect(after.decidedByUserId).toBeNull();
      expect(await database.db.styleExampleDecision.count({ where: { styleExampleId: id } })).toBe(0);
    });

    it("still lets that same agent archive their own profile's example", async () => {
      // The control, and **the same principal** refused above — not another member who happens to share
      // the role. The guard is about the Workspace layer, not about agents.
      const { id } = await exampleFor("BUSINESS_PROFILE", "Own voice one");
      const agent = await member("Decide Own Agent", "AGENT");
      const { id: sharedId } = await exampleFor("WORKSPACE", "Shared voice control");

      await expect(archiveStyleExample(db(), agent.context, sharedId)).rejects.toBeInstanceOf(WorkspacePermissionError);

      expect((await archiveStyleExample(db(), agent.context, id)).status).toBe("ARCHIVED");
    });

    it("allows an admin to archive a Workspace-scoped example", async () => {
      const { id } = await exampleFor("WORKSPACE", "Shared voice two");
      const admin = await member("Decide Admin", "ADMIN");

      expect((await archiveStyleExample(db(), admin.context, id)).status).toBe("ARCHIVED");
      expect((await rowOf(id)).status).toBe("ARCHIVED");
    });

    it("refuses an agent approving a Workspace-scoped suggestion, and no approver is stamped", async () => {
      const { id } = await suggestedWorkspaceExample("Shared voice three");
      const agent = await member("Approve Agent", "AGENT");

      await expect(approveStyleExample(db(), agent.context, id)).rejects.toBeInstanceOf(WorkspacePermissionError);

      // The provenance argument, asserted rather than stated: a CHECK requires an approver for anything
      // ACTIVE, which is the database insisting a human vouched for it. The refusal has to leave the row
      // SUGGESTED *and* unstamped, or an agent has supplied that vouching for content every profile's
      // voice draws on.
      const after = await rowOf(id);
      expect(after.status).toBe("SUGGESTED");
      expect(after.approvedByUserId).toBeNull();
    });

    it("still lets that same agent approve their own profile's suggestion", async () => {
      const { id } = await suggestedProfileExample("Own voice two");
      const agent = await member("Approve Own Agent", "AGENT");
      const { id: sharedId } = await suggestedWorkspaceExample("Shared voice three-b");

      await expect(approveStyleExample(db(), agent.context, sharedId)).rejects.toBeInstanceOf(WorkspacePermissionError);

      expect((await approveStyleExample(db(), agent.context, id)).status).toBe("ACTIVATED");
      expect((await rowOf(id)).approvedByUserId).toBe(agent.userId);
    });

    it("allows an admin to approve a Workspace-scoped suggestion, and stamps them as its approver", async () => {
      const { id } = await suggestedWorkspaceExample("Shared voice four");
      const admin = await member("Approve Admin", "ADMIN");

      expect((await approveStyleExample(db(), admin.context, id)).status).toBe("ACTIVATED");

      const after = await rowOf(id);
      expect(after.status).toBe("ACTIVE");
      expect(after.approvedByUserId).toBe(admin.userId);
    });

    it("refuses an agent rejecting a Workspace-scoped suggestion, and it stays pending", async () => {
      const { id } = await suggestedWorkspaceExample("Shared voice five");
      const agent = await member("Reject Agent", "AGENT");

      await expect(rejectStyleExample(db(), agent.context, id)).rejects.toBeInstanceOf(WorkspacePermissionError);

      expect((await rowOf(id)).status).toBe("SUGGESTED");
    });

    it("still lets that same agent reject their own profile's suggestion", async () => {
      const { id } = await suggestedProfileExample("Own voice three");
      const agent = await member("Reject Own Agent", "AGENT");
      const { id: sharedId } = await suggestedWorkspaceExample("Shared voice five-b");

      await expect(rejectStyleExample(db(), agent.context, sharedId)).rejects.toBeInstanceOf(WorkspacePermissionError);

      expect((await rejectStyleExample(db(), agent.context, id)).status).toBe("REJECTED_EXAMPLE");
    });

    it("allows an admin to reject a Workspace-scoped suggestion", async () => {
      const { id } = await suggestedWorkspaceExample("Shared voice eight");
      const admin = await member("Reject Admin", "ADMIN");

      expect((await rejectStyleExample(db(), admin.context, id)).status).toBe("REJECTED_EXAMPLE");
      expect((await rowOf(id)).status).toBe("REJECTED");
    });

    it("refuses an agent restoring a Workspace-scoped example an admin archived", async () => {
      const { id } = await exampleFor("WORKSPACE", "Shared voice six");
      const admin = await member("Restore Admin", "ADMIN");
      expect((await archiveStyleExample(db(), admin.context, id)).status).toBe("ARCHIVED");

      const agent = await member("Restore Agent", "AGENT");

      // What this one protects is the *retrieval* half: a restore puts an archived example back into
      // every profile's voice. It does **not** re-stamp the approver — `decide` writes
      // `approvedByUserId` only when the row has none, and this row was stamped when it was created — so
      // the approver is asserted here as the thing that must stay untouched, not as the thing at risk.
      await expect(restoreStyleExample(db(), agent.context, id)).rejects.toBeInstanceOf(WorkspacePermissionError);

      const after = await rowOf(id);
      expect(after.status).toBe("ARCHIVED");
      expect(after.approvedByUserId).toBe(workspace.ownerUserId);
    });

    it("still lets that same agent restore their own profile's archived example", async () => {
      const { id } = await exampleFor("BUSINESS_PROFILE", "Own voice four");
      const agent = await member("Restore Own Agent", "AGENT");
      expect((await archiveStyleExample(db(), agent.context, id)).status).toBe("ARCHIVED");

      expect((await restoreStyleExample(db(), agent.context, id)).status).toBe("RESTORED");
      expect((await rowOf(id)).status).toBe("ACTIVE");
    });

    it("allows an admin to restore a Workspace-scoped example", async () => {
      const { id } = await exampleFor("WORKSPACE", "Shared voice seven");
      const admin = await member("Restore Admin Two", "ADMIN");
      expect((await archiveStyleExample(db(), admin.context, id)).status).toBe("ARCHIVED");

      expect((await restoreStyleExample(db(), admin.context, id)).status).toBe("RESTORED");
      expect((await rowOf(id)).status).toBe("ACTIVE");
    });
  });

  describe("who may write the voice every profile inherits", () => {
    /**
     * The Workspace layer is read by every Business Profile, so writing it from one profile's screen is a
     * cross-profile act — the same one `createStyleExample` guards for a workspace-scoped example, and the
     * one the privacy spec assigns to an admin or owner. `saveStyleProfile` was the single workspace-scoped
     * write in this file with no role check at all, so a member granted one profile could rewrite the voice
     * all of them reply in. These cases exist because nothing failed when that check was absent.
     */
    const contextFor = async (name: string, role: "AGENT" | "ADMIN") => {
      const user = await database.db.user.create({ data: { name, email: `${name.replace(/\W/gu, "-").toLowerCase()}@example.test` } });
      const owner = await authorizeWorkspaceAccess(database.db, { userId: workspace.ownerUserId, workspaceId: workspace.workspaceId });
      await addWorkspaceMember(database.db, owner, { userId: user.id, role, businessProfileScope: "ALL" });
      return authorizeBusinessProfileAccess(database.db, {
        userId: user.id,
        workspaceId: workspace.workspaceId,
        businessProfileId: profile.businessProfileId,
      });
    };

    const voice = { persona: "Rewritten", tone: null, replyLength: null, emoji: null, greeting: null, signOff: null, preferredPhrases: [], avoidedPhrases: [], language: null };

    const workspaceLayer = async () => {
      const layers = await readStyleProfiles(db(), profile.context);
      return layers.find((layer) => layer.scope === "WORKSPACE");
    };

    it("refuses an agent, who may answer in this profile but not change what every profile sounds like", async () => {
      const agent = await contextFor("Style Agent", "AGENT");
      const before = await workspaceLayer();

      await expect(saveStyleProfile(database.db, agent, "WORKSPACE", voice)).rejects.toBeInstanceOf(WorkspacePermissionError);

      // **This function is not transactional**, and that is why the row is read back rather than the
      // rejection being taken as proof. With the guard moved below its `updateMany` — a plausible
      // regression, since nothing structural holds it in place — the refusal still throws, the agent's
      // persona is committed to the layer every profile inherits, an audit row claims the save happened,
      // and the suite was measured passing 50/50. The exception is not the behaviour; the unchanged layer
      // is.
      expect(await workspaceLayer()).toEqual(before);
      expect(await database.db.styleProfile.count({ where: { workspaceId: workspace.workspaceId, businessProfileId: null, persona: voice.persona } })).toBe(0);
    });

    it("still lets that same agent write their own profile's layer, which is theirs to write", async () => {
      // The control, and the same principal refused above. The guard is about the workspace layer, not
      // about agents, and narrowing it to both would have taken the profile voice away from the people
      // who use it.
      const agent = await contextFor("Style Own Agent", "AGENT");

      await expect(saveStyleProfile(database.db, agent, "WORKSPACE", voice)).rejects.toBeInstanceOf(WorkspacePermissionError);

      expect((await saveStyleProfile(database.db, agent, "BUSINESS_PROFILE", voice)).status).toBe("SAVED");
    });

    it("allows an admin, because the privacy spec gives them this act", async () => {
      const admin = await contextFor("Style Admin", "ADMIN");

      expect((await saveStyleProfile(database.db, admin, "WORKSPACE", voice)).status).toBe("SAVED");
      // The write really landed, so the refusals above are about the role and not about a broken path.
      expect((await workspaceLayer())?.persona).toBe(voice.persona);
    });
  });

});

function blank() {
  return {
    persona: null,
    tone: null,
    replyLength: null,
    emoji: null,
    greeting: null,
    signOff: null,
    preferredPhrases: [] as readonly string[],
    avoidedPhrases: [] as readonly string[],
    language: null,
  };
}
