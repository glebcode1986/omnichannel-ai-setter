/**
 * The review claim, like the delivery claim, is a database decision. Two colleagues opening one queue is
 * normal; both acting on the same item is not, and only a conditional UPDATE can settle which click
 * counted — so it is tested against a real server rather than a stub.
 */
import { noRetrieval, resolveReview, type ReviewDependencies } from "@omnichannel/application";
import { toUserId } from "@omnichannel/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAiDraftStore } from "./ai-draft-store";
import { createDbClient, type DbClient } from "./client";
import { createReviewStore, createStyleLearningStore } from "./review-store";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { seedWorkspace, type SeededWorkspace, type SeededProfile } from "./testing/fixtures";

const NOW = new Date("2026-09-19T12:00:00.000Z");

describe.skipIf(!databaseTestsEnabled())("review store (PostgreSQL)", () => {
  let database: TestDatabase;
  let workspace: SeededWorkspace;
  let profile: SeededProfile;
  let rival: DbClient;
  let seq = 0;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    workspace = await seedWorkspace(database.db, "review");
    [profile] = workspace.profiles as [SeededProfile];
    rival = createDbClient({ connectionString: database.url });
  }, 120_000);

  afterAll(async () => {
    await rival?.$disconnect();
    await database?.dispose();
  });

  const actor = () => ({ kind: "USER", userId: toUserId(workspace.ownerUserId) }) as const;
  const scope = () => ({ workspaceId: profile.context.workspaceId, businessProfileId: profile.businessProfileId });

  const pendingDraft = async (): Promise<string> => {
    seq += 1;
    const { aiDraftId } = await createAiDraftStore(database.db).saveDraft({
      scope: { ...scope(), conversationId: profile.conversationId },
      generationKey: `review_${String(seq)}`,
      trigger: "AUTOMATIC",
      anchorMessageId: profile.messageId,
      anchorStateVersion: 1,
      text: "We open at 10 on Saturday.",
      structuredOutput: { reply: "We open at 10 on Saturday." },
      confidence: 0.9,
      modelSuggestsSend: false,
      needsReview: true,
      reasonCodes: ["MISSING_FACT"],
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

  const dependencies = (client: DbClient): ReviewDependencies => ({
    reviews: createReviewStore(client, profile.context),
    style: createStyleLearningStore(client, profile.context),
    log: { info: () => undefined, warn: () => undefined },
    now: () => NOW,
    inboundContextFor: () => Promise.resolve("Are you open Saturday?"),
  });

  const command = (draftId: string, action: Parameters<typeof resolveReview>[1]["action"]) => ({
    scope: { ...scope(), conversationId: profile.conversationId },
    draftId,
    actor: actor(),
    action,
    reviewMode: "NORMAL" as const,
  });

  it("lets exactly one of two colleagues resolve the same item", async () => {
    const draftId = await pendingDraft();

    const [first, second] = await Promise.all([
      resolveReview(dependencies(database.db), command(draftId, { kind: "APPROVE" })),
      resolveReview(dependencies(rival), command(draftId, { kind: "APPROVE" })),
    ]);

    expect([first.status, second.status].sort()).toEqual(["ALREADY_RESOLVED", "SCHEDULED"]);
    // And exactly one logical send exists, not two.
    expect(await database.db.deliveryJobRecord.count({ where: { ...scope(), draftId } })).toBe(1);
  }, 120_000);

  it("schedules through the delivery coordinator rather than sending", async () => {
    const draftId = await pendingDraft();

    const outcome = await resolveReview(dependencies(database.db), command(draftId, { kind: "APPROVE" }));

    expect(outcome.status).toBe("SCHEDULED");
    const job = await database.db.deliveryJobRecord.findFirstOrThrow({ where: { ...scope(), draftId }, select: { status: true, selectedDelayMs: true } });
    // A human has already decided, so there is no human-like delay left to simulate.
    expect(job).toMatchObject({ status: "SCHEDULED", selectedDelayMs: 0 });
    // Nothing was sent: no outbound message exists yet.
    expect(await database.db.message.count({ where: { ...scope(), aiDraftId: draftId } })).toBe(0);
  }, 120_000);

  it("stores the human's wording and learns style from it, never knowledge", async () => {
    const draftId = await pendingDraft();

    await resolveReview(dependencies(database.db), command(draftId, { kind: "EDIT", text: "Saturdays we're open 10 till 6 😊", saveAsStyleExample: true }));

    const draft = await database.db.aiDraft.findUniqueOrThrow({ where: { workspaceId_businessProfileId_id: { ...scope(), id: draftId } }, select: { text: true } });
    expect(draft.text).toBe("Saturdays we're open 10 till 6 😊");

    const example = await database.db.styleExample.findFirstOrThrow({ where: { ...scope(), sourceDraftId: draftId }, select: { provenance: true, outboundText: true, inboundContext: true } });
    expect(example).toMatchObject({ provenance: "HUMAN_EDITED_DRAFT", outboundText: "Saturdays we're open 10 till 6 😊", inboundContext: "Are you open Saturday?" });
    // What a person wrote says how this business sounds; it does not make the claims inside it true.
    expect(await database.db.knowledgeDocument.count({ where: { workspaceId: scope().workspaceId } })).toBe(0);
  }, 120_000);

  it("takes ownership when something goes out and returns it when the draft is dismissed", async () => {
    const approved = await pendingDraft();
    await resolveReview(dependencies(database.db), command(approved, { kind: "APPROVE" }));

    const held = await database.db.conversation.findUniqueOrThrow({ where: { workspaceId_businessProfileId_id: { ...scope(), id: profile.conversationId } }, select: { takeoverState: true, takeoverActorUserId: true } });
    expect(held).toMatchObject({ takeoverState: "HUMAN_ACTIVE", takeoverActorUserId: workspace.ownerUserId });

    const dismissed = await pendingDraft();
    await resolveReview(dependencies(database.db), command(dismissed, { kind: "DISMISS", note: "not relevant" }));

    const released = await database.db.conversation.findUniqueOrThrow({ where: { workspaceId_businessProfileId_id: { ...scope(), id: profile.conversationId } }, select: { takeoverState: true, takeoverActorUserId: true } });
    expect(released).toMatchObject({ takeoverState: "NONE", takeoverActorUserId: null });
    expect((await database.db.aiDraft.findUniqueOrThrow({ where: { workspaceId_businessProfileId_id: { ...scope(), id: dismissed } }, select: { status: true } })).status).toBe("DISMISSED");
  }, 120_000);

  it("reuses the first operation when a second click reaches an already scheduled draft", async () => {
    const draftId = await pendingDraft();
    const first = await resolveReview(dependencies(database.db), command(draftId, { kind: "APPROVE" }));

    // Force the item back to claimable to simulate a retried request reaching an already scheduled draft.
    await database.db.aiDraft.update({ where: { workspaceId_businessProfileId_id: { ...scope(), id: draftId } }, data: { status: "PENDING" } });
    const second = await resolveReview(dependencies(database.db), command(draftId, { kind: "APPROVE" }));

    expect(first.status === "SCHEDULED" && second.status === "SCHEDULED" ? second.operationId : "").toBe(first.status === "SCHEDULED" ? first.operationId : "");
    expect(await database.db.deliveryJobRecord.count({ where: { ...scope(), draftId } })).toBe(1);
  }, 120_000);

  it("reports a draft that no longer exists rather than inventing one", async () => {
    const outcome = await resolveReview(dependencies(database.db), command("01a0b40c-0000-7000-8000-00000000ffff", { kind: "APPROVE" }));

    expect(outcome).toEqual({ status: "GONE" });
  }, 120_000);
});
