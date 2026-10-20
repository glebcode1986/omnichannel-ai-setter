/**
 * What the customer is told while a reply is being written (#22, P4-05).
 *
 * The presence job was queued when the reply was, up to two minutes earlier, and a conversation does not
 * wait. So every case here moves the state *after* scheduling and asks what the announcement does about
 * it: a cancelled delivery, a newer customer message, a colleague taking over, the business switching
 * automation off, an operator's kill switch. Each must be silence, because a typing indicator is a promise
 * that a reply is coming.
 *
 * Run against a real database because the facts being judged are rows, and because the judgement is the
 * delivery coordinator's own — a fake store would be asserting that this file calls a function, which is
 * not the claim worth proving.
 */
import { noRetrieval, type PresenceAnnouncer } from "@omnichannel/application";
import {
  appendInboundMessage,
  authorizeBusinessProfileAccess,
  authorizeWorkspaceAccess,
  createAiDraftStore,
  createBusinessProfile,
  createChannelAccount,
  createContactWithChannelIdentity,
  createConversation,
  createPresenceStore,
  createWorkspaceWithOwner,
  scheduleAutomatedDelivery,
} from "@omnichannel/db";
import { NO_CAPABILITIES } from "@omnichannel/domain";
import type { PresenceJob } from "@omnichannel/queue";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createChannelStateResolver } from "./delivery-policy";
import { createPresenceHandler } from "./presence-handler";
import { createEndToEndInfrastructure, endToEndTestsEnabled, type EndToEndInfrastructure } from "./testing/infrastructure";

const NOW = new Date("2026-10-05T12:00:00.000Z");
const MARK_READ_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Distinctive, so a log line that leaked the customer's message id would be unmistakable. */
const WAMID_PREFIX = "wamid.canary-presence-";

