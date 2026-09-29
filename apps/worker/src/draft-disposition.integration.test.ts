/**
 * What the disposition offers a person when the standard window has closed (#16, ADR-014).
 *
 * The human-support exception is the only route out of a closed Instagram window, and it exists only
 * where Meta has approved *this app* for it. That approval is live configuration — no API reports it, and
 * nothing stores it — so the question this file asks is whether the disposition actually reads it, and
 * whether the answer changes what a person is offered.
 *
 * It matters because this decision runs long before any transport is consulted. While it answered
 * `UNAVAILABLE` unconditionally, a correctly built sender and a correctly granted approval could never
 * meet: review offered nothing, and the delivery was refused before the tagged path was reachable.
 */
import { noRetrieval } from "@omnichannel/application";
import {
  appendInboundMessage,
  authorizeBusinessProfileAccess,
  authorizeWorkspaceAccess,
  createAiDraftStore,
  createBusinessProfile,
  createChannelAccount,
  createContactWithChannelIdentity,
  createConversation,
  createWorkspaceWithOwner,
} from "@omnichannel/db";
import { NO_CAPABILITIES } from "@omnichannel/domain";
import type { HumanAgentApproval } from "@omnichannel/channel-instagram";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDraftDisposition } from "./draft-disposition";
import { createEndToEndInfrastructure, endToEndTestsEnabled, type EndToEndInfrastructure } from "./testing/infrastructure";

const NOW = new Date("2026-09-20T12:00:00.000Z");
/** Outside the 24-hour standard window, inside the 7-day human-support one. */
const AFTER_WINDOW = new Date(NOW.getTime() - 48 * 60 * 60 * 1000);
/** Inside the standard window and still inside the automated dispatch budget, so nothing else decides. */
const INSIDE_WINDOW = new Date(NOW.getTime() - 5_000);

