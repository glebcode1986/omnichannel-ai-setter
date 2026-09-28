/**
 * The review claim, like the delivery claim, is a database decision. Two colleagues opening one queue is
 * normal; both acting on the same item is not, and only a conditional UPDATE can settle which click
 * counted — so it is tested against a real server rather than a stub.
 */
import { noRetrieval, resolveReview, type ReviewDependencies } from "@omnichannel/application";
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAiDraftStore } from "./ai-draft-store";
import { createDbClient, type DbClient } from "./client";
import { addWorkspaceMember } from "./repositories/workspaces";
import { authorizeBusinessProfileAccess, authorizeWorkspaceAccess, type BusinessProfileContext } from "./tenancy";
import { createReviewStore, createStyleLearningStore } from "./review-store";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { seedWorkspace, type SeededWorkspace, type SeededProfile } from "./testing/fixtures";

const NOW = new Date("2026-09-19T12:00:00.000Z");

describe.skipIf(!databaseTestsEnabled())("review store (PostgreSQL)", () => {
  let database: TestDatabase;
  let workspace: SeededWorkspace;
  let profile: SeededProfile;
  let rival: DbClient;
  /** A second signed-in member of the same Business Profile, so "two colleagues" means two people. */
  let colleagueContext: BusinessProfileContext;
  let seq = 0;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    workspace = await seedWorkspace(database.db, "review");
    [profile] = workspace.profiles as [SeededProfile];
    rival = createDbClient({ connectionString: database.url });

    const other = await database.db.user.create({ data: { name: "Review Colleague", email: `review-colleague-${randomUUID()}@example.test` } });
    const workspaceContext = await authorizeWorkspaceAccess(database.db, { userId: workspace.ownerUserId, workspaceId: profile.context.workspaceId });
    await addWorkspaceMember(database.db, workspaceContext, { userId: other.id, role: "ADMIN", businessProfileScope: "ALL" });
    colleagueContext = await authorizeBusinessProfileAccess(database.db, {
      userId: other.id,
      workspaceId: profile.context.workspaceId,
      businessProfileId: profile.businessProfileId,
    });
  }, 120_000);

  afterAll(async () => {
    await rival?.$disconnect();
    await database?.dispose();
  });

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

  const dependencies = (client: DbClient, as: BusinessProfileContext = profile.context): ReviewDependencies => ({
    reviews: createReviewStore(client, as),
    style: createStyleLearningStore(client, as),
    log: { info: () => undefined, warn: () => undefined },
    now: () => NOW,
    inboundContextFor: () => Promise.resolve("Are you open Saturday?"),
  });

  const command = (draftId: string, action: Parameters<typeof resolveReview>[1]["action"]) => ({
    scope: { ...scope(), conversationId: profile.conversationId },
    draftId,
    action,
    reviewMode: "NORMAL" as const,
  });

  it("lets exactly one of two colleagues resolve the same item", async () => {
    const draftId = await pendingDraft();

    // Two people, on two connections. Whoever loses must learn that they did not decide this: told
    // "scheduled", they would believe a send was theirs — and for an edit, that wording they wrote went
    // out when it was discarded.
    const [first, second] = await Promise.all([
      resolveReview(dependencies(database.db), command(draftId, { kind: "APPROVE" })),
      resolveReview(dependencies(rival, colleagueContext), command(draftId, { kind: "APPROVE" })),
    ]);

    expect([first.status, second.status].sort()).toEqual(["ALREADY_RESOLVED", "SCHEDULED"]);
    // And exactly one logical send exists, not two.
    expect(await database.db.deliveryJobRecord.count({ where: { ...scope(), draftId } })).toBe(1);
  }, 120_000);

  it("answers one person's retry with the send they already made", async () => {
    const draftId = await pendingDraft();

    // Two clicks at the same instant are a race even for one person, and either answer is truthful: one
    // of them made the decision. What must not vary is how many sends exist.
    const together = await Promise.all([
      resolveReview(dependencies(database.db), command(draftId, { kind: "APPROVE" })),
      resolveReview(dependencies(rival), command(draftId, { kind: "APPROVE" })),
    ]);
    expect(together.map((outcome) => outcome.status)).toContain("SCHEDULED");
    expect(await database.db.deliveryJobRecord.count({ where: { ...scope(), draftId } })).toBe(1);

    // A retry *after* the decision committed — a lost answer, a reloaded page — is the case that has to be
    // certain: the same person is told which operation is theirs, not that somebody else resolved it.
    const scheduled = together.find((outcome) => outcome.status === "SCHEDULED");
    const retried = await resolveReview(dependencies(database.db), command(draftId, { kind: "APPROVE" }));
    expect(retried).toEqual(scheduled);
  }, 120_000);

  /**
   * The same person asking for something different is not a replay.
   *
   * A delivery already created may only be handed back to a request that describes the same decision. The
   * earlier rule — same person, same send — answered "scheduled" to an edit whose wording never won, and
   * to a human-support request whose stored intent is an ordinary reply.
   */
  const differingDecisions: readonly {
    readonly what: string;
    readonly first: Parameters<typeof command>[1];
    readonly second: Parameters<typeof command>[1];
    readonly reviewMode?: "HUMAN_AGENT";
  }[] = [
    {
      what: "an approval followed by an edit",
      first: { kind: "APPROVE" },
      second: { kind: "EDIT", text: "Actually, 11 till 5 on Saturdays.", saveAsStyleExample: true },
    },
    {
      what: "an edit followed by different wording",
      first: { kind: "EDIT", text: "We're open 10 till 6.", saveAsStyleExample: true },
      second: { kind: "EDIT", text: "We're open 11 till 5.", saveAsStyleExample: true },
    },
    {
      what: "the same wording asked to be learned from this time",
      first: { kind: "EDIT", text: "We're open 10 till 6.", saveAsStyleExample: false },
      second: { kind: "EDIT", text: "We're open 10 till 6.", saveAsStyleExample: true },
    },
  ];

  for (const { what, first, second } of differingDecisions) {
    it(`refuses ${what} rather than reporting the earlier send as this one`, async () => {
      const draftId = await pendingDraft();
      const committed = await resolveReview(dependencies(database.db), command(draftId, first));
      expect(committed.status).toBe("SCHEDULED");
      const examplesAfterFirst = await database.db.styleExample.count({ where: { ...scope(), sourceDraftId: draftId } });

      const later = await resolveReview(dependencies(database.db), command(draftId, second));

      // Nothing new was sent, so nothing new may be claimed — and the losing wording is not evidence of
      // how this business sounds, because it never went to anybody.
      expect(later).toEqual({ status: "ALREADY_RESOLVED" });
      expect(await database.db.deliveryJobRecord.count({ where: { ...scope(), draftId } })).toBe(1);
      expect(await database.db.styleExample.count({ where: { ...scope(), sourceDraftId: draftId } })).toBe(examplesAfterFirst);
    }, 120_000);
  }

  it("refuses a human-support request for a send already authorized as an ordinary reply", async () => {
    const draftId = await pendingDraft();
    expect((await resolveReview(dependencies(database.db), command(draftId, { kind: "APPROVE" }))).status).toBe("SCHEDULED");

    const tagged = await resolveReview(dependencies(database.db), {
      ...command(draftId, { kind: "APPROVE" }),
      reviewMode: "HUMAN_AGENT" as const,
    });

    // The stored delivery carries the ordinary intent. Reporting this as scheduled would say a tagged
    // human-agent send was authorized when nothing of the sort is recorded (ADR-014).
    expect(tagged).toEqual({ status: "ALREADY_RESOLVED" });
    const job = await database.db.deliveryJobRecord.findFirstOrThrow({ where: { ...scope(), draftId }, select: { approvedReviewMode: true } });
    expect(job.approvedReviewMode).toBe("NORMAL");
  }, 120_000);

  it("learns from a person's wording once, however many times the same decision arrives", async () => {
    const draftId = await pendingDraft();
    const edit = { kind: "EDIT", text: "Saturdays we're open 10 till 6 😊", saveAsStyleExample: true } as const;

    const first = await resolveReview(dependencies(database.db), command(draftId, edit));
    const replay = await resolveReview(dependencies(database.db), command(draftId, edit));

    expect(replay).toEqual(first);
    // One sentence, counted once: a duplicate would weight it twice in every later answer.
    expect(await database.db.styleExample.count({ where: { ...scope(), sourceDraftId: draftId } })).toBe(1);
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

    const example = await database.db.styleExample.findFirstOrThrow({
      where: { ...scope(), sourceDraftId: draftId },
      select: { provenance: true, outboundText: true, inboundContext: true, approvedByUserId: true },
    });
    // Whose wording it was is part of the evidence, and it is the authenticated member's — the caller
    // never gets to say.
    expect(example).toMatchObject({
      provenance: "HUMAN_EDITED_DRAFT",
      outboundText: "Saturdays we're open 10 till 6 😊",
      inboundContext: "Are you open Saturday?",
      approvedByUserId: workspace.ownerUserId,
    });
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

  it("attributes a claimed conversation to the member who claimed it", async () => {
    const draftId = await pendingDraft();

    await resolveReview(dependencies(database.db), command(draftId, { kind: "CLAIM" }));

    const held = await database.db.conversation.findUniqueOrThrow({
      where: { workspaceId_businessProfileId_id: { ...scope(), id: profile.conversationId } },
      select: { takeoverState: true, takeoverActorKind: true, takeoverActorUserId: true },
    });
    // Taking a conversation is a person doing it, and the inbox has to be able to say which person.
    expect(held).toMatchObject({ takeoverState: "HUMAN_ACTIVE", takeoverActorKind: "USER", takeoverActorUserId: workspace.ownerUserId });
  }, 120_000);

  it("does not let a fresh takeover inherit an earlier auto-resume deadline", async () => {
    // The conversation was paused a minute ago and automation was due to resume shortly. A person then
    // takes it over for real. Carrying that deadline forward would hand the conversation back to
    // automation while the human is still in it — the one failure ADR-004 exists to prevent, arriving
    // quietly and on a timer nobody set.
    const resumeAt = new Date(Date.now() + 60_000);
    await database.db.conversation.update({
      where: { workspaceId_businessProfileId_id: { ...scope(), id: profile.conversationId } },
      data: {
        takeoverState: "HUMAN_ACTIVE",
        takeoverReason: "UNMATCHED_OUTBOUND_ECHO",
        takeoverReviewMode: null,
        humanTakeoverAt: new Date(Date.now() - 60_000),
        takeoverPausedUntil: resumeAt,
        takeoverActorKind: "SYSTEM",
        takeoverActorUserId: null,
      },
    });

    const draftId = await pendingDraft();
    await resolveReview(dependencies(database.db), command(draftId, { kind: "APPROVE" }));

    const held = await database.db.conversation.findUniqueOrThrow({
      where: { workspaceId_businessProfileId_id: { ...scope(), id: profile.conversationId } },
      select: { takeoverState: true, takeoverPausedUntil: true, takeoverActorUserId: true },
    });
    expect(held).toMatchObject({ takeoverState: "HUMAN_ACTIVE", takeoverActorUserId: workspace.ownerUserId });
    expect(held.takeoverPausedUntil).toBeNull();
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
