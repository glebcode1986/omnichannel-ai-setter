import { randomUUID } from "node:crypto";

import { noRetrieval, type SaveDraftInput } from "@omnichannel/application";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAiDraftStore } from "./ai-draft-store";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { seedWorkspace, type SeededProfile } from "./testing/fixtures";

describe.skipIf(!databaseTestsEnabled())("ai draft store (PostgreSQL)", () => {
  let database: TestDatabase;
  let profile: SeededProfile;
  const db = () => database.db;
  const store = () => createAiDraftStore(database.db);

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    [profile] = (await seedWorkspace(database.db, "drafts")).profiles as [SeededProfile];
  }, 120_000);

  afterAll(async () => {
    await database?.dispose();
  });

  const input = (overrides: Partial<SaveDraftInput> = {}): SaveDraftInput => ({
    scope: {
      workspaceId: profile.context.workspaceId,
      businessProfileId: profile.businessProfileId,
      conversationId: profile.conversationId,
    },
    generationKey: randomUUID(),
    trigger: "AUTOMATIC",
    anchorMessageId: profile.messageId,
    anchorStateVersion: 1,
    text: "We open at 10 on Saturday.",
    structuredOutput: { reply: "We open at 10 on Saturday.", confidence: 0.8 },
    confidence: 0.8,
    modelSuggestsSend: true,
    needsReview: false,
    reasonCodes: [],
    intent: "HOURS",
    suggestedLeadStage: "ENGAGED",
    factualSourceIds: ["chunk_1"],
    retrieval: noRetrieval("OK"),
    status: "PENDING",
    provider: "anthropic",
    model: "claude-opus-5-20260101",
    promptVersion: "reply.v1",
    schemaVersion: "ai-draft.v1",
    requestId: "req_abc",
    latencyMs: 640,
    usage: { inputTokens: 1200, outputTokens: 180, cacheReadInputTokens: 400 },
    ...overrides,
  });

  it("persists the draft with the metadata an audit needs", async () => {
    const { aiDraftId } = await store().saveDraft(input());

    const row = await db().aiDraft.findUniqueOrThrow({ where: { id: aiDraftId } });
    expect(row).toMatchObject({
      status: "PENDING",
      confidence: 0.8,
      modelSuggestsSend: true,
      needsReview: false,
      intent: "HOURS",
      suggestedLeadStage: "ENGAGED",
      factualSourceIds: ["chunk_1"],
      modelProvider: "anthropic",
      modelName: "claude-opus-5-20260101",
      promptVersion: "reply.v1",
      schemaVersion: "ai-draft.v1",
      providerRequestId: "req_abc",
      latencyMs: 640,
      inputTokens: 1200,
      outputTokens: 180,
      cacheReadTokens: 400,
    });
  });

  it("is idempotent: a retried generation returns the same draft", async () => {
    const first = await store().saveDraft(input({ generationKey: "gen-retry" }));
    const retry = await store().saveDraft(input({ generationKey: "gen-retry", text: "A different attempt." }));

    expect(retry.aiDraftId).toBe(first.aiDraftId);
    expect(await db().aiDraft.count({ where: { generationKey: "gen-retry" } })).toBe(1);
    // The first result stands; a retry never rewrites a draft a human may already have seen.
    expect((await db().aiDraft.findUniqueOrThrow({ where: { id: first.aiDraftId } })).text).toBe("We open at 10 on Saturday.");
  });

  it("keeps an audit row for a generation whose output was unusable", async () => {
    const { aiDraftId } = await store().saveDraft(
      input({ text: null, structuredOutput: null, status: "HELD", confidence: 0, modelSuggestsSend: false, needsReview: true, reasonCodes: ["INVALID_MODEL_OUTPUT"], factualSourceIds: [] }),
    );

    const row = await db().aiDraft.findUniqueOrThrow({ where: { id: aiDraftId } });
    expect(row).toMatchObject({ status: "HELD", text: null, structuredOutput: null, reasonCodes: ["INVALID_MODEL_OUTPUT"] });
    // The model that produced the unusable output is still recorded.
    expect(row).toMatchObject({ modelProvider: "anthropic", promptVersion: "reply.v1" });
  });

  it("refuses an incomplete draft that is not held, and a negative usage count", async () => {
    const scope = { workspaceId: profile.context.workspaceId, businessProfileId: profile.businessProfileId };
    const base = {
      ...scope,
      conversationId: profile.conversationId,
      anchorMessageId: profile.messageId,
      anchorStateVersion: 1,
      confidence: 0.5,
      modelSuggestsSend: false,
      needsReview: true,
      modelProvider: "anthropic",
      modelName: "m",
      promptVersion: "p",
      schemaVersion: "s",
    };

    // A PENDING draft with no text would look actionable while holding nothing to act on.
    await expect(
      db().aiDraft.create({ data: { ...base, generationKey: randomUUID(), status: "PENDING", text: null, structuredOutput: undefined } }),
    ).rejects.toThrow(/ai_drafts_usable_check/);
    await expect(
      db().aiDraft.create({ data: { ...base, generationKey: randomUUID(), status: "HELD", text: "t", structuredOutput: {}, inputTokens: -1 } }),
    ).rejects.toThrow(/ai_drafts_usage_check/);
  });

  it("drops a lead stage the model invented rather than storing it", async () => {
    const { aiDraftId } = await store().saveDraft(input({ suggestedLeadStage: "DEFINITELY_BUYING" }));

    expect((await db().aiDraft.findUniqueOrThrow({ where: { id: aiDraftId } })).suggestedLeadStage).toBeNull();
  });

  it("stores what retrieval supplied, with scores, beside what the model relied on", async () => {
    const supplied = {
      status: "OK" as const,
      knowledge: [
        { chunkId: "chunk_1", documentId: "doc_1", documentVersion: 3, scopeLevel: "BUSINESS_PROFILE" as const, score: 0.0328, lexicalRank: 1, semanticRank: 2 },
        { chunkId: "chunk_2", documentId: "doc_1", documentVersion: 3, scopeLevel: "WORKSPACE" as const, score: 0.0161 },
      ],
      style: [{ exampleId: "style_1", score: 0.0164 }],
      knowledgeDiagnostics: { lexicalCandidates: 6, semanticCandidates: 4 },
      styleDiagnostics: { lexicalCandidates: 2, semanticCandidates: 0, semanticSkipped: "PROFILE_MISMATCH" as const },
    };

    const { aiDraftId } = await store().saveDraft(input({ retrieval: supplied, factualSourceIds: ["chunk_1"] }));
    const row = await db().aiDraft.findUniqueOrThrow({ where: { id: aiDraftId }, select: { retrieval: true, factualSourceIds: true } });

    // Scores and ranks survive the JSON round trip: a reviewer asking "was this fact even offered?" needs
    // the numbers, not just the IDs.
    expect(row.retrieval).toEqual(supplied);
    // And the two stay distinct — supplied is not the same list as relied upon.
    expect(row.factualSourceIds).toEqual(["chunk_1"]);
  });

  it("records an unreachable corpus distinguishably from one that returned nothing", async () => {
    const outage = await store().saveDraft(input({ retrieval: noRetrieval("UNAVAILABLE"), factualSourceIds: [] }));
    const empty = await store().saveDraft(input({ retrieval: noRetrieval("OK"), factualSourceIds: [] }));

    const rows = await db().aiDraft.findMany({ where: { id: { in: [outage.aiDraftId, empty.aiDraftId] } }, select: { id: true, retrieval: true } });
    const statusOf = (id: string) => (rows.find((row) => row.id === id)?.retrieval as { status: string } | null)?.status;

    // Both have an empty knowledge list; only the stored status says which one was actually asked.
    expect(statusOf(outage.aiDraftId)).toBe("UNAVAILABLE");
    expect(statusOf(empty.aiDraftId)).toBe("OK");
  });
});
