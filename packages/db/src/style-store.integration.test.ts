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

import {
  approveStyleExample,
  archiveStyleExample,
  createStyleExample,
  listStyleExamples,
  readStyleProfiles,
  rejectStyleExample,
  restoreStyleExample,
  saveStyleProfile,
  suggestStyleExample,
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
