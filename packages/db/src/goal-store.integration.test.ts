/**
 * What a conversation is for (Issue #55).
 *
 * The cases worth writing are the ones about authority and about what a goal does *not* do. A goal that
 * could be set by a model, or that carried a schedule, would make the follow-up gate decorative.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeGoal, readGoals, setNextAction, setPrimaryGoal, suggestGoal } from "./goal-store";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { seedWorkspace, type SeededProfile, type SeededWorkspace } from "./testing/fixtures";

const AT = new Date("2026-10-05T10:00:00.000Z");

describe.skipIf(!databaseTestsEnabled())("conversation goals", () => {
  let database: TestDatabase;
  let seq = 0;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
  }, 180_000);

  afterAll(async () => {
    await database?.dispose();
  });

  const db = () => database.db;

  /** Its own workspace per case: one active primary goal per conversation is the invariant under test. */
  const fresh = async (label = "goal") => {
    seq += 1;
    const workspace: SeededWorkspace = await seedWorkspace(db(), `${label}-${String(seq)}`);
    const [profile] = workspace.profiles as [SeededProfile];
    return { workspace, profile, scope: { workspaceId: profile.context.workspaceId, businessProfileId: profile.businessProfileId } };
  };

  const draftFor = async (profile: SeededProfile) => {
    seq += 1;
    const draft = await db().aiDraft.create({
      data: {
        workspaceId: profile.context.workspaceId,
        businessProfileId: profile.businessProfileId,
        conversationId: profile.conversationId,
        anchorMessageId: profile.messageId,
        anchorStateVersion: 1,
        generationKey: `goal-draft-${String(seq)}`,
        trigger: "AUTOMATIC",
        text: "Shall I book you in?",
        structuredOutput: { reply: "x" },
        confidence: 0.9,
        modelSuggestsSend: true,
        needsReview: false,
        status: "PENDING",
        modelProvider: "anthropic",
        modelName: "claude-opus-5",
        promptVersion: "reply.v1",
        schemaVersion: "ai-draft.v1",
      },
      select: { id: true },
    });
    return draft.id;
  };

  it("records who set the goal", async () => {
    const { profile } = await fresh();

    const set = await setPrimaryGoal(db(), profile.context, { conversationId: profile.conversationId, kind: "BOOK_APPOINTMENT", note: "Wants a Saturday", at: AT });

    expect(set.status).toBe("SET");
    const goals = await readGoals(db(), profile.context, profile.conversationId);
    expect(goals.primary).toMatchObject({ kind: "BOOK_APPOINTMENT", isPrimary: true, status: "ACTIVE", source: "HUMAN_SET" });
    expect(goals.primary?.setByName).toContain("Test goal-");
    expect(goals.primary?.note).toBe("Wants a Saturday");
  }, 180_000);

  it("keeps a model's reading as a suggestion, never the conversation's goal", async () => {
    const { profile } = await fresh();
    const draftId = await draftFor(profile);

    const suggested = await suggestGoal(db(), profile.context, { conversationId: profile.conversationId, kind: "BOOK_APPOINTMENT", sourceDraftId: draftId });

    expect(suggested.status).toBe("SUGGESTED");
    const goals = await readGoals(db(), profile.context, profile.conversationId);
    // There is no primary goal: the model's reading is beside the question, not the answer to it.
    expect(goals.primary).toBeUndefined();
    expect(goals.all[0]).toMatchObject({ isPrimary: false, source: "AI_SUGGESTED", sourceDraftId: draftId });
  }, 180_000);

  it("refuses a suggestion with no draft behind it, in the database", async () => {
    const { profile, scope } = await fresh();

    // An AI goal that named no reply would be a claim nobody can trace.
    await expect(
      db().conversationGoal.create({
        data: { ...scope, conversationId: profile.conversationId, kind: "QUALIFY_LEAD", isPrimary: false, source: "AI_SUGGESTED" },
      }),
    ).rejects.toThrow(/conversation_goals_provenance_check/u);
  }, 180_000);

  it("refuses a person's goal with nobody's name on it, in the database", async () => {
    const { profile, scope } = await fresh();

    await expect(
      db().conversationGoal.create({
        data: { ...scope, conversationId: profile.conversationId, kind: "QUALIFY_LEAD", isPrimary: true, source: "HUMAN_SET" },
      }),
    ).rejects.toThrow(/conversation_goals_provenance_check/u);
  }, 180_000);

  it("retires the old goal rather than losing it", async () => {
    const { profile } = await fresh();
    const first = await setPrimaryGoal(db(), profile.context, { conversationId: profile.conversationId, kind: "ANSWER_QUESTION", at: AT });

    await setPrimaryGoal(db(), profile.context, { conversationId: profile.conversationId, kind: "BOOK_APPOINTMENT", at: AT });

    const goals = await readGoals(db(), profile.context, profile.conversationId);
    expect(goals.primary?.kind).toBe("BOOK_APPOINTMENT");
    // What a conversation used to be for is how somebody later understands a follow-up sent under it.
    expect(goals.all.find((goal) => goal.id === (first.status === "SET" ? first.id : ""))).toMatchObject({ status: "ABANDONED" });
  }, 180_000);

  it("allows exactly one active primary goal, in the database", async () => {
    const { profile, scope } = await fresh();
    await setPrimaryGoal(db(), profile.context, { conversationId: profile.conversationId, kind: "ANSWER_QUESTION", at: AT });

    // Two would be two answers to "what are we trying to do here", and the assistant would pick one at
    // random. The partial index is what makes the store's transaction necessary rather than merely tidy.
    await expect(
      db().conversationGoal.create({
        data: { ...scope, conversationId: profile.conversationId, kind: "QUALIFY_LEAD", isPrimary: true, source: "HUMAN_SET", setByUserId: profile.context.userId },
      }),
    ).rejects.toThrow(/conversation_goals_active_primary_key|Unique constraint/u);
  }, 180_000);

  it("treats setting the goal it already has as no change", async () => {
    const { profile } = await fresh();
    const first = await setPrimaryGoal(db(), profile.context, { conversationId: profile.conversationId, kind: "COLLECT_DETAILS", note: "Needs an address", at: AT });

    const again = await setPrimaryGoal(db(), profile.context, { conversationId: profile.conversationId, kind: "COLLECT_DETAILS", at: AT });

    // Writing a new row would retire a goal in favour of itself and lose the note and the moment somebody
    // actually decided.
    expect(again).toEqual({ status: "UNCHANGED", id: first.status === "SET" ? first.id : "" });
    expect((await readGoals(db(), profile.context, profile.conversationId)).primary?.note).toBe("Needs an address");
  }, 180_000);

  it("records the moment a goal was reached", async () => {
    const { profile } = await fresh();
    const set = await setPrimaryGoal(db(), profile.context, { conversationId: profile.conversationId, kind: "BOOK_APPOINTMENT", at: AT });
    const goalId = set.status === "SET" ? set.id : "";

    expect(await closeGoal(db(), profile.context, goalId, "ACHIEVED", AT)).toEqual({ status: "ACHIEVED", id: goalId });

    const goals = await readGoals(db(), profile.context, profile.conversationId);
    expect(goals.primary).toBeUndefined();
    expect(goals.all[0]).toMatchObject({ status: "ACHIEVED", achievedAt: AT, abandonedAt: null });
  }, 180_000);

  it("refuses a half-terminal row in the database", async () => {
    const { profile } = await fresh();
    const set = await setPrimaryGoal(db(), profile.context, { conversationId: profile.conversationId, kind: "QUALIFY_LEAD", at: AT });
    const goalId = set.status === "SET" ? set.id : "";

    // A terminal status with no moment, or a moment with an active status, is a row the analytics cannot
    // count and a reader cannot interpret.
    await expect(db().conversationGoal.update({ where: { id: goalId }, data: { status: "ACHIEVED" } })).rejects.toThrow(/conversation_goals_terminal_check/u);
    await expect(db().conversationGoal.update({ where: { id: goalId }, data: { achievedAt: AT } })).rejects.toThrow(/conversation_goals_terminal_check/u);
  }, 180_000);

  it("will not let a goal be both achieved and abandoned", async () => {
    const { profile } = await fresh();
    const set = await setPrimaryGoal(db(), profile.context, { conversationId: profile.conversationId, kind: "QUALIFY_LEAD", at: AT });

    await expect(
      db().conversationGoal.update({ where: { id: set.status === "SET" ? set.id : "" }, data: { status: "ACHIEVED", achievedAt: AT, abandonedAt: AT } }),
    ).rejects.toThrow(/conversation_goals_terminal_check/u);
  }, 180_000);

  it("refuses to call NONE achieved, since it says nothing further happens", async () => {
    const { profile } = await fresh();
    const set = await setPrimaryGoal(db(), profile.context, { conversationId: profile.conversationId, kind: "NONE", at: AT });
    const goalId = set.status === "SET" ? set.id : "";

    expect(await closeGoal(db(), profile.context, goalId, "ACHIEVED", AT)).toEqual({ status: "REFUSED", reason: "a goal of NONE cannot be achieved" });
    // A CHECK says the same, so the store is not the only thing holding it.
    await expect(db().conversationGoal.update({ where: { id: goalId }, data: { status: "ACHIEVED", achievedAt: AT } })).rejects.toThrow(
      /conversation_goals_none_check/u,
    );
    // Abandoning it is fine: deciding there is nothing further and then changing your mind is ordinary.
    expect(await closeGoal(db(), profile.context, goalId, "ABANDONED", AT)).toEqual({ status: "ABANDONED", id: goalId });
  }, 180_000);

  it("cannot close a goal twice", async () => {
    const { profile } = await fresh();
    const set = await setPrimaryGoal(db(), profile.context, { conversationId: profile.conversationId, kind: "QUALIFY_LEAD", at: AT });
    const goalId = set.status === "SET" ? set.id : "";
    await closeGoal(db(), profile.context, goalId, "ACHIEVED", AT);

    expect(await closeGoal(db(), profile.context, goalId, "ABANDONED", AT)).toEqual({ status: "GONE" });
  }, 180_000);

  it("carries no schedule at all", async () => {
    const columns = await db().$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'conversation_goals'`;
    const names = columns.map((row) => row.column_name);

    // A goal that implied a due date would chase customers by existing, and the decision to message
    // somebody would be made by whoever set the goal rather than by the gate.
    for (const forbidden of ["due_at", "next_attempt_at", "attempt_count", "max_attempts", "scheduled_for"]) {
      expect(names, `conversation_goals must not have ${forbidden}`).not.toContain(forbidden);
    }
  }, 180_000);

  it("keeps the next action on the conversation, where the leads board reads it", async () => {
    const { profile, scope } = await fresh();

    expect(await setNextAction(db(), profile.context, { conversationId: profile.conversationId, nextAction: "Call about Saturday", nextActionAt: AT })).toMatchObject({
      status: "SET",
    });

    // Deliberately the conversation's own field rather than a new table: a lead's "what happens next" and
    // a conversation's are the same question, and two places to answer it would give two answers.
    const row = await db().conversation.findFirst({ where: { ...scope, id: profile.conversationId }, select: { nextAction: true, nextActionAt: true } });
    expect(row).toEqual({ nextAction: "Call about Saturday", nextActionAt: AT });
  }, 180_000);

  it("clears the moment when the action is cleared", async () => {
    const { profile, scope } = await fresh();
    await setNextAction(db(), profile.context, { conversationId: profile.conversationId, nextAction: "Something", nextActionAt: AT });

    await setNextAction(db(), profile.context, { conversationId: profile.conversationId, nextAction: null });

    // A date with nothing attached is a reminder about nothing.
    expect(await db().conversation.findFirst({ where: { ...scope, id: profile.conversationId }, select: { nextAction: true, nextActionAt: true } })).toEqual({
      nextAction: null,
      nextActionAt: null,
    });
  }, 180_000);

  it("refuses a next action that is only whitespace", async () => {
    const { profile } = await fresh();

    expect(await setNextAction(db(), profile.context, { conversationId: profile.conversationId, nextAction: "   " })).toEqual({
      status: "REFUSED",
      reason: "a next action needs either words or nothing at all",
    });
  }, 180_000);

  it("does not reach into another Business Profile", async () => {
    const { profile } = await fresh();
    seq += 1;
    const other = await seedWorkspace(db(), `goal-other-${String(seq)}`);
    const [theirs] = other.profiles as [SeededProfile];

    expect(await setPrimaryGoal(db(), profile.context, { conversationId: theirs.conversationId, kind: "QUALIFY_LEAD", at: AT })).toEqual({ status: "GONE" });
    expect(await setNextAction(db(), profile.context, { conversationId: theirs.conversationId, nextAction: "Reach across" })).toEqual({ status: "GONE" });
    expect((await readGoals(db(), profile.context, theirs.conversationId)).all).toEqual([]);
  }, 180_000);
});
