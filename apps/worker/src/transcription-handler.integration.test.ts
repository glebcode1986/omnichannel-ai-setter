/**
 * What happens to a customer's voice note, path by path (Issue #21).
 *
 * The handler's whole job is deciding what a failure *means*, and every one of those decisions is a row
 * in the database afterwards: pending for another attempt, terminal with a reason, or read with words and
 * provenance. So this runs against a real database and reads the rows back, because "the handler called
 * the right store function" is not the claim worth proving — "the row a person will see says the right
 * thing" is.
 *
 * The provider and the media port are scripted. Both are the real ports, so an answer this file cannot
 * express is an answer the adapters cannot produce either.
 */
import type { TranscriptionOutcome, TranscriptionProvider, TranscriptionRequest } from "@omnichannel/application";
import {
  appendInboundMessage,
  authorizeBusinessProfileAccess,
  authorizeWorkspaceAccess,
  createBusinessProfile,
  createChannelAccount,
  createContactWithChannelIdentity,
  createConversation,
  createPendingTranscripts,
  publishPlanVersion,
  readEntitlement,
  readUsage,
  setWorkspaceSubscription,
} from "@omnichannel/db";
import { commercialAccessOf, NO_CAPABILITIES } from "@omnichannel/domain";
import type { MediaTranscriptionJob } from "@omnichannel/queue";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createTranscriptionHandler,
  RetryableTranscriptionError,
  TRANSCRIPTION_RESERVE_SECONDS,
  type MediaFetchPort,
  type MediaFetchResult,
} from "./transcription-handler";
import { createPaidWorkspace } from "./testing/paid-workspace";
import { createEndToEndInfrastructure, endToEndTestsEnabled, type EndToEndInfrastructure } from "./testing/infrastructure";

const NOW = new Date("2026-10-05T12:00:00.000Z");
/** An OggS header and a recognisable tail, so a log line that leaked the recording would be obvious. */
const AUDIO = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0xca, 0xfe, 0x42, 0x07]);
const TRANSCRIPT = "Hi, could I move my Saturday appointment to Sunday afternoon?";

