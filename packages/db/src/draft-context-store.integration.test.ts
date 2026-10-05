import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDraftContextStore, type DraftContextStore } from "./draft-context-store";
import { appendInboundMessage } from "./repositories/messages";
import { createPendingTranscripts, loadTranscriptionWork, recordTranscript, recordTranscriptionFailure } from "./transcript-store";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { seedWorkspace, type SeededProfile } from "./testing/fixtures";

describe.skipIf(!databaseTestsEnabled())("draft context store (PostgreSQL)", () => {
  let database: TestDatabase;
  let profile: SeededProfile;
  let other: SeededProfile;
  let store: DraftContextStore;
  const db = () => database.db;
  let sequence = 0;
  const unique = (prefix: string) => `${prefix}-${++sequence}`;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    [profile] = (await seedWorkspace(database.db, "draft-ctx")).profiles as [SeededProfile];
    [other] = (await seedWorkspace(database.db, "draft-ctx-other")).profiles as [SeededProfile];
    store = createDraftContextStore(database.db);
  }, 120_000);

  afterAll(async () => {
    await database?.dispose();
  });

  const query = (overrides: Partial<Parameters<DraftContextStore["load"]>[0]> = {}) => ({
    workspaceId: profile.context.workspaceId,
    businessProfileId: profile.businessProfileId,
    conversationId: profile.conversationId,
    anchorMessageId: profile.messageId,
    ...overrides,
  });

  it("loads the conversation state and the customer burst the draft answers", async () => {
    const context = await store.load(query());

    expect(context?.snapshot).toMatchObject({
      conversationId: profile.conversationId,
      status: "OPEN",
      aiEnabled: true,
      takeoverState: "NONE",
      // No automation policy row exists for this profile, so automation is off until someone opts in.
      mode: "OFF",
      anchorSuperseded: false,
    });
    expect(context?.inbound.map((segment) => segment.provenance)).toEqual([profile.messageId]);
    expect(context?.history).toEqual([]);
  });

  it("reports an anchor the customer has already overtaken", async () => {
    const newer = await appendInboundMessage(db(), profile.context, {
      conversationId: profile.conversationId,
      channelMessageId: unique("mid"),
      kind: "TEXT",
      text: "Actually, never mind.",
      occurredAt: new Date("2026-09-18T11:00:00.000Z"),
    });

    // Drafting against the older anchor would answer a question the customer has moved on from.
    expect((await store.load(query()))?.snapshot.anchorSuperseded).toBe(true);
    expect((await store.load(query({ anchorMessageId: newer.id })))?.snapshot.anchorSuperseded).toBe(false);
    await db().message.delete({ where: { id: newer.id } });
  });

  it("separates earlier turns from the burst being answered", async () => {
    const second = await appendInboundMessage(db(), profile.context, {
      conversationId: profile.conversationId,
      channelMessageId: unique("mid"),
      kind: "TEXT",
      text: "And are you open on Sunday?",
      occurredAt: new Date("2026-09-18T09:00:00.000Z"),
    });
    await db().message.create({
      data: {
        workspaceId: profile.context.workspaceId,
        businessProfileId: profile.businessProfileId,
        channelAccountId: profile.channelAccount.id,
        conversationId: profile.conversationId,
        channelMessageId: unique("mid-out"),
        direction: "OUT",
        source: "HUMAN",
        kind: "TEXT",
        text: "Checking for you.",
        occurredAt: new Date("2026-09-18T08:30:00.000Z"),
      },
    });

    const context = await store.load(query({ anchorMessageId: second.id }));

    // The reply answers the trailing run of customer messages; everything before it is context.
    expect(context?.inbound.map((segment) => segment.text)).toEqual(["And are you open on Sunday?"]);
    expect(context?.history.at(-1)).toMatchObject({ kind: "OUTBOUND", text: "Checking for you." });
    expect(context?.history.some((segment) => segment.provenance === profile.messageId)).toBe(true);
  });

  it("prefers a conversation override, then a channel policy, then the profile default", async () => {
    await db().automationPolicy.create({
      data: {
        workspaceId: profile.context.workspaceId,
        businessProfileId: profile.businessProfileId,
        mode: "DRAFT",
        mandatoryReviewReasons: [],
      },
    });
    expect((await store.load(query()))?.snapshot.mode).toBe("DRAFT");

    await db().automationPolicy.create({
      data: {
        workspaceId: profile.context.workspaceId,
        businessProfileId: profile.businessProfileId,
        channelAccountId: profile.channelAccount.id,
        mode: "AUTOPILOT",
        mandatoryReviewReasons: [],
      },
    });
    expect((await store.load(query()))?.snapshot.mode).toBe("AUTOPILOT");

    await db().conversation.update({ where: { id: profile.conversationId }, data: { modeOverride: "OFF" } });
    // The conversation's own override wins over both policies.
    expect((await store.load(query()))?.snapshot.mode).toBe("OFF");
    await db().conversation.update({ where: { id: profile.conversationId }, data: { modeOverride: null } });
  });

  it("refuses a conversation or anchor from another tenant, or one that does not exist", async () => {
    expect(await store.load(query({ conversationId: other.conversationId }))).toBeUndefined();
    expect(await store.load(query({ anchorMessageId: other.messageId }))).toBeUndefined();
    expect(await store.load(query({ workspaceId: other.context.workspaceId }))).toBeUndefined();
    expect(await store.load(query({ conversationId: "00000000-0000-7000-8000-000000000000" }))).toBeUndefined();
  });

  it("labels a message with no text instead of dropping the turn", async () => {
    const media = await db().message.create({
      data: {
        workspaceId: profile.context.workspaceId,
        businessProfileId: profile.businessProfileId,
        channelAccountId: profile.channelAccount.id,
        conversationId: profile.conversationId,
        channelMessageId: unique("mid-media"),
        direction: "IN",
        source: "PARTICIPANT",
        kind: "IMAGE",
        occurredAt: new Date("2026-09-18T09:30:00.000Z"),
      },
    });

    const context = await store.load(query({ anchorMessageId: media.id }));

    expect(context?.inbound.at(-1)).toMatchObject({ provenance: media.id, text: "[image with no text]" });
  });

  /**
   * What a voice note contributes to the reply it is supposed to answer (Issue #21).
   *
   * Two facts, and the draft engine needs both: the words, when there are words, and whether the burst
   * contains a recording nobody could read. The second one is not derivable from the first — a message
   * whose reading failed and a message with nothing in it look identical from the text alone, and only one
   * of them means a customer asked something nobody heard.
   */
  describe("a recording in the conversation", () => {
    let voiceSequence = 0;

    /** A voice note stored the way ingestion stores one, with its pending reading alongside. */
    const voiceNote = async (options: { readonly at: Date; readonly caption?: string } = { at: new Date("2026-09-18T12:00:00.000Z") }) => {
      const providerMediaId = `media-ctx-${++voiceSequence}`;
      const message = await appendInboundMessage(db(), profile.context, {
        conversationId: profile.conversationId,
        channelMessageId: unique("mid-voice"),
        kind: "AUDIO",
        ...(options.caption === undefined ? {} : { text: options.caption }),
        media: [{ kind: "AUDIO", providerMediaId, mimeType: "audio/ogg; codecs=opus" }],
        occurredAt: options.at,
      });
      await createPendingTranscripts(db(), {
        workspaceId: profile.context.workspaceId,
        businessProfileId: profile.businessProfileId,
        messageId: message.id,
        media: [{ providerMediaId, mimeType: "audio/ogg; codecs=opus" }],
        at: options.at,
      });
      const [work] = await loadTranscriptionWork(db(), { workspaceId: profile.context.workspaceId, messageId: message.id });
      // A reading finishes after it was requested, and the CHECK says so — so the completion time is
      // derived from the note's own clock rather than from a constant.
      return { messageId: message.id, transcriptId: work?.transcriptId ?? "", providerMediaId, completedAt: new Date(options.at.getTime() + 1_000) };
    };

    const read = (note: { readonly transcriptId: string; readonly completedAt: Date }, text: string) =>
      recordTranscript(db(), {
        workspaceId: profile.context.workspaceId,
        transcriptId: note.transcriptId,
        transcript: { text, provider: "openai", model: "gpt-transcribe", latencyMs: 700 },
        at: note.completedAt,
      });

    const failed = (note: { readonly transcriptId: string; readonly completedAt: Date }) =>
      recordTranscriptionFailure(db(), {
        workspaceId: profile.context.workspaceId,
        transcriptId: note.transcriptId,
        reason: "UNSUPPORTED_AUDIO",
        retryable: false,
        permanentlyUnsupported: true,
        at: note.completedAt,
      });

    const cleanUp = async (messageIds: readonly string[]) => {
      await db().messageTranscript.deleteMany({ where: { messageId: { in: [...messageIds] } } });
      await db().message.deleteMany({ where: { id: { in: [...messageIds] } } });
    };

    it("puts the words of a successful reading where the reply can answer them", async () => {
      const note = await voiceNote({ at: new Date("2026-09-18T12:00:00.000Z") });
      await read(note, "Can I move my Saturday slot to Sunday?");

      const context = await store.load(query({ anchorMessageId: note.messageId }));

      // The transcript is a segment's text like any other customer writing — which is what makes it
      // untrusted by construction, sanitized and fenced by the draft engine downstream.
      expect(context?.inbound.at(-1)).toMatchObject({ kind: "INBOUND", provenance: note.messageId, text: "Can I move my Saturday slot to Sunday?" });
      expect(context?.unreadableAudio).toBe(false);
      await cleanUp([note.messageId]);
    });

    it("lets the caption the customer typed outrank any reading of the recording", async () => {
      const note = await voiceNote({ at: new Date("2026-09-18T12:05:00.000Z"), caption: "Sorry — ignore the voice note, I meant Sunday." });
      await read(note, "Can I move my Saturday slot to Saturday?");

      const context = await store.load(query({ anchorMessageId: note.messageId }));

      // They chose those words themselves; a machine's reading of the same message does not get to
      // replace them.
      expect(context?.inbound.at(-1)?.text).toBe("Sorry — ignore the voice note, I meant Sunday.");
      await cleanUp([note.messageId]);
    });

    it("marks the burst unreadable when a reading failed, and still keeps the turn", async () => {
      const note = await voiceNote({ at: new Date("2026-09-18T12:10:00.000Z") });
      await failed(note);

      const context = await store.load(query({ anchorMessageId: note.messageId }));

      expect(context?.unreadableAudio).toBe(true);
      expect(context?.inbound.at(-1)).toMatchObject({ provenance: note.messageId, text: "[audio with no text]" });
      await cleanUp([note.messageId]);
    });

    it("marks the burst unreadable while the reading is still pending", async () => {
      const note = await voiceNote({ at: new Date("2026-09-18T12:15:00.000Z") });

      // "Not yet" and "never" are different facts about the provider and the same fact about this draft:
      // the words are not available to write a reply from.
      expect((await store.load(query({ anchorMessageId: note.messageId })))?.unreadableAudio).toBe(true);
      await cleanUp([note.messageId]);
    });

    it("marks the burst unreadable for a recording that has no reading row at all", async () => {
      const message = await appendInboundMessage(db(), profile.context, {
        conversationId: profile.conversationId,
        channelMessageId: unique("mid-voice"),
        kind: "AUDIO",
        media: [{ kind: "AUDIO", providerMediaId: "media-ctx-orphan", mimeType: "audio/ogg" }],
        occurredAt: new Date("2026-09-18T12:20:00.000Z"),
      });

      // A voice note from before this feature existed, or one whose pending row was never written.
      // Reading the recordings off the readings table would make this look like an empty message.
      expect((await store.load(query({ anchorMessageId: message.id })))?.unreadableAudio).toBe(true);
      await cleanUp([message.id]);
    });

    it("ignores an unread recording that is history rather than the question", async () => {
      const old = await voiceNote({ at: new Date("2026-09-18T12:25:00.000Z") });
      await failed(old);
      const reply = await db().message.create({
        data: {
          workspaceId: profile.context.workspaceId,
          businessProfileId: profile.businessProfileId,
          channelAccountId: profile.channelAccount.id,
          conversationId: profile.conversationId,
          channelMessageId: unique("mid-out"),
          direction: "OUT",
          source: "HUMAN",
          kind: "TEXT",
          text: "Of course, moved to Sunday.",
          occurredAt: new Date("2026-09-18T12:26:00.000Z"),
        },
      });
      const next = await appendInboundMessage(db(), profile.context, {
        conversationId: profile.conversationId,
        channelMessageId: unique("mid"),
        kind: "TEXT",
        text: "Thanks!",
        occurredAt: new Date("2026-09-18T12:27:00.000Z"),
      });

      const context = await store.load(query({ anchorMessageId: next.id }));

      // An unread voice note from before the last reply is a turn somebody already answered. Holding
      // every later draft for a person because of it would never clear.
      expect(context?.unreadableAudio).toBe(false);
      expect(context?.history.some((segment) => segment.provenance === old.messageId)).toBe(true);
      await cleanUp([old.messageId, reply.id, next.id]);
    });

    it("keeps the words it has and still holds the reply when only one of two recordings was read", async () => {
      const first = "media-ctx-pair-a";
      const second = "media-ctx-pair-b";
      const message = await appendInboundMessage(db(), profile.context, {
        conversationId: profile.conversationId,
        channelMessageId: unique("mid-voice"),
        kind: "AUDIO",
        media: [
          { kind: "AUDIO", providerMediaId: first, mimeType: "audio/ogg" },
          { kind: "AUDIO", providerMediaId: second, mimeType: "audio/ogg" },
        ],
        occurredAt: new Date("2026-09-18T12:35:00.000Z"),
      });
      await createPendingTranscripts(db(), {
        workspaceId: profile.context.workspaceId,
        businessProfileId: profile.businessProfileId,
        messageId: message.id,
        media: [{ providerMediaId: first }, { providerMediaId: second }],
        at: new Date("2026-09-18T12:35:00.000Z"),
      });
      const work = await loadTranscriptionWork(db(), { workspaceId: profile.context.workspaceId, messageId: message.id });
      await read(
        { transcriptId: work.find((row) => row.providerMediaId === first)?.transcriptId ?? "", completedAt: new Date("2026-09-18T12:35:01.000Z") },
        "First half of the question.",
      );

      const context = await store.load(query({ anchorMessageId: message.id }));

      // Partly heard is not heard. The half that was read is still the best text available for the turn,
      // and the half that was not is why the reply waits for a person.
      expect(context?.inbound.at(-1)?.text).toBe("First half of the question.");
      expect(context?.unreadableAudio).toBe(true);
      await cleanUp([message.id]);
    });
  });
});
