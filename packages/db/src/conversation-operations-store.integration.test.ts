/**
 * Stopping a send, and taking a conversation, against a real server (Issue #29).
 *
 * The one that has to be right is cancellation. A worker claims a delivery by moving it out of
 * `SCHEDULED`, so "cancel" and "claim" race, and the two ways of losing that race need different words on
 * screen: a send that was already cancelled is nothing to worry about, and a send the worker already has
 * may be at the provider right now. Telling someone their reply was stopped when it was not is the worst
 * outcome this whole feature can produce, so it is tested against PostgreSQL rather than a stub.
 */
import { operateConversation, type ConversationOperationDependencies } from "@omnichannel/application";
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { composeHumanReply } from "./composer-store";
import { createConversationOperationStore } from "./conversation-operations-store";
import { createAiDraftStore } from "./ai-draft-store";
import { noRetrieval } from "@omnichannel/application";
import { createDbClient, type DbClient } from "./client";
import { authorizeBusinessProfileAccess, type BusinessProfileContext } from "./tenancy";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { seedWorkspace, type SeededProfile, type SeededWorkspace } from "./testing/fixtures";

const NOW = new Date("2026-09-30T12:00:00.000Z");

describe.skipIf(!databaseTestsEnabled())("conversation operations (PostgreSQL)", () => {
  let database: TestDatabase;
  let workspace: SeededWorkspace;
  let profile: SeededProfile;
  let neighbour: SeededWorkspace;
  let rival: DbClient;
  let seq = 0;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    workspace = await seedWorkspace(database.db, "ops");
    [profile] = workspace.profiles as [SeededProfile];
    neighbour = await seedWorkspace(database.db, "ops-neighbour");
    rival = createDbClient({ connectionString: database.url });
  }, 120_000);

  afterAll(async () => {
    await rival?.$disconnect();
    await database?.dispose();
  });

  const scope = () => ({ workspaceId: profile.context.workspaceId, businessProfileId: profile.businessProfileId });

  const dependencies = (client: DbClient = database.db, as: BusinessProfileContext = profile.context): ConversationOperationDependencies => ({
    conversations: createConversationOperationStore(client, as),
    log: { info: () => undefined, warn: () => undefined },
    now: () => NOW,
  });

  /** A draft with a delivery queued behind its delay: the state a person would cancel. */
  const scheduledSend = async (target: SeededProfile = profile): Promise<string> => {
    seq += 1;
    const targetScope = { workspaceId: target.context.workspaceId, businessProfileId: target.businessProfileId };
    const { aiDraftId } = await createAiDraftStore(database.db).saveDraft({
      scope: { ...targetScope, conversationId: target.conversationId },
      generationKey: `ops_${String(seq)}`,
      trigger: "AUTOMATIC",
      anchorMessageId: target.messageId,
      anchorStateVersion: 1,
      text: "We open at 10 on Saturday.",
      structuredOutput: { reply: "We open at 10 on Saturday." },
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
    });
    const operationId = randomUUID();
    await database.db.deliveryJobRecord.create({
      data: {
        ...targetScope,
        draftId: aiDraftId,
        operationId,
        correlationId: operationId,
        status: "SCHEDULED",
        scheduledFor: new Date(NOW.getTime() + 60_000),
        selectedDelayMs: 60_000,
      },
    });
    await database.db.aiDraft.update({ where: { workspaceId_businessProfileId_id: { ...targetScope, id: aiDraftId } }, data: { status: "SCHEDULED" } });
    return operationId;
  };

  const readJob = (operationId: string) =>
    database.db.deliveryJobRecord.findFirstOrThrow({ where: { operationId }, select: { status: true, cancelReason: true, cancelledAt: true } });

  const readConversation = () =>
    database.db.conversation.findUniqueOrThrow({
      where: { workspaceId_businessProfileId_id: { ...scope(), id: profile.conversationId } },
      select: { takeoverState: true, takeoverActorUserId: true, takeoverPausedUntil: true, takeoverReason: true },
    });

  describe("cancelling a queued send", () => {
    it("stops it, ends the draft and takes the conversation", async () => {
      const operationId = await scheduledSend();

      const outcome = await operateConversation(dependencies(), {
        scope: { ...scope(), conversationId: profile.conversationId },
        operation: { kind: "CANCEL_SEND", operationId },
      });

      expect(outcome).toEqual({ status: "SEND_CANCELLED" });
      const job = await readJob(operationId);
      expect(job.status).toBe("CANCELLED_HUMAN_TAKEOVER");
      expect(job.cancelReason).toBe("HUMAN_CANCELLED_FROM_INBOX");
      // The draft is ended too, or a cancelled reply comes back as a review item for someone else to send.
      const draft = await database.db.aiDraft.findFirstOrThrow({ where: { deliveryJob: { operationId } }, select: { status: true } });
      expect(draft.status).toBe("DISMISSED");
      // Stopping automation's reply is taking the conversation; leaving automation running would let the
      // next draft go out seconds after the person refused this one.
      const conversation = await readConversation();
      expect(conversation.takeoverState).toBe("HUMAN_ACTIVE");
      expect(conversation.takeoverActorUserId).toBe(profile.context.userId);
    }, 120_000);

    it("says so plainly when the same person cancels twice", async () => {
      const operationId = await scheduledSend();
      const command = { scope: { ...scope(), conversationId: profile.conversationId }, operation: { kind: "CANCEL_SEND" as const, operationId } };

      expect(await operateConversation(dependencies(), command)).toEqual({ status: "SEND_CANCELLED" });
      // A double click is not an error, and it must not report a second cancellation that never happened.
      expect(await operateConversation(dependencies(), command)).toEqual({ status: "ALREADY_CANCELLED" });
      expect((await readJob(operationId)).cancelReason).toBe("HUMAN_CANCELLED_FROM_INBOX");
    }, 120_000);

    it("refuses a send the worker has already claimed, and says which state it is in", async () => {
      const operationId = await scheduledSend();
      // Exactly what the worker's claim does: move it out of SCHEDULED.
      await database.db.deliveryJobRecord.update({ where: { operationId }, data: { status: "SENDING", claimedAt: NOW } });

      const outcome = await operateConversation(dependencies(), {
        scope: { ...scope(), conversationId: profile.conversationId },
        operation: { kind: "CANCEL_SEND", operationId },
      });

      // ADR-012 forbids guessing about a send whose outcome is unknown. Reporting it cancelled would be a
      // claim about what the customer received.
      expect(outcome).toEqual({ status: "TOO_LATE", currentStatus: "SENDING" });
      expect((await readJob(operationId)).status).toBe("SENDING");
    }, 120_000);

    it("reports the state it found, not the one it read a moment earlier", async () => {
      const operationId = await scheduledSend();

      // The race itself: the worker claims between this store's read and its conditional update. The
      // answer has to describe the row as it is now, or someone is told their send is still queued at the
      // exact moment a worker took it.
      await Promise.all([
        // A SENT row must carry both the timestamp and the platform id — the schema's own CHECK says so,
        // because a send recorded without its identifier cannot be reconciled afterwards.
        database.db.deliveryJobRecord.update({ where: { operationId }, data: { status: "SENT", sentAt: NOW, platformMessageId: `mid-${operationId}` } }),
        operateConversation(dependencies(rival), {
          scope: { ...scope(), conversationId: profile.conversationId },
          operation: { kind: "CANCEL_SEND", operationId },
        }),
      ]);

      const outcome = await operateConversation(dependencies(), {
        scope: { ...scope(), conversationId: profile.conversationId },
        operation: { kind: "CANCEL_SEND", operationId },
      });
      expect(outcome).toEqual({ status: "TOO_LATE", currentStatus: "SENT" });
    }, 120_000);

    it("cannot be pointed at another Workspace's send by naming this conversation", async () => {
      const [theirProfile] = neighbour.profiles as [SeededProfile];
      const operationId = await scheduledSend(theirProfile);

      const outcome = await operateConversation(dependencies(), {
        scope: { ...scope(), conversationId: profile.conversationId },
        operation: { kind: "CANCEL_SEND", operationId },
      });

      expect(outcome).toEqual({ status: "GONE" });
      expect((await readJob(operationId)).status).toBe("SCHEDULED");
    }, 120_000);

    it("refuses an operation id that belongs to a different conversation in the same profile", async () => {
      const operationId = await scheduledSend();
      // A second conversation needs its own channel identity: one identity holds one conversation.
      const contact = await database.db.contact.create({ data: { ...scope(), displayName: "Second Customer" }, select: { id: true } });
      const identity = await database.db.channelIdentity.create({
        data: {
          ...scope(),
          channelAccountId: profile.channelAccount.id,
          contactId: contact.id,
          externalUserId: `ig-user-second-${String(seq)}`,
        },
        select: { id: true },
      });
      const other = await database.db.conversation.create({
        data: { ...scope(), channelAccountId: profile.channelAccount.id, channelIdentityId: identity.id, contactId: contact.id },
        select: { id: true },
      });

      const outcome = await operateConversation(dependencies(), {
        scope: { ...scope(), conversationId: other.id },
        operation: { kind: "CANCEL_SEND", operationId },
      });

      // The delivery derives its recipient from its own draft, so cancelling "here" while the send is
      // "there" would be one action described two ways.
      expect(outcome).toEqual({ status: "GONE" });
      expect((await readJob(operationId)).status).toBe("SCHEDULED");
    }, 120_000);
  });

  describe("cancelling a reply a person wrote themselves (ADR-018 Option B)", () => {
    /**
     * The blocking finding on PR #76: this lookup and the Inbox's pending-send query both reached the
     * conversation through `draft.conversationId`, and a human-composed delivery has no draft. So
     * `cancelSend` answered `GONE` while the row sat `SCHEDULED` and went out — the operator was told
     * their reply was not queued, and then it was. These cases drive the real composer write path rather
     * than a hand-built row, because the CHECKs on `delivery_jobs` are part of what makes an origin legal.
     *
     * Each case composes into a conversation of its own. Composing takes the conversation and allows one
     * queued reply at a time, so sharing one would make these cases depend on each other's order — and
     * on the fixture other describes assert against.
     */
    const freshConversation = async (target: SeededProfile): Promise<string> => {
      seq += 1;
      const targetScope = { workspaceId: target.context.workspaceId, businessProfileId: target.businessProfileId };
      const contact = await database.db.contact.create({ data: { ...targetScope, displayName: `Composer Customer ${String(seq)}` }, select: { id: true } });
      const identity = await database.db.channelIdentity.create({
        data: { ...targetScope, channelAccountId: target.channelAccount.id, contactId: contact.id, externalUserId: `ig-user-composed-${String(seq)}` },
        select: { id: true },
      });
      const conversation = await database.db.conversation.create({
        data: { ...targetScope, channelAccountId: target.channelAccount.id, channelIdentityId: identity.id, contactId: contact.id },
        select: { id: true },
      });
      return conversation.id;
    };

    const composed = async (target: SeededProfile = profile): Promise<{ readonly operationId: string; readonly conversationId: string }> => {
      const conversationId = await freshConversation(target);
      const outcome = await composeHumanReply(database.db, target.context, {
        conversationId,
        text: `Yes, we are open until six. (${String(seq)})`,
        reviewMode: "NORMAL",
        at: NOW,
      });
      if (outcome.status !== "SCHEDULED") {
        throw new Error(`the fixture expected a queued reply, got ${outcome.status}`);
      }
      return { operationId: outcome.operationId, conversationId };
    };

    const cancel = (operationId: string, conversationId: string, as: BusinessProfileContext = profile.context) =>
      operateConversation(dependencies(database.db, as), {
        scope: { workspaceId: as.workspaceId, businessProfileId: as.businessProfileId, conversationId },
        operation: { kind: "CANCEL_SEND", operationId },
      });

    it("stops it, and the row really leaves SCHEDULED", async () => {
      const { operationId, conversationId } = await composed();

      expect(await cancel(operationId, conversationId)).toMatchObject({ status: "SEND_CANCELLED" });
      expect(await readJob(operationId)).toMatchObject({ status: "CANCELLED_HUMAN_TAKEOVER", cancelReason: "HUMAN_CANCELLED_FROM_INBOX" });
    }, 120_000);

    it("has no draft to end, and does not mind", async () => {
      // `ai_drafts` stays model-only, which is the point of Option B: cancelling a person's reply must
      // neither invent a draft to dismiss nor fail for the lack of one.
      const { operationId, conversationId } = await composed();

      await cancel(operationId, conversationId);

      const job = await database.db.deliveryJobRecord.findFirstOrThrow({
        where: { operationId },
        select: { draftId: true, humanText: true, conversationId: true },
      });
      expect(job.draftId).toBeNull();
      expect(job.humanText).not.toBeNull();
      expect(job.conversationId).toBe(conversationId);
    }, 120_000);

    it("refuses one named from a different conversation in the same profile", async () => {
      // The relation used to carry this isolation for free. Matching the direct column as well means the
      // conversation in the request still has to be the conversation on the row.
      const { operationId } = await composed();
      const elsewhere = await freshConversation(profile);

      expect(await cancel(operationId, elsewhere)).toEqual({ status: "GONE" });
      expect((await readJob(operationId)).status).toBe("SCHEDULED");
    }, 120_000);

    it("cannot be pointed at another Workspace's reply by naming a conversation here", async () => {
      const [theirProfile] = neighbour.profiles as [SeededProfile];
      const { operationId } = await composed(theirProfile);
      const ours = await freshConversation(profile);

      expect(await cancel(operationId, ours)).toEqual({ status: "GONE" });
      expect((await readJob(operationId)).status).toBe("SCHEDULED");
    }, 120_000);

    it("loses the race with a worker safely, exactly as the draft-origin path does", async () => {
      // The claim is what moves the row out of SCHEDULED. Reporting "cancelled" here would tell someone
      // their reply was stopped at the moment it reached the provider.
      const { operationId, conversationId } = await composed();
      await database.db.deliveryJobRecord.updateMany({ where: { operationId }, data: { status: "SENDING", claimedAt: NOW } });

      expect(await cancel(operationId, conversationId)).toEqual({ status: "TOO_LATE", currentStatus: "SENDING" });
      expect((await readJob(operationId)).status).toBe("SENDING");
    }, 120_000);
  });

  describe("taking over and handing back", () => {
    it("takes the conversation for the person who asked", async () => {
      const outcome = await operateConversation(dependencies(), {
        scope: { ...scope(), conversationId: profile.conversationId },
        operation: { kind: "TAKE_OVER" },
      });

      expect(outcome).toEqual({ status: "TAKEN_OVER" });
      const conversation = await readConversation();
      expect(conversation.takeoverState).toBe("HUMAN_ACTIVE");
      expect(conversation.takeoverActorUserId).toBe(profile.context.userId);
    }, 120_000);

    it("is the same conversation when taken twice", async () => {
      const command = { scope: { ...scope(), conversationId: profile.conversationId }, operation: { kind: "TAKE_OVER" as const } };
      await operateConversation(dependencies(), command);

      expect(await operateConversation(dependencies(), command)).toEqual({ status: "TAKEN_OVER" });
      expect((await readConversation()).takeoverActorUserId).toBe(profile.context.userId);
    }, 120_000);

    it("hands it back to automation, holding nothing", async () => {
      await operateConversation(dependencies(), { scope: { ...scope(), conversationId: profile.conversationId }, operation: { kind: "TAKE_OVER" } });

      const outcome = await operateConversation(dependencies(), {
        scope: { ...scope(), conversationId: profile.conversationId },
        operation: { kind: "HAND_BACK" },
      });

      expect(outcome).toEqual({ status: "HANDED_BACK" });
      const conversation = await readConversation();
      expect(conversation.takeoverState).toBe("NONE");
      expect(conversation.takeoverActorUserId).toBeNull();
      expect(conversation.takeoverPausedUntil).toBeNull();
    }, 120_000);

    it("keeps holding the conversation while a timed pause runs", async () => {
      const pauseUntil = new Date(NOW.getTime() + 3_600_000);

      await operateConversation(dependencies(), {
        scope: { ...scope(), conversationId: profile.conversationId },
        operation: { kind: "HAND_BACK", pauseUntil },
      });

      const conversation = await readConversation();
      // Still held: dropping the takeover now and trusting the deadline would let the next draft go out
      // immediately, which is the opposite of a pause.
      expect(conversation.takeoverState).toBe("HUMAN_ACTIVE");
      expect(conversation.takeoverPausedUntil?.toISOString()).toBe(pauseUntil.toISOString());
    }, 120_000);

    it("refuses a pause that has already ended", async () => {
      const outcome = await operateConversation(dependencies(), {
        scope: { ...scope(), conversationId: profile.conversationId },
        operation: { kind: "HAND_BACK", pauseUntil: new Date(NOW.getTime() - 1) },
      });

      // Writing it would record a deadline the next read treats as "resume now" — a different operation
      // than the one asked for.
      expect(outcome).toEqual({ status: "REJECTED", reason: "a pause must end in the future" });
    }, 120_000);

    it("clears an earlier pause when a person acts again", async () => {
      await operateConversation(dependencies(), {
        scope: { ...scope(), conversationId: profile.conversationId },
        operation: { kind: "HAND_BACK", pauseUntil: new Date(NOW.getTime() + 3_600_000) },
      });

      await operateConversation(dependencies(), { scope: { ...scope(), conversationId: profile.conversationId }, operation: { kind: "TAKE_OVER" } });

      // They are here now; inheriting the old deadline would resume automation while they are typing.
      expect((await readConversation()).takeoverPausedUntil).toBeNull();
    }, 120_000);

    it("cannot touch a conversation in another Workspace", async () => {
      const [theirProfile] = neighbour.profiles as [SeededProfile];

      const outcome = await operateConversation(dependencies(), {
        scope: { ...scope(), conversationId: theirProfile.conversationId },
        operation: { kind: "TAKE_OVER" },
      });

      expect(outcome).toEqual({ status: "GONE" });
      const theirs = await database.db.conversation.findUniqueOrThrow({
        where: {
          workspaceId_businessProfileId_id: {
            workspaceId: theirProfile.context.workspaceId,
            businessProfileId: theirProfile.businessProfileId,
            id: theirProfile.conversationId,
          },
        },
        select: { takeoverState: true },
      });
      expect(theirs.takeoverState).toBe("NONE");
    }, 120_000);
  });

  it("is scoped to the member who is signed in, not to one a caller names", async () => {
    // The store stamps its own authorized identity, and there is nowhere in the command to put another.
    const colleague = await database.db.user.create({ data: { name: "Ops Colleague", email: `ops-colleague-${randomUUID()}@example.test` } });
    await database.db.workspaceMember.create({
      data: { workspaceId: profile.context.workspaceId, userId: colleague.id, role: "ADMIN", businessProfileScope: "ALL" },
    });
    const asColleague = await authorizeBusinessProfileAccess(database.db, {
      userId: colleague.id,
      workspaceId: profile.context.workspaceId,
      businessProfileId: profile.businessProfileId,
    });

    await operateConversation(dependencies(database.db, asColleague), {
      scope: { ...scope(), conversationId: profile.conversationId },
      operation: { kind: "TAKE_OVER" },
    });

    expect((await readConversation()).takeoverActorUserId).toBe(colleague.id);
  }, 120_000);
});
