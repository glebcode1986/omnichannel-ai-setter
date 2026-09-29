/**
 * A reviewed reply, from the click to the adapter, against a real PostgreSQL server.
 *
 * This path had a hole that no unit test could see: the review queue scheduled a delivery and the worker
 * later executed it as automation, because the authority the person granted was never written down. The
 * reply a human approved then met the very gates that exist to ask for a human — DRAFT mode, their own
 * ownership of the conversation — and was held or cancelled before the adapter, while the provider's
 * human-support path could not be reached at all.
 *
 * So these tests run the real thing end to end: `resolveReview` against the real review store, then the
 * real delivery handler, coordinator and delivery store, with a sender that records what it was asked to
 * do. A stub that only proves "something called schedule" is exactly what missed this.
 */
import {
  noRetrieval,
  resolveReview,
  type DeliveryChannelStatePort,
  type DeliveryDependencies,
  type DeliverySendCommand,
  type ReviewCommand,
  type ReviewDependencies,
} from "@omnichannel/application";
import {
  appendInboundMessage,
  authorizeBusinessProfileAccess,
  addWorkspaceMember,
  authorizeWorkspaceAccess,
  createAiDraftStore,
  createBusinessProfile,
  createChannelAccount,
  createContactWithChannelIdentity,
  createConversation,
  createDeliveryStore,
  createReviewStore,
  createStyleLearningStore,
  createWorkspaceWithOwner,
  type BusinessProfileContext,
} from "@omnichannel/db";
import { NO_CAPABILITIES, toUserId, type Actor } from "@omnichannel/domain";
import type { DeliveryJob } from "@omnichannel/queue";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDeliveryHandler } from "./delivery-handler";
import { createChannelStateResolver } from "./delivery-policy";
import { createEndToEndInfrastructure, endToEndTestsEnabled, type EndToEndInfrastructure } from "./testing/infrastructure";

const NOW = new Date("2026-09-19T12:00:00.000Z");

