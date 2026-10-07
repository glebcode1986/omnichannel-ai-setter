/**
 * The WhatsApp vertical slice, end to end (#24, P4-07).
 *
 * The claim worth proving is that WhatsApp has no route of its own. A customer message reaches a reply
 * through the same disposition, the same policy engine, the same delay engine, the same delivery
 * coordinator and the same claim that Instagram goes through — the channel changes only what happens
 * below the transport boundary, and which rules the window is judged by.
 *
 * So this drives the real pieces against real PostgreSQL and substitutes exactly two things a test cannot
 * have: the model, and Meta's HTTP endpoint. Every assertion is about durable state the system wrote.
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
  createCredentialCipher,
  scheduleAutomatedDelivery,
  writeChannelCredential,
} from "@omnichannel/db";
import { NO_CAPABILITIES } from "@omnichannel/domain";
import type { WhatsAppHttpPort, WhatsAppHttpResult } from "@omnichannel/channel-whatsapp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDeliveryEngine, deliverableChannels } from "./delivery-engine";
import { createPaidWorkspace } from "./testing/paid-workspace";
import { createDeliveryHandler } from "./delivery-handler";
import { createDraftDisposition } from "./draft-disposition";
import { createEndToEndInfrastructure, endToEndTestsEnabled, type EndToEndInfrastructure } from "./testing/infrastructure";

const NOW = new Date("2026-10-05T12:00:00.000Z");
/** Inside the 24-hour customer-service window. */
const INSIDE_WINDOW = new Date(NOW.getTime() - 60 * 60 * 1000);
/** Outside it: free-form is refused by Meta from here, and only an approved template may reach anyone. */
const OUTSIDE_WINDOW = new Date(NOW.getTime() - 36 * 60 * 60 * 1000);
const PHONE_NUMBER_ID = "wa-phone-slice";
const WABA_ID = "waba-slice";
const TOKEN = "EAAwa-slice-token-canary-4c81";
const CIPHER_KEY_ID = "test-key";
const CIPHER = createCredentialCipher({ keyId: CIPHER_KEY_ID, keys: { [CIPHER_KEY_ID]: Buffer.alloc(32, 4) } });

const env = {
  CHANNEL_CREDENTIAL_KEY_ID: CIPHER_KEY_ID,
  CHANNEL_CREDENTIAL_KEY: Buffer.alloc(32, 4).toString("base64"),
  WHATSAPP_APP_SECRET: "wa-app-secret",
  WHATSAPP_VERIFY_TOKEN: "wa-verify-token",
  INSTAGRAM_HUMAN_AGENT_APPROVAL: "NOT_APPROVED",
} as const;

let wire = 0;
const accepted = (): WhatsAppHttpResult => ({
  kind: "RESPONSE",
  status: 200,
  body: JSON.stringify({ messaging_product: "whatsapp", messages: [{ id: `wamid.slice-${String(++wire)}` }] }),
});

