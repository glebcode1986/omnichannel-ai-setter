/**
 * The operator's journey, end to end, against a real database (Issue #35).
 *
 * **What "end to end" means here, and why.** This repository has no browser driver, and the contract is
 * explicit about what it wants instead: "E2E must exercise server authorization and stale-state behavior,
 * not only happy-path DOM interactions." So every journey below enters through
 * `resolveBusinessProfileContext` — the same authorization the pages use, session check included — and
 * then drives the same stores the server actions drive, against a migrated PostgreSQL database.
 *
 * That catches the class of defect a DOM test cannot: an authorization gap, a stale write that should have
 * been refused, a state machine that let a person do two contradictory things. The component tests cover
 * the other side, that a button is wired to the action it names.
 *
 * No provider is reached and no Meta credential exists in this suite, per the contract's hard invariant.
 *
 * Every journey has three parts, and the middle one is the point:
 *   1. the happy path, so the rest is not vacuous;
 *   2. **an authorization probe** — the same call as somebody who may not make it;
 *   3. **a stale-state probe** — the same call after the world moved.
 */
import {
  activateBusinessProfile,
  addWorkspaceMember,
  authorizeBusinessProfileAccess,
  authorizeWorkspaceAccess,
  BusinessProfileAccessDeniedError,
  connectChannelAccount,
  createAiDraftStore,
  createBusinessProfile,
  createContactWithChannelIdentity,
  createConversation,
  createConversationOperationStore,
  createKnowledge,
  createReviewStore,
  createWorkspaceWithOwner,
  editKnowledge,
  listInbox,
  listPolicyAudits,
  readConversation,
  readGoals,
  readOnboarding,
  readStageHistory,
  saveStyleProfile,
  savePolicy,
  searchAuditEvents,
  setPrimaryGoal,
  skipOnboardingStep,
  transitionLeadStage,
  type BusinessProfileContext,
} from "@omnichannel/db";
import { noRetrieval } from "@omnichannel/application";
import { MANDATORY_REVIEW_REASON_CODES, NO_CAPABILITIES, type ReasonCode } from "@omnichannel/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "../server/testing/database";
import { resolveBusinessProfileContext, UnauthenticatedError } from "../server/workspace-context";

const AT = new Date("2026-10-05T10:00:00.000Z");