describe.skipIf(!endToEndTestsEnabled())("a reviewed reply reaching the adapter (end to end)", () => {
  let infra: EndToEndInfrastructure;
  let context: BusinessProfileContext;
  let scope: { workspaceId: string; businessProfileId: string };
  let channelAccountId: string;
  let approverId: string;
  let colleague: Actor;
  let colleagueId: string;
  /** A second signed-in member of the same Business Profile, and one from a different profile. */
  let colleagueContext: BusinessProfileContext;
  let otherProfileContext: BusinessProfileContext;
  let otherProfileId: string;
  let seq = 0;

  beforeAll(async () => {
    infra = await createEndToEndInfrastructure();
    const owner = await infra.db.user.create({ data: { name: "Review Owner", email: "review-owner@example.test" } });
    const other = await infra.db.user.create({ data: { name: "Colleague", email: "review-colleague@example.test" } });
    approverId = owner.id;
    colleague = { kind: "USER", userId: toUserId(other.id) };
    colleagueId = other.id;

    const { workspaceId } = await createWorkspaceWithOwner(infra.db, { name: "Review Workspace", ownerUserId: owner.id });
    const workspace = await authorizeWorkspaceAccess(infra.db, { userId: owner.id, workspaceId });
    const { businessProfileId } = await createBusinessProfile(infra.db, workspace, { name: "Review Profile" });
    context = await authorizeBusinessProfileAccess(infra.db, { userId: owner.id, workspaceId, businessProfileId });
    scope = { workspaceId, businessProfileId };

    await addWorkspaceMember(infra.db, workspace, { userId: other.id, role: "ADMIN", businessProfileScope: "ALL" });
    colleagueContext = await authorizeBusinessProfileAccess(infra.db, { userId: other.id, workspaceId, businessProfileId });
    const second = await createBusinessProfile(infra.db, workspace, { name: "Other Profile" });
    otherProfileId = second.businessProfileId;
    otherProfileContext = await authorizeBusinessProfileAccess(infra.db, { userId: other.id, workspaceId, businessProfileId: second.businessProfileId });
    const account = await createChannelAccount(infra.db, context, {
      channel: "INSTAGRAM",
      externalAccountId: "ig-account-review",
      capabilities: { ...NO_CAPABILITIES, text: true },
    });
    channelAccountId = account.id;
  }, 180_000);

  afterAll(async () => {
    await infra?.dispose();
  });

  /**
   * A conversation of its own per case, with the customer's message a minute old.
   *
   * Separate conversations because several of these deliberately end with a human owning one, and a test
   * that inherited that ownership would pass for the wrong reason.
   */
  const freshConversation = async (options: { mode?: "DRAFT" | "AUTOPILOT" | "OFF"; lastInboundAt?: Date } = {}) => {
    seq += 1;
    const { contactId, channelIdentityId } = await createContactWithChannelIdentity(infra.db, context, {
      channelAccountId,
      externalUserId: `ig-user-review-${String(seq)}`,
      displayName: `Customer ${String(seq)}`,
    });
    const conversation = await createConversation(infra.db, context, { channelAccountId, channelIdentityId });
    const occurredAt = options.lastInboundAt ?? new Date(NOW.getTime() - 60_000);
    const message = await appendInboundMessage(infra.db, context, {
      conversationId: conversation.id,
      channelMessageId: `mid-review-${String(seq)}`,
      kind: "TEXT",
      text: "Are you open on Saturday?",
      occurredAt,
    });
    await infra.db.conversation.update({
      where: { workspaceId_businessProfileId_id: { ...scope, id: conversation.id } },
      data: { modeOverride: options.mode ?? "DRAFT" },
    });
    void contactId;
    return { conversationId: conversation.id, messageId: message.id, lastInboundAt: occurredAt };
  };

  /** A draft waiting for a person, exactly as the engine leaves one it will not send itself. */
  const pendingDraft = async (conversationId: string, anchorMessageId: string, options: { needsReview?: boolean } = {}): Promise<string> => {
    seq += 1;
    const { aiDraftId } = await createAiDraftStore(infra.db).saveDraft({
      scope: { ...scope, conversationId },
      generationKey: `review_e2e_${String(seq)}`,
      trigger: "AUTOMATIC",
      anchorMessageId,
      anchorStateVersion: 1,
      text: "We open at 10 on Saturday.",
      structuredOutput: { reply: "We open at 10 on Saturday." },
      confidence: 0.9,
      modelSuggestsSend: true,
      needsReview: options.needsReview ?? true,
      reasonCodes: options.needsReview === false ? [] : ["MISSING_FACT"],
      factualSourceIds: [],
      retrieval: noRetrieval("OK"),
      status: "PENDING",
      provider: "anthropic",
      model: "claude-opus-5",
      promptVersion: "reply.v1",
      schemaVersion: "ai-draft.v1",
    });
    return aiDraftId;
  };

  const reviewDependencies = (as: BusinessProfileContext = context): ReviewDependencies => ({
    reviews: createReviewStore(infra.db, as),
    style: createStyleLearningStore(infra.db, as),
    log: { info: () => undefined, warn: () => undefined },
    now: () => NOW,
    inboundContextFor: () => Promise.resolve("Are you open on Saturday?"),
  });

  const approve = (conversationId: string, draftId: string, overrides: Partial<ReviewCommand> = {}, as: BusinessProfileContext = context) =>
    resolveReview(reviewDependencies(as), {
      scope: { ...scope, conversationId },
      draftId,
      action: { kind: "APPROVE" },
      reviewMode: "NORMAL",
      ...overrides,
    });

  /**
   * The provider's own view of the conversation.
   *
   * Supplied rather than resolved for the human-support cases: `createChannelStateResolver` cannot know
   * whether this Meta app is approved for Human Agent — that is an app-level capability nothing here
   * stores — so it answers `UNKNOWN` and fails closed. The fact under test is the authority, not the
   * approval lookup, so the provider fact is handed in and everything else stays real.
   */
  const humanAgentLive = (until: Date): DeliveryChannelStatePort => ({
    stateFor: () => ({
      window: { state: "NOT_ELIGIBLE", reason: "standard messaging window closed" },
      humanAgent: { state: "ELIGIBLE", expiresAt: until },
    }),
  });

  /** The real handler, with a sender that records rather than sends. */
  const deliver = (conversationId: string, operationId: string, now: Date = NOW, channel?: DeliveryChannelStatePort) => {
    const sends: DeliverySendCommand[] = [];
    const engine: DeliveryDependencies = {
      store: createDeliveryStore(infra.db),
      sender: {
        send: (input) => {
          sends.push(input);
          return Promise.resolve({ outcome: "ACCEPTED", platformMessageId: `mid-sent-${input.operationId}` });
        },
      },
      channel: channel ?? createChannelStateResolver(() => now),
      log: infra.logger,
      now: () => now,
    };
    const job: DeliveryJob = {
      schemaVersion: 1,
      ...scope,
      correlationId: `corr-review-${operationId}`,
      conversationId,
      draftId: "unused",
      deliveryJobId: operationId,
      operationId,
      scheduledFor: now.toISOString(),
      selectedDelayMs: 0,
    };
    // No kill switch in these cases: what is under test is the authority a reviewed reply carries, and a
    // suspension would stop every one of them before that question is reached. It is still stated rather
    // than defaulted, because a handler that can be composed without one can be composed without one in
    // production too.
    return { run: () => createDeliveryHandler({ engine, outboundSuspension: () => Promise.resolve(undefined), logger: infra.logger })(job), sends };
  };

  const statusOf = async (operationId: string) =>
    (await infra.db.deliveryJobRecord.findUniqueOrThrow({ where: { operationId }, select: { status: true } })).status;

  const scheduledOperation = (outcome: Awaited<ReturnType<typeof approve>>): string => {
    if (outcome.status !== "SCHEDULED") {
      throw new Error(`the review did not schedule anything: ${outcome.status}`);
    }
    return outcome.operationId;
  };

  it("sends a DRAFT-mode reply a person approved, and tells the adapter who approved it", async () => {
    const { conversationId, messageId } = await freshConversation({ mode: "DRAFT" });
    const draftId = await pendingDraft(conversationId, messageId);

    const operationId = scheduledOperation(await approve(conversationId, draftId));
    const { run, sends } = deliver(conversationId, operationId);
    const attempt = await run();

    // DRAFT mode and the approver's own ownership both hold every automated reply. This one is not
    // automated, and the same coordinator that stops automation lets it through.
    expect(attempt).toMatchObject({ status: "SEND_RESULT" });
    expect(await statusOf(operationId)).toBe("SENT");
    expect(sends).toHaveLength(1);
    expect(sends[0]?.authority).toEqual({
      kind: "HUMAN_APPROVED",
      approvedByUserId: approverId,
      approvedAt: NOW,
      reviewMode: "NORMAL",
    });
    expect(sends[0]?.text).toBe("We open at 10 on Saturday.");
  }, 180_000);

  it("reaches the adapter as HUMAN_APPROVED on the human-support path, and only while it is live", async () => {
    // A conversation whose standard window has closed but whose human-support exception has not.
    const closedWindow = new Date(NOW.getTime() - 25 * 60 * 60 * 1000);
    const { conversationId, messageId } = await freshConversation({ mode: "DRAFT", lastInboundAt: closedWindow });
    await infra.db.automationPolicy.create({
      data: { ...scope, channelAccountId, mode: "DRAFT", mandatoryReviewReasons: [], instagramAfterWindowPolicy: "HUMAN_ASSISTED_EXTENDED" },
    });
    const draftId = await pendingDraft(conversationId, messageId);

    const operationId = scheduledOperation(await approve(conversationId, draftId, { reviewMode: "HUMAN_AGENT" }));
    const { run, sends } = deliver(conversationId, operationId, NOW, humanAgentLive(new Date(NOW.getTime() + 60_000)));
    await run();

    // The only permitted route out of a closed window, and it is reached with the authority that permits
    // it — never as an automated standard send.
    expect(sends).toHaveLength(1);
    expect(sends[0]?.authority).toMatchObject({ kind: "HUMAN_APPROVED", reviewMode: "HUMAN_AGENT" });
    expect(await statusOf(operationId)).toBe("SENT");
  }, 180_000);

  it("never reaches the adapter once the human-support exception has expired", async () => {
    const longClosed = new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000);
    const { conversationId, messageId } = await freshConversation({ mode: "DRAFT", lastInboundAt: longClosed });
    const draftId = await pendingDraft(conversationId, messageId);

    const operationId = scheduledOperation(await approve(conversationId, draftId, { reviewMode: "HUMAN_AGENT" }));
    // The same exception, one millisecond past its end.
    const { run, sends } = deliver(conversationId, operationId, NOW, humanAgentLive(new Date(NOW.getTime() - 1)));
    await run();

    // Eligibility is a fact about a moment, and the moment has passed — whoever authorized it.
    expect(sends).toEqual([]);
    expect(await statusOf(operationId)).not.toBe("SENT");
  }, 180_000);

  it("fails closed when the customer writes again between the approval and the send", async () => {
    const { conversationId, messageId } = await freshConversation({ mode: "DRAFT" });
    const draftId = await pendingDraft(conversationId, messageId);
    const operationId = scheduledOperation(await approve(conversationId, draftId));

    await appendInboundMessage(infra.db, context, {
      conversationId,
      channelMessageId: `mid-review-newer-${operationId}`,
      kind: "TEXT",
      text: "actually, never mind",
      occurredAt: new Date(NOW.getTime() + 1_000),
    });
    const { run, sends } = deliver(conversationId, operationId);
    await run();

    // An approval is not authority over a question the customer has already moved past.
    expect(sends).toEqual([]);
    expect(await statusOf(operationId)).toBe("CANCELLED_SUPERSEDED");
  }, 180_000);

  it("fails closed when a colleague takes the conversation after the approval", async () => {
    const { conversationId, messageId } = await freshConversation({ mode: "DRAFT" });
    const draftId = await pendingDraft(conversationId, messageId);
    const operationId = scheduledOperation(await approve(conversationId, draftId));

    // The colleague takes it the way the inbox does: the ownership write, on its own.
    await infra.db.conversation.update({
      where: { workspaceId_businessProfileId_id: { ...scope, id: conversationId } },
      data: {
        takeoverState: "HUMAN_ACTIVE",
        takeoverReason: "HUMAN_SENT_FROM_INBOX",
        humanTakeoverAt: new Date(NOW.getTime() + 1_000),
        takeoverActorKind: "USER",
        takeoverActorUserId: colleague.kind === "USER" ? colleague.userId : null,
        takeoverPausedUntil: null,
      },
    });
    const { run, sends } = deliver(conversationId, operationId);
    await run();

    // They own the conversation now. An approval from before that does not reach past them.
    expect(sends).toEqual([]);
    expect(await statusOf(operationId)).toBe("CANCELLED_HUMAN_TAKEOVER");
  }, 180_000);

  it("leaves no moment in which the approved delivery exists without its ownership", async () => {
    const { conversationId, messageId } = await freshConversation({ mode: "DRAFT" });
    const draftId = await pendingDraft(conversationId, messageId);

    // The conversation row is held by another transaction, so scheduling blocks on taking ownership —
    // after it would have written the delivery row, had the two been separate writes.
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked = (): void => {};
    const lockHeld = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = infra.db.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT "id" FROM "conversations"
          WHERE "workspace_id" = ${scope.workspaceId} AND "business_profile_id" = ${scope.businessProfileId} AND "id" = ${conversationId}
          FOR UPDATE`;
        locked();
        await held;
      },
      { timeout: 60_000, maxWait: 60_000 },
    );
    await lockHeld;

    const approving = approve(conversationId, draftId);
    // While it waits, nothing of it is visible: no delivery row, and so no job a worker could pick up and
    // judge as ordinary automation.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await infra.db.deliveryJobRecord.count({ where: { ...scope, draftId } })).toBe(0);

    release();
    await holder;
    const operationId = scheduledOperation(await approving);

    // And once it commits, both halves are there together.
    const job = await infra.db.deliveryJobRecord.findUniqueOrThrow({
      where: { operationId },
      select: { authority: true, approvedByUserId: true, approvedReviewMode: true },
    });
    const conversation = await infra.db.conversation.findUniqueOrThrow({
      where: { workspaceId_businessProfileId_id: { ...scope, id: conversationId } },
      select: { takeoverState: true, takeoverActorUserId: true },
    });
    expect(job).toMatchObject({ authority: "HUMAN_APPROVED", approvedReviewMode: "NORMAL" });
    expect(conversation).toMatchObject({ takeoverState: "HUMAN_ACTIVE", takeoverActorUserId: job.approvedByUserId });
  }, 180_000);

  it("attributes the send to the authenticated member, with no way to name anybody else", async () => {
    const { conversationId, messageId } = await freshConversation({ mode: "DRAFT" });
    const draftId = await pendingDraft(conversationId, messageId);

    // The command carries no identity at all — there is no field for one — so this is the only identity
    // the decision can be made under: the one the authorization was issued for.
    const operationId = scheduledOperation(await approve(conversationId, draftId));

    const job = await infra.db.deliveryJobRecord.findUniqueOrThrow({ where: { operationId }, select: { approvedByUserId: true } });
    const conversation = await infra.db.conversation.findUniqueOrThrow({
      where: { workspaceId_businessProfileId_id: { ...scope, id: conversationId } },
      select: { takeoverActorUserId: true, takeoverActorKind: true },
    });
    expect(job.approvedByUserId).toBe(approverId);
    expect(conversation).toMatchObject({ takeoverActorKind: "USER", takeoverActorUserId: approverId });
  }, 180_000);

  it("follows the context it was issued for, not the one that came before it", async () => {
    const { conversationId, messageId } = await freshConversation({ mode: "DRAFT" });
    const draftId = await pendingDraft(conversationId, messageId);

    // The same workspace and the same Business Profile, a different signed-in member. Everything the
    // decision writes has to name *them*, because that is who acted.
    const operationId = scheduledOperation(await approve(conversationId, draftId, {}, colleagueContext));

    const job = await infra.db.deliveryJobRecord.findUniqueOrThrow({ where: { operationId }, select: { approvedByUserId: true } });
    const conversation = await infra.db.conversation.findUniqueOrThrow({
      where: { workspaceId_businessProfileId_id: { ...scope, id: conversationId } },
      select: { takeoverActorUserId: true },
    });
    expect(job.approvedByUserId).toBe(colleagueId);
    expect(conversation.takeoverActorUserId).toBe(colleagueId);
    expect(job.approvedByUserId).not.toBe(approverId);
  }, 180_000);

  it("cannot be made to approve as a member of another Business Profile", async () => {
    const { conversationId, messageId } = await freshConversation({ mode: "DRAFT" });
    const draftId = await pendingDraft(conversationId, messageId);

    // A store built for a different Business Profile cannot reach this draft at all, so there is no path
    // by which one profile's member becomes the recorded approver of another's reply.
    const outcome = await resolveReview(reviewDependencies(otherProfileContext), {
      scope: { workspaceId: scope.workspaceId, businessProfileId: otherProfileId, conversationId },
      draftId,
      action: { kind: "APPROVE" },
      reviewMode: "NORMAL",
    });

    expect(outcome).toEqual({ status: "GONE" });
    expect(await infra.db.deliveryJobRecord.count({ where: { ...scope, draftId } })).toBe(0);
    const draft = await infra.db.aiDraft.findUniqueOrThrow({ where: { workspaceId_businessProfileId_id: { ...scope, id: draftId } }, select: { status: true } });
    expect(draft.status).toBe("PENDING");
    const conversation = await infra.db.conversation.findUniqueOrThrow({
      where: { workspaceId_businessProfileId_id: { ...scope, id: conversationId } },
      select: { takeoverState: true },
    });
    expect(conversation.takeoverState).toBe("NONE");
  }, 180_000);

  it("refuses to approve a draft from one conversation while taking another", async () => {
    const mine = await freshConversation({ mode: "DRAFT" });
    const theirs = await freshConversation({ mode: "DRAFT" });
    const draftId = await pendingDraft(mine.conversationId, mine.messageId);

    // The draft belongs to `mine`; the command names `theirs`. Both are in this Business Profile, so
    // nothing about tenancy stops it: the delivery path derives the recipient from the draft, so this
    // would take ownership of one conversation and send into another.
    const outcome = await approve(theirs.conversationId, draftId);

    expect(outcome).toMatchObject({ status: "REJECTED" });
    expect(await infra.db.deliveryJobRecord.count({ where: { ...scope, draftId } })).toBe(0);
    for (const conversationId of [mine.conversationId, theirs.conversationId]) {
      const conversation = await infra.db.conversation.findUniqueOrThrow({
        where: { workspaceId_businessProfileId_id: { ...scope, id: conversationId } },
        select: { takeoverState: true },
      });
      expect(conversation.takeoverState).toBe("NONE");
    }
    const draft = await infra.db.aiDraft.findUniqueOrThrow({ where: { workspaceId_businessProfileId_id: { ...scope, id: draftId } }, select: { status: true } });
    expect(draft.status).toBe("PENDING");
  }, 180_000);

  it("strands nothing when the decision fails part-way, and the retry still works", async () => {
    const { conversationId, messageId } = await freshConversation({ mode: "DRAFT" });
    const draftId = await pendingDraft(conversationId, messageId);

    // A client whose last write inside the decision fails. The claim, the authority and the delivery row
    // have all been written by then, which is exactly the shape of the old bug: separately, the draft
    // would be left CLAIMED with no delivery, and every retry told somebody had already resolved it.
    const failing = new Proxy(infra.db, {
      get(target, property, receiver) {
        if (property !== "$transaction") {
          const value: unknown = Reflect.get(target, property, receiver);
          return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        }
        return (run: (tx: unknown) => Promise<unknown>, options: unknown) =>
          target.$transaction(async (tx) => {
            const gated = new Proxy(tx, {
              get(txTarget, txProperty, txReceiver) {
                if (txProperty !== "conversation") {
                  return Reflect.get(txTarget, txProperty, txReceiver) as unknown;
                }
                return { update: () => Promise.reject(new Error("the ownership write failed")) };
              },
            });
            return run(gated);
          }, options as Parameters<typeof target.$transaction>[1]);
      },
    });

    await expect(
      resolveReview(
        { ...reviewDependencies(), reviews: createReviewStore(failing, context) },
        { scope: { ...scope, conversationId }, draftId, action: { kind: "APPROVE" }, reviewMode: "NORMAL" },
      ),
    ).rejects.toThrow("the ownership write failed");

    // Nothing of it survived: no delivery, no claim, no ownership. The decision is one write or none.
    expect(await infra.db.deliveryJobRecord.count({ where: { ...scope, draftId } })).toBe(0);
    const afterFailure = await infra.db.aiDraft.findUniqueOrThrow({ where: { workspaceId_businessProfileId_id: { ...scope, id: draftId } }, select: { status: true } });
    expect(afterFailure.status).toBe("PENDING");

    // And the person can simply click again.
    const operationId = scheduledOperation(await approve(conversationId, draftId));
    const { run, sends } = deliver(conversationId, operationId);
    await run();
    expect(sends).toHaveLength(1);
    expect(await statusOf(operationId)).toBe("SENT");
  }, 180_000);

  it("tells a colleague who clicks afterwards that it was already resolved", async () => {
    const { conversationId, messageId } = await freshConversation({ mode: "DRAFT" });
    const draftId = await pendingDraft(conversationId, messageId);

    const first = scheduledOperation(await approve(conversationId, draftId));
    const second = await approve(conversationId, draftId, {}, colleagueContext);

    // Not "scheduled": they did not decide this, and saying otherwise would report a send as theirs — and
    // for an edit, report wording as sent that was discarded. Exactly one logical send exists either way.
    expect(second).toEqual({ status: "ALREADY_RESOLVED" });
    expect(await infra.db.deliveryJobRecord.count({ where: { ...scope, draftId } })).toBe(1);
    const job = await infra.db.deliveryJobRecord.findUniqueOrThrow({ where: { operationId: first }, select: { approvedByUserId: true } });
    expect(job.approvedByUserId).toBe(approverId);
  }, 180_000);

  it("answers a retry of a decision that already committed with the same operation", async () => {
    const { conversationId, messageId } = await freshConversation({ mode: "DRAFT" });
    const draftId = await pendingDraft(conversationId, messageId);

    const first = scheduledOperation(await approve(conversationId, draftId));
    const again = await approve(conversationId, draftId);

    // The same person, the same decision: the same logical send, so it is named rather than refused.
    // Reporting a decision and committing it cannot disagree, whatever the network did to the first answer.
    expect(again).toMatchObject({ status: "SCHEDULED", operationId: first });
  }, 180_000);

  it("keeps automation automated: a delivery nobody approved reaches the adapter as such", async () => {
    const { conversationId, messageId } = await freshConversation({ mode: "AUTOPILOT" });
    const draftId = await pendingDraft(conversationId, messageId, { needsReview: false });
    const operationId = `op-automated-${String(seq)}`;
    await infra.db.deliveryJobRecord.create({
      data: { ...scope, draftId, operationId, correlationId: operationId, status: "SCHEDULED", scheduledFor: NOW, selectedDelayMs: 0 },
    });

    const { run, sends } = deliver(conversationId, operationId);
    await run();

    // Nothing in the worker can turn an unapproved delivery into an approved one: the authority is read
    // from the row, and this row has none.
    expect(sends).toHaveLength(1);
    expect(sends[0]?.authority).toEqual({ kind: "AUTOMATED" });
  }, 180_000);
});
