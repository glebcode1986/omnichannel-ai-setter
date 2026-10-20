/**
 * Who sent it, and what follows (#23, P4-06).
 *
 * Coexistence means a business keeps answering customers from the WhatsApp Business App while this product
 * answers from the Cloud API. Meta publishes those native sends on `smb_message_echoes` — and publishes
 * nothing that says who typed them, on which of the up to four linked devices, or whether it was this
 * product itself. So authorship is not read from a payload; it is *correlated*, by matching the message id
 * against this product's own sends.
 *
 * Which makes the direction of the remaining doubt the thing worth testing. A native reply missed means
 * the assistant drafts over a colleague who is already handling the conversation, which is the one failure
 * human takeover exists to prevent. Our own send mistaken for a colleague means an unnecessary pause a
 * person can undo. These are not symmetric, and the tests below pin the behaviour to the safe side.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAccountLifecycle, OFFBOARDED_HEALTH_REASON } from "./whatsapp-lifecycle-store";
import { createDeliveryStore, scheduleAutomatedDelivery } from "./delivery-store";
import { createIngestionStore } from "./ingestion-store";
import { createAiDraftStore } from "./ai-draft-store";
import { noRetrieval } from "@omnichannel/application";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { seedWorkspace, type SeededProfile } from "./testing/fixtures";

const NOW = new Date("2026-10-05T12:00:00.000Z");
const WABA_ID = "waba-coexistence-1";

describe.skipIf(!databaseTestsEnabled())("coexistence authorship and account lifecycle (PostgreSQL)", () => {
  let database: TestDatabase;
  let profile: SeededProfile;
  let sequence = 0;
  const db = () => database.db;
  const unique = (prefix: string) => `${prefix}-${++sequence}`;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    [profile] = (await seedWorkspace(database.db, "coexistence")).profiles as [SeededProfile];
    await database.db.whatsAppConnection.create({
      data: {
        workspaceId: profile.context.workspaceId,
        businessProfileId: profile.businessProfileId,
        channelAccountId: profile.channelAccount.id,
        wabaId: WABA_ID,
        connectedAt: NOW,
        phoneRegisteredAt: NOW,
        webhookSubscribedAt: NOW,
        onboardingMode: "COEXISTENCE_EXISTING_BUSINESS_APP",
      },
    });
  }, 120_000);

  afterAll(async () => {
    await database?.dispose();
  });

  beforeEach(async () => {
    await db().channelAccount.update({ where: { id: profile.channelAccount.id }, data: { status: "CONNECTED" } });
    await db().whatsAppConnection.updateMany({ where: { wabaId: WABA_ID }, data: { healthReason: null } });
  });

  const scope = () => ({ workspaceId: profile.context.workspaceId, businessProfileId: profile.businessProfileId });
  const store = () => createIngestionStore(db());

  describe("whether a message with this id was sent by us", () => {
    const ask = (platformMessageId: string) =>
      db().$transaction(async () =>
        store().transaction(async (tx) =>
          tx.isAppOriginatedMessage({ ...scope(), channelAccountId: profile.channelAccount.id, platformMessageId }),
        ),
      );

    it("says no for an id nothing of ours carries", async () => {
      // The native send: a colleague answered from the app, and nothing here has a record of it.
      expect(await ask(unique("wamid.native"))).toBe(false);
    });

    it("says yes for a reply this product sent through its own API", async () => {
      const wamid = unique("wamid.ours");
      await db().message.create({
        data: {
          ...scope(),
          channelAccountId: profile.channelAccount.id,
          conversationId: profile.conversationId,
          channelMessageId: wamid,
          direction: "OUT",
          source: "AI",
          kind: "TEXT",
          occurredAt: NOW,
          deliveryStatus: "SENT",
          operationId: unique("op"),
        },
      });

      expect(await ask(wamid)).toBe(true);
    });

    it("says yes for a reply a person composed in the Inbox, which has no draft to reach through", async () => {
      // The defect this covers: the fallback filtered through `draft.conversation`, and a human-composed
      // delivery has no draft (ADR-018 Option B). Its echo was therefore read as somebody replying from
      // the provider's own app, and the conversation was taken over on the strength of our own send.
      const wamid = unique("wamid.composed");
      const user = await db().user.findFirstOrThrow({ select: { id: true } });
      await db().deliveryJobRecord.create({
        data: {
          ...scope(),
          conversationId: profile.conversationId,
          humanText: "On my way.",
          composedByUserId: user.id,
          operationId: unique("op"),
          correlationId: unique("corr"),
          status: "SENT",
          scheduledFor: NOW,
          sentAt: NOW,
          selectedDelayMs: 0,
          platformMessageId: wamid,
          authority: "HUMAN_APPROVED",
          approvedByUserId: user.id,
          approvedAt: NOW,
          approvedReviewMode: "NORMAL",
          // A human-approved delivery names the decision it came from; the CHECK insists on all four.
          decisionKey: unique("decision"),
        },
      });

      expect(await ask(wamid)).toBe(true);
    });

    it("says no for another Workspace's send carrying the same id", async () => {
      const wamid = unique("wamid.foreign");
      const [other] = (await seedWorkspace(db(), unique("coexistence-other"))).profiles as [SeededProfile];
      await db().message.create({
        data: {
          workspaceId: other.context.workspaceId,
          businessProfileId: other.businessProfileId,
          channelAccountId: other.channelAccount.id,
          conversationId: other.conversationId,
          channelMessageId: wamid,
          direction: "OUT",
          source: "AI",
          kind: "TEXT",
          occurredAt: NOW,
          deliveryStatus: "SENT",
          operationId: unique("op"),
        },
      });

      // A platform id is unique per channel account, not globally. Matching on it alone across tenants
      // would let one business's send suppress another's takeover.
      expect(await ask(wamid)).toBe(false);
    });
  });

  describe("when the provider echoes our send before we have recorded it", () => {
    it("settles the send and takes the message back, rather than aborting on the id it already holds", async () => {
      // The window is real and nothing closes it: the send returns a platform id, and the row carrying it
      // is written afterwards, in a separate transaction. A webhook arriving in between inserts that id
      // first — as a human's message, because nothing yet says it was ours.
      const wamid = unique("wamid.race");
      const { aiDraftId } = await createAiDraftStore(db()).saveDraft({
        scope: { ...scope(), conversationId: profile.conversationId },
        generationKey: unique("gen"),
        trigger: "AUTOMATIC",
        anchorMessageId: profile.messageId,
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
        model: "coexistence",
        promptVersion: "reply.v1",
        schemaVersion: "ai-draft.v1",
      });
      const { operationId } = await scheduleAutomatedDelivery(db(), { ...scope(), draftId: aiDraftId, correlationId: unique("corr"), delayMs: 0, now: NOW });
      await db().deliveryJobRecord.update({ where: { operationId }, data: { status: "SENDING", claimedAt: NOW } });
      // The echo wins the race and writes the id first, attributed to a person.
      await db().message.create({
        data: {
          ...scope(),
          channelAccountId: profile.channelAccount.id,
          conversationId: profile.conversationId,
          channelMessageId: wamid,
          direction: "OUT",
          source: "HUMAN",
          kind: "TEXT",
          occurredAt: NOW,
          deliveryStatus: "SENT",
        },
      });

      await createDeliveryStore(db()).settle(operationId, { kind: "SENT", platformMessageId: wamid }, NOW);

      // The send is the authoritative record of its own authorship, so it claims the row it finds. Before
      // this, the unique platform id aborted the whole settle: the delivery stayed SENDING with no sent
      // time, and the audit trail said a person had written the assistant's reply.
      expect(await db().message.findFirstOrThrow({ where: { channelMessageId: wamid, ...scope() } })).toMatchObject({
        source: "AI",
        operationId,
        aiDraftId,
      });
      expect(await db().deliveryJobRecord.findUniqueOrThrow({ where: { operationId } })).toMatchObject({ status: "SENT", platformMessageId: wamid });
    });
  });

  describe("when the business disconnects the number from its own app", () => {
    const connection = () => db().whatsAppConnection.findFirstOrThrow({ where: { wabaId: WABA_ID } });
    const account = () => db().channelAccount.findUniqueOrThrow({ where: { id: profile.channelAccount.id } });

    it("pauses sending by marking the number as needing re-authorization", async () => {
      // Meta's instruction to integrators is explicit — "Pause any pending Cloud API message sends for
      // this client" — and this is how: NEEDS_REAUTH is refused by the policy engine's account gate and
      // re-asserted by the delivery claim, so a reply scheduled earlier is held when it comes due.
      expect(await applyAccountLifecycle(db(), { wabaId: WABA_ID, event: "OFFBOARDED", at: NOW })).toEqual({ updated: 1 });

      expect(await account()).toMatchObject({ status: "NEEDS_REAUTH" });
      expect(await connection()).toMatchObject({ healthReason: OFFBOARDED_HEALTH_REASON });
    });

    it("does not disconnect it, because Meta reconnects it automatically", async () => {
      await applyAccountLifecycle(db(), { wabaId: WABA_ID, event: "OFFBOARDED", at: NOW });

      // The number still exists and the business still has it; reconnection "typically completes within a
      // few minutes". DISCONNECTED would make an operator redo an onboarding nobody undid.
      expect((await account()).status).not.toBe("DISCONNECTED");
    });

    it("restores it on reconnection", async () => {
      await applyAccountLifecycle(db(), { wabaId: WABA_ID, event: "OFFBOARDED", at: NOW });

      expect(await applyAccountLifecycle(db(), { wabaId: WABA_ID, event: "RECONNECTED", at: NOW })).toEqual({ updated: 1 });
      expect(await account()).toMatchObject({ status: "CONNECTED" });
      expect(await connection()).toMatchObject({ healthReason: null });
    });

    it("restores only what offboarding took", async () => {
      // A number needing re-authorization for another reason — a revoked token, say — is not quietly
      // reconnected by a provider event about something else.
      await db().channelAccount.update({ where: { id: profile.channelAccount.id }, data: { status: "NEEDS_REAUTH" } });

      expect(await applyAccountLifecycle(db(), { wabaId: WABA_ID, event: "RECONNECTED", at: NOW })).toEqual({ updated: 0 });
      expect(await account()).toMatchObject({ status: "NEEDS_REAUTH" });
    });

    it("leaves an account an operator disconnected alone", async () => {
      await db().channelAccount.update({ where: { id: profile.channelAccount.id }, data: { status: "DISCONNECTED" } });

      expect(await applyAccountLifecycle(db(), { wabaId: WABA_ID, event: "OFFBOARDED", at: NOW })).toEqual({ updated: 0 });
      expect(await account()).toMatchObject({ status: "DISCONNECTED" });
    });

    it("changes nothing for a messaging account nobody connected", async () => {
      expect(await applyAccountLifecycle(db(), { wabaId: "waba-nobody-connected", event: "OFFBOARDED", at: NOW })).toEqual({ updated: 0 });
      expect(await account()).toMatchObject({ status: "CONNECTED" });
    });
  });
});
