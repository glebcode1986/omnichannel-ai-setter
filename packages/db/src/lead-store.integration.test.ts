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
import { WorkspacePermissionError } from "./errors";
import { addWorkspaceMember } from "./repositories/workspaces";
import { authorizeBusinessProfileAccess, authorizeWorkspaceAccess } from "./tenancy";
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

  describe("who may reconfigure the board every profile sees", () => {
    /**
     * `lead_stage_displays` has **no `business_profile_id` column** — it is keyed
     * `(workspace_id, stage)`, and `readStageDisplays` reads it by Workspace alone — so the labels,
     * order and hidden flags are the board every Business Profile in the Workspace sees.
     * `saveStageDisplays` took a `BusinessProfileContext`, then deleted every row for
     * `context.workspaceId` and recreated them from the submitted form, with no role check at any layer:
     * `saveStagesAction` called only `requireBusinessProfileContext` and the Leads page rendered the form
     * unconditionally. So an AGENT granted a single profile could rename, reorder and hide the stages on
     * every other profile's board — and hiding one takes those leads off everyone's board.
     *
     * The refusal asserts the **rows**, not only the exception. This function's write is a
     * `$transaction`, so a misplaced guard would roll back — but a guard is not the only way this can
     * regress, and a refusal means "the configuration did not move", which is a claim about the table.
     */
    const member = async (name: string, role: "AGENT" | "ADMIN") => {
      const user = await database.db.user.create({ data: { name, email: `${name.replace(/\W/gu, "-").toLowerCase()}@example.test` } });
      const owner = await authorizeWorkspaceAccess(database.db, { userId: workspace.ownerUserId, workspaceId: profile.context.workspaceId });
      await addWorkspaceMember(database.db, owner, { userId: user.id, role, businessProfileScope: "ALL" });
      return authorizeBusinessProfileAccess(database.db, { userId: user.id, workspaceId: profile.context.workspaceId, businessProfileId: profile.businessProfileId });
    };

    const board = async () =>
      database.db.leadStageDisplay.findMany({
        where: { workspaceId: profile.context.workspaceId },
        select: { stage: true, label: true, position: true, hidden: true },
        orderBy: { position: "asc" },
      });

    const configuration = [
      { stage: "NEW" as const, label: "Agent's name for it", position: 0, hidden: false },
      { stage: "LOST" as const, label: "Hidden by an agent", position: 1, hidden: true },
    ];

    it("refuses an agent, and the board every profile reads does not move", async () => {
      await saveStageDisplays(db(), profile.context, [{ stage: "NEW", label: "The owner's name for it", position: 0, hidden: false }]);
      const before = await board();
      const agent = await member("Stage Agent", "AGENT");

      await expect(saveStageDisplays(db(), agent, configuration)).rejects.toBeInstanceOf(WorkspacePermissionError);

      expect(await board()).toEqual(before);
    }, 180_000);

    it("refuses before it validates, so an unauthorized post cannot probe the rules", async () => {
      // Invalid input *and* the wrong role. The answer has to be the permission error: whether this member
      // may reconfigure the shared board does not depend on whether their form was well formed.
      const agent = await member("Stage Probe Agent", "AGENT");

      await expect(saveStageDisplays(db(), agent, [{ stage: "NEW", label: "   ", position: 0, hidden: false }])).rejects.toBeInstanceOf(
        WorkspacePermissionError,
      );
    }, 180_000);

    it("still lets that same agent do the lead work that is theirs", async () => {
      // The control, and it is a different shape from the knowledge and style ones: there is no
      // profile-scoped variant of a stage configuration to fall back on, because the model has no profile
      // column. So what must still work is the ordinary pipeline — moving a lead and editing it — which is
      // what would have been lost had the guard been put on the wrong function.
      const agent = await member("Stage Own Agent", "AGENT");
      await setStage("NEW");

      await expect(saveStageDisplays(db(), agent, configuration)).rejects.toBeInstanceOf(WorkspacePermissionError);

      expect(
        await transitionLeadStage(db(), agent, { conversationId: profile.conversationId, toStage: "ENGAGED", expectedStage: "NEW", source: "HUMAN_SET" }),
      ).toEqual({ status: "MOVED", stage: "ENGAGED" });
      expect((await readStageDisplays(db(), agent)).length).toBe(7);
    }, 180_000);

    it("allows an admin, and the configuration really lands", async () => {
      const admin = await member("Stage Admin", "ADMIN");

      expect(await saveStageDisplays(db(), admin, configuration)).toEqual({ status: "SAVED" });

      // Without this the refusals above would also pass if the write were broken for everyone.
      expect(await board()).toEqual([
        { stage: "NEW", label: "Agent's name for it", position: 0, hidden: false },
        { stage: "LOST", label: "Hidden by an agent", position: 1, hidden: true },
      ]);
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
        reason: "a lead can only be assigned to somebody who works on this Business Profile",
      });
    }, 180_000);

    /**
     * The half that Workspace membership alone lets through — and did.
     *
     * `editLead` checked membership and never the Business Profile grant, so a member whose scope is
     * `SELECTED` without this profile could be given a lead inside it: parked where its assignee cannot
     * open it, shown to everybody else as somebody's work, and their name carried into a profile-scoped
     * read. The same asymmetry was a blocking finding on human tasks (#55); this is the leads half, found
     * by looking for the class rather than waiting for it to be reported twice.
     */
    it("refuses a member of this Workspace who was not granted this Business Profile", async () => {
      const ungranted = await db().user.create({ data: { name: "Lead Ungranted", email: `lead-ungranted-${String(Date.now())}@example.test` } });
      const workspaceContext = await authorizeWorkspaceAccess(db(), { userId: workspace.ownerUserId, workspaceId: profile.context.workspaceId });
      await addWorkspaceMember(db(), workspaceContext, { userId: ungranted.id, role: "AGENT", businessProfileScope: { selected: [] } });

      expect(await editLead(db(), profile.context, profile.conversationId, { assignedUserId: ungranted.id })).toEqual({
        status: "REFUSED",
        reason: "a lead can only be assigned to somebody who works on this Business Profile",
      });
      // And the same refusal for a user id that belongs to nobody, so an assignment form cannot become a
      // way to discover who exists.
      expect(await editLead(db(), profile.context, profile.conversationId, { assignedUserId: "01999999-9999-7999-8999-999999999999" })).toMatchObject({
        status: "REFUSED",
      });
    }, 180_000);

    it("names nobody when a stored assignee is not somebody this profile may know", async () => {
      const stranger = neighbour.ownerUserId;
      // Written past the store, which is how a row from before the guard — or one a console session wrote
      // — actually arrives. The foreign key permits it: it references global `users(id)`.
      await db().conversation.updateMany({ where: { id: profile.conversationId }, data: { assignedUserId: stranger } });

      const [lead] = (await listLeads(db(), profile.context)).filter((row) => row.conversationId === profile.conversationId);

      // The id stays, because an operator needs to see that the lead is parked on somebody who cannot work
      // it in order to take it back. The name does not: this profile has no business knowing it.
      expect(lead?.assignedUserId).toBe(stranger);
      expect(lead?.assignedUserName).toBeNull();
      const strangerName = await db().user.findUniqueOrThrow({ where: { id: stranger }, select: { name: true } });
      expect(JSON.stringify(lead)).not.toContain(strangerName.name);
      await db().conversation.updateMany({ where: { id: profile.conversationId }, data: { assignedUserId: null } });
    }, 180_000);

    it("stops naming a colleague the moment their grant is taken away", async () => {
      const revoked = await db().user.create({ data: { name: "Lead Revoked", email: `lead-revoked-${String(Date.now())}@example.test` } });
      const workspaceContext = await authorizeWorkspaceAccess(db(), { userId: workspace.ownerUserId, workspaceId: profile.context.workspaceId });
      await addWorkspaceMember(db(), workspaceContext, {
        userId: revoked.id,
        role: "AGENT",
        businessProfileScope: { selected: [profile.businessProfileId] },
      });
      expect(await editLead(db(), profile.context, profile.conversationId, { assignedUserId: revoked.id })).toEqual({ status: "SAVED" });
      const named = (await listLeads(db(), profile.context)).find((row) => row.conversationId === profile.conversationId);
      // The positive control: while the grant stands the name is shown, so this case cannot pass by the
      // list having stopped naming anybody at all.
      expect(named?.assignedUserName).toBe("Lead Revoked");

      await db().memberBusinessProfileAccess.deleteMany({
        where: { businessProfileId: profile.businessProfileId, member: { userId: revoked.id } },
      });

      const after = (await listLeads(db(), profile.context)).find((row) => row.conversationId === profile.conversationId);
      expect(after?.assignedUserId).toBe(revoked.id);
      expect(after?.assignedUserName).toBeNull();
      await db().conversation.updateMany({ where: { id: profile.conversationId }, data: { assignedUserId: null } });
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
