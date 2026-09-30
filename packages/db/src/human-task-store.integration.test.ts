/**
 * Human tasks, and the one thing they cannot do (Issue #55).
 *
 * "Completion or dismissal of a HumanTask never sends a customer a message" is the invariant, and the
 * strongest form of it is not a test of `completeTask` — it is the shape of the table. `human_tasks` has
 * no draft, no operation id and no delivery relation, so the isolation test below reads the schema and
 * asserts that absence. A future writer who wanted "mark done" to send something would have to add a
 * column, and that is a decision somebody makes on purpose in a reviewed diff.
 *
 * The behavioural tests are still here, because the schema shape proves nothing can be sent *from this
 * table* and the tests prove nothing is sent *by these functions* either.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assignTask, completeTask, createTask, dismissTask, listTasks, suggestTask } from "./human-task-store";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { seedWorkspace, type SeededProfile, type SeededWorkspace } from "./testing/fixtures";

const AT = new Date("2026-10-05T10:00:00.000Z");

describe.skipIf(!databaseTestsEnabled())("human tasks", () => {
  let database: TestDatabase;
  let workspace: SeededWorkspace;
  let profile: SeededProfile;
  let neighbour: SeededWorkspace;
  let draftId: string;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    workspace = await seedWorkspace(database.db, "tasks");
    [profile] = workspace.profiles as [SeededProfile];
    neighbour = await seedWorkspace(database.db, "tasks-neighbour");
    const draft = await database.db.aiDraft.create({
      data: {
        workspaceId: profile.context.workspaceId,
        businessProfileId: profile.businessProfileId,
        conversationId: profile.conversationId,
        anchorMessageId: profile.messageId,
        anchorStateVersion: 1,
        generationKey: "task-source",
        trigger: "AUTOMATIC",
        text: "I will check and come back to you.",
        structuredOutput: { reply: "x" },
        confidence: 0.8,
        modelSuggestsSend: false,
        needsReview: true,
        status: "PENDING",
        modelProvider: "anthropic",
        modelName: "claude-opus-5",
        promptVersion: "reply.v1",
        schemaVersion: "ai-draft.v1",
      },
      select: { id: true },
    });
    draftId = draft.id;
  }, 180_000);

  afterAll(async () => {
    await database?.dispose();
  });

  const db = () => database.db;
  const scope = () => ({ workspaceId: profile.context.workspaceId, businessProfileId: profile.businessProfileId });

  describe("isolation from anything that sends", () => {
    it("has no column a send path could attach to", async () => {
      const columns = await db().$queryRaw<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'human_tasks'`;
      const names = columns.map((row) => row.column_name);

      expect(names.length).toBeGreaterThan(5);
      // The absence *is* the mechanism. Adding any of these would be the moment somebody made "mark done"
      // capable of messaging a customer, and it would have to be argued for in a diff.
      for (const forbidden of ["draft_id", "operation_id", "delivery_job_id", "correlation_id", "scheduled_for", "platform_message_id", "channel_message_id"]) {
        expect(names, `human_tasks must not have ${forbidden}`).not.toContain(forbidden);
      }
    }, 180_000);

    it("has no foreign key into deliveries or messages", async () => {
      const references = await db().$queryRaw<{ referenced: string }[]>`
        SELECT ccu.table_name AS referenced
          FROM information_schema.table_constraints tc
          JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
         WHERE tc.table_name = 'human_tasks' AND tc.constraint_type = 'FOREIGN KEY'`;
      const tables = [...new Set(references.map((row) => row.referenced))];

      // It may point at a draft as *provenance* — which reply suggested the task — and at people and the
      // conversation. It may not point at a delivery job or a message, which are the things that go out.
      expect(tables).not.toContain("delivery_jobs");
      expect(tables).not.toContain("messages");
      expect(tables).not.toContain("queue_outbox");
    }, 180_000);

    it("writes nothing outbound when a task is completed", async () => {
      const created = await createTask(db(), profile.context, { kind: "CALL_CUSTOMER", title: "Ring them about Saturday", conversationId: profile.conversationId });
      const taskId = created.status === "CREATED" ? created.id : "";
      const before = {
        messages: await db().message.count({ where: scope() }),
        deliveries: await db().deliveryJobRecord.count({ where: scope() }),
        drafts: await db().aiDraft.count({ where: scope() }),
        outbox: await db().queueOutbox.count({ where: { workspaceId: profile.context.workspaceId } }),
      };

      expect(await completeTask(db(), profile.context, taskId, AT)).toEqual({ status: "DONE", id: taskId });

      // Counted on every table a send touches, because "it did not send" has to mean more than "no
      // message row appeared".
      expect(await db().message.count({ where: scope() })).toBe(before.messages);
      expect(await db().deliveryJobRecord.count({ where: scope() })).toBe(before.deliveries);
      expect(await db().aiDraft.count({ where: scope() })).toBe(before.drafts);
      expect(await db().queueOutbox.count({ where: { workspaceId: profile.context.workspaceId } })).toBe(before.outbox);
    }, 180_000);

    it("writes nothing outbound when a task is dismissed", async () => {
      const created = await createTask(db(), profile.context, { kind: "PREPARE_QUOTE", title: "Quote for the Mill Lane job" });
      const taskId = created.status === "CREATED" ? created.id : "";
      const before = await db().deliveryJobRecord.count({ where: scope() });

      expect(await dismissTask(db(), profile.context, taskId, "They booked elsewhere", AT)).toEqual({ status: "DISMISSED", id: taskId });

      expect(await db().deliveryJobRecord.count({ where: scope() })).toBe(before);
    }, 180_000);

    it("does not touch the conversation's takeover or mode either", async () => {
      const created = await createTask(db(), profile.context, { kind: "CHECK_AVAILABILITY", title: "Is Thursday free?", conversationId: profile.conversationId });
      const taskId = created.status === "CREATED" ? created.id : "";
      const before = await db().conversation.findFirst({
        where: { ...scope(), id: profile.conversationId },
        select: { takeoverState: true, modeOverride: true, stateVersion: true, aiEnabled: true },
      });

      await completeTask(db(), profile.context, taskId, AT);

      // A task is work for a person, not a conversation operation. Quietly taking the conversation over
      // on completion would be a side effect nobody asked for.
      expect(
        await db().conversation.findFirst({ where: { ...scope(), id: profile.conversationId }, select: { takeoverState: true, modeOverride: true, stateVersion: true, aiEnabled: true } }),
      ).toEqual(before);
    }, 180_000);
  });

  describe("raising and working through them", () => {
    it("records who raised a task and what it is", async () => {
      const created = await createTask(db(), profile.context, {
        kind: "VERIFY_DETAILS",
        title: "Confirm the delivery address",
        detail: "They gave two different postcodes.",
        dueAt: new Date(AT.getTime() + 86_400_000),
      });
      const taskId = created.status === "CREATED" ? created.id : "";

      const tasks = await listTasks(db(), profile.context, { status: "OPEN" });
      const task = tasks.find((row) => row.id === taskId);
      expect(task).toMatchObject({ kind: "VERIFY_DETAILS", title: "Confirm the delivery address", status: "OPEN" });
      expect(task?.detail).toBe("They gave two different postcodes.");
    }, 180_000);

    it("refuses a task with no title somebody could act on", async () => {
      expect(await createTask(db(), profile.context, { kind: "OTHER", title: "   " })).toEqual({
        status: "REFUSED",
        reason: "a task needs a title somebody can act on",
      });
      // And the database refuses it too, so the store is not the only thing holding it.
      await expect(
        db().humanTask.create({ data: { ...scope(), kind: "OTHER", title: "  " } }),
      ).rejects.toThrow(/human_tasks_title_check/u);
    }, 180_000);

    it("lets a model raise a task, which is safe because a task cannot send", async () => {
      const suggested = await suggestTask(db(), profile.context, {
        kind: "ESCALATE_INTERNALLY",
        title: "Customer mentioned a chargeback",
        sourceDraftId: draftId,
        conversationId: profile.conversationId,
      });
      const taskId = suggested.status === "CREATED" ? suggested.id : "";

      const task = (await listTasks(db(), profile.context, { status: "OPEN" })).find((row) => row.id === taskId);
      // The worst a model can do here is give somebody more to read — and the row names the reply that
      // prompted it, so an operator can see why before acting.
      expect(task?.sourceDraftId).toBe(draftId);
    }, 180_000);

    it("names who finished it and when", async () => {
      const created = await createTask(db(), profile.context, { kind: "CALL_CUSTOMER", title: "Ring about the invoice" });
      const taskId = created.status === "CREATED" ? created.id : "";

      await completeTask(db(), profile.context, taskId, AT);

      const task = (await listTasks(db(), profile.context, { status: "DONE" })).find((row) => row.id === taskId);
      expect(task?.completedByName).toBe("Test tasks-owner");
      expect(task?.completedAt).toEqual(AT);
    }, 180_000);

    it("cannot be finished twice", async () => {
      const created = await createTask(db(), profile.context, { kind: "OTHER", title: "Done once" });
      const taskId = created.status === "CREATED" ? created.id : "";
      await completeTask(db(), profile.context, taskId, AT);

      expect(await completeTask(db(), profile.context, taskId, AT)).toEqual({ status: "GONE" });
    }, 180_000);

    it("insists a dismissal says why", async () => {
      const created = await createTask(db(), profile.context, { kind: "OTHER", title: "Needs a reason" });
      const taskId = created.status === "CREATED" ? created.id : "";

      // A decision with no reason is one nobody can review.
      expect(await dismissTask(db(), profile.context, taskId, "  ", AT)).toEqual({ status: "REFUSED", reason: "say why this task is not needed" });
      expect((await listTasks(db(), profile.context, { status: "OPEN" })).some((row) => row.id === taskId)).toBe(true);
    }, 180_000);

    it("refuses a half-completed row in the database", async () => {
      const created = await createTask(db(), profile.context, { kind: "OTHER", title: "Half done" });
      const taskId = created.status === "CREATED" ? created.id : "";

      // A finished task with nobody's name on it, or a name with no moment, is a row nobody can read.
      await expect(db().humanTask.update({ where: { id: taskId }, data: { status: "DONE" } })).rejects.toThrow(/human_tasks_completion_check/u);
      await expect(
        db().humanTask.update({ where: { id: taskId }, data: { status: "DONE", completedAt: AT } }),
      ).rejects.toThrow(/human_tasks_completion_check/u);
    }, 180_000);

    it("hands a task to somebody, and takes it back", async () => {
      const created = await createTask(db(), profile.context, { kind: "OTHER", title: "Assign me" });
      const taskId = created.status === "CREATED" ? created.id : "";

      await assignTask(db(), profile.context, taskId, profile.context.userId);
      const assigned = (await listTasks(db(), profile.context, { assignedUserId: profile.context.userId })).find((row) => row.id === taskId);
      await assignTask(db(), profile.context, taskId, null);
      const unassigned = (await listTasks(db(), profile.context, { status: "OPEN" })).find((row) => row.id === taskId);

      expect(assigned?.assignedName).toBe("Test tasks-owner");
      expect(unassigned?.assignedUserId).toBeNull();
    }, 180_000);

    it("puts the soonest due first and the undated last", async () => {
      const fresh = await seedWorkspace(db(), "tasks-order");
      const [ordered] = fresh.profiles as [SeededProfile];
      await createTask(db(), ordered.context, { kind: "OTHER", title: "No deadline" });
      await createTask(db(), ordered.context, { kind: "OTHER", title: "Later", dueAt: new Date(AT.getTime() + 172_800_000) });
      await createTask(db(), ordered.context, { kind: "OTHER", title: "Sooner", dueAt: new Date(AT.getTime() + 3_600_000) });

      const titles = (await listTasks(db(), ordered.context, { status: "OPEN" })).map((row) => row.title);

      // A task with no deadline is not the most urgent one, which is what a naive ascending sort makes it.
      expect(titles).toEqual(["Sooner", "Later", "No deadline"]);
    }, 180_000);

    it("stays inside the Business Profile", async () => {
      const [theirProfile] = neighbour.profiles as [SeededProfile];
      const theirs = await createTask(db(), theirProfile.context, { kind: "OTHER", title: "Their task" });
      const theirId = theirs.status === "CREATED" ? theirs.id : "";

      expect((await listTasks(db(), profile.context, {})).map((row) => row.id)).not.toContain(theirId);
      expect(await completeTask(db(), profile.context, theirId, AT)).toEqual({ status: "GONE" });
      // Every write, not just the one. Task ids are unique, so a query scoped only by id would reach
      // across and change another business's queue.
      expect(await dismissTask(db(), profile.context, theirId, "not ours", AT)).toEqual({ status: "GONE" });
      expect(await assignTask(db(), profile.context, theirId, profile.context.userId)).toEqual({ status: "GONE" });
      // And it is still open where it belongs, so the refusal did not reach across and change it.
      expect((await listTasks(db(), theirProfile.context, { status: "OPEN" })).some((row) => row.id === theirId)).toBe(true);
    }, 180_000);
  });
});
