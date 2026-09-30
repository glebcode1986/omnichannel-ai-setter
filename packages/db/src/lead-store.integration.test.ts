/**
 * The lead pipeline, against a real server (Issue #33).
 *
 * The case this file exists for is the stale drag. A kanban card is a picture of the past, so a
 * transition that did not carry the stage the operator was looking at would silently overwrite whatever
 * changed since — and the board would then show the right thing while the audit trail read as if nobody
 * had disagreed. So the expected stage is part of the command, and losing that race is a distinct answer.
 */
import { noRetrieval } from "@omnichannel/application";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAiDraftStore } from "./ai-draft-store";

import {
  editLead,
  listLeads,
  readQualification,
  readStageDisplays,
  readStageHistory,
  recordQualification,
  saveStageDisplays,
  transitionLeadStage,
} from "./lead-store";
import { addWorkspaceMember } from "./repositories/workspaces";
import { authorizeWorkspaceAccess } from "./tenancy";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { seedWorkspace, type SeededProfile, type SeededWorkspace } from "./testing/fixtures";

describe.skipIf(!databaseTestsEnabled())("the lead pipeline", () => {
  let database: TestDatabase;
  let workspace: SeededWorkspace;
  let profile: SeededProfile;
  let neighbour: SeededWorkspace;
  let colleagueId: string;
  let outsiderId: string;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    workspace = await seedWorkspace(database.db, "leads");
    [profile] = workspace.profiles as [SeededProfile];
    neighbour = await seedWorkspace(database.db, "leads-neighbour");

    const colleague = await database.db.user.create({ data: { name: "Lead Colleague", email: "lead-colleague@example.test" } });
    const outsider = await database.db.user.create({ data: { name: "Lead Outsider", email: "lead-outsider@example.test" } });
    colleagueId = colleague.id;
    outsiderId = outsider.id;
    const workspaceContext = await authorizeWorkspaceAccess(database.db, { userId: workspace.ownerUserId, workspaceId: profile.context.workspaceId });
    await addWorkspaceMember(database.db, workspaceContext, { userId: colleagueId, role: "AGENT", businessProfileScope: "ALL" });
  }, 180_000);

  afterAll(async () => {
    await database?.dispose();
  });

  const db = () => database.db;
  const scope = () => ({ workspaceId: profile.context.workspaceId, businessProfileId: profile.businessProfileId });
  const key = () => ({ workspaceId_businessProfileId_id: { ...scope(), id: profile.conversationId } });
  const setStage = (stage: "NEW" | "ENGAGED" | "QUALIFYING" | "QUALIFIED" | "BOOKED" | "WON" | "LOST") =>
    db().conversation.update({ where: key(), data: { leadStage: stage } });

  describe("display stages", () => {
    it("returns every stage in product order before anything is configured", async () => {
      const displays = await readStageDisplays(db(), profile.context);

      expect(displays.map((display) => display.stage)).toEqual(["NEW", "ENGAGED", "QUALIFYING", "QUALIFIED", "BOOKED", "WON", "LOST"]);
      expect(displays.every((display) => display.isDefault)).toBe(true);
      expect(displays[0]?.label).toBe("New");
    }, 180_000);

    it("renames, reorders and hides without changing what a stage means", async () => {
      const outcome = await saveStageDisplays(db(), profile.context, [
        { stage: "QUALIFIED", label: "Ready to book", position: 0, hidden: false },
        { stage: "NEW", label: "Fresh", position: 1, hidden: false },
        { stage: "LOST", label: "Gone cold", position: 2, hidden: true },
      ]);

      expect(outcome).toEqual({ status: "SAVED" });
      const displays = await readStageDisplays(db(), profile.context);
      // The configured three come first in their chosen order; the rest keep the product's own order
      // after them, because a stage nobody configured still has to appear or its leads vanish.
      expect(displays[0]).toMatchObject({ stage: "QUALIFIED", label: "Ready to book", isDefault: false });
      expect(displays[1]).toMatchObject({ stage: "NEW", label: "Fresh" });
      expect(displays.find((display) => display.stage === "LOST")?.hidden).toBe(true);
      expect(displays.map((display) => display.stage)).toHaveLength(7);
      // And the internal vocabulary is untouched: a rename is a label, not a new stage.
      expect(displays.every((display) => ["NEW", "ENGAGED", "QUALIFYING", "QUALIFIED", "BOOKED", "WON", "LOST"].includes(display.stage))).toBe(true);
    }, 180_000);

    it("refuses a stage this product does not have", async () => {
      expect(await saveStageDisplays(db(), profile.context, [{ stage: "CUSTOMER" as never, label: "Customer", position: 0, hidden: false }])).toEqual({
        status: "REFUSED",
        reason: "that is not a stage this product has",
      });
    }, 180_000);

    it("refuses a duplicate stage, a duplicate position and a blank label", async () => {
      expect(
        await saveStageDisplays(db(), profile.context, [
          { stage: "NEW", label: "A", position: 0, hidden: false },
          { stage: "NEW", label: "B", position: 1, hidden: false },
        ]),
      ).toEqual({ status: "REFUSED", reason: "each stage appears once" });
      expect(
        await saveStageDisplays(db(), profile.context, [
          { stage: "NEW", label: "A", position: 0, hidden: false },
          { stage: "WON", label: "B", position: 0, hidden: false },
        ]),
      ).toEqual({ status: "REFUSED", reason: "each stage needs its own position" });
      expect(await saveStageDisplays(db(), profile.context, [{ stage: "NEW", label: "   ", position: 0, hidden: false }])).toEqual({
        status: "REFUSED",
        reason: "a stage needs a label",
      });
    }, 180_000);

    it("refuses hiding every stage, which would be a board with nothing on it", async () => {
      expect(await saveStageDisplays(db(), profile.context, [{ stage: "NEW", label: "Fresh", position: 0, hidden: true }])).toEqual({
        status: "REFUSED",
        reason: "at least one stage has to stay visible",
      });
    }, 180_000);

    it("never reads another Workspace's configuration", async () => {
      const [theirProfile] = neighbour.profiles as [SeededProfile];
      await saveStageDisplays(db(), theirProfile.context, [{ stage: "NEW", label: "Their name for it", position: 0, hidden: false }]);

      const mine = await readStageDisplays(db(), profile.context);
      expect(mine.map((display) => display.label)).not.toContain("Their name for it");
    }, 180_000);
  });

  describe("moving a lead", () => {
    it("moves it and records who did it", async () => {
      await setStage("NEW");

      const outcome = await transitionLeadStage(db(), profile.context, {
        conversationId: profile.conversationId,
        toStage: "QUALIFIED",
        expectedStage: "NEW",
        source: "HUMAN_SET",
      });

      expect(outcome).toEqual({ status: "MOVED", stage: "QUALIFIED" });
      const [latest] = await readStageHistory(db(), profile.context, profile.conversationId);
      expect(latest).toMatchObject({ fromStage: "NEW", toStage: "QUALIFIED", source: "HUMAN_SET", actorName: "Test leads-owner" });
    }, 180_000);

    /**
     * The stale drag, which is the whole reason `expectedStage` exists.
     *
     * The operator's board said ENGAGED. By the time they dropped the card, the stage was WON. Applying
     * the drop would undo a colleague's decision and leave a history reading as though nobody disagreed.
     */
    it("refuses a move from a stage the lead has already left, and says where it actually is", async () => {
      await setStage("ENGAGED");
      await transitionLeadStage(db(), profile.context, {
        conversationId: profile.conversationId,
        toStage: "WON",
        expectedStage: "ENGAGED",
        source: "HUMAN_SET",
      });

      const stale = await transitionLeadStage(db(), profile.context, {
        conversationId: profile.conversationId,
        toStage: "QUALIFIED",
        expectedStage: "ENGAGED",
        source: "HUMAN_SET",
      });

      expect(stale).toEqual({ status: "STALE", currentStage: "WON" });
      const current = await db().conversation.findUniqueOrThrow({ where: key(), select: { leadStage: true } });
      expect(current.leadStage).toBe("WON");
      // And no history row for the refused move: it did not happen.
      const history = await readStageHistory(db(), profile.context, profile.conversationId);
      expect(history.filter((entry) => entry.toStage === "QUALIFIED" && entry.fromStage === "ENGAGED")).toHaveLength(0);
    }, 180_000);

    it("says nothing moved when the lead is already where it is being dropped", async () => {
      await setStage("BOOKED");

      const outcome = await transitionLeadStage(db(), profile.context, {
        conversationId: profile.conversationId,
        toStage: "BOOKED",
        expectedStage: "BOOKED",
        source: "HUMAN_SET",
      });

      // A history of non-moves is a history nobody reads, and the `from <> to` CHECK would refuse it.
      expect(outcome).toEqual({ status: "UNCHANGED", stage: "BOOKED" });
    }, 180_000);

    it("refuses a stage this product does not have", async () => {
      await setStage("NEW");

      expect(
        await transitionLeadStage(db(), profile.context, {
          conversationId: profile.conversationId,
          toStage: "CUSTOMER" as never,
          expectedStage: "NEW",
          source: "HUMAN_SET",
        }),
      ).toEqual({ status: "REFUSED", reason: "that is not a stage this product has" });
    }, 180_000);

    it("cannot move another Workspace's lead", async () => {
      const [theirProfile] = neighbour.profiles as [SeededProfile];

      const outcome = await transitionLeadStage(db(), profile.context, {
        conversationId: theirProfile.conversationId,
        toStage: "WON",
        expectedStage: "NEW",
        source: "HUMAN_SET",
      });

      expect(outcome).toEqual({ status: "GONE" });
    }, 180_000);

    it("keeps the whole history, newest first", async () => {
      await setStage("NEW");
      await transitionLeadStage(db(), profile.context, { conversationId: profile.conversationId, toStage: "ENGAGED", expectedStage: "NEW", source: "HUMAN_SET" });
      await transitionLeadStage(db(), profile.context, {
        conversationId: profile.conversationId,
        toStage: "QUALIFYING",
        expectedStage: "ENGAGED",
        source: "HUMAN_CONFIRMED",
      });

      const history = await readStageHistory(db(), profile.context, profile.conversationId);
      expect(history[0]).toMatchObject({ toStage: "QUALIFYING", source: "HUMAN_CONFIRMED" });
      expect(history[1]).toMatchObject({ toStage: "ENGAGED", source: "HUMAN_SET" });
    }, 180_000);

    /**
     * The invariant, tested against the database rather than against this file.
     *
     * A human change with nobody's name on it is unattributed rather than automatic, and an AI suggestion
     * has no actor to name. A CHECK pairs the two, so the test that means anything tries to break it.
     */
    it("cannot record a human change with no actor, or an AI suggestion with one", async () => {
      await expect(
        db().leadStageTransition.create({
          data: { ...scope(), conversationId: profile.conversationId, fromStage: "NEW", toStage: "WON", source: "HUMAN_SET" },
        }),
      ).rejects.toThrow(/lead_stage_transitions_actor_check/u);

      await expect(
        db().leadStageTransition.create({
          data: {
            ...scope(),
            conversationId: profile.conversationId,
            fromStage: "NEW",
            toStage: "WON",
            source: "AI_SUGGESTED",
            actorUserId: workspace.ownerUserId,
          },
        }),
      ).rejects.toThrow(/lead_stage_transitions_actor_check/u);
    }, 180_000);
  });

  describe("the lead's own fields", () => {
    it("assigns, tags, notes and sets a next action", async () => {
      const when = new Date("2026-10-05T09:00:00.000Z");

      const outcome = await editLead(db(), profile.context, profile.conversationId, {
        assignedUserId: colleagueId,
        tags: ["  vip  ", "vip", "", "returning"],
        note: "  Prefers mornings.  ",
        nextAction: "Call back",
        nextActionAt: when,
      });

      expect(outcome).toEqual({ status: "SAVED" });
      const [lead] = (await listLeads(db(), profile.context)).filter((row) => row.conversationId === profile.conversationId);
      expect(lead?.assignedUserName).toBe("Lead Colleague");
      // Trimmed and deduplicated: two spellings of one tag would split a filter in two.
      expect(lead?.tags).toEqual(["vip", "returning"]);
      expect(lead?.note).toBe("Prefers mornings.");
      expect(lead?.nextActionAt?.toISOString()).toBe(when.toISOString());
    }, 180_000);

    it("refuses to assign a lead to somebody who is not in this Workspace", async () => {
      // A name on a lead that nobody can act under would tell the next reader that person is working it.
      expect(await editLead(db(), profile.context, profile.conversationId, { assignedUserId: outsiderId })).toEqual({
        status: "REFUSED",
        reason: "a lead can only be assigned to a member of this workspace",
      });
    }, 180_000);

    it("clears an assignee, a note and a next action", async () => {
      await editLead(db(), profile.context, profile.conversationId, { assignedUserId: colleagueId, note: "Something", nextAction: "Call" });

      await editLead(db(), profile.context, profile.conversationId, { assignedUserId: null, note: "  ", nextAction: "" });

      const [lead] = (await listLeads(db(), profile.context)).filter((row) => row.conversationId === profile.conversationId);
      expect(lead?.assignedUserId).toBeNull();
      expect(lead?.note).toBeNull();
      expect(lead?.nextAction).toBeNull();
    }, 180_000);

    it("cannot edit another Workspace's lead", async () => {
      const [theirProfile] = neighbour.profiles as [SeededProfile];

      expect(await editLead(db(), profile.context, theirProfile.conversationId, { note: "Hijacked" })).toEqual({ status: "GONE" });
    }, 180_000);
  });

  describe("qualification answers", () => {
    it("keeps the AI's reading and a person's answer side by side", async () => {
      await db().leadQualificationAnswer.create({
        data: { ...scope(), conversationId: profile.conversationId, criterion: "has a budget", value: "probably", source: "AI_SUGGESTED" },
      });

      await recordQualification(db(), profile.context, profile.conversationId, {
        criterion: "has a budget",
        value: "yes, 400",
        source: "HUMAN_CONFIRMED",
      });

      const answers = await readQualification(db(), profile.context, profile.conversationId);
      const forCriterion = answers.filter((answer) => answer.criterion === "has a budget");
      // Both, not merged: a reader who saw one field could not tell whether a person ever looked at it.
      expect(forCriterion).toHaveLength(2);
      expect(forCriterion.find((answer) => answer.source === "AI_SUGGESTED")?.value).toBe("probably");
      expect(forCriterion.find((answer) => answer.source === "HUMAN_CONFIRMED")?.value).toBe("yes, 400");
      expect(forCriterion.find((answer) => answer.source === "HUMAN_CONFIRMED")?.actorName).toBe("Test leads-owner");
    }, 180_000);

    it("replaces a person's own earlier answer rather than stacking them", async () => {
      await recordQualification(db(), profile.context, profile.conversationId, { criterion: "wants a date", value: "maybe", source: "HUMAN_SET" });
      await recordQualification(db(), profile.context, profile.conversationId, { criterion: "wants a date", value: "the 12th", source: "HUMAN_SET" });

      const answers = (await readQualification(db(), profile.context, profile.conversationId)).filter((answer) => answer.criterion === "wants a date");
      expect(answers).toHaveLength(1);
      expect(answers[0]?.value).toBe("the 12th");
    }, 180_000);

    it("refuses half an answer", async () => {
      expect(await recordQualification(db(), profile.context, profile.conversationId, { criterion: "  ", value: "yes", source: "HUMAN_SET" })).toEqual({
        status: "REFUSED",
        reason: "an answer needs both the question and the answer",
      });
    }, 180_000);

    it("cannot answer for another Workspace's lead", async () => {
      const [theirProfile] = neighbour.profiles as [SeededProfile];

      expect(
        await recordQualification(db(), profile.context, theirProfile.conversationId, { criterion: "budget", value: "yes", source: "HUMAN_SET" }),
      ).toEqual({ status: "GONE" });
    }, 180_000);
  });

  describe("listing leads", () => {
    /**
     * The invariant, with the two values deliberately disagreeing.
     *
     * An assertion that only checked the suggestion was "present or null" would be a tautology — mine
     * was, at first. What has to be true is that a suggestion of WON does not become the lead's stage,
     * and that both are reported so a screen can show the disagreement.
     */
    it("keeps the AI's suggested stage apart from the confirmed one", async () => {
      await setStage("ENGAGED");
      await createAiDraftStore(db()).saveDraft({
        scope: { ...scope(), conversationId: profile.conversationId },
        generationKey: `lead_suggest_${String(Date.now())}`,
        trigger: "AUTOMATIC",
        anchorMessageId: profile.messageId,
        anchorStateVersion: 1,
        text: "Shall I book you in?",
        structuredOutput: { reply: "Shall I book you in?" },
        confidence: 0.9,
        modelSuggestsSend: true,
        needsReview: false,
        reasonCodes: [],
        factualSourceIds: [],
        retrieval: noRetrieval("OK"),
        status: "PENDING",
        provider: "anthropic",
        model: "claude-opus-5",
        promptVersion: "reply.v1",
        schemaVersion: "ai-draft.v1",
        suggestedLeadStage: "WON",
      });

      const [lead] = (await listLeads(db(), profile.context)).filter((row) => row.conversationId === profile.conversationId);

      // The AI thinks WON. Nobody confirmed it, so the lead is still where a person left it.
      expect(lead?.stage).toBe("ENGAGED");
      expect(lead?.suggestedStage).toBe("WON");
      const current = await db().conversation.findUniqueOrThrow({ where: key(), select: { leadStage: true } });
      expect(current.leadStage).toBe("ENGAGED");
    }, 180_000);

    it("filters by stage, assignee and tag", async () => {
      await setStage("QUALIFIED");
      await editLead(db(), profile.context, profile.conversationId, { assignedUserId: colleagueId, tags: ["vip"] });

      expect((await listLeads(db(), profile.context, { stage: "QUALIFIED" })).map((row) => row.conversationId)).toContain(profile.conversationId);
      expect((await listLeads(db(), profile.context, { stage: "LOST" })).map((row) => row.conversationId)).not.toContain(profile.conversationId);
      expect((await listLeads(db(), profile.context, { assignedUserId: colleagueId })).map((row) => row.conversationId)).toContain(profile.conversationId);
      expect((await listLeads(db(), profile.context, { tag: "vip" })).map((row) => row.conversationId)).toContain(profile.conversationId);
      expect((await listLeads(db(), profile.context, { tag: "cold" })).map((row) => row.conversationId)).not.toContain(profile.conversationId);
    }, 180_000);

    it("never lists another Workspace's leads", async () => {
      const [theirProfile] = neighbour.profiles as [SeededProfile];

      expect((await listLeads(db(), profile.context)).map((row) => row.conversationId)).not.toContain(theirProfile.conversationId);
    }, 180_000);
  });
});