describe.skipIf(!endToEndTestsEnabled())("announcing presence before a reply", () => {
  let infra: EndToEndInfrastructure;
  let scope: { workspaceId: string; businessProfileId: string };
  let context: Awaited<ReturnType<typeof authorizeBusinessProfileAccess>>;
  let channelAccountId: string;
  let seq = 0;

  beforeAll(async () => {
    infra = await createEndToEndInfrastructure();
    const user = await infra.db.user.create({ data: { name: "Presence Owner", email: "presence-owner@example.test" } });
    const { workspaceId } = await createWorkspaceWithOwner(infra.db, { name: "Presence Workspace", ownerUserId: user.id });
    const workspace = await authorizeWorkspaceAccess(infra.db, { userId: user.id, workspaceId });
    const { businessProfileId } = await createBusinessProfile(infra.db, workspace, { name: "Presence Profile" });
    context = await authorizeBusinessProfileAccess(infra.db, { userId: user.id, workspaceId, businessProfileId });
    scope = { workspaceId, businessProfileId };

    const account = await createChannelAccount(infra.db, context, {
      channel: "WHATSAPP",
      externalAccountId: "wa-phone-presence",
      // The capabilities onboarding records. Presence reads these rather than the channel's name.
      capabilities: { ...NO_CAPABILITIES, text: true, readReceipts: true, typingIndicator: true },
    });
    channelAccountId = account.id;
    // The profile default already exists: the accepted P3-02 head makes `createBusinessProfile` write it
    // alongside the profile itself, from the domain's own `profileDefaultPolicyWrite()`. So this edits that
    // row rather than inventing a second one — a hand-written create violates
    // `automation_policies_profile_default_key`.
    await infra.db.automationPolicy.updateMany({
      where: { ...scope, channelAccountId: null },
      data: { mode: "AUTOPILOT", confidenceThreshold: 0.8, mandatoryReviewReasons: [], presenceMode: "READ_AND_TYPING", presenceTypingLeadMs: 8_000 },
    });
  }, 180_000);

  afterAll(async () => {
    await infra?.dispose();
  });

  beforeEach(() => {
    infra.logs.length = 0;
  });

  /** A conversation with a customer message and a reply already scheduled, as the disposition leaves one. */
  async function scheduledReply(): Promise<{ conversationId: string; operationId: string; wamid: string; anchorId: string }> {
    seq += 1;
    const identity = await createContactWithChannelIdentity(infra.db, context, { channelAccountId, externalUserId: `wa-user-presence-${String(seq)}` });
    const conversation = await createConversation(infra.db, context, { channelAccountId, channelIdentityId: identity.channelIdentityId });
    const wamid = `${WAMID_PREFIX}${String(seq)}`;
    const anchor = await appendInboundMessage(infra.db, context, {
      conversationId: conversation.id,
      channelMessageId: wamid,
      kind: "TEXT",
      text: "Are you open on Saturday?",
      occurredAt: NOW,
    });
    const { aiDraftId } = await createAiDraftStore(infra.db).saveDraft({
      scope: { ...scope, conversationId: conversation.id },
      generationKey: `presence_${String(seq)}`,
      trigger: "AUTOMATIC",
      anchorMessageId: anchor.id,
      anchorStateVersion: 1,
      text: "Yes — 10:00 to 18:00.",
      structuredOutput: { reply: "Yes" },
      confidence: 0.95,
      modelSuggestsSend: true,
      needsReview: false,
      reasonCodes: [],
      factualSourceIds: [],
      retrieval: noRetrieval("OK"),
      status: "PENDING",
      provider: "fixture",
      model: "presence",
      promptVersion: "reply.v1",
      schemaVersion: "ai-draft.v1",
    });
    const { operationId } = await scheduleAutomatedDelivery(infra.db, {
      ...scope,
      draftId: aiDraftId,
      correlationId: `corr-presence-${String(seq)}`,
      delayMs: 60_000,
      now: NOW,
    });
    return { conversationId: conversation.id, operationId, wamid, anchorId: anchor.id };
  }

  const job = (reply: { conversationId: string; operationId: string }): PresenceJob => ({
    schemaVersion: 1,
    ...scope,
    correlationId: `corr-presence-${String(seq)}`,
    channelAccountId,
    conversationId: reply.conversationId,
    operationId: reply.operationId,
    typing: true,
  });

  /** Records what it was asked to announce, and can be told to fail the way a provider does. */
  function announcer(outcome: boolean | Error = true) {
    const calls: Parameters<PresenceAnnouncer["announce"]>[0][] = [];
    const port: PresenceAnnouncer = {
      announce(input) {
        calls.push(input);
        return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
      },
    };
    return { port, calls };
  }

  const handler = (port?: PresenceAnnouncer) =>
    createPresenceHandler({
      store: createPresenceStore(infra.db),
      ...(port === undefined ? {} : { announcer: port }),
      channel: createChannelStateResolver(() => new Date(NOW.getTime() + 52_000), "NOT_APPROVED"),
      markReadMaxAgeMs: MARK_READ_MAX_AGE_MS,
      logger: infra.logger,
      // Fired 52 s into the 60 s delay, which is where the plan put it.
      now: () => new Date(NOW.getTime() + 52_000),
    });

  const skipped = () => infra.logs.find((line) => line.event === "worker.presence_skipped");

  describe("a reply that is still going out", () => {
    it("marks the customer's own latest message read and shows the indicator", async () => {
      const reply = await scheduledReply();
      const port = announcer();

      await handler(port.port)(job(reply));

      expect(port.calls).toEqual([{ ...scope, channelAccountId, inboundProviderMessageId: reply.wamid, typing: true }]);
      expect(infra.logs.find((line) => line.event === "worker.presence_announced")).toMatchObject({ typing: true, announced: true });
    });

    it("marks the newest customer message, not the one the draft answered", async () => {
      // The provider marks earlier messages in the conversation read along with it, so the newest covers
      // the whole burst in one call — and a burst is the normal case this product debounces around.
      const reply = await scheduledReply();
      const newest = `${WAMID_PREFIX}newest-${String(seq)}`;
      await appendInboundMessage(infra.db, context, {
        conversationId: reply.conversationId,
        channelMessageId: newest,
        kind: "TEXT",
        text: "Sorry, I meant Sunday.",
        // Before the anchor, so this does not supersede the reply; only its recency is under test.
        occurredAt: new Date(NOW.getTime() - 1_000),
      });
      const port = announcer();

      await handler(port.port)(job(reply));

      expect(port.calls[0]?.inboundProviderMessageId).toBe(reply.wamid);
    });
  });

  describe("a reply that will not go out after all", () => {
    it("says nothing once the delivery was cancelled", async () => {
      const reply = await scheduledReply();
      await infra.db.deliveryJobRecord.update({
        where: { operationId: reply.operationId },
        data: { status: "CANCELLED_HUMAN_TAKEOVER", cancelledAt: NOW, cancelReason: "HUMAN_CANCELLED_FROM_INBOX" },
      });
      const port = announcer();

      await handler(port.port)(job(reply));

      expect(port.calls).toEqual([]);
      expect(skipped()).toMatchObject({ reason: "DELIVERY_NOT_SCHEDULED" });
    });

    it("says nothing once the customer has written again", async () => {
      const reply = await scheduledReply();
      await appendInboundMessage(infra.db, context, {
        conversationId: reply.conversationId,
        channelMessageId: `${WAMID_PREFIX}newer-${String(seq)}`,
        kind: "TEXT",
        text: "Actually, never mind.",
        occurredAt: new Date(NOW.getTime() + 10_000),
      });
      const port = announcer();

      await handler(port.port)(job(reply));

      // The reply will be cancelled as superseded when it comes due. Typing for it would be a promise
      // this product has already decided not to keep.
      expect(port.calls).toEqual([]);
      expect(skipped()).toMatchObject({ reason: "SEND_NO_LONGER_APPROVED" });
    });

    it("says nothing once a person has taken the conversation over", async () => {
      const reply = await scheduledReply();
      await infra.db.conversation.update({
        where: { id: reply.conversationId },
        data: {
          takeoverState: "HUMAN_ACTIVE",
          takeoverReason: "HUMAN_CLAIMED",
          takeoverActorKind: "USER",
          takeoverActorUserId: (await infra.db.user.findFirstOrThrow({ select: { id: true } })).id,
          humanTakeoverAt: NOW,
          takeoverPausedUntil: new Date(NOW.getTime() + 6 * 60 * 60 * 1000),
        },
      });
      const port = announcer();

      await handler(port.port)(job(reply));

      expect(port.calls).toEqual([]);
      expect(skipped()).toMatchObject({ reason: "SEND_NO_LONGER_APPROVED" });
    });

    it("says nothing once the thread's automation is switched off", async () => {
      const reply = await scheduledReply();
      await infra.db.conversation.update({ where: { id: reply.conversationId }, data: { modeOverride: "OFF" } });
      const port = announcer();

      await handler(port.port)(job(reply));

      expect(port.calls).toEqual([]);
      expect(skipped()).toMatchObject({ reason: "SEND_NO_LONGER_APPROVED" });
    });

    it("says nothing for a delivery that no longer exists", async () => {
      const port = announcer();

      await handler(port.port)({ ...job({ conversationId: "conv-gone", operationId: "op-gone" }) });

      expect(port.calls).toEqual([]);
      expect(skipped()).toMatchObject({ reason: "DELIVERY_NOT_SCHEDULED" });
    });
  });

  describe("the business's own setting", () => {
    it("announces only a read receipt when the business did not ask for typing", async () => {
      const reply = await scheduledReply();
      await infra.db.automationPolicy.updateMany({ where: { ...scope, channelAccountId: null }, data: { presenceMode: "READ_ON_RECEIPT" } });
      const port = announcer();

      await handler(port.port)(job(reply));
      await infra.db.automationPolicy.updateMany({ where: { ...scope, channelAccountId: null }, data: { presenceMode: "READ_AND_TYPING" } });

      // The job was planned with typing; what is still true wins over what was planned.
      expect(port.calls[0]).toMatchObject({ typing: false });
    });

    it("says nothing at all once the business switches presence off", async () => {
      const reply = await scheduledReply();
      await infra.db.automationPolicy.updateMany({ where: { ...scope, channelAccountId: null }, data: { presenceMode: "OFF" } });
      const port = announcer();

      await handler(port.port)(job(reply));
      await infra.db.automationPolicy.updateMany({ where: { ...scope, channelAccountId: null }, data: { presenceMode: "READ_AND_TYPING" } });

      expect(port.calls).toEqual([]);
      expect(skipped()).toMatchObject({ reason: "MODE_OFF" });
    });

    it("drops the indicator on an account whose capabilities do not carry one", async () => {
      const reply = await scheduledReply();
      await infra.db.channelAccount.update({
        where: { id: channelAccountId },
        data: { capabilities: { ...NO_CAPABILITIES, text: true, readReceipts: true, typingIndicator: false } },
      });
      const port = announcer();

      await handler(port.port)(job(reply));
      await infra.db.channelAccount.update({
        where: { id: channelAccountId },
        data: { capabilities: { ...NO_CAPABILITIES, text: true, readReceipts: true, typingIndicator: true } },
      });

      expect(port.calls[0]).toMatchObject({ typing: false });
    });
  });

  describe("when the announcement itself fails", () => {
    it("reports a refusal and changes nothing about the reply", async () => {
      const reply = await scheduledReply();
      const port = announcer(false);

      await expect(handler(port.port)(job(reply))).resolves.toBeUndefined();

      // Still scheduled, still unclaimed: a cosmetic effect never touches a delivery.
      expect(await infra.db.deliveryJobRecord.findUniqueOrThrow({ where: { operationId: reply.operationId } })).toMatchObject({
        status: "SCHEDULED",
        attemptCount: 0,
        claimedAt: null,
      });
      expect(infra.logs.find((line) => line.event === "worker.presence_announced")).toMatchObject({ announced: false });
    });

    it("absorbs an announcer that throws, because one attempt is all this job gets", async () => {
      const reply = await scheduledReply();
      const port = announcer(new Error("provider exploded"));

      // Never rethrown: the family allows one attempt, and a retry a minute later would raise a typing
      // indicator after the message had already arrived.
      await expect(handler(port.port)(job(reply))).resolves.toBeUndefined();
      expect(infra.logs.find((line) => line.event === "worker.presence_failed")).toMatchObject({ errorName: "Error" });
      expect(await infra.db.deliveryJobRecord.findUniqueOrThrow({ where: { operationId: reply.operationId } })).toMatchObject({ status: "SCHEDULED" });
    });

    it("declines by name when this deployment has no announcer at all", async () => {
      const reply = await scheduledReply();

      await handler()(job(reply));

      expect(skipped()).toMatchObject({ reason: "NO_ANNOUNCER" });
    });
  });

  describe("another Workspace's reply", () => {
    it("is not announced on, however well-formed the job is", async () => {
      const reply = await scheduledReply();
      const port = announcer();

      // `operation_id` is globally unique, so a lookup by it alone answers for whichever tenant owns it.
      // The workspace on the job is the whole of what stands between one tenant and another tenant's
      // customer being told that somebody is typing a reply to them.
      await handler(port.port)({ ...job(reply), workspaceId: "00000000-0000-7000-8000-000000000000" });

      expect(port.calls).toEqual([]);
    });
  });

  describe("what reaches the log", () => {
    it("never carries the customer's words or the message id the provider was given", async () => {
      const reply = await scheduledReply();
      const port = announcer();

      await handler(port.port)(job(reply));

      const serialized = JSON.stringify(infra.logs);
      expect(serialized).not.toContain("Are you open on Saturday?");
      expect(serialized).not.toContain("10:00 to 18:00");
      // A wamid is enough to mark another conversation's message read for the next 30 days.
      expect(serialized).not.toContain(WAMID_PREFIX);
    });
  });
});
