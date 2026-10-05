/**
 * The readings of a customer's recordings, against PostgreSQL (Issue #21).
 *
 * Three things are worth a real database rather than a fake: whether a redelivered webhook can produce a
 * second reading of one recording, whether the conditional writes actually refuse a row somebody else has
 * already settled, and whether the CHECKs refuse a half-written reading. Each of those lives in a `where`
 * clause or a constraint, which is exactly what a fake store cannot be wrong about.
 *
 * Every function here takes the workspace explicitly, so every one of them is also asked the forged
 * question: the right transcript id with the wrong workspace must change nothing and read nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createPendingTranscripts,
  loadTranscriptionWork,
  markTranscriptMediaDeleted,
  readMessageTranscripts,
  recordTranscript,
  recordTranscriptionFailure,
} from "./transcript-store";
import { appendInboundMessage } from "./repositories/messages";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { seedWorkspace, type SeededProfile } from "./testing/fixtures";

const AT = new Date("2026-10-05T12:00:00.000Z");
const LATER = new Date("2026-10-05T12:00:05.000Z");

describe.skipIf(!databaseTestsEnabled())("message transcripts (PostgreSQL)", () => {
  let database: TestDatabase;
  let profile: SeededProfile;
  /** Another Workspace entirely, for the forged-scope half of every case. */
  let foreign: SeededProfile;
  let sequence = 0;
  const db = () => database.db;
  const unique = (prefix: string) => `${prefix}-${++sequence}`;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    [profile] = (await seedWorkspace(database.db, "transcripts")).profiles as [SeededProfile];
    [foreign] = (await seedWorkspace(database.db, "transcripts-foreign")).profiles as [SeededProfile];
  }, 120_000);

  afterAll(async () => {
    await database?.dispose();
  });

  const workspaceId = () => profile.context.workspaceId;

  /** A voice note stored the way ingestion stores one, with its pending reading alongside. */
  const voiceNote = async (
    options: { readonly media?: readonly { providerMediaId: string; mimeType?: string; sizeBytes?: number }[]; readonly text?: string } = {},
  ) => {
    const media = options.media ?? [{ providerMediaId: unique("media"), mimeType: "audio/ogg; codecs=opus", sizeBytes: 4096 }];
    const message = await appendInboundMessage(db(), profile.context, {
      conversationId: profile.conversationId,
      channelMessageId: unique("mid"),
      kind: "AUDIO",
      ...(options.text === undefined ? {} : { text: options.text }),
      media: media.map((entry) => ({ kind: "AUDIO" as const, providerMediaId: entry.providerMediaId, ...(entry.mimeType === undefined ? {} : { mimeType: entry.mimeType }) })),
      occurredAt: AT,
    });
    const created = await createPendingTranscripts(db(), {
      workspaceId: workspaceId(),
      businessProfileId: profile.businessProfileId,
      messageId: message.id,
      media,
      at: AT,
    });
    return { messageId: message.id, media, created };
  };

  const rowOf = (transcriptId: string) => db().messageTranscript.findUniqueOrThrow({ where: { id: transcriptId } });

  const transcript = {
    text: "Hi, can I move my Saturday appointment to Sunday?",
    provider: "openai",
    model: "gpt-transcribe",
    latencyMs: 820,
  } as const;

  describe("recording that a reading is owed", () => {
    it("writes one pending row per recording, with what the provider said about it", async () => {
      const { messageId, media } = await voiceNote();

      const work = await loadTranscriptionWork(db(), { workspaceId: workspaceId(), messageId });

      expect(work).toHaveLength(1);
      expect(work[0]).toMatchObject({
        messageId,
        providerMediaId: media[0]?.providerMediaId,
        mimeType: "audio/ogg; codecs=opus",
        state: "PENDING",
        attemptCount: 0,
        channelAccountId: profile.channelAccount.id,
        messageOccurredAt: AT,
      });
    });

    it("takes a redelivered webhook as the no-op it is", async () => {
      // Meta redelivers for up to seven days. A second row for one recording would mean two readings of
      // the same words, two provider calls and two chances to disagree about what the customer said.
      const { messageId, media } = await voiceNote();

      const again = await createPendingTranscripts(db(), {
        workspaceId: workspaceId(),
        businessProfileId: profile.businessProfileId,
        messageId,
        media,
        at: LATER,
      });

      expect(again.created).toBe(0);
      expect(await loadTranscriptionWork(db(), { workspaceId: workspaceId(), messageId })).toHaveLength(1);
      // And the first row's own clock is untouched: a redelivery is not a new request.
      expect((await db().messageTranscript.findFirstOrThrow({ where: { messageId } })).requestedAt).toEqual(AT);
    });

    it("keeps a redelivery from undoing a reading that already happened", async () => {
      const { messageId, media } = await voiceNote();
      const [work] = await loadTranscriptionWork(db(), { workspaceId: workspaceId(), messageId });
      await recordTranscript(db(), { workspaceId: workspaceId(), transcriptId: work?.transcriptId ?? "", transcript, at: AT });

      await createPendingTranscripts(db(), {
        workspaceId: workspaceId(),
        businessProfileId: profile.businessProfileId,
        messageId,
        media,
        at: LATER,
      });

      // `skipDuplicates` leaves the settled row alone rather than resetting it to PENDING, which would
      // queue a second reading of a recording whose words are already stored.
      expect(await rowOf(work?.transcriptId ?? "")).toMatchObject({ state: "READY", text: transcript.text });
    });

    it("writes a row per recording when one message carries several", async () => {
      const media = [
        { providerMediaId: unique("media"), mimeType: "audio/ogg" },
        { providerMediaId: unique("media"), mimeType: "audio/mp4" },
      ];
      const { messageId, created } = await voiceNote({ media });

      expect(created.created).toBe(2);
      expect((await loadTranscriptionWork(db(), { workspaceId: workspaceId(), messageId })).map((row) => row.providerMediaId)).toEqual(
        [...media].map((entry) => entry.providerMediaId).sort(),
      );
    });

    it("writes nothing when the message carries no recordings", async () => {
      expect(
        await createPendingTranscripts(db(), {
          workspaceId: workspaceId(),
          businessProfileId: profile.businessProfileId,
          messageId: profile.messageId,
          media: [],
          at: AT,
        }),
      ).toEqual({ created: 0 });
    });
  });

  describe("storing a reading", () => {
    it("stores the words with the provenance that says where they came from", async () => {
      const { messageId } = await voiceNote();
      const [work] = await loadTranscriptionWork(db(), { workspaceId: workspaceId(), messageId });

      expect(
        await recordTranscript(db(), {
          workspaceId: workspaceId(),
          transcriptId: work?.transcriptId ?? "",
          transcript: { ...transcript, language: "en", modelRevision: "2026-09-01", providerRequestId: "req_7", durationSeconds: 4.2 },
          at: LATER,
        }),
      ).toEqual({ recorded: true });

      expect(await rowOf(work?.transcriptId ?? "")).toMatchObject({
        state: "READY",
        text: transcript.text,
        provider: "openai",
        model: "gpt-transcribe",
        modelRevision: "2026-09-01",
        language: "en",
        providerRequestId: "req_7",
        latencyMs: 820,
        attemptCount: 1,
        completedAt: LATER,
        failureReason: null,
        // The recommended model publishes none, and nothing invents one.
        confidence: null,
        confidenceSource: null,
      });
    });

    it("refuses the second of two workers reading the same recording", async () => {
      const { messageId } = await voiceNote();
      const [work] = await loadTranscriptionWork(db(), { workspaceId: workspaceId(), messageId });
      const id = work?.transcriptId ?? "";
      await recordTranscript(db(), { workspaceId: workspaceId(), transcriptId: id, transcript, at: AT });

      const second = await recordTranscript(db(), {
        workspaceId: workspaceId(),
        transcriptId: id,
        transcript: { ...transcript, text: "Something else entirely." },
        at: LATER,
      });

      // Overwriting would be a silent disagreement about what a customer said, with nothing to show it.
      expect(second).toEqual({ recorded: false });
      expect(await rowOf(id)).toMatchObject({ text: transcript.text, attemptCount: 1 });
    });

    it("attributes a confidence to the provider when one is given without a source", async () => {
      const { messageId } = await voiceNote();
      const [work] = await loadTranscriptionWork(db(), { workspaceId: workspaceId(), messageId });

      await recordTranscript(db(), {
        workspaceId: workspaceId(),
        transcriptId: work?.transcriptId ?? "",
        transcript: { ...transcript, confidence: 0.91 },
        at: LATER,
      });

      // The CHECK refuses a number with no source, so the store names one rather than letting the write
      // fail: a figure arriving from a provider is a provider's figure.
      expect(await rowOf(work?.transcriptId ?? "")).toMatchObject({ confidence: 0.91, confidenceSource: "PROVIDER" });
    });

    it("keeps a derived confidence labelled as derived", async () => {
      const { messageId } = await voiceNote();
      const [work] = await loadTranscriptionWork(db(), { workspaceId: workspaceId(), messageId });

      await recordTranscript(db(), {
        workspaceId: workspaceId(),
        transcriptId: work?.transcriptId ?? "",
        transcript: { ...transcript, confidence: 0.4, confidenceSource: "DERIVED" },
        at: LATER,
      });

      expect(await rowOf(work?.transcriptId ?? "")).toMatchObject({ confidence: 0.4, confidenceSource: "DERIVED" });
    });
  });

  describe("storing a failure", () => {
    const failure = (
      transcriptId: string,
      overrides: Partial<{ reason: string; code: string; retryable: boolean; permanentlyUnsupported: boolean }> = {},
    ) =>
      recordTranscriptionFailure(db(), {
        workspaceId: workspaceId(),
        transcriptId,
        reason: overrides.reason ?? "UNAVAILABLE",
        ...(overrides.code === undefined ? {} : { code: overrides.code }),
        retryable: overrides.retryable ?? false,
        permanentlyUnsupported: overrides.permanentlyUnsupported ?? false,
        at: LATER,
      });

    const pending = async () => {
      const { messageId } = await voiceNote();
      const [work] = await loadTranscriptionWork(db(), { workspaceId: workspaceId(), messageId });
      return work?.transcriptId ?? "";
    };

    it("leaves a retryable failure pending, and still counts the attempt", async () => {
      const id = await pending();

      expect(await failure(id, { reason: "UNAVAILABLE", retryable: true })).toEqual({ recorded: true });

      expect(await rowOf(id)).toMatchObject({
        state: "PENDING",
        failureReason: "UNAVAILABLE",
        attemptCount: 1,
        // A pending reading has not finished, and the CHECK ties the two together.
        completedAt: null,
        text: null,
      });
    });

    it("marks a reading that can never succeed UNSUPPORTED rather than FAILED", async () => {
      const id = await pending();

      await failure(id, { reason: "UNSUPPORTED_AUDIO", code: "NOT_AUDIO", permanentlyUnsupported: true });

      // Different sentences to an operator, and different decisions for the queue.
      expect(await rowOf(id)).toMatchObject({ state: "UNSUPPORTED", failureReason: "UNSUPPORTED_AUDIO", failureCode: "NOT_AUDIO", completedAt: LATER });
    });

    it("marks a failure that merely did not work FAILED", async () => {
      const id = await pending();

      await failure(id, { reason: "PROVIDER_REJECTED", code: "400" });

      expect(await rowOf(id)).toMatchObject({ state: "FAILED", failureReason: "PROVIDER_REJECTED", completedAt: LATER });
    });

    it("cannot write a failure over a reading that already succeeded", async () => {
      const id = await pending();
      await recordTranscript(db(), { workspaceId: workspaceId(), transcriptId: id, transcript, at: AT });

      expect(await failure(id, { reason: "UNAVAILABLE", retryable: true })).toEqual({ recorded: false });
      expect(await rowOf(id)).toMatchObject({ state: "READY", text: transcript.text, failureReason: null });
    });

    it("never carries words, whatever the caller passes", async () => {
      const id = await pending();
      await db().messageTranscript.update({ where: { id }, data: { provider: "openai", model: "gpt-transcribe" } });

      await failure(id, { reason: "MALFORMED_RESULT" });

      // The database forbids text outside READY; this is the caller's half of the same rule.
      expect((await rowOf(id)).text).toBeNull();
    });
  });

  describe("what the draft path reads", () => {
    it("returns a reading and a failure differently, so a draft can tell them apart", async () => {
      const read = await voiceNote();
      const unread = await voiceNote();
      const [readWork] = await loadTranscriptionWork(db(), { workspaceId: workspaceId(), messageId: read.messageId });
      const [unreadWork] = await loadTranscriptionWork(db(), { workspaceId: workspaceId(), messageId: unread.messageId });
      await recordTranscript(db(), {
        workspaceId: workspaceId(),
        transcriptId: readWork?.transcriptId ?? "",
        transcript: { ...transcript, language: "en" },
        at: LATER,
      });
      await recordTranscriptionFailure(db(), {
        workspaceId: workspaceId(),
        transcriptId: unreadWork?.transcriptId ?? "",
        reason: "UNSUPPORTED_AUDIO",
        retryable: false,
        permanentlyUnsupported: true,
        at: LATER,
      });

      const records = await readMessageTranscripts(db(), { workspaceId: workspaceId(), messageIds: [read.messageId, unread.messageId] });

      expect(records.find((record) => record.messageId === read.messageId)).toMatchObject({
        state: "READY",
        text: transcript.text,
        language: "en",
        provider: "openai",
        model: "gpt-transcribe",
      });
      expect(records.find((record) => record.messageId === unread.messageId)).toMatchObject({
        state: "UNSUPPORTED",
        text: undefined,
        failureReason: "UNSUPPORTED_AUDIO",
      });
    });

    it("asks nothing when there are no messages to ask about", async () => {
      expect(await readMessageTranscripts(db(), { workspaceId: workspaceId(), messageIds: [] })).toEqual([]);
    });
  });

  describe("the retention record", () => {
    it("records the provider's deletion once", async () => {
      const { messageId } = await voiceNote();
      const [work] = await loadTranscriptionWork(db(), { workspaceId: workspaceId(), messageId });
      const id = work?.transcriptId ?? "";

      expect(await markTranscriptMediaDeleted(db(), { workspaceId: workspaceId(), transcriptId: id, at: LATER })).toEqual({ marked: true });
      // A later sweep asking again must not move the date: an operator answering a deletion request needs
      // when it was done, not when it was last noticed.
      expect(await markTranscriptMediaDeleted(db(), { workspaceId: workspaceId(), transcriptId: id, at: AT })).toEqual({ marked: false });
      expect((await rowOf(id)).mediaDeletedAt).toEqual(LATER);
    });
  });

  describe("another Workspace's transcript", () => {
    it("cannot be read, stored, failed or marked deleted with a forged scope", async () => {
      const { messageId } = await voiceNote();
      const [work] = await loadTranscriptionWork(db(), { workspaceId: workspaceId(), messageId });
      const id = work?.transcriptId ?? "";
      const forged = foreign.context.workspaceId;

      // Every one of these carries the real transcript id. The workspace is the only thing that is wrong,
      // and it is the only thing standing between a tenant and another tenant's customer's words.
      expect(await loadTranscriptionWork(db(), { workspaceId: forged, messageId })).toEqual([]);
      expect(await readMessageTranscripts(db(), { workspaceId: forged, messageIds: [messageId] })).toEqual([]);
      expect(await recordTranscript(db(), { workspaceId: forged, transcriptId: id, transcript, at: LATER })).toEqual({ recorded: false });
      expect(
        await recordTranscriptionFailure(db(), { workspaceId: forged, transcriptId: id, reason: "UNAVAILABLE", retryable: false, permanentlyUnsupported: false, at: LATER }),
      ).toEqual({ recorded: false });
      expect(await markTranscriptMediaDeleted(db(), { workspaceId: forged, transcriptId: id, at: LATER })).toEqual({ marked: false });

      // Still exactly as it was left.
      expect(await rowOf(id)).toMatchObject({ state: "PENDING", text: null, failureReason: null, mediaDeletedAt: null, attemptCount: 0 });
    });
  });

  describe("what the database itself refuses", () => {
    const pendingRow = async () => {
      const { messageId } = await voiceNote();
      const [work] = await loadTranscriptionWork(db(), { workspaceId: workspaceId(), messageId });
      return work?.transcriptId ?? "";
    };
    const violates = (attempt: Promise<unknown>, constraint: string) => expect(attempt).rejects.toThrow(new RegExp(constraint));

    it("refuses a reading that succeeded with no words to show for it", async () => {
      const id = await pendingRow();
      await violates(
        db().messageTranscript.update({ where: { id }, data: { state: "READY", provider: "openai", model: "gpt-transcribe", completedAt: LATER } }),
        "message_transcripts_ready_has_text_check",
      );
      await violates(
        db().messageTranscript.update({
          where: { id },
          data: { state: "READY", text: "   ", provider: "openai", model: "gpt-transcribe", completedAt: LATER },
        }),
        "message_transcripts_ready_has_text_check",
      );
    });

    it("refuses a failed reading that carries words", async () => {
      const id = await pendingRow();
      // This is the one that matters: a half-written reading reaching a customer's reply as though the
      // recording had been understood.
      await violates(
        db().messageTranscript.update({ where: { id }, data: { state: "FAILED", failureReason: "PROVIDER_REJECTED", text: "half a sentence", completedAt: LATER } }),
        "message_transcripts_unready_has_no_text_check",
      );
    });

    it("refuses a failure nobody named", async () => {
      const id = await pendingRow();
      await violates(
        db().messageTranscript.update({ where: { id }, data: { state: "FAILED", completedAt: LATER } }),
        "message_transcripts_failure_named_check",
      );
    });

    it("refuses a confidence that does not say where it came from, or one outside 0..1", async () => {
      const id = await pendingRow();
      await violates(db().messageTranscript.update({ where: { id }, data: { confidence: 0.8 } }), "message_transcripts_confidence_attributed_check");
      await violates(
        db().messageTranscript.update({ where: { id }, data: { confidenceSource: "PROVIDER" } }),
        "message_transcripts_confidence_attributed_check",
      );
      await violates(
        db().messageTranscript.update({ where: { id }, data: { confidence: 1.5, confidenceSource: "PROVIDER" } }),
        "message_transcripts_confidence_range_check",
      );
    });

    it("refuses measurements a later reader would try to reason about", async () => {
      const id = await pendingRow();
      await violates(db().messageTranscript.update({ where: { id }, data: { durationSeconds: 0 } }), "message_transcripts_measurements_check");
      await violates(db().messageTranscript.update({ where: { id }, data: { latencyMs: -1 } }), "message_transcripts_measurements_check");
      await violates(db().messageTranscript.update({ where: { id }, data: { sizeBytes: 0 } }), "message_transcripts_measurements_check");
      await violates(
        db().messageTranscript.update({ where: { id }, data: { state: "FAILED", failureReason: "UNAVAILABLE", completedAt: new Date(AT.getTime() - 1000) } }),
        "message_transcripts_measurements_check",
      );
    });

    it("refuses a row that claims to be both pending and finished", async () => {
      const id = await pendingRow();
      await violates(db().messageTranscript.update({ where: { id }, data: { completedAt: LATER } }), "message_transcripts_pending_unfinished_check");
      await violates(
        db().messageTranscript.update({ where: { id }, data: { state: "FAILED", failureReason: "UNAVAILABLE" } }),
        "message_transcripts_pending_unfinished_check",
      );
    });

    it("refuses to delete a message a reading still points at", async () => {
      const { messageId } = await voiceNote();
      // RESTRICT rather than cascade: a transcript is a record of what a customer said, and a message
      // deleted out from under it would take that record with it silently.
      await expect(db().message.delete({ where: { id: messageId } })).rejects.toThrow();
    });
  });
});
