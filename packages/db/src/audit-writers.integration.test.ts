/**
 * That the audit log is actually written (Issue #34).
 *
 * `audit-store.integration.test.ts` proves the log behaves. This proves it is *fed*, which is a separate
 * claim and the one that decides whether the feature exists: a searchable audit nothing writes to is a
 * table, not a record.
 *
 * Every case also asserts the event is committed with the change it describes. A write that happened
 * outside the transaction would still pass a "was it recorded" check while leaving the two able to
 * disagree after a crash — which is the one question this table exists to answer.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { searchAuditEvents } from "./audit-store";
import { createConversationOperationStore } from "./conversation-operations-store";
import { createKnowledge, editKnowledge } from "./knowledge-store";
import { MANDATORY_REVIEW_REASON_CODES } from "@omnichannel/domain";

import { savePolicy } from "./policy-store";
import { addWorkspaceMember } from "./repositories/workspaces";
import { saveStyleProfile } from "./style-store";
import { authorizeWorkspaceAccess } from "./tenancy";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { seedWorkspace, type SeededProfile, type SeededWorkspace } from "./testing/fixtures";

const AT = new Date("2026-10-01T12:00:00.000Z");

describe.skipIf(!databaseTestsEnabled())("the audit log is written by", () => {
  let database: TestDatabase;
  let workspace: SeededWorkspace;
  let profile: SeededProfile;
  let ownerContext: Awaited<ReturnType<typeof authorizeWorkspaceAccess>>;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    workspace = await seedWorkspace(database.db, "audit-writers");
    [profile] = workspace.profiles as [SeededProfile];
    ownerContext = await authorizeWorkspaceAccess(database.db, { userId: workspace.ownerUserId, workspaceId: workspace.workspaceId });
    // The profile default, which onboarding creates in the real flow. `savePolicy` edits; it does not
    // invent a policy, and that is the right shape — a settings save should not be able to conjure the
    // settings it is saving.
    await database.db.automationPolicy.create({
      data: { workspaceId: profile.context.workspaceId, businessProfileId: profile.businessProfileId, mandatoryReviewReasons: [...MANDATORY_REVIEW_REASON_CODES] },
    });
  }, 180_000);

  afterAll(async () => {
    await database?.dispose();
  });

  const db = () => database.db;
  const events = async (kind: string) => (await searchAuditEvents(db(), ownerContext, { kinds: [kind as never], limit: 200 })).rows;

  it("taking a conversation over, and handing it back", async () => {
    const store = createConversationOperationStore(db(), profile.context);

    await store.takeOver({ conversationId: profile.conversationId, at: AT });
    const started = await events("TAKEOVER_STARTED");
    await store.handBack({ conversationId: profile.conversationId, at: AT });
    const ended = await events("TAKEOVER_ENDED");

    expect(started.map((row) => row.subjectId)).toContain(profile.conversationId);
    expect(started[0]?.actorName).toBe("Test audit-writers-owner");
    expect(ended.map((row) => row.subjectId)).toContain(profile.conversationId);
    // Both carry the conversation, so the log can be read from the thread it happened in.
    expect(ended[0]?.conversationId).toBe(profile.conversationId);
  }, 180_000);

  it("a timed hand-back, which says until when", async () => {
    const store = createConversationOperationStore(db(), profile.context);
    const until = new Date(AT.getTime() + 3_600_000);

    await store.takeOver({ conversationId: profile.conversationId, at: AT });
    await store.handBack({ conversationId: profile.conversationId, at: AT, pauseUntil: until });

    const paused = (await events("TAKEOVER_ENDED")).find((row) => row.summary.includes("Paused"));
    expect(paused?.detail).toMatchObject({ pausedUntil: until.toISOString() });
  }, 180_000);

  it("a settings change, pointing at the typed before/after rather than copying it", async () => {
    const outcome = await savePolicy(db(), profile.context, null, { businessGoal: "Book more consultations" });

    expect(outcome.status).toBe("SAVED");
    const changed = await events("POLICY_CHANGED");
    const row = changed[0];
    expect(row?.subjectType).toBe("policy_change_audits");
    // One truth, one pointer. The row it names holds the before and after.
    expect(await db().policyChangeAudit.count({ where: { id: row?.subjectId } })).toBe(1);
  }, 180_000);

  it("turning the mode up, as its own event as well as the settings one", async () => {
    await savePolicy(db(), profile.context, null, { mode: "DRAFT" });

    const modes = await events("MODE_CHANGED");
    expect(modes[0]?.summary).toBe("Changed the mode from OFF to DRAFT");
    expect(modes[0]?.detail).toMatchObject({ from: "OFF", to: "DRAFT" });
    // Somebody searching "when did this profile start replying unattended" should not have to know it
    // was buried in a settings save, so the policy event is recorded too.
    expect((await events("POLICY_CHANGED")).length).toBeGreaterThan(1);
  }, 180_000);

  it("nothing, when a settings save changed no mode", async () => {
    const before = (await events("MODE_CHANGED")).length;

    await savePolicy(db(), profile.context, null, { businessGoal: "Something else entirely" });

    // A mode event for a save that did not touch the mode would make the log useless for the one
    // question it answers best.
    expect((await events("MODE_CHANGED")).length).toBe(before);
  }, 180_000);

  it("widening what goes out unattended, as its own kind", async () => {
    await savePolicy(db(), profile.context, null, { whatsappTemplateAutomationAllowlist: ["appointment_reminder"] });

    const template = await events("TEMPLATE_POLICY_CHANGED");
    expect(template).toHaveLength(1);
    expect(template[0]?.detail).toMatchObject({ scope: "PROFILE_DEFAULT" });
  }, 180_000);

  it("a new version of a knowledge source", async () => {
    const created = await createKnowledge(db(), profile.context, { title: "Opening hours", chunks: ["We open at nine."] });
    const documentId = created.status === "CREATED" ? created.documentId : "";

    await editKnowledge(db(), profile.context, documentId, { chunks: ["We open at ten."] });

    const versioned = await events("KNOWLEDGE_VERSIONED");
    expect(versioned.map((row) => row.subjectId)).toContain(documentId);
    expect(versioned[0]?.summary).toBe("Saved version 2 of Opening hours");
    expect(versioned[0]?.detail).toMatchObject({ version: 2 });
  }, 180_000);

  it("a change to the voice, saying which layer", async () => {
    const draft = {
      persona: "Warm and brief",
      tone: null,
      replyLength: null,
      emoji: null,
      greeting: null,
      signOff: null,
      preferredPhrases: [],
      avoidedPhrases: [],
      language: null,
    };

    await saveStyleProfile(db(), profile.context, "WORKSPACE", draft);
    await saveStyleProfile(db(), profile.context, "BUSINESS_PROFILE", draft);

    const styled = await events("STYLE_VERSIONED");
    expect(styled.map((row) => row.detail)).toEqual(
      expect.arrayContaining([expect.objectContaining({ layer: "WORKSPACE" }), expect.objectContaining({ layer: "BUSINESS_PROFILE" })]),
    );
  }, 180_000);

  it("granting somebody access, at the workspace and admin-only", async () => {
    const newcomer = await db().user.create({ data: { name: "Audit Newcomer", email: "audit-newcomer@example.test" } });

    await addWorkspaceMember(db(), ownerContext, { userId: newcomer.id, role: "AGENT", businessProfileScope: "ALL" });

    const members = await events("MEMBER_CHANGED");
    expect(members[0]?.summary).toBe("Added a member as AGENT");
    // No profile: who may act is not any one profile's business.
    expect(members[0]?.businessProfileId).toBeNull();
    expect(members[0]?.sensitive).toBe(true);
    expect(members[0]?.detail).toMatchObject({ role: "AGENT", scope: "ALL" });
  }, 180_000);

  describe("and rolled back with the change it describes", () => {
    it("records nothing when the change it accompanies fails", async () => {
      const before = (await events("KNOWLEDGE_VERSIONED")).length;

      // A title that will be refused: the store rejects before it writes, and no audit row may survive
      // a change that never happened.
      const refused = await editKnowledge(db(), profile.context, "a-document-that-does-not-exist", { chunks: ["x"] });

      expect(refused.status).toBe("GONE");
      expect((await events("KNOWLEDGE_VERSIONED")).length).toBe(before);
    }, 180_000);

    it("records nothing when the transaction it is in throws afterwards", async () => {
      const before = (await events("MODE_CHANGED")).length;

      // The audit write and the change are in one transaction, so a failure after the audit row is
      // written takes it with it. Without that, a crash would leave a mode change nobody appears to have
      // made — or a record of one that never happened, which is worse.
      await expect(
        db().$transaction(async (tx) => {
          await savePolicy(tx as never, profile.context, null, { mode: "AUTOPILOT" });
          throw new Error("something failed after the audit row was written");
        }),
      ).rejects.toThrow(/something failed/u);

      expect((await events("MODE_CHANGED")).length).toBe(before);
      // And the change itself did not land either, which is the same guarantee read from the other side.
      expect((await db().automationPolicy.findFirst({ where: { workspaceId: profile.context.workspaceId, businessProfileId: profile.businessProfileId, channelAccountId: null }, select: { mode: true } }))?.mode).not.toBe("AUTOPILOT");
    }, 180_000);
  });
});