describe.skipIf(!endToEndTestsEnabled())("WhatsApp vertical slice (end to end)", () => {
  let infra: EndToEndInfrastructure;
  let scope: { workspaceId: string; businessProfileId: string };
  let context: Awaited<ReturnType<typeof authorizeBusinessProfileAccess>>;
  let channelAccountId: string;
  let seq = 0;

  beforeAll(async () => {
    infra = await createEndToEndInfrastructure();
    const user = await infra.db.user.create({ data: { name: "WA Slice", email: "wa-slice@example.test" } });
    const { workspaceId } = await createPaidWorkspace(infra.db, { name: "WA Slice Workspace", ownerUserId: user.id });
    const workspace = await authorizeWorkspaceAccess(infra.db, { userId: user.id, workspaceId });
    const { businessProfileId } = await createBusinessProfile(infra.db, workspace, { name: "WA Slice Profile" });
    context = await authorizeBusinessProfileAccess(infra.db, { userId: user.id, workspaceId, businessProfileId });
    scope = { workspaceId, businessProfileId };

    const account = await createChannelAccount(infra.db, context, {
      channel: "WHATSAPP",
      externalAccountId: PHONE_NUMBER_ID,
      capabilities: { ...NO_CAPABILITIES, text: true, readReceipts: true, typingIndicator: true, nativeOutboundVisible: true },
    });
    channelAccountId = account.id;
    await infra.db.whatsAppConnection.create({
      data: {
        ...scope,
        channelAccountId,
        wabaId: WABA_ID,
        connectedAt: NOW,
        phoneRegisteredAt: NOW,
        webhookSubscribedAt: NOW,
        onboardingMode: "COEXISTENCE_EXISTING_BUSINESS_APP",
      },
    });
    const { credentialId } = await writeChannelCredential(infra.db, CIPHER, {
      workspaceId,
      purpose: "WHATSAPP_BUSINESS_TOKEN",
      token: TOKEN,
      expiresAt: new Date(NOW.getTime() + 60 * 24 * 60 * 60 * 1000),
    });
    await infra.db.channelAccount.update({ where: { id: channelAccountId }, data: { credentialId, status: "CONNECTED" } });
    await infra.db.automationPolicy.create({
      data: { ...scope, mode: "AUTOPILOT", confidenceThreshold: 0.8, mandatoryReviewReasons: [], deliveryDelayMinMs: 1_000, deliveryDelayMaxMs: 2_000 },
    });
  }, 180_000);

  afterAll(async () => {
    await infra?.dispose();
  });

  beforeEach(() => {
    infra.logs.length = 0;
  });

  function scriptedHttp(results: readonly WhatsAppHttpResult[]) {
    const requests: Parameters<WhatsAppHttpPort["send"]>[0][] = [];
    let index = 0;
    const port: WhatsAppHttpPort = {
      send(request) {
        requests.push(request);
        return Promise.resolve(results[Math.min(index++, results.length - 1)] ?? { kind: "NO_RESPONSE", reason: "NETWORK", message: "script exhausted" });
      },
    };
    return { port, requests };
  }

  /** A customer, a conversation and a draft, exactly as ingestion and the draft engine leave them. */
  async function conversationWithDraft(lastInboundAt: Date): Promise<{ conversationId: string; draftId: string }> {
    seq += 1;
    const identity = await createContactWithChannelIdentity(infra.db, context, { channelAccountId, externalUserId: `wa-customer-${String(seq)}` });
    const conversation = await createConversation(infra.db, context, { channelAccountId, channelIdentityId: identity.channelIdentityId });
    const anchor = await appendInboundMessage(infra.db, context, {
      conversationId: conversation.id,
      channelMessageId: `wamid.in-${String(seq)}`,
      kind: "TEXT",
      text: "Are you open on Saturday?",
      occurredAt: lastInboundAt,
    });
    const { aiDraftId } = await createAiDraftStore(infra.db).saveDraft({
      scope: { ...scope, conversationId: conversation.id },
      generationKey: `wa_slice_${String(seq)}`,
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
      model: "wa-slice",
      promptVersion: "reply.v1",
      schemaVersion: "ai-draft.v1",
    });
    return { conversationId: conversation.id, draftId: aiDraftId };
  }

  const dispose = () =>
    createDraftDisposition({
      db: infra.db,
      producer: { scheduleDelivery: () => Promise.resolve({ jobId: "job" }), schedulePresence: () => Promise.resolve({ jobId: "presence" }) } as never,
      logger: infra.logger,
      now: () => NOW,
      random: () => 0.5,
      humanAgentApproval: "NOT_APPROVED",
      presence: { typingTtlMs: 25_000, deliverableChannels: deliverableChannels(env) },
    });

  const deliver = (results: readonly WhatsAppHttpResult[]) => {
    const http = scriptedHttp(results);
    const handler = createDeliveryHandler({
      engine: createDeliveryEngine(env, infra.db, infra.logger, { whatsappHttp: http.port, now: () => NOW }),
      logger: infra.logger,
    });
    return { handler, requests: http.requests };
  };

  const schedule = async (draftId: string) =>
    scheduleAutomatedDelivery(infra.db, { ...scope, draftId, correlationId: `corr-wa-${String(seq)}`, delayMs: 0, now: NOW });

  const jobFor = (operationId: string, conversationId: string, draftId: string) => ({
    schemaVersion: 1 as const,
    ...scope,
    correlationId: `corr-wa-${String(seq)}`,
    conversationId,
    draftId,
    deliveryJobId: operationId,
    operationId,
    scheduledFor: NOW.toISOString(),
    selectedDelayMs: 0,
  });

  describe("a reply inside the customer-service window", () => {
    it("goes out through the Cloud API and is recorded as sent", async () => {
      const { conversationId, draftId } = await conversationWithDraft(INSIDE_WINDOW);
      const { operationId } = await schedule(draftId);
      const sending = deliver([accepted()]);

      await sending.handler(jobFor(operationId, conversationId, draftId));

      expect(sending.requests).toHaveLength(1);
      expect(sending.requests[0]?.url).toContain(`/${PHONE_NUMBER_ID}/messages`);
      expect(JSON.parse(sending.requests[0]?.body ?? "{}")).toMatchObject({ messaging_product: "whatsapp", type: "text" });
      const job = await infra.db.deliveryJobRecord.findUniqueOrThrow({ where: { operationId } });
      expect(job).toMatchObject({ status: "SENT" });
      expect(job.platformMessageId).toMatch(/^wamid\.slice-/u);
      // The outbound message exists, attributed to the assistant and tied to the operation.
      expect(await infra.db.message.findFirstOrThrow({ where: { operationId } })).toMatchObject({ direction: "OUT", source: "AI", deliveryStatus: "SENT" });
    });

    it("schedules through the shared disposition, with a delay the delay engine chose", async () => {
      const { conversationId, draftId } = await conversationWithDraft(INSIDE_WINDOW);

      const disposed = await dispose()({ ...scope, conversationId, draftId, correlationId: `corr-wa-disp-${String(seq)}` });

      expect(disposed).toMatchObject({ status: "SCHEDULED" });
      // Instagram's automated-dispatch budget does not apply here: WhatsApp publishes no such deadline,
      // and applying one would shorten the human-like delay for a rule that platform does not impose.
      expect(disposed.status === "SCHEDULED" ? disposed.delayMs : 0).toBeGreaterThanOrEqual(1_000);
    });
  });

  describe("a reply once the window has closed", () => {
    it("is held for a person rather than sent free-form", async () => {
      const { conversationId, draftId } = await conversationWithDraft(OUTSIDE_WINDOW);

      const disposed = await dispose()({ ...scope, conversationId, draftId, correlationId: `corr-wa-closed-${String(seq)}` });

      // ADR-016's default is SERVICE_WINDOW_ONLY, so automation stops until the customer writes again.
      // The conversation is not "not eligible" — a template could still reach them — but choosing to send
      // one is a decision the draft engine does not make today.
      expect(disposed.status).not.toBe("SCHEDULED");
    });

    it("is refused by the coordinator even if a job for it reaches the worker", async () => {
      const { conversationId, draftId } = await conversationWithDraft(OUTSIDE_WINDOW);
      const { operationId } = await schedule(draftId);
      const sending = deliver([accepted()]);

      await sending.handler(jobFor(operationId, conversationId, draftId));

      // Nothing was dispatched: the window gate runs before the transport is ever consulted.
      expect(sending.requests).toEqual([]);
      expect((await infra.db.deliveryJobRecord.findUniqueOrThrow({ where: { operationId } })).status).not.toBe("SENT");
    });
  });

  describe("what stops a reply that was already scheduled", () => {
    it("a newer customer message supersedes it", async () => {
      const { conversationId, draftId } = await conversationWithDraft(INSIDE_WINDOW);
      const { operationId } = await schedule(draftId);
      await appendInboundMessage(infra.db, context, {
        conversationId,
        channelMessageId: `wamid.newer-${String(seq)}`,
        kind: "TEXT",
        text: "Actually, never mind.",
        occurredAt: new Date(NOW.getTime() + 1_000),
      });
      const sending = deliver([accepted()]);

      await sending.handler(jobFor(operationId, conversationId, draftId));

      expect(sending.requests).toEqual([]);
      expect((await infra.db.deliveryJobRecord.findUniqueOrThrow({ where: { operationId } })).status).toBe("CANCELLED_SUPERSEDED");
    });

    it("a person taking the conversation over cancels it", async () => {
      const { conversationId, draftId } = await conversationWithDraft(INSIDE_WINDOW);
      const { operationId } = await schedule(draftId);
      await infra.db.conversation.update({
        where: { id: conversationId },
        data: {
          takeoverState: "HUMAN_ACTIVE",
          takeoverReason: "UNMATCHED_OUTBOUND_ECHO",
          takeoverActorKind: "NATIVE_APP",
          humanTakeoverAt: NOW,
          takeoverPausedUntil: new Date(NOW.getTime() + 6 * 60 * 60 * 1000),
        },
      });
      const sending = deliver([accepted()]);

      await sending.handler(jobFor(operationId, conversationId, draftId));

      // The native-send takeover from #23 reaches the send through the shared gate, not a WhatsApp path.
      expect(sending.requests).toEqual([]);
      expect((await infra.db.deliveryJobRecord.findUniqueOrThrow({ where: { operationId } })).status).toBe("CANCELLED_HUMAN_TAKEOVER");
    });

    it("an operator's kill switch holds it", async () => {
      const { conversationId, draftId } = await conversationWithDraft(INSIDE_WINDOW);
      const { operationId } = await schedule(draftId);
      const user = await infra.db.user.findFirstOrThrow({ select: { id: true } });
      await infra.db.automationSuspension.create({
        data: { scope: "WORKSPACE", workspaceId: scope.workspaceId, reason: "OPERATOR", since: NOW, byUserId: user.id },
      });
      const sending = deliver([accepted()]);

      await sending.handler(jobFor(operationId, conversationId, draftId));
      await infra.db.automationSuspension.updateMany({ where: { liftedAt: null }, data: { liftedAt: NOW, liftedByUserId: user.id } });

      expect(sending.requests).toEqual([]);
      expect((await infra.db.deliveryJobRecord.findUniqueOrThrow({ where: { operationId } })).status).toBe("HELD_REVIEW");
    });
  });

  describe("what the provider answers", () => {
    it("records a definite rejection without retrying it", async () => {
      const { conversationId, draftId } = await conversationWithDraft(INSIDE_WINDOW);
      const { operationId } = await schedule(draftId);
      const sending = deliver([
        { kind: "RESPONSE", status: 400, body: JSON.stringify({ error: { code: 131047, message: "re-engagement message" } }) },
      ]);

      await sending.handler(jobFor(operationId, conversationId, draftId));

      const job = await infra.db.deliveryJobRecord.findUniqueOrThrow({ where: { operationId } });
      expect(job.status).not.toBe("SENT");
      expect(job.lastErrorCode).toContain("131047");
      // Nothing was stored as sent, so a later reader cannot believe a customer received it.
      expect(await infra.db.message.findFirst({ where: { operationId } })).toBeNull();
    });

    it("quarantines an ambiguous network outcome instead of sending again", async () => {
      const { conversationId, draftId } = await conversationWithDraft(INSIDE_WINDOW);
      const { operationId } = await schedule(draftId);
      const sending = deliver([{ kind: "NO_RESPONSE", reason: "TIMEOUT", message: "timed out" }]);

      await sending.handler(jobFor(operationId, conversationId, draftId));

      // The request may have reached Meta. Retrying would send a customer the same reply twice, and a
      // second one cannot be taken back (ADR-012).
      expect((await infra.db.deliveryJobRecord.findUniqueOrThrow({ where: { operationId } })).status).toBe("HELD_AMBIGUOUS");
    });

    it("refuses a send on an account whose token was revoked, having tried nothing", async () => {
      const { conversationId, draftId } = await conversationWithDraft(INSIDE_WINDOW);
      const { operationId } = await schedule(draftId);
      await infra.db.channelCredential.updateMany({
        where: { workspaceId: scope.workspaceId, purpose: "WHATSAPP_BUSINESS_TOKEN" },
        data: { revokedAt: new Date() },
      });
      const sending = deliver([accepted()]);

      await sending.handler(jobFor(operationId, conversationId, draftId));
      await infra.db.channelCredential.updateMany({ where: { workspaceId: scope.workspaceId, purpose: "WHATSAPP_BUSINESS_TOKEN" }, data: { revokedAt: null } });

      expect(sending.requests).toEqual([]);
      expect((await infra.db.deliveryJobRecord.findUniqueOrThrow({ where: { operationId } })).status).not.toBe("SENT");
    });
  });

  describe("the same job twice", () => {
    it("sends once, however many times the queue delivers it", async () => {
      const { conversationId, draftId } = await conversationWithDraft(INSIDE_WINDOW);
      const { operationId } = await schedule(draftId);
      const sending = deliver([accepted(), accepted()]);
      const job = jobFor(operationId, conversationId, draftId);

      await sending.handler(job);
      await sending.handler(job);

      // The claim is the single winner: `status = SCHEDULED` is the only claimable state, and the second
      // run finds the operation already settled.
      expect(sending.requests).toHaveLength(1);
      expect(await infra.db.message.count({ where: { operationId } })).toBe(1);
    });
  });

  describe("what this deployment can deliver on", () => {
    it("names WhatsApp once its transport is configured", () => {
      expect([...deliverableChannels(env)].sort()).toEqual(["WHATSAPP"]);
      // And nothing when the key that decrypts every token is missing, whatever else is set.
      expect([...deliverableChannels({ ...env, CHANNEL_CREDENTIAL_KEY_ID: undefined })]).toEqual([]);
    });
  });

  describe("what reaches the log", () => {
    it("never carries the access token or the customer's words", async () => {
      const { conversationId, draftId } = await conversationWithDraft(INSIDE_WINDOW);
      const { operationId } = await schedule(draftId);
      const sending = deliver([accepted()]);

      await sending.handler(jobFor(operationId, conversationId, draftId));

      const serialized = JSON.stringify(infra.logs);
      expect(serialized).not.toContain(TOKEN);
      expect(serialized).not.toContain("Are you open on Saturday?");
      expect(serialized).not.toContain("10:00 to 18:00");
    });
  });
});
