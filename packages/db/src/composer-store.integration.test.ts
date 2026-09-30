/**
 * A person's own reply, through the shared delivery path (ADR-018 Option B, Issue #29).
 *
 * Two families of case. First the **constraints**: a delivery has exactly one content origin, and the
 * database refuses every other arrangement — no origin, both origins, human wording with nobody's name
 * on it, an author on an AI draft, empty wording, and a human-composed send claiming automation's
 * authority. Those are asserted in raw SQL, because the invariant has to hold for a migration and a
 * console session and not only for this store.
 *
 * Then the **regressions** the decision asks for: composing with no draft in sight, a double submit, and
 * a second different message while one is still queued.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { composeHumanReply, pendingHumanReply } from "./composer-store";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { seedWorkspace, type SeededProfile, type SeededWorkspace } from "./testing/fixtures";

const AT = new Date("2026-09-30T12:00:00.000Z");

describe.skipIf(!databaseTestsEnabled())("a human-composed reply", () => {
  let database: TestDatabase;
  let workspace: SeededWorkspace;
  let profile: SeededProfile;
  let neighbour: SeededWorkspace;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    workspace = await seedWorkspace(database.db, "composer");
    [profile] = workspace.profiles as [SeededProfile];
    neighbour = await seedWorkspace(database.db, "composer-neighbour");
  }, 180_000);

  afterAll(async () => {
    await database?.dispose();
  });

  const db = () => database.db;
  const scope = () => ({ workspaceId: profile.context.workspaceId, businessProfileId: profile.businessProfileId });
  const clearPending = () =>
    db().deliveryJobRecord.updateMany({
      where: { ...scope(), humanText: { not: null }, status: { in: ["SCHEDULED", "SENDING"] } },
      data: { status: "CANCELLED_POLICY", cancelledAt: AT, cancelReason: "test cleanup" },
    });

  describe("the shape the database admits", () => {
    /**
     * A row that is otherwise valid, so each probe tests the constraint it names.
     *
     * `HUMAN_APPROVED` already required its whole approval — approver, timestamp, review mode and
     * decision key — before this task, and that CHECK fires first. A probe missing them would pass while
     * proving nothing about the origin constraints.
     */
    const APPROVAL = `'${"$"}{workspace.ownerUserId}', NOW(), 'NORMAL', 'probe-key'`;

    const insert = (columns: string, values: string) =>
      db().$executeRawUnsafe(
        // `updated_at` is maintained by the Prisma client, so it has no database default and a raw insert
        // has to supply it.
        `INSERT INTO "delivery_jobs" ("id", "workspace_id", "business_profile_id", "operation_id", "correlation_id", "status", "scheduled_for", "selected_delay_ms", "created_at", "updated_at", ${columns})
         VALUES (gen_random_uuid()::text, $1, $2, gen_random_uuid()::text, gen_random_uuid()::text, 'SCHEDULED', NOW(), 0, NOW(), NOW(), ${values})`,
        profile.context.workspaceId,
        profile.businessProfileId,
      );

    it("refuses a delivery with no content origin at all", async () => {
      // Nothing to send, and nothing on screen would explain why the customer never heard back.
      await expect(insert('"authority"', `'AUTOMATED'`)).rejects.toThrow(/delivery_jobs_one_origin_check/u);
    }, 180_000);

    it("refuses a delivery carrying both origins", async () => {
      const draft = await anyDraftId();
      // Two different messages wearing one operation id.
      await expect(
        insert(
          '"draft_id", "human_text", "composed_by_user_id", "conversation_id", "authority", "approved_by_user_id", "approved_at", "approved_review_mode", "decision_key"',
          `'${draft}', 'Mine too', '${workspace.ownerUserId}', '${profile.conversationId}', 'HUMAN_APPROVED', ${APPROVAL}`,
        ),
      ).rejects.toThrow(/delivery_jobs_one_origin_check/u);
    }, 180_000);

    it("refuses human wording with nobody's name on it", async () => {
      // Unattributed rather than automatic: somebody typed it, and the record has to say who.
      await expect(
        insert(
          '"human_text", "conversation_id", "authority", "approved_by_user_id", "approved_at", "approved_review_mode", "decision_key"',
          `'Anonymous', '${profile.conversationId}', 'HUMAN_APPROVED', ${APPROVAL}`,
        ),
      ).rejects.toThrow(/delivery_jobs_composer_check/u);
    }, 180_000);

    it("refuses an author on an AI draft", async () => {
      const draft = await anyDraftId();
      // That would claim a person wrote what a model produced.
      await expect(
        insert(
          '"draft_id", "composed_by_user_id", "authority", "approved_by_user_id", "approved_at", "approved_review_mode", "decision_key"',
          `'${draft}', '${workspace.ownerUserId}', 'HUMAN_APPROVED', ${APPROVAL}`,
        ),
      ).rejects.toThrow(/delivery_jobs_composer_check/u);
    }, 180_000);

    it("refuses empty wording, which would ask the transport to send nothing", async () => {
      await expect(
        insert(
          '"human_text", "composed_by_user_id", "conversation_id", "authority", "approved_by_user_id", "approved_at", "approved_review_mode", "decision_key"',
          `'   ', '${workspace.ownerUserId}', '${profile.conversationId}', 'HUMAN_APPROVED', ${APPROVAL}`,
        ),
      ).rejects.toThrow(/delivery_jobs_human_text_check/u);
    }, 180_000);

    it("refuses a human-composed send claiming automation's authority", async () => {
      // Automation did not write these words, and the human-support transport path depends on the
      // difference (ADR-014).
      await expect(
        insert('"human_text", "composed_by_user_id", "conversation_id", "authority"', `'Mine', '${workspace.ownerUserId}', '${profile.conversationId}', 'AUTOMATED'`),
      ).rejects.toThrow(/delivery_jobs_human_authority_check/u);
    }, 180_000);

    it("refuses human wording with no conversation to send it to", async () => {
      await expect(
        insert(
          '"human_text", "composed_by_user_id", "authority", "approved_by_user_id", "approved_at", "approved_review_mode", "decision_key"',
          `'Nowhere', '${workspace.ownerUserId}', 'HUMAN_APPROVED', ${APPROVAL}`,
        ),
      ).rejects.toThrow(/delivery_jobs_conversation_origin_check/u);
    }, 180_000);

    it("still accepts an ordinary AI delivery, so the checks above are not refusing everything", async () => {
      const draft = await anyDraftId();

      await expect(insert('"draft_id", "authority"', `'${draft}', 'AUTOMATED'`)).resolves.toBeGreaterThan(0);
    }, 180_000);

    const anyDraftId = async () => {
      const existing = await db().aiDraft.findFirst({ where: scope(), select: { id: true } });
      if (existing !== null) {
        return existing.id;
      }
      const created = await db().aiDraft.create({
        data: {
          ...scope(),
          conversationId: profile.conversationId,
          anchorMessageId: profile.messageId,
          anchorStateVersion: 1,
          generationKey: `composer_${String(Date.now())}`,
          text: "Model wording.",
          structuredOutput: { reply: "Model wording." },
          confidence: 0.9,
          modelSuggestsSend: true,
          needsReview: false,
          modelProvider: "anthropic",
          modelName: "claude-opus-5",
          promptVersion: "reply.v1",
          schemaVersion: "ai-draft.v1",
        },
        select: { id: true },
      });
      return created.id;
    };
  });

  describe("composing", () => {
    it("queues a reply with no draft anywhere in sight, and takes the conversation", async () => {
      await clearPending();

      const outcome = await composeHumanReply(db(), profile.context, {
        conversationId: profile.conversationId,
        text: "  We are open until six today.  ",
        reviewMode: "NORMAL",
        at: AT,
      });

      expect(outcome.status).toBe("SCHEDULED");
      const job = await db().deliveryJobRecord.findFirstOrThrow({
        where: { ...scope(), humanText: { not: null }, status: "SCHEDULED" },
        select: { humanText: true, draftId: true, composedByUserId: true, authority: true, approvedReviewMode: true, selectedDelayMs: true, conversationId: true },
      });
      expect(job.humanText).toBe("We are open until six today.");
      // No draft, no invented model metadata: `ai_drafts` stays what a model produced.
      expect(job.draftId).toBeNull();
      expect(job.composedByUserId).toBe(profile.context.userId);
      expect(job.authority).toBe("HUMAN_APPROVED");
      // A person has already decided, so there is no human-like delay left to simulate.
      expect(job.selectedDelayMs).toBe(0);
      expect(job.conversationId).toBe(profile.conversationId);

      const conversation = await db().conversation.findUniqueOrThrow({
        where: { workspaceId_businessProfileId_id: { ...scope(), id: profile.conversationId } },
        select: { takeoverState: true, takeoverActorUserId: true },
      });
      expect(conversation.takeoverState).toBe("HUMAN_ACTIVE");
      expect(conversation.takeoverActorUserId).toBe(profile.context.userId);
    }, 180_000);

    it("creates no AI draft, so reliability and eval counts are untouched", async () => {
      await clearPending();
      const before = await db().aiDraft.count({ where: scope() });

      await composeHumanReply(db(), profile.context, { conversationId: profile.conversationId, text: "No draft for this.", reviewMode: "NORMAL", at: AT });

      // The whole point of Option B: a person's words never become a generation.
      expect(await db().aiDraft.count({ where: scope() })).toBe(before);
    }, 180_000);

    it("answers a double submit with the send it already made", async () => {
      await clearPending();
      const input = { conversationId: profile.conversationId, text: "Same words twice.", reviewMode: "NORMAL" as const, at: AT };

      const first = await composeHumanReply(db(), profile.context, input);
      const second = await composeHumanReply(db(), profile.context, input);

      expect(first).toMatchObject({ status: "SCHEDULED", replayed: false });
      // One decision reported twice — a double click, or a retry after a lost response.
      expect(second).toMatchObject({ status: "SCHEDULED", replayed: true });
      expect(second.status === "SCHEDULED" ? second.operationId : "").toBe(first.status === "SCHEDULED" ? first.operationId : "x");
      expect(await db().deliveryJobRecord.count({ where: { ...scope(), humanText: "Same words twice." } })).toBe(1);
    }, 180_000);

    it("refuses a different message while one is still queued, and says which is in the way", async () => {
      await clearPending();
      const first = await composeHumanReply(db(), profile.context, { conversationId: profile.conversationId, text: "First message.", reviewMode: "NORMAL", at: AT });

      const second = await composeHumanReply(db(), profile.context, { conversationId: profile.conversationId, text: "Second, different.", reviewMode: "NORMAL", at: AT });

      // Two messages, not idempotency. Refused, with the operation a person can cancel.
      expect(second).toEqual({ status: "ALREADY_PENDING", operationId: first.status === "SCHEDULED" ? first.operationId : "" });
      expect(await db().deliveryJobRecord.count({ where: { ...scope(), humanText: "Second, different." } })).toBe(0);
    }, 180_000);

    it("lets a person compose again once the queued reply is cancelled", async () => {
      await clearPending();
      await composeHumanReply(db(), profile.context, { conversationId: profile.conversationId, text: "To be cancelled.", reviewMode: "NORMAL", at: AT });
      await clearPending();

      const outcome = await composeHumanReply(db(), profile.context, { conversationId: profile.conversationId, text: "After cancelling.", reviewMode: "NORMAL", at: AT });

      expect(outcome.status).toBe("SCHEDULED");
    }, 180_000);

    it("treats a different review mode as a different decision", async () => {
      await clearPending();
      await composeHumanReply(db(), profile.context, { conversationId: profile.conversationId, text: "Same words.", reviewMode: "NORMAL", at: AT });

      const other = await composeHumanReply(db(), profile.context, { conversationId: profile.conversationId, text: "Same words.", reviewMode: "HUMAN_AGENT", at: AT });

      // The same wording on the provider's human-support path authorizes a different send (ADR-014), so
      // it is not a replay of the ordinary one.
      expect(other.status).toBe("ALREADY_PENDING");
    }, 180_000);

    it("refuses an empty reply", async () => {
      await clearPending();

      expect(await composeHumanReply(db(), profile.context, { conversationId: profile.conversationId, text: "   ", reviewMode: "NORMAL", at: AT })).toEqual({
        status: "REFUSED",
        reason: "a reply cannot be empty",
      });
    }, 180_000);

    it("refuses a conversation that is not open", async () => {
      await clearPending();
      await db().conversation.update({ where: { workspaceId_businessProfileId_id: { ...scope(), id: profile.conversationId } }, data: { status: "CLOSED" } });

      const outcome = await composeHumanReply(db(), profile.context, { conversationId: profile.conversationId, text: "Into a closed thread.", reviewMode: "NORMAL", at: AT });

      expect(outcome).toEqual({ status: "REFUSED", reason: "this conversation is not open" });
      await db().conversation.update({ where: { workspaceId_businessProfileId_id: { ...scope(), id: profile.conversationId } }, data: { status: "OPEN" } });
    }, 180_000);

    it("cannot compose into another Workspace's conversation", async () => {
      const [theirProfile] = neighbour.profiles as [SeededProfile];

      const outcome = await composeHumanReply(db(), profile.context, { conversationId: theirProfile.conversationId, text: "Not mine.", reviewMode: "NORMAL", at: AT });

      expect(outcome).toEqual({ status: "GONE" });
      expect(await db().deliveryJobRecord.count({ where: { humanText: "Not mine." } })).toBe(0);
    }, 180_000);

    it("reports the queued reply so a person can see and stop it", async () => {
      await clearPending();
      await composeHumanReply(db(), profile.context, { conversationId: profile.conversationId, text: "Visible and stoppable.", reviewMode: "NORMAL", at: AT });

      expect(await pendingHumanReply(db(), profile.context, profile.conversationId)).toMatchObject({ text: "Visible and stoppable." });
    }, 180_000);

    it("reports nothing pending once it is gone", async () => {
      await clearPending();

      expect(await pendingHumanReply(db(), profile.context, profile.conversationId)).toBeUndefined();
    }, 180_000);
  });
});
