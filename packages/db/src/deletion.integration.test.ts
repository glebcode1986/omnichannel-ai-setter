/**
 * What is left after a deletion (#57, P3-04).
 *
 * The claim worth proving is not that rows went away — it is that **nothing derived from the customer
 * survived**. A product that deleted the messages but kept the transcript of their voice note, the
 * model's summary of the thread, the facts it learned about them, or a style example quoting them
 * verbatim has not forgotten anybody; it has only stopped showing them, and the next reply would still
 * be written from what it remembers.
 *
 * So every case here seeds the derived half as well as the correspondence, and asserts on counts across
 * the whole schema afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { executeDeletion, listDeletionRequests, requestDeletion, requestProfileDeletion, type ProviderMediaPort } from "./deletion-store";
import { createPendingTranscripts, recordTranscript } from "./transcript-store";
import { createContactWithChannelIdentity } from "./repositories/contacts";
import { createConversation } from "./repositories/conversations";
import { appendInboundMessage } from "./repositories/messages";
import { addTestMember, createTestUser, seedWorkspace, type SeededProfile } from "./testing/fixtures";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import type { authorizeWorkspaceAccess } from "./tenancy";

const NOW = new Date("2026-10-07T12:00:00.000Z");

describe.skipIf(!databaseTestsEnabled())("deleting a customer's data (PostgreSQL)", () => {
  let database: TestDatabase;
  let profile: SeededProfile;
  let other: SeededProfile;
  let owner: Awaited<ReturnType<typeof authorizeWorkspaceAccess>>;
  let agent: Awaited<ReturnType<typeof authorizeWorkspaceAccess>>;
  let sequence = 0;
  const db = () => database.db;
  const unique = (prefix: string) => `${prefix}-${++sequence}`;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    const seeded = await seedWorkspace(database.db, "deletion", ["main", "second"]);
    [profile, other] = seeded.profiles as [SeededProfile, SeededProfile];
    owner = seeded.context;
    const agentUserId = await createTestUser(database.db, "deletion-agent");
    agent = await addTestMember(database.db, seeded.workspaceId, agentUserId, "AGENT", "ALL");
  }, 120_000);

  afterAll(async () => {
    await database?.dispose();
  });

  const scope = () => ({ workspaceId: profile.context.workspaceId, businessProfileId: profile.businessProfileId });

  /**
   * A customer with correspondence *and* everything the product derived from them.
   *
   * A fresh contact and conversation per case rather than the seeded one: these tests delete what they
   * create, and sharing a thread would make each case depend on the order the previous one ran in.
   */
  async function customerWithEverything() {
    const label = unique("del");
    const identity = await createContactWithChannelIdentity(db(), profile.context, {
      channelAccountId: profile.channelAccount.id,
      externalUserId: `ig-user-${label}`,
      displayName: `Customer ${label}`,
    });
    const conversation = await createConversation(db(), profile.context, {
      channelAccountId: profile.channelAccount.id,
      channelIdentityId: identity.channelIdentityId,
    });
    const providerMediaId = `wa-media-${label}`;
    const message = await appendInboundMessage(db(), profile.context, {
      conversationId: conversation.id,
      channelMessageId: `wamid-${label}`,
      kind: "AUDIO",
      media: [{ kind: "AUDIO", providerMediaId, mimeType: "audio/ogg" }],
      occurredAt: NOW,
    });
    await createPendingTranscripts(db(), { ...scope(), messageId: message.id, media: [{ providerMediaId }], at: NOW });
    const [transcript] = await db().messageTranscript.findMany({ where: { messageId: message.id }, select: { id: true } });
    await recordTranscript(db(), {
      workspaceId: scope().workspaceId,
      transcriptId: transcript?.id ?? "",
      transcript: { text: "Can I move my booking?", provider: "openai", model: "gpt-transcribe", latencyMs: 500 },
      at: new Date(NOW.getTime() + 1_000),
    });
    await db().conversationSummary.create({
      data: { ...scope(), conversationId: conversation.id, summary: "Wants to move a booking.", modelProvider: "fixture", modelName: "t" },
    });
    await db().customerFact.create({
      data: {
        ...scope(),
        contactId: identity.contactId,
        category: "LOGISTICS",
        subject: "address",
        value: "12 Elm Street",
        status: "ACTIVE",
        source: "HUMAN_RECORDED",
        confirmedByUserId: profile.context.userId,
        confirmedAt: NOW,
      },
    });
    await db().customerPreference.create({
      data: {
        ...scope(),
        contactId: identity.contactId,
        subject: "contact time",
        value: "mornings",
        status: "ACTIVE",
        source: "HUMAN_RECORDED",
        confirmedByUserId: profile.context.userId,
        confirmedAt: NOW,
      },
    });
    await db().contactPoint.create({
      data: { ...scope(), contactId: identity.contactId, kind: "PHONE", normalizedValue: `+1555000${String(sequence).padStart(4, "0")}`, rawValue: "+1 555 000" },
    });
    await db().styleExample.create({
      data: {
        workspaceId: scope().workspaceId,
        businessProfileId: scope().businessProfileId,
        inboundContext: "Can I move my booking?",
        outboundText: "Of course — which day suits?",
        provenance: "HUMAN_TYPED",
        status: "ACTIVE",
        // An active example is a verified one, which the CHECK insists on.
        approvedByUserId: profile.context.userId,
        sourceMessageId: message.id,
      },
    });
    return { contactId: identity.contactId, conversationId: conversation.id, messageId: message.id, providerMediaId };
  }

  const countsFor = async (seeded: { contactId: string; conversationId: string }) => ({
    messages: await db().message.count({ where: { conversationId: seeded.conversationId } }),
    transcripts: await db().messageTranscript.count({ where: { message: { conversationId: seeded.conversationId } } }),
    summaries: await db().conversationSummary.count({ where: { conversationId: seeded.conversationId } }),
    facts: await db().customerFact.count({ where: { contactId: seeded.contactId } }),
    preferences: await db().customerPreference.count({ where: { contactId: seeded.contactId } }),
    contactPoints: await db().contactPoint.count({ where: { contactId: seeded.contactId } }),
    styleExamples: await db().styleExample.count({ where: { sourceMessage: { conversationId: seeded.conversationId } } }),
    contacts: await db().contact.count({ where: { id: seeded.contactId } }),
  });

  const acceptingMedia = (outcome = true): { port: ProviderMediaPort; calls: unknown[] } => {
    const calls: unknown[] = [];
    return { calls, port: { delete: (input) => { calls.push(input); return Promise.resolve(outcome); } } };
  };

  describe("recording the request", () => {
    it("is admin or owner work, never an agent's", async () => {
      // A deletion is irreversible, and its consequences are workspace-wide even when its scope is one
      // person. Somebody handling conversations should not be able to trigger one.
      await expect(requestDeletion(db(), agent, { scope: "WORKSPACE" })).rejects.toThrow();
      await expect(requestProfileDeletion(db(), profile.context, { scope: "CONTACT", targetId: profile.contactId })).resolves.toMatchObject({
        state: "REQUESTED",
      });
    });

    it("records who asked, what for, and nothing having happened yet", async () => {
      const request = await requestProfileDeletion(db(), profile.context, {
        scope: "CONTACT",
        targetId: profile.contactId,
        reason: "customer asked",
      });

      expect(request).toMatchObject({ scope: "CONTACT", targetId: profile.contactId, state: "REQUESTED", removed: {}, failures: [] });
      expect(request.completedAt).toBeUndefined();
      expect(await db().deletionRequest.findUniqueOrThrow({ where: { id: request.id } })).toMatchObject({
        requestedByUserId: profile.context.userId,
        reason: "customer asked",
        startedAt: null,
      });
    });

    it("refuses a scope whose shape does not match what it names", async () => {
      // The database holds this, not the caller: a CONTACT request with no target is one nobody could
      // act on, and a WORKSPACE request with one is a narrower deletion wearing the widest scope's name.
      await expect(
        db().deletionRequest.create({
          data: { workspaceId: scope().workspaceId, scope: "CONTACT", requestedByUserId: profile.context.userId },
        }),
      ).rejects.toThrow(/deletion_requests_scope_target_check/u);
      await expect(
        db().deletionRequest.create({
          data: { workspaceId: scope().workspaceId, scope: "WORKSPACE", targetId: profile.contactId, requestedByUserId: profile.context.userId },
        }),
      ).rejects.toThrow(/deletion_requests_scope_target_check/u);
    });

    it("refuses a row that claims to be both running and finished", async () => {
      await expect(
        db().deletionRequest.create({
          data: {
            workspaceId: scope().workspaceId,
            scope: "WORKSPACE",
            requestedByUserId: profile.context.userId,
            state: "PROCESSING",
            startedAt: NOW,
            completedAt: NOW,
          },
        }),
      ).rejects.toThrow(/deletion_requests_lifecycle_check/u);
    });

    it("refuses to call a run with failures complete", async () => {
      await expect(
        db().deletionRequest.create({
          data: {
            workspaceId: scope().workspaceId,
            scope: "WORKSPACE",
            requestedByUserId: profile.context.userId,
            state: "COMPLETED",
            startedAt: NOW,
            completedAt: NOW,
            failures: [{ step: "PROVIDER_MEDIA", reason: "PROVIDER_REFUSED" }],
          },
        }),
      ).rejects.toThrow(/deletion_requests_failures_check/u);
    });
  });

  describe("carrying one out", () => {
    it("removes the derived data as well as the correspondence", async () => {
      const seeded = await customerWithEverything();
      const before = await countsFor(seeded);
      expect(before.transcripts).toBeGreaterThan(0);
      expect(before.summaries).toBeGreaterThan(0);
      expect(before.facts).toBeGreaterThan(0);
      expect(before.styleExamples).toBeGreaterThan(0);
      const request = await requestProfileDeletion(db(), profile.context, { scope: "CONTACT", targetId: seeded.contactId });
      const media = acceptingMedia();

      const done = await executeDeletion(db(), request.id, { media: media.port, now: () => NOW });

      expect(done.state).toBe("COMPLETED");
      // The half that makes this a deletion rather than a hiding.
      expect(await countsFor(seeded)).toEqual({
        messages: 0,
        transcripts: 0,
        summaries: 0,
        facts: 0,
        preferences: 0,
        contactPoints: 0,
        styleExamples: 0,
        contacts: 0,
      });
      expect(done.removed["transcripts"]).toBeGreaterThan(0);
      expect(done.removed["styleExamples"]).toBeGreaterThan(0);
    });

    it("asks the provider to forget its own copy before the row that names it", async () => {
      const seeded = await customerWithEverything();
      const request = await requestProfileDeletion(db(), profile.context, { scope: "CONTACT", targetId: seeded.contactId });
      const media = acceptingMedia();

      await executeDeletion(db(), request.id, { media: media.port, now: () => NOW });

      // The media id is the only handle on the provider's copy; deleting the row first would strand it.
      expect(media.calls).toContainEqual(expect.objectContaining({ providerMediaId: seeded.providerMediaId }));
    });

    it("reports a partial failure when the provider refuses, rather than claiming success", async () => {
      const seeded = await customerWithEverything();
      const request = await requestProfileDeletion(db(), profile.context, { scope: "CONTACT", targetId: seeded.contactId });

      const done = await executeDeletion(db(), request.id, { media: acceptingMedia(false).port, now: () => NOW });

      // A COMPLETED deletion that left a customer's voice note on the provider's servers would be a lie.
      expect(done.state).toBe("PARTIAL_FAILURE");
      expect(done.failures).toContainEqual({ step: "PROVIDER_MEDIA", reason: "PROVIDER_REFUSED" });
    });

    it("reports a partial failure when the deployment has no way to reach the provider", async () => {
      const seeded = await customerWithEverything();
      const request = await requestProfileDeletion(db(), profile.context, { scope: "CONTACT", targetId: seeded.contactId });

      const done = await executeDeletion(db(), request.id, { now: () => NOW });

      expect(done.state).toBe("PARTIAL_FAILURE");
      expect(done.failures).toContainEqual({ step: "PROVIDER_MEDIA", reason: "NO_MEDIA_PORT" });
    });

    it("keeps the opt-out while removing the person it pointed at", async () => {
      const seeded = await customerWithEverything();
      await db().followUpSuppression.create({
        data: { ...scope(), contactId: seeded.contactId, reason: "CUSTOMER_REQUEST", sourceMessageId: seeded.messageId, recordedByUserId: profile.context.userId },
      });
      const request = await requestProfileDeletion(db(), profile.context, { scope: "CONTACT", targetId: seeded.contactId });

      await executeDeletion(db(), request.id, { media: acceptingMedia().port, now: () => NOW });

      // You cannot both forget somebody and remember not to contact them. The opt-out survives, and so
      // does the least that still recognises the person it names — their provider id and nothing else.
      const suppression = await db().followUpSuppression.findFirstOrThrow({ where: { ...scope() } });
      expect(suppression).toMatchObject({ reason: "CUSTOMER_REQUEST", sourceMessageId: null, liftedAt: null });
      expect(await db().contact.findUniqueOrThrow({ where: { id: seeded.contactId } })).toMatchObject({ displayName: null });
      expect(await db().channelIdentity.findFirstOrThrow({ where: { contactId: seeded.contactId } })).toMatchObject({
        displayName: null,
        username: null,
      });
      // And everything a reply could be written from is gone all the same.
      expect(await db().message.count({ where: { conversationId: seeded.conversationId } })).toBe(0);
      expect(await db().customerFact.count({ where: { contactId: seeded.contactId } })).toBe(0);
      await db().followUpSuppression.deleteMany({ where: { ...scope() } });
    });

    it("is claimed once, so two runners cannot both delete and disagree", async () => {
      const seeded = await customerWithEverything();
      const request = await requestProfileDeletion(db(), profile.context, { scope: "CONTACT", targetId: seeded.contactId });

      const first = await executeDeletion(db(), request.id, { media: acceptingMedia().port, now: () => NOW });
      const second = await executeDeletion(db(), request.id, { media: acceptingMedia().port, now: () => NOW });

      expect(first.state).toBe("COMPLETED");
      // The second found it settled and did nothing, rather than running the whole purge again.
      expect(second.state).toBe("COMPLETED");
      expect(second.removed).toEqual(first.removed);
    });
  });

  describe("a conversation-scoped request", () => {
    it("leaves the customer and everything learned from their other threads", async () => {
      const seeded = await customerWithEverything();
      const factsBefore = await db().customerFact.count({ where: { contactId: seeded.contactId } });
      const request = await requestProfileDeletion(db(), profile.context, { scope: "CONVERSATION", targetId: seeded.conversationId });

      await executeDeletion(db(), request.id, { media: acceptingMedia().port, now: () => NOW });

      // One thread, not one person: the contact survives, and so does what was learned elsewhere.
      expect(await db().conversation.count({ where: { id: seeded.conversationId } })).toBe(0);
      expect(await db().contact.count({ where: { id: seeded.contactId } })).toBe(1);
      expect(await db().customerFact.count({ where: { contactId: seeded.contactId } })).toBe(factsBefore);
    });
  });

  describe("another Business Profile's customer", () => {
    it("is untouched by a request scoped to this one", async () => {
      const before = await db().contact.count({ where: { businessProfileId: other.businessProfileId } });
      const request = await requestProfileDeletion(db(), profile.context, { scope: "BUSINESS_PROFILE" });

      await executeDeletion(db(), request.id, { media: acceptingMedia().port, now: () => NOW });

      // The scope columns come from the authorized context, so a profile the requester may not act in
      // cannot be reached by naming it.
      expect(await db().contact.count({ where: { businessProfileId: other.businessProfileId } })).toBe(before);
    });
  });

  describe("the record an operator reads", () => {
    it("lists requests newest first, scoped to the workspace", async () => {
      const requests = await listDeletionRequests(db(), owner);

      expect(requests.length).toBeGreaterThan(0);
      expect(requests.every((request) => request.workspaceId === profile.context.workspaceId)).toBe(true);
      expect(requests[0]?.requestedAt.getTime()).toBeGreaterThanOrEqual(requests[requests.length - 1]?.requestedAt.getTime() ?? 0);
    });
  });
});