describe.skipIf(!endToEndTestsEnabled())("what review is offered once the standard window has closed", () => {
  let infra: EndToEndInfrastructure;
  let scope: { workspaceId: string; businessProfileId: string };
  let context: Awaited<ReturnType<typeof authorizeBusinessProfileAccess>>;
  let channelAccountId: string;
  let seq = 0;

  beforeAll(async () => {
    infra = await createEndToEndInfrastructure();
    const user = await infra.db.user.create({ data: { name: "Window Owner", email: "window-owner@example.test" } });
    const { workspaceId } = await createWorkspaceWithOwner(infra.db, { name: "Window Workspace", ownerUserId: user.id });
    const workspace = await authorizeWorkspaceAccess(infra.db, { userId: user.id, workspaceId });
    const { businessProfileId } = await createBusinessProfile(infra.db, workspace, { name: "Window Profile" });
    context = await authorizeBusinessProfileAccess(infra.db, { userId: user.id, workspaceId, businessProfileId });
    scope = { workspaceId, businessProfileId };

    const account = await createChannelAccount(infra.db, context, {
      channel: "INSTAGRAM",
      externalAccountId: "ig-account-window",
      capabilities: { ...NO_CAPABILITIES, text: true },
    });
    channelAccountId = account.id;

    // The business opted into automation and into the human-support exception; without the second there
    // is no after-window route for anyone to take, approved app or not.
    await infra.db.automationPolicy.create({
      data: {
        ...scope,
        channelAccountId,
        mode: "AUTOPILOT",
        confidenceThreshold: 0.8,
        mandatoryReviewReasons: [],
        deliveryDelayMinMs: 1_000,
        deliveryDelayMaxMs: 2_000,
        instagramAfterWindowPolicy: "HUMAN_ASSISTED_EXTENDED",
      },
    });
  }, 180_000);

  afterAll(async () => {
    await infra?.dispose();
  });

  /** A conversation of its own per case, so one test's takeover cannot decide the next one's answer. */
  const conversationWith = async (lastInboundAt: Date): Promise<{ conversationId: string; draftId: string }> => {
    seq += 1;
    const identity = await createContactWithChannelIdentity(infra.db, context, { channelAccountId, externalUserId: `ig-user-window-${String(seq)}` });
    const conversation = await createConversation(infra.db, context, { channelAccountId, channelIdentityId: identity.channelIdentityId });
    const anchor = await appendInboundMessage(infra.db, context, {
      conversationId: conversation.id,
      kind: "TEXT",
      text: "Are you open on Saturday?",
      occurredAt: lastInboundAt,
    });
    const { aiDraftId } = await createAiDraftStore(infra.db).saveDraft({
      scope: { ...scope, conversationId: conversation.id },
      generationKey: `window_${String(seq)}`,
      trigger: "AUTOMATIC",
      anchorMessageId: anchor.id,
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
      provider: "fixture",
      model: "window",
      promptVersion: "reply.v1",
      schemaVersion: "ai-draft.v1",
    });
    return { conversationId: conversation.id, draftId: aiDraftId };
  };

  /** Composed with the live approval, exactly as the worker composes it from its environment. */
  const dispose = (humanAgentApproval?: HumanAgentApproval) =>
    createDraftDisposition({
      db: infra.db,
      producer: { scheduleDelivery: () => Promise.resolve({ jobId: "job" }) } as never,
      logger: infra.logger,
      now: () => NOW,
      random: () => 0.5,
      ...(humanAgentApproval === undefined ? {} : { humanAgentApproval }),
    });

  const takeoverOf = (conversationId: string) =>
    infra.db.conversation.findUniqueOrThrow({
      where: { workspaceId_businessProfileId_id: { ...scope, id: conversationId } },
      select: { takeoverState: true, takeoverReason: true, takeoverReviewMode: true },
    });

  it("offers the human-support path when the app is approved for it", async () => {
    const { conversationId, draftId } = await conversationWith(AFTER_WINDOW);

    const disposed = await dispose("APPROVED")({ ...scope, conversationId, draftId, correlationId: "corr-window-approved" });

    // Not a send, and not silence: a person is asked, and asked for the one kind of send that is still
    // permitted — which is what makes the tagged transport reachable at all.
    expect(disposed.status).toBe("REVIEW");
    expect(await takeoverOf(conversationId)).toMatchObject({
      takeoverState: "REVIEW_REQUIRED",
      takeoverReason: "HUMAN_AGENT_REVIEW",
      takeoverReviewMode: "HUMAN_AGENT",
    });
  }, 180_000);

  for (const approval of ["UNKNOWN", "NOT_APPROVED"] as const) {
    it(`does not offer it when the app's approval is ${approval}`, async () => {
      const { conversationId, draftId } = await conversationWith(AFTER_WINDOW);

      const disposed = await dispose(approval)({ ...scope, conversationId, draftId, correlationId: `corr-window-${approval}` });

      // Nothing about the conversation changed; the exception simply does not exist for this app, and a
      // review item offering a route that would be refused is worse than no review item.
      expect(disposed.status).not.toBe("SCHEDULED");
      expect(await takeoverOf(conversationId)).not.toMatchObject({ takeoverReviewMode: "HUMAN_AGENT" });
    }, 180_000);
  }

  it("treats an unconfigured deployment as unapproved", async () => {
    const { conversationId, draftId } = await conversationWith(AFTER_WINDOW);

    const disposed = await dispose()({ ...scope, conversationId, draftId, correlationId: "corr-window-default" });

    // Omitted is not "probably fine". The default has to be the closed one, because it is what a
    // deployment that never thought about this gets.
    expect(disposed.status).not.toBe("SCHEDULED");
    expect(await takeoverOf(conversationId)).not.toMatchObject({ takeoverReviewMode: "HUMAN_AGENT" });
  }, 180_000);

  it("still sends automatically while the standard window is open, approved or not", async () => {
    const { conversationId, draftId } = await conversationWith(INSIDE_WINDOW);

    const disposed = await dispose("APPROVED")({ ...scope, conversationId, draftId, correlationId: "corr-window-open" });

    // The exception is a way out of a closed window, never a reason to route an ordinary reply through a
    // person — or through the tagged transport.
    expect(disposed.status).toBe("SCHEDULED");
    expect(await takeoverOf(conversationId)).toMatchObject({ takeoverState: "NONE" });
  }, 180_000);
});