describe.skipIf(!endToEndTestsEnabled())("reading a customer's recording", () => {
  let infra: EndToEndInfrastructure;
  let scope: { workspaceId: string; businessProfileId: string };
  let context: Awaited<ReturnType<typeof authorizeBusinessProfileAccess>>;
  let channelAccountId: string;
  let conversationId: string;
  let foreignWorkspaceId: string;
  let workspace: Awaited<ReturnType<typeof authorizeWorkspaceAccess>>;
  let planVersionId: string;
  let seq = 0;

  beforeAll(async () => {
    infra = await createEndToEndInfrastructure();
    const user = await infra.db.user.create({ data: { name: "Voice Owner", email: "voice-owner@example.test" } });
    const paid = await createPaidWorkspace(infra.db, { name: "Voice Workspace", ownerUserId: user.id });
    const workspaceId = paid.workspaceId;
    planVersionId = paid.planVersionId;
    workspace = await authorizeWorkspaceAccess(infra.db, { userId: user.id, workspaceId });
    const { businessProfileId } = await createBusinessProfile(infra.db, workspace, { name: "Voice Profile" });
    context = await authorizeBusinessProfileAccess(infra.db, { userId: user.id, workspaceId, businessProfileId });
    scope = { workspaceId, businessProfileId };

    const account = await createChannelAccount(infra.db, context, {
      channel: "WHATSAPP",
      externalAccountId: "wa-phone-voice",
      capabilities: { ...NO_CAPABILITIES, text: true },
    });
    channelAccountId = account.id;
    const identity = await createContactWithChannelIdentity(infra.db, context, {
      channelAccountId,
      externalUserId: "wa-customer-voice",
      displayName: "Voice Customer",
    });
    const conversation = await createConversation(infra.db, context, { channelAccountId, channelIdentityId: identity.channelIdentityId });
    conversationId = conversation.id;

    const other = await infra.db.user.create({ data: { name: "Other Owner", email: "voice-other@example.test" } });
    foreignWorkspaceId = (await createPaidWorkspace(infra.db, { name: "Other Workspace", ownerUserId: other.id })).workspaceId;
  }, 180_000);

  afterAll(async () => {
    await infra?.dispose();
  });

  beforeEach(() => {
    infra.logs.length = 0;
  });

  /** A stored voice note with its pending reading, exactly as ingestion leaves one. */
  const voiceNote = async (options: { readonly recordings?: number; readonly mimeType?: string } = {}) => {
    const mediaIds = Array.from({ length: options.recordings ?? 1 }, () => `wa-media-${++seq}`);
    const mimeType = options.mimeType ?? "audio/ogg; codecs=opus";
    const message = await appendInboundMessage(infra.db, context, {
      conversationId,
      channelMessageId: `wamid-${++seq}`,
      kind: "AUDIO",
      media: mediaIds.map((providerMediaId) => ({ kind: "AUDIO" as const, providerMediaId, mimeType })),
      occurredAt: NOW,
    });
    await createPendingTranscripts(infra.db, { ...scope, messageId: message.id, media: mediaIds.map((providerMediaId) => ({ providerMediaId, mimeType })), at: NOW });
    return { messageId: message.id, mediaIds, mimeType };
  };

  const job = (messageId: string, overrides: Partial<MediaTranscriptionJob> = {}): MediaTranscriptionJob => ({
    schemaVersion: 1,
    ...scope,
    correlationId: `corr-${++seq}`,
    channelAccountId,
    conversationId,
    messageId,
    ...overrides,
  });

  const rowsOf = (messageId: string) => infra.db.messageTranscript.findMany({ where: { messageId }, orderBy: { providerMediaId: "asc" } });

  /** A media port that answers from a script, and records what it was asked for. */
  function scriptedMedia(results: readonly MediaFetchResult[], deletions: readonly boolean[] = []) {
    const fetches: Parameters<MediaFetchPort["fetch"]>[0][] = [];
    const deletes: Parameters<MediaFetchPort["delete"]>[0][] = [];
    let fetchIndex = 0;
    let deleteIndex = 0;
    const port: MediaFetchPort = {
      fetch(input) {
        fetches.push(input);
        return Promise.resolve(results[Math.min(fetchIndex++, results.length - 1)] ?? { ok: false, reason: "SCRIPT_EXHAUSTED", retryable: false, permanent: false });
      },
      delete(input) {
        deletes.push(input);
        return Promise.resolve(deletions[Math.min(deleteIndex++, deletions.length - 1)] ?? true);
      },
    };
    return { port, fetches, deletes };
  }

  function scriptedTranscriber(outcomes: readonly TranscriptionOutcome[]) {
    const requests: TranscriptionRequest[] = [];
    let index = 0;
    const transcriber: TranscriptionProvider = {
      provider: "openai",
      model: "gpt-transcribe",
      transcribe(request) {
        requests.push(request);
        return Promise.resolve(outcomes[Math.min(index++, outcomes.length - 1)] ?? { ok: false, reason: "MALFORMED_RESULT" });
      },
    };
    return { transcriber, requests };
  }

  const downloaded = (mimeType = "audio/ogg; codecs=opus"): MediaFetchResult => ({ ok: true, bytes: AUDIO, mimeType, sizeBytes: AUDIO.byteLength });

  const read = (overrides: Partial<Extract<TranscriptionOutcome, { ok: true }>["transcript"]> = {}): TranscriptionOutcome => ({
    ok: true,
    transcript: { text: TRANSCRIPT, provider: "openai", model: "gpt-transcribe", latencyMs: 940, ...overrides },
  });

  const handler = (options: {
    readonly media: MediaFetchPort;
    readonly transcription?: TranscriptionProvider;
    readonly deleteMediaAfterReading?: boolean;
  }) =>
    createTranscriptionHandler({
      db: infra.db,
      media: options.media,
      ...(options.transcription === undefined ? {} : { transcription: options.transcription }),
      deleteMediaAfterReading: options.deleteMediaAfterReading ?? false,
      logger: infra.logger,
      now: () => new Date(NOW.getTime() + 5_000),
    });

  const events = () => infra.logs.map((line) => line.event);

  describe("a valid voice note", () => {
    it("stores the words with the provenance of the reading that produced them", async () => {
      const note = await voiceNote();
      const media = scriptedMedia([downloaded()]);
      const transcriber = scriptedTranscriber([
        read({ language: "en", modelRevision: "2026-09-01", providerRequestId: "req_42", durationSeconds: 6.5 }),
      ]);

      await handler({ media: media.port, transcription: transcriber.transcriber })(job(note.messageId));

      expect(await rowsOf(note.messageId)).toMatchObject([
        {
          state: "READY",
          text: TRANSCRIPT,
          provider: "openai",
          model: "gpt-transcribe",
          modelRevision: "2026-09-01",
          language: "en",
          providerRequestId: "req_42",
          latencyMs: 940,
          attemptCount: 1,
          failureReason: null,
          // The recommended model publishes none, and nothing here invents one.
          confidence: null,
          confidenceSource: null,
          // Retention is off by default, so the provider still holds the recording.
          mediaDeletedAt: null,
        },
      ]);
      expect(media.fetches).toEqual([{ ...scope, channelAccountId, providerMediaId: note.mediaIds[0] }]);
    });

    it("names the file from the reading's own identity and the container, never from a payload", async () => {
      const note = await voiceNote();
      const media = scriptedMedia([downloaded("audio/mpeg")]);
      const transcriber = scriptedTranscriber([read()]);

      await handler({ media: media.port, transcription: transcriber.transcriber })(job(note.messageId));

      const [row] = await rowsOf(note.messageId);
      // A filename that travelled from a webhook would put attacker-chosen text into a provider request,
      // and the extension is what the provider identifies the container by — so it comes from the MIME
      // type the sending provider reported rather than from anything a person typed.
      expect(transcriber.requests[0]?.filename).toBe(`${row?.id ?? ""}.mp3`);
      expect(transcriber.requests[0]?.mimeType).toBe("audio/mpeg");
      expect(transcriber.requests[0]?.audio).toEqual(AUDIO);
    });

    it("reads every recording on one message", async () => {
      const note = await voiceNote({ recordings: 2 });
      const media = scriptedMedia([downloaded(), downloaded()]);
      const transcriber = scriptedTranscriber([read({ text: "First half." }), read({ text: "Second half." })]);

      await handler({ media: media.port, transcription: transcriber.transcriber })(job(note.messageId));

      expect((await rowsOf(note.messageId)).map((row) => row.state)).toEqual(["READY", "READY"]);
      expect(media.fetches.map((fetch) => fetch.providerMediaId).sort()).toEqual([...note.mediaIds].sort());
    });

    it("does nothing at all for a message whose readings are already settled", async () => {
      const note = await voiceNote();
      const media = scriptedMedia([downloaded()]);
      const transcriber = scriptedTranscriber([read()]);
      const run = handler({ media: media.port, transcription: transcriber.transcriber });
      await run(job(note.messageId));

      // A redelivered webhook, or a job the queue retried after the words were stored.
      await run(job(note.messageId));

      expect(transcriber.requests).toHaveLength(1);
      expect(media.fetches).toHaveLength(1);
      expect(events()).toContain("worker.transcription_nothing_outstanding");
    });
  });

  describe("a recording that cannot be fetched", () => {
    it("keeps an expired URL pending and asks the queue to try again", async () => {
      const note = await voiceNote();
      const media = scriptedMedia([{ ok: false, reason: "EXPIRED", retryable: true, permanent: false }]);
      const transcriber = scriptedTranscriber([read()]);

      await expect(handler({ media: media.port, transcription: transcriber.transcriber })(job(note.messageId))).rejects.toBeInstanceOf(
        RetryableTranscriptionError,
      );

      // The documented remedy is to resolve the media ID again, which is exactly what a retry does.
      expect(await rowsOf(note.messageId)).toMatchObject([
        { state: "PENDING", failureReason: "DOWNLOAD_EXPIRED", attemptCount: 1, completedAt: null, text: null },
      ]);
      expect(transcriber.requests).toEqual([]);
    });

    it("gives up on a recording the provider has forgotten, rather than spending four attempts", async () => {
      const note = await voiceNote();
      const media = scriptedMedia([{ ok: false, reason: "NOT_FOUND", retryable: false, permanent: true, code: "404" }]);

      // Returns normally: after seven days the recording is always gone, and a person is waiting for the
      // review item rather than for the queue to exhaust its backoff.
      await handler({ media: media.port, transcription: scriptedTranscriber([read()]).transcriber })(job(note.messageId));

      expect(await rowsOf(note.messageId)).toMatchObject([
        { state: "UNSUPPORTED", failureReason: "DOWNLOAD_NOT_FOUND", failureCode: "404", completedAt: new Date(NOW.getTime() + 5_000) },
      ]);
    });

    it("records a refused credential as failed rather than unsupported", async () => {
      const note = await voiceNote();
      const media = scriptedMedia([{ ok: false, reason: "NO_CREDENTIALS", retryable: false, permanent: false }]);

      await handler({ media: media.port, transcription: scriptedTranscriber([read()]).transcriber })(job(note.messageId));

      // Worth another attempt once somebody reconnects the number, but not something this job can wait
      // out — so FAILED, which is a different sentence to an operator than UNSUPPORTED.
      expect(await rowsOf(note.messageId)).toMatchObject([{ state: "FAILED", failureReason: "DOWNLOAD_NO_CREDENTIALS" }]);
    });
  });

  describe("a reading the provider could not produce", () => {
    const cases = [
      { reason: "UNAVAILABLE", state: "PENDING", retried: true },
      { reason: "QUOTA_EXHAUSTED", state: "FAILED", retried: false },
      { reason: "MALFORMED_RESULT", state: "FAILED", retried: false },
      { reason: "EMPTY_RESULT", state: "FAILED", retried: false },
      { reason: "PROVIDER_REJECTED", state: "FAILED", retried: false },
      { reason: "UNSUPPORTED_AUDIO", state: "UNSUPPORTED", retried: false },
      { reason: "TOO_LARGE", state: "UNSUPPORTED", retried: false },
    ] as const;

    for (const scenario of cases) {
      it(`records ${scenario.reason} as ${scenario.state}${scenario.retried ? " and retries" : " without retrying"}`, async () => {
        const note = await voiceNote();
        const media = scriptedMedia([downloaded()]);
        const transcriber = scriptedTranscriber([{ ok: false, reason: scenario.reason, code: "CODE" }]);
        const run = handler({ media: media.port, transcription: transcriber.transcriber })(job(note.messageId));

        if (scenario.retried) {
          await expect(run).rejects.toBeInstanceOf(RetryableTranscriptionError);
        } else {
          await expect(run).resolves.toBeUndefined();
        }

        // Whatever went wrong, the row carries a reason and no words. A half-written reading reaching a
        // customer's reply as though the recording had been understood is the failure this prevents.
        expect(await rowsOf(note.messageId)).toMatchObject([{ state: scenario.state, failureReason: scenario.reason, failureCode: "CODE", text: null }]);
      });
    }

    it("still reads the other recordings when one of them is throttled", async () => {
      const note = await voiceNote({ recordings: 2 });
      const media = scriptedMedia([downloaded(), downloaded()]);
      const transcriber = scriptedTranscriber([{ ok: false, reason: "UNAVAILABLE" }, read({ text: "The second one." })]);

      await expect(handler({ media: media.port, transcription: transcriber.transcriber })(job(note.messageId))).rejects.toBeInstanceOf(
        RetryableTranscriptionError,
      );

      // A throttled provider must not leave the rest of the message unread as well, and the retry then
      // finds only the row that is still owed an answer.
      expect((await rowsOf(note.messageId)).map((row) => row.state).sort()).toEqual(["PENDING", "READY"]);
    });
  });

  describe("a deployment with no transcriber", () => {
    it("records the recording as unread without asking anybody for anything", async () => {
      const note = await voiceNote();
      const media = scriptedMedia([downloaded()]);

      await handler({ media: media.port })(job(note.messageId));

      // A supported configuration, not a fault — and still recorded, because the draft path has to know
      // the words are unavailable rather than assume the recording was empty.
      expect(await rowsOf(note.messageId)).toMatchObject([{ state: "UNSUPPORTED", failureReason: "NOT_CONFIGURED", text: null }]);
      // Nothing is downloaded for a reading nobody can perform.
      expect(media.fetches).toEqual([]);
      expect(events()).toContain("worker.transcription_not_configured");
    });
  });

  describe("the retention hook", () => {
    it("asks the provider to forget the recording once the words are stored", async () => {
      const note = await voiceNote();
      const media = scriptedMedia([downloaded()], [true]);

      await handler({ media: media.port, transcription: scriptedTranscriber([read()]).transcriber, deleteMediaAfterReading: true })(job(note.messageId));

      expect(media.deletes).toEqual([{ ...scope, channelAccountId, providerMediaId: note.mediaIds[0] }]);
      expect(await rowsOf(note.messageId)).toMatchObject([{ state: "READY", mediaDeletedAt: new Date(NOW.getTime() + 5_000) }]);
    });

    it("leaves the row saying the recording is still theirs when the provider refused", async () => {
      const note = await voiceNote();
      const media = scriptedMedia([downloaded()], [false]);

      await handler({ media: media.port, transcription: scriptedTranscriber([read()]).transcriber, deleteMediaAfterReading: true })(job(note.messageId));

      // An operator answering a customer's deletion request needs the truth, not an optimistic date.
      expect(await rowsOf(note.messageId)).toMatchObject([{ mediaDeletedAt: null }]);
    });

    it("never deletes the recording of a reading that failed", async () => {
      const note = await voiceNote();
      const media = scriptedMedia([downloaded()]);
      const transcriber = scriptedTranscriber([{ ok: false, reason: "MALFORMED_RESULT" }]);

      await handler({ media: media.port, transcription: transcriber.transcriber, deleteMediaAfterReading: true })(job(note.messageId));

      // The recording is the only remaining record of what the customer said. Deleting it after a failed
      // reading would destroy the thing a person is about to be asked to listen to.
      expect(media.deletes).toEqual([]);
    });
  });

  describe("another Workspace's message", () => {
    it("is neither read nor written, however well-formed the job is", async () => {
      const note = await voiceNote();
      const media = scriptedMedia([downloaded()]);
      const transcriber = scriptedTranscriber([read()]);

      // The right message id, the wrong workspace: the shape a forged or misrouted job has.
      await handler({ media: media.port, transcription: transcriber.transcriber })(job(note.messageId, { workspaceId: foreignWorkspaceId }));

      expect(media.fetches).toEqual([]);
      expect(transcriber.requests).toEqual([]);
      expect(await rowsOf(note.messageId)).toMatchObject([{ state: "PENDING", attemptCount: 0, text: null }]);
    });
  });

  describe("what reaches the log", () => {
    it("carries the identifiers and the measurements, and never the recording or its words", async () => {
      const note = await voiceNote();
      const media = scriptedMedia([downloaded()], [true]);
      const transcriber = scriptedTranscriber([read({ text: "canary-transcript-reschedule-to-sunday", language: "en" })]);

      await handler({ media: media.port, transcription: transcriber.transcriber, deleteMediaAfterReading: true })(job(note.messageId));

      const serialized = JSON.stringify(infra.logs);
      // A transcript is a customer's own words. Its length is the only thing about it an operator needs.
      expect(serialized).not.toContain("canary-transcript");
      // And the bytes of the recording never go near a log line in any encoding.
      expect(serialized).not.toContain(Buffer.from(AUDIO).toString("base64"));
      expect(serialized).not.toContain("OggS");
      const recorded = infra.logs.find((line) => line.event === "worker.transcription_recorded");
      expect(recorded).toMatchObject({
        workspaceId: scope.workspaceId,
        messageId: note.messageId,
        characters: "canary-transcript-reschedule-to-sunday".length,
        hasConfidence: false,
        provider: "openai",
        model: "gpt-transcribe",
      });
    });

    it("names the reason a reading failed without quoting the provider's prose", async () => {
      const note = await voiceNote();
      const media = scriptedMedia([downloaded()]);
      const transcriber = scriptedTranscriber([{ ok: false, reason: "PROVIDER_REJECTED", code: "400" }]);

      await handler({ media: media.port, transcription: transcriber.transcriber })(job(note.messageId));

      expect(infra.logs.find((line) => line.event === "worker.transcription_failed")).toMatchObject({
        reason: "PROVIDER_REJECTED",
        code: "400",
        retryable: false,
        transcriptId: (await rowsOf(note.messageId))[0]?.id,
      });
    });
  });

  /**
   * The allowance (#40, USAGE_METERING.md).
   *
   * Transcription is the one customer-facing metered resource in the initial plans, so this is where the
   * reserve/commit/release machinery meets a real paid provider call. The cases worth writing are the
   * three where a naive implementation leaks: a refusal that still downloads the bytes, a hold that is
   * never given back when the reading fails, and a commit that records the estimate instead of the truth.
   */
  describe("the transcription allowance", () => {
    const planWith = async (code: string, grants: Parameters<typeof publishPlanVersion>[1]["grants"]) =>
      (await publishPlanVersion(infra.db, { code, name: code, grants })).planVersionId;

    /**
     * The counter for this cycle, read as a *delta* by every case below.
     *
     * The cycle is the workspace's and the earlier suites in this file consume it too, so an absolute
     * assertion would be an assertion about the order the file happens to run in. The delta is what each
     * case actually claims.
     */
    const usageFor = async () => {
      const snapshot = await readUsage(infra.db, scope.workspaceId, new Date(NOW.getTime() + 5_000));
      return snapshot.counters["VOICE_TRANSCRIPTION_SECONDS"] ?? { committed: 0, reserved: 0 };
    };

    const since = async (before: { readonly committed: number; readonly reserved: number }) => {
      const after = await usageFor();
      return { committed: after.committed - before.committed, reserved: after.reserved - before.reserved };
    };

    afterEach(async () => {
      // Back to the uncapped test plan, so one case's allowance cannot decide the next one's outcome.
      await setWorkspaceSubscription(infra.db, workspace, { planVersionId, state: "ACTIVE" });
    });

    it("commits what the reading actually took, not what it held", async () => {
      const before = await usageFor();
      const { messageId } = await voiceNote();
      const media = scriptedMedia([downloaded()]);
      const { transcriber } = scriptedTranscriber([read({ durationSeconds: 7.4 })]);

      await handler({ media: media.port, transcription: transcriber })(job(messageId));

      const usage = await since(before);
      // Rounded to whole seconds, because the column counts seconds and a fractional one would truncate
      // silently. Nothing is still held: the hold went back as the commit took its place.
      expect(usage).toEqual({ committed: 7, reserved: 0 });
    }, 180_000);

    it("commits the estimate when the provider reports no duration, rather than zero", async () => {
      const before = await usageFor();
      const { messageId } = await voiceNote();
      const media = scriptedMedia([downloaded()]);
      const { transcriber } = scriptedTranscriber([read()]);

      await handler({ media: media.port, transcription: transcriber })(job(messageId));

      // The work happened and somebody paid for it. Recording zero would understate our own costs for
      // every provider that does not measure — `gpt-transcribe` is one of them.
      expect((await since(before)).committed).toBe(TRANSCRIPTION_RESERVE_SECONDS);
    }, 180_000);

    it("gives the hold back when the reading fails, so a failure costs no allowance", async () => {
      const before = await usageFor();
      const { messageId } = await voiceNote();
      const media = scriptedMedia([downloaded()]);
      const { transcriber } = scriptedTranscriber([{ ok: false, reason: "UNSUPPORTED_AUDIO" }]);

      await handler({ media: media.port, transcription: transcriber })(job(messageId));

      expect(await since(before)).toEqual({ committed: 0, reserved: 0 });
    }, 180_000);

    it("gives the hold back when the recording cannot even be downloaded", async () => {
      const before = await usageFor();
      const { messageId } = await voiceNote();
      const media = scriptedMedia([{ ok: false, reason: "NOT_FOUND", retryable: false, permanent: true }]);
      const { transcriber, requests } = scriptedTranscriber([read()]);

      await handler({ media: media.port, transcription: transcriber })(job(messageId));

      expect(await since(before)).toEqual({ committed: 0, reserved: 0 });
      expect(requests).toEqual([]);
    }, 180_000);

    it("refuses to read anything once the allowance is spent, and never calls the provider", async () => {
      const before = await usageFor();
      // Sells AI and transcription, like every accepted plan does, and differs from them only in the size
      // of the allowance. A plan selling transcription and nothing else would make the assertions below
      // about *this plan's* narrowness rather than about exhaustion, which is the thing under test.
      const tiny = await planWith("voice-tiny-allowance", {
        features: ["AI_DRAFTS", "AUTOPILOT", "VOICE_TRANSCRIPTION"],
        limits: {},
        quotas: { VOICE_TRANSCRIPTION_SECONDS: 10 },
      });
      await setWorkspaceSubscription(infra.db, workspace, { planVersionId: tiny, state: "ACTIVE" });
      const { messageId, mediaIds } = await voiceNote();
      const media = scriptedMedia([downloaded()]);
      const { transcriber, requests } = scriptedTranscriber([read()]);

      await handler({ media: media.port, transcription: transcriber })(job(messageId));

      // The estimate alone exceeds ten seconds, so the hold is refused before anything is spent.
      expect(requests).toEqual([]);
      const rows = await rowsOf(messageId);
      expect(rows[0]).toMatchObject({ state: "FAILED", failureReason: "BILLING_LIMIT" });
      // And a reply written as though the recording had been heard is what this prevents: the draft path
      // turns the missing transcript into `AUDIO_NOT_TRANSCRIBED` and holds the reply for a person.
      expect(rows[0]?.text).toBeNull();

      // PRICING_PACKAGING.md §142-148 says what exhaustion may *not* touch, and until now only the
      // transcription half of that was asserted. The word the spec uses is "only", and an "only" nothing
      // checks is the kind of claim that stays true by luck: a later change coupling the voice counter to
      // commercial access would pass every assertion above while silently switching off text replies for
      // a workspace that merely ran out of minutes.

      // "no automatic overage charge is enabled by default" — the refusal spends nothing, so a workspace
      // cannot be billed past its allowance by a recording arriving.
      expect(await since(before)).toEqual({ committed: 0, reserved: 0 });

      // "the incoming voice message remains stored/visible in Inbox" — the recording is not what failed,
      // and a message deleted or emptied to settle a billing limit would be data lost to a commercial
      // rule, which the spec forbids outright.
      const stored = await infra.db.message.findUniqueOrThrow({
        where: { id: messageId },
        select: { kind: true, direction: true, conversationId: true, media: true },
      });
      expect(stored).toMatchObject({ kind: "AUDIO", direction: "IN", conversationId });
      expect(JSON.stringify(stored.media)).toContain(mediaIds[0] ?? "");

      // "text conversations and normal AI behavior continue" — asserted at `commercialAccessOf`, which is
      // the decision the draft path actually consults, rather than by driving a draft here: this file owns
      // the recording's paths and the disposition's own suite owns that one. The three fields are the
      // whole of what the draft path reads.
      expect(commercialAccessOf(await readEntitlement(infra.db, scope.workspaceId, NOW))).toEqual({
        paidWorkAllowed: true,
        aiDrafts: true,
        autopilot: true,
      });
    }, 180_000);

    it("downloads nothing at all when the plan does not sell transcription", async () => {
      const without = await planWith("voice-no-transcription", { features: ["AI_DRAFTS"], limits: {}, quotas: {} });
      await setWorkspaceSubscription(infra.db, workspace, { planVersionId: without, state: "ACTIVE" });
      const { messageId } = await voiceNote();
      const media = scriptedMedia([downloaded()]);
      const { transcriber, requests } = scriptedTranscriber([read()]);

      await handler({ media: media.port, transcription: transcriber })(job(messageId));

      // Our bandwidth as well as the provider's bill: a workspace that does not buy this should not have
      // either spent on it.
      expect(media.fetches).toEqual([]);
      expect(requests).toEqual([]);
      expect((await rowsOf(messageId))[0]).toMatchObject({ state: "FAILED", failureReason: "BILLING_FEATURE_OFF" });
    }, 180_000);

    it("keeps the recording in the Inbox either way, because the message was persisted long before", async () => {
      const without = await planWith("voice-inbox-survives", { features: ["AI_DRAFTS"], limits: {}, quotas: {} });
      await setWorkspaceSubscription(infra.db, workspace, { planVersionId: without, state: "ACTIVE" });
      const { messageId } = await voiceNote();

      await handler({ media: scriptedMedia([downloaded()]).port, transcription: scriptedTranscriber([read()]).transcriber })(job(messageId));

      // The property the spec states outright: never drop inbound customer data because billing is
      // unavailable. Ingestion does not consult an entitlement at all, and this is the evidence.
      expect(await infra.db.message.count({ where: { id: messageId } })).toBe(1);
    }, 180_000);
  });
});