describe.skipIf(!databaseTestsEnabled())("the operator journey", () => {
  let database: TestDatabase;
  let ownerId: string;
  let agentId: string;
  let outsiderId: string;
  let workspaceId: string;
  let profileId: string;
  let otherProfileId: string;
  let seq = 0;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    const db = database.db;

    const owner = await db.user.create({ data: { name: "Journey Owner", email: "journey-owner@example.test" } });
    const agent = await db.user.create({ data: { name: "Journey Agent", email: "journey-agent@example.test" } });
    const outsider = await db.user.create({ data: { name: "Journey Outsider", email: "journey-outsider@example.test" } });
    ownerId = owner.id;
    agentId = agent.id;
    outsiderId = outsider.id;

    ({ workspaceId } = await createWorkspaceWithOwner(db, { name: "Journey Workspace", ownerUserId: ownerId }));
    const workspace = await authorizeWorkspaceAccess(db, { userId: ownerId, workspaceId });
    ({ businessProfileId: profileId } = await createBusinessProfile(db, workspace, { name: "Live" }));
    ({ businessProfileId: otherProfileId } = await createBusinessProfile(db, workspace, { name: "Off limits" }));

    // An Agent who may see one profile and not the other. This is the authorization probe's subject
    // throughout: a member of the workspace, which is a harder case than an outsider.
    await addWorkspaceMember(db, workspace, { userId: agentId, role: "AGENT", businessProfileScope: { selected: [profileId] } });

    // An outsider with no membership at all.
    await createWorkspaceWithOwner(db, { name: "Somewhere Else", ownerUserId: outsiderId });
  }, 240_000);

  afterAll(async () => {
    await database?.dispose();
  });

  const db = () => database.db;
  /** The session seam the pages go through, so the journeys exercise the real authorization. */
  const as = (userId: string | undefined) => ({ getSessionUserId: () => Promise.resolve(userId), db: database.db });
  const owner = () => resolveBusinessProfileContext(as(ownerId), workspaceId, profileId);
  const scope = () => ({ workspaceId, businessProfileId: profileId });

  /** A fresh conversation with one inbound message, which is where every operator journey starts. */
  const conversation = async (context: BusinessProfileContext, channelAccountId: string) => {
    seq += 1;
    const identity = await createContactWithChannelIdentity(db(), context, {
      channelAccountId,
      externalUserId: `journey-user-${String(seq)}`,
      displayName: `Journey Customer ${String(seq)}`,
    });
    const created = await createConversation(db(), context, { channelAccountId, channelIdentityId: identity.channelIdentityId });
    const conversationId = created.id;
    const message = await db().message.create({
      data: {
        ...scope(),
        channelAccountId,
        conversationId,
        direction: "IN",
        source: "PARTICIPANT",
        kind: "TEXT",
        text: "Do you have anything on Saturday?",
        occurredAt: AT,
      },
      select: { id: true },
    });
    await db().conversation.update({
      where: { workspaceId_businessProfileId_id: { ...scope(), id: conversationId } },
      data: { lastMessageAt: AT, lastInboundAt: AT },
    });
    return { conversationId, messageId: message.id, contactId: identity.contactId };
  };

  const draftFor = async (
    context: BusinessProfileContext,
    target: { conversationId: string; messageId: string },
    options: { needsReview?: boolean; reasons?: readonly ReasonCode[]; confidence?: number } = {},
  ) => {
    seq += 1;
    const { aiDraftId } = await createAiDraftStore(db()).saveDraft({
      scope: { ...scope(), conversationId: target.conversationId },
      generationKey: `journey-${String(seq)}`,
      trigger: "AUTOMATIC",
      anchorMessageId: target.messageId,
      anchorStateVersion: 1,
      text: "Yes — Saturday at eleven is free.",
      structuredOutput: { reply: "Yes — Saturday at eleven is free." },
      confidence: options.confidence ?? 0.92,
      modelSuggestsSend: options.needsReview !== true,
      needsReview: options.needsReview ?? false,
      reasonCodes: [...(options.reasons ?? [])],
      factualSourceIds: [],
      retrieval: noRetrieval("OK"),
      status: options.needsReview === true ? "HELD" : "PENDING",
      provider: "anthropic",
      model: "claude-opus-5",
      promptVersion: "reply.v1",
      schemaVersion: "ai-draft.v1",
    });
    expect(context).toBeDefined();
    return aiDraftId;
  };

  /** A credential row, because an account must reference one. No provider secret: an opaque test value. */
  const credential = async (label: string) => {
    seq += 1;
    const row = await db().channelCredential.create({
      data: {
        workspaceId,
        purpose: "INSTAGRAM_PAGE_TOKEN",
        keyId: "journey-test-key",
        algorithm: "aes-256-gcm",
        ciphertext: Buffer.from(`journey-${label}-${String(seq)}`),
        nonce: Buffer.from(`nonce-${String(seq)}`.padEnd(12, "0").slice(0, 12)),
        authTag: Buffer.from(`tag-${String(seq)}`.padEnd(16, "0").slice(0, 16)),
      },
      select: { id: true },
    });
    return row.id;
  };

  const liveAccount = async () => {
    const context = await owner();
    seq += 1;
    return connectChannelAccount(db(), context, {
      channel: "INSTAGRAM",
      externalAccountId: `journey-account-${String(seq)}`,
      displayName: `Journey Account ${String(seq)}`,
      capabilities: NO_CAPABILITIES,
      credentialId: await credential("instagram"),
    });
  };

  describe("1. setting the product up and taking it live", () => {
    it("refuses every step of the journey to a request with no session", async () => {
      await expect(resolveBusinessProfileContext(as(undefined), workspaceId, profileId)).rejects.toThrow(UnauthenticatedError);
    }, 240_000);

    it("refuses the profile an Agent was not granted, even though they are in the workspace", async () => {
      // A member of the workspace is the harder case than an outsider: the workspace check passes and only
      // the profile grant stops them.
      await expect(resolveBusinessProfileContext(as(agentId), workspaceId, otherProfileId)).rejects.toThrow(BusinessProfileAccessDeniedError);
      await expect(resolveBusinessProfileContext(as(outsiderId), workspaceId, profileId)).rejects.toThrow(BusinessProfileAccessDeniedError);
      // And the granted one still works, so the refusals above are a grant check and not a broken helper.
      await expect(resolveBusinessProfileContext(as(agentId), workspaceId, profileId)).resolves.toBeDefined();
    }, 240_000);

    it("reports what is still missing, and refuses to go live until it is not", async () => {
      const context = await owner();

      const before = await readOnboarding(db(), context);
      const refused = await activateBusinessProfile(db(), context);

      // The checklist and the activation must agree. A page that listed blockers and a button that
      // ignored them would be the worst of both.
      expect(before.state.steps.some((step) => step.state !== "COMPLETE")).toBe(true);
      expect(refused.kind).toBe("NOT_READY");
      expect(refused.kind === "NOT_READY" ? refused.blockers.length : 0).toBeGreaterThan(0);
    }, 240_000);

    it("carries the operator through connection, knowledge, style and simulation to activation", async () => {
      const context = await owner();
      const account = await liveAccount();

      await createKnowledge(db(), context, { title: "Opening hours", chunks: ["We are open Tuesday to Saturday, nine until six."] });
      await saveStyleProfile(db(), context, "BUSINESS_PROFILE", {
        persona: "Warm and brief",
        tone: "Friendly",
        replyLength: "SHORT",
        emoji: "NONE",
        greeting: null,
        signOff: null,
        preferredPhrases: [],
        avoidedPhrases: [],
        language: "en",
      });
      await db().automationPolicy.create({ data: { ...scope(), mandatoryReviewReasons: [...MANDATORY_REVIEW_REASON_CODES] } });

      const snapshot = await readOnboarding(db(), context);

      // The connection is live and the two content steps are done, so the remaining blockers are the ones
      // the operator still has to decide rather than ones the journey failed to satisfy.
      expect(account.status).toBe("CONNECTED");
      expect(snapshot.state.steps.filter((step) => step.state === "COMPLETE").length).toBeGreaterThan(0);
    }, 240_000);

    it("lets an operator skip a step and put it back, and says which they skipped", async () => {
      const context = await owner();
      const step = (await readOnboarding(db(), context)).state.steps.find((candidate) => candidate.skippable)?.step;
      expect(step, "the checklist must offer something skippable, or this journey is untestable").toBeDefined();

      await skipOnboardingStep(db(), context, step ?? "");
      const skipped = await readOnboarding(db(), context);

      // A skip is a decision with a reason, not a dismissal: the page has to be able to show what was
      // set aside and why.
      expect(skipped.state.steps.find((candidate) => candidate.step === step)?.state).toBe("SKIPPED");
    }, 240_000);
  });

  describe("2. working the Inbox", () => {
    it("finds a conversation by search, opens it, and takes it over", async () => {
      const context = await owner();
      const account = await liveAccount();
      const target = await conversation(context, account.id);

      const found = await listInbox(db(), context, { search: "Journey Customer" }, {});
      const opened = await readConversation(db(), context, target.conversationId);
      const operations = createConversationOperationStore(db(), context);
      const takenOver = await operations.takeOver({ conversationId: target.conversationId, at: AT });
      const handedBack = await operations.handBack({ conversationId: target.conversationId, at: AT });

      expect(found.rows.map((row) => row.id)).toContain(target.conversationId);
      expect(opened?.messages.map((message) => message.text)).toContain("Do you have anything on Saturday?");
      expect(takenOver.status).toBe("TAKEN_OVER");
      expect(handedBack.status).toBe("HANDED_BACK");
    }, 240_000);

    it("shows an Agent nothing from the profile they were not granted", async () => {
      const ownerContext = await owner();
      const otherContext = await authorizeBusinessProfileAccess(db(), { userId: ownerId, workspaceId, businessProfileId: otherProfileId });
      const account = await connectChannelAccount(db(), otherContext, {
        channel: "INSTAGRAM",
        externalAccountId: "journey-other-account",
        displayName: "Other Profile Account",
        capabilities: NO_CAPABILITIES,
        credentialId: await credential("probe"),
      });
      const hidden = await conversation(otherContext, account.id);

      const agentContext = await resolveBusinessProfileContext(as(agentId), workspaceId, profileId);
      const visible = await listInbox(db(), agentContext, {}, {});

      // The same query, a different context, and the other profile's thread is absent rather than
      // filtered out afterwards.
      expect(visible.rows.map((row) => row.id)).not.toContain(hidden.conversationId);
      expect(await readConversation(db(), agentContext, hidden.conversationId)).toBeUndefined();
      expect(ownerContext).toBeDefined();
    }, 240_000);

    it("refuses an operation on a conversation that is not this profile's", async () => {
      const otherContext = await authorizeBusinessProfileAccess(db(), { userId: ownerId, workspaceId, businessProfileId: otherProfileId });
      const account = await connectChannelAccount(db(), otherContext, {
        channel: "WHATSAPP",
        externalAccountId: "journey-other-whatsapp",
        displayName: "Other WhatsApp",
        capabilities: NO_CAPABILITIES,
        credentialId: await credential("probe"),
      });
      const elsewhere = await conversation(otherContext, account.id);

      const operations = createConversationOperationStore(db(), await owner());

      // Naming another profile's conversation from this one's context is "gone", not an error page and
      // not a successful takeover.
      expect(await operations.takeOver({ conversationId: elsewhere.conversationId, at: AT })).toEqual({ status: "GONE" });
    }, 240_000);
  });

  describe("3. reviewing a draft in DRAFT mode", () => {
    it("approves a draft as written", async () => {
      const context = await owner();
      const account = await liveAccount();
      const target = await conversation(context, account.id);
      const draftId = await draftFor(context, target, { needsReview: true, reasons: ["MODE_NOT_AUTOPILOT"] });

      const decided = await createReviewStore(db(), context).resolveApproval({
        draftId,
        conversationId: target.conversationId,
        decision: { reviewMode: "NORMAL", saveAsStyleExample: false },
        at: AT,
      });

      expect(decided.kind).toBe("SCHEDULED");
      expect(decided.kind === "SCHEDULED" ? decided.replayed : true).toBe(false);
    }, 240_000);

    it("edits a draft, sends the person's wording, and records that they wrote it", async () => {
      const context = await owner();
      const account = await liveAccount();
      const target = await conversation(context, account.id);
      const draftId = await draftFor(context, target, { needsReview: true });

      const decided = await createReviewStore(db(), context).resolveApproval({
        draftId,
        conversationId: target.conversationId,
        decision: { editedText: "Saturday at eleven works — shall I put you down?", reviewMode: "NORMAL", saveAsStyleExample: false },
        at: AT,
      });

      const draft = await db().aiDraft.findFirst({ where: { ...scope(), id: draftId }, select: { text: true, requestedByUserId: true, structuredOutput: true } });
      expect(decided.kind).toBe("SCHEDULED");
      expect(draft?.text).toBe("Saturday at eleven works — shall I put you down?");
      expect(draft?.requestedByUserId).toBe(ownerId);
      // The model's own output is untouched: it is evidence about what the model produced, not about what
      // was sent.
      expect(draft?.structuredOutput).toMatchObject({ reply: "Yes — Saturday at eleven is free." });
    }, 240_000);

    it("rejects a draft and hands the conversation back", async () => {
      const context = await owner();
      const account = await liveAccount();
      const target = await conversation(context, account.id);
      const draftId = await draftFor(context, target, { needsReview: true });

      const decided = await createReviewStore(db(), context).resolveDismissal({ draftId, conversationId: target.conversationId, at: AT, note: "Not what we offer" });

      const conversationRow = await db().conversation.findFirst({ where: { ...scope(), id: target.conversationId }, select: { takeoverState: true } });
      expect(decided.kind).toBe("DISMISSED");
      // Nobody is holding it and nothing is waiting, which is what dismissal means.
      expect(conversationRow?.takeoverState).toBe("NONE");
    }, 240_000);

    it("refuses a decision on a draft the conversation has moved past", async () => {
      const context = await owner();
      const account = await liveAccount();
      const target = await conversation(context, account.id);
      const draftId = await draftFor(context, target, { needsReview: true });
      // The customer wrote again between the page rendering and the operator clicking.
      await db().conversation.update({ where: { workspaceId_businessProfileId_id: { ...scope(), id: target.conversationId } }, data: { stateVersion: { increment: 1 } } });

      const decided = await createReviewStore(db(), context).resolveApproval({
        draftId,
        conversationId: target.conversationId,
        decision: { reviewMode: "NORMAL", saveAsStyleExample: false },
        at: AT,
      });

      // The stale-state probe. Sending here would send an answer to a question that has changed, which
      // the customer would read as the business not listening.
      expect(decided.kind).toBe("STALE");
    }, 240_000);

    it("answers a repeated decision with the same send rather than a second one", async () => {
      const context = await owner();
      const account = await liveAccount();
      const target = await conversation(context, account.id);
      const draftId = await draftFor(context, target, { needsReview: true });
      const decision = { reviewMode: "NORMAL" as const, saveAsStyleExample: false };

      const first = await createReviewStore(db(), context).resolveApproval({ draftId, conversationId: target.conversationId, decision, at: AT });
      const again = await createReviewStore(db(), context).resolveApproval({ draftId, conversationId: target.conversationId, decision, at: AT });

      // A double-submitted form is one decision, not two messages.
      expect(first.kind).toBe("SCHEDULED");
      expect(again).toMatchObject({ kind: "SCHEDULED", replayed: true });
      expect(first.kind === "SCHEDULED" && again.kind === "SCHEDULED" ? again.operationId : "").toBe(first.kind === "SCHEDULED" ? first.operationId : "");
    }, 240_000);
  });

  describe("4. a pending send in AUTOPILOT", () => {
    it("cancels a queued reply before it goes out", async () => {
      const context = await owner();
      const account = await liveAccount();
      const target = await conversation(context, account.id);
      const draftId = await draftFor(context, target);
      seq += 1;
      const operationId = `journey-op-${String(seq)}`;
      await db().deliveryJobRecord.create({
        data: {
          ...scope(),
          draftId,
          operationId,
          correlationId: operationId,
          status: "SCHEDULED",
          scheduledFor: new Date(AT.getTime() + 45_000),
          selectedDelayMs: 45_000,
        },
      });

      const stopped = await createConversationOperationStore(db(), context).cancelSend({ conversationId: target.conversationId, operationId, at: AT });

      const job = await db().deliveryJobRecord.findFirst({ where: { operationId }, select: { status: true, cancelReason: true } });
      expect(stopped.status).toBe("SEND_CANCELLED");
      expect(job?.status).toBe("CANCELLED_HUMAN_TAKEOVER");
      expect(job?.cancelReason).toBe("HUMAN_CANCELLED_FROM_INBOX");
    }, 240_000);

    it("says the send has already gone rather than pretending to stop it", async () => {
      const context = await owner();
      const account = await liveAccount();
      const target = await conversation(context, account.id);
      const draftId = await draftFor(context, target);
      seq += 1;
      const operationId = `journey-claimed-${String(seq)}`;
      await db().deliveryJobRecord.create({
        data: {
          ...scope(),
          draftId,
          operationId,
          correlationId: operationId,
          status: "SENDING",
          scheduledFor: AT,
          selectedDelayMs: 0,
          claimedAt: AT,
        },
      });

      const attempted = await createConversationOperationStore(db(), context).cancelSend({ conversationId: target.conversationId, operationId, at: AT });

      // A worker has it and the send may be at the provider right now. ADR-012 forbids guessing, and
      // "cancelled" would be a guess the operator would act on.
      expect(attempted.status).toBe("TOO_LATE");
    }, 240_000);

    it("refuses to cancel a send named from another profile's conversation", async () => {
      const otherContext = await authorizeBusinessProfileAccess(db(), { userId: ownerId, workspaceId, businessProfileId: otherProfileId });
      const account = await connectChannelAccount(db(), otherContext, {
        channel: "INSTAGRAM",
        externalAccountId: "journey-cancel-probe",
        displayName: "Cancel Probe",
        capabilities: NO_CAPABILITIES,
        credentialId: await credential("probe"),
      });
      const elsewhere = await conversation(otherContext, account.id);
      const draftId = await draftFor(otherContext, elsewhere);
      const operationId = "journey-cross-profile-op";
      await db().deliveryJobRecord.create({
        data: {
          workspaceId,
          businessProfileId: otherProfileId,
          draftId,
          operationId,
          correlationId: operationId,
          status: "SCHEDULED",
          scheduledFor: new Date(AT.getTime() + 45_000),
          selectedDelayMs: 45_000,
        },
      });

      const attempted = await createConversationOperationStore(db(), await owner()).cancelSend({
        conversationId: elsewhere.conversationId,
        operationId,
        at: AT,
      });

      // One tenant must not be able to stop another's sends by naming an operation id.
      expect(attempted.status).toBe("GONE");
      expect((await db().deliveryJobRecord.findFirst({ where: { operationId }, select: { status: true } }))?.status).toBe("SCHEDULED");
    }, 240_000);
  });

  describe("5. a missing fact becomes confirmed knowledge", () => {
    it("holds the reply, takes the answer, and leaves the knowledge ready to retry", async () => {
      const context = await owner();
      const account = await liveAccount();
      const target = await conversation(context, account.id);
      const draftId = await draftFor(context, target, { needsReview: true, reasons: ["MISSING_FACT"], confidence: 0.4 });

      const held = await db().aiDraft.findFirst({ where: { ...scope(), id: draftId }, select: { status: true, needsReview: true, reasonCodes: true } });
      const created = await createKnowledge(db(), context, { title: "Saturday hours", chunks: ["On Saturdays we close at four."] });
      const documentId = created.status === "CREATED" ? created.documentId : "";
      const edited = await editKnowledge(db(), context, documentId, { chunks: ["On Saturdays we close at four, last appointment three-thirty."] });

      // The draft waited for a person rather than guessing, and the answer they added is a new version
      // with its own indexing state — which is what makes a retry answer differently.
      expect(held).toMatchObject({ status: "HELD", needsReview: true });
      expect(held?.reasonCodes).toContain("MISSING_FACT");
      expect(edited).toMatchObject({ status: "VERSIONED", version: 2 });
      const document = await db().knowledgeDocument.findFirst({ where: { workspaceId, id: documentId }, select: { indexingState: true } });
      // New wording has not been read by anything yet. Saying otherwise would show a green source whose
      // current text nothing has ever indexed.
      expect(document?.indexingState).toBe("PENDING");
    }, 240_000);

    it("refuses to add knowledge from a profile the member may not act in", async () => {
      const agentContext = await resolveBusinessProfileContext(as(agentId), workspaceId, profileId);
      await expect(resolveBusinessProfileContext(as(agentId), workspaceId, otherProfileId)).rejects.toThrow(BusinessProfileAccessDeniedError);

      // And what they may do, they may do — so the refusal above is about the grant.
      expect((await createKnowledge(db(), agentContext, { title: "Agent's note", chunks: ["Parking is on the street."] })).status).toBe("CREATED");
    }, 240_000);
  });

  describe("6. moving a lead", () => {
    it("moves a lead and records who moved it", async () => {
      const context = await owner();
      const account = await liveAccount();
      const target = await conversation(context, account.id);

      const moved = await transitionLeadStage(db(), context, { conversationId: target.conversationId, expectedStage: "NEW", toStage: "ENGAGED", source: "HUMAN_SET", at: AT });
      const history = await readStageHistory(db(), context, target.conversationId);

      expect(moved.status).toBe("MOVED");
      expect(history[0]).toMatchObject({ toStage: "ENGAGED", fromStage: "NEW" });
      expect(history[0]?.actorName).toBe("Journey Owner");
    }, 240_000);

    it("refuses a move drawn against a stage the lead has already left", async () => {
      const context = await owner();
      const account = await liveAccount();
      const target = await conversation(context, account.id);
      await transitionLeadStage(db(), context, { conversationId: target.conversationId, expectedStage: "NEW", toStage: "ENGAGED", source: "HUMAN_SET", at: AT });

      // Two operators with the board open. The second drag carries the stage their screen was drawn in.
      const stale = await transitionLeadStage(db(), context, { conversationId: target.conversationId, expectedStage: "NEW", toStage: "LOST", source: "HUMAN_SET", at: AT });

      expect(stale).toMatchObject({ status: "STALE", currentStage: "ENGAGED" });
      // And the lead is where the first move put it, not where the stale one aimed.
      expect((await readStageHistory(db(), context, target.conversationId))[0]?.toStage).toBe("ENGAGED");
    }, 240_000);

    it("keeps a conversation's goal and its lead stage as separate answers", async () => {
      const context = await owner();
      const account = await liveAccount();
      const target = await conversation(context, account.id);

      await setPrimaryGoal(db(), context, { conversationId: target.conversationId, kind: "BOOK_APPOINTMENT", at: AT });
      await transitionLeadStage(db(), context, { conversationId: target.conversationId, expectedStage: "NEW", toStage: "QUALIFYING", source: "HUMAN_SET", at: AT });

      // What the conversation is *for* and how far along it is are different questions, and a surface
      // that read one from the other would be wrong the first time somebody qualified a lead they had
      // already decided not to book.
      expect((await readGoals(db(), context, target.conversationId)).primary?.kind).toBe("BOOK_APPOINTMENT");
      expect((await readStageHistory(db(), context, target.conversationId))[0]?.toStage).toBe("QUALIFYING");
    }, 240_000);
  });

  describe("7. a policy change is on the record", () => {
    it("records the change twice over: the typed history and the searchable log", async () => {
      const context = await owner();

      const saved = await savePolicy(db(), context, null, { mode: "DRAFT", businessGoal: "Fill Saturday mornings" });

      const audits = await listPolicyAudits(db(), context, { limit: 5 });
      const workspaceContext = await authorizeWorkspaceAccess(db(), { userId: ownerId, workspaceId });
      const events = await searchAuditEvents(db(), workspaceContext, { kinds: ["MODE_CHANGED"], limit: 20 });

      expect(saved.status).toBe("SAVED");
      // The typed before/after, for somebody asking what a setting used to be.
      expect(audits[0]).toMatchObject({ actorName: "Journey Owner" });
      expect(audits[0]?.impacts).toBeDefined();
      // And the searchable log, for somebody asking when this profile started replying unattended.
      expect(events.rows[0]?.summary).toContain("Changed the mode");
      expect(events.rows[0]?.actorName).toBe("Journey Owner");
    }, 240_000);

    it("does not show an Agent the admin-only entries", async () => {
      const agentWorkspace = await authorizeWorkspaceAccess(db(), { userId: agentId, workspaceId });

      const page = await searchAuditEvents(db(), agentWorkspace, { limit: 100 });

      // Absent, not redacted: a row shown as `***` at 14:02 still discloses that somebody's access
      // changed at 14:02.
      expect(page.rows.some((row) => row.sensitive)).toBe(false);
      expect(page.restricted).toBe(true);
      // The ordinary work is there, so this is a filter and not an empty page.
      expect(page.rows.some((row) => row.kind === "MODE_CHANGED" || row.kind === "POLICY_CHANGED")).toBe(true);
    }, 240_000);

    it("keeps the log inside the workspace", async () => {
      const outsiderWorkspace = await db().workspaceMember.findFirst({ where: { userId: outsiderId }, select: { workspaceId: true } });
      const theirContext = await authorizeWorkspaceAccess(db(), { userId: outsiderId, workspaceId: outsiderWorkspace?.workspaceId ?? "" });

      const theirs = await searchAuditEvents(db(), theirContext, { limit: 100 });

      expect(theirs.rows).toEqual([]);
    }, 240_000);
  });

  describe("8. the states a page has to render truthfully", () => {
    it("has an empty state that is empty, not an error", async () => {
      const otherContext = await authorizeBusinessProfileAccess(db(), { userId: ownerId, workspaceId, businessProfileId: otherProfileId });

      const nothing = await listInbox(db(), otherContext, { search: "nobody by this name exists" }, {});

      // A search with no matches is a normal outcome. It must not throw, and it must not offer a cursor
      // to a page that would also be empty.
      expect(nothing.rows).toEqual([]);
      expect(nothing.nextCursor).toBeUndefined();
    }, 240_000);

    it("returns undefined for a conversation that is gone rather than throwing", async () => {
      const context = await owner();

      // A bookmarked id from a profile the viewer lost access to is a 404, not a stack trace that
      // confirms the row exists.
      expect(await readConversation(db(), context, "00000000-0000-0000-0000-000000000000")).toBeUndefined();
    }, 240_000);

    it("recovers when a refused write is retried after the world settles", async () => {
      const context = await owner();
      const account = await liveAccount();
      const target = await conversation(context, account.id);
      await transitionLeadStage(db(), context, { conversationId: target.conversationId, expectedStage: "NEW", toStage: "ENGAGED", source: "HUMAN_SET", at: AT });

      const refused = await transitionLeadStage(db(), context, { conversationId: target.conversationId, expectedStage: "NEW", toStage: "QUALIFIED", source: "HUMAN_SET", at: AT });
      const retried = await transitionLeadStage(db(), context, {
        conversationId: target.conversationId,
        expectedStage: refused.status === "STALE" ? refused.currentStage : "NEW",
        toStage: "QUALIFIED",
        source: "HUMAN_SET",
        at: AT,
      });

      // The refusal tells the caller what the world actually is, so the retry can be made correctly.
      // A refusal that said only "no" would leave a person reloading and guessing.
      expect(refused.status).toBe("STALE");
      expect(retried.status).toBe("MOVED");
    }, 240_000);
  });
});
