/**
 * Reading the recordings on one inbound message (Issue #21).
 *
 * The job names a message, and the recordings owed a reading were written as rows in the same transaction
 * as that message — so this handler asks the database what is outstanding rather than trusting a list in
 * a payload. Two copies of the same list eventually disagree, and the copy in a queue payload is the one
 * that survives a redeploy.
 *
 * Four rules decide what happens when something goes wrong, and all four exist to keep a failed reading
 * from becoming an invented one.
 *
 * **A failure is recorded, never guessed at.** Every unhappy path writes a typed reason on the row. The
 * draft path reads that and holds the reply for a person; nothing anywhere turns silence into words.
 *
 * **Only a failure that could succeed later is thrown.** The queue retries what it is given, so an
 * unsupported container or a recording too large is recorded as terminal and returns normally: throwing
 * it would spend four attempts to reach the same answer while a person waits for the review item.
 *
 * **A provider's own `Retry-After` is honoured** by failing the job rather than swallowing it, so the
 * queue's backoff carries it.
 *
 * **The recording is never logged, and neither is a word of the transcript.** The identifiers, the
 * provider's codes and the sizes are the whole of what goes into a log line.
 */
import type { TranscriptionProvider } from "@omnichannel/application";
import { transcriptionRetryable } from "@omnichannel/application";
import type { DbClient } from "@omnichannel/db";
import { loadTranscriptionWork, markTranscriptMediaDeleted, recordTranscript, recordTranscriptionFailure } from "@omnichannel/db";
import type { Logger } from "@omnichannel/observability";
import type { MediaTranscriptionJob } from "@omnichannel/queue";

/** What the handler needs to fetch a recording: the channel's own media calls, already bound to an account. */
export interface MediaFetchPort {
  /**
   * Downloads the bytes of one media object, or says why it could not.
   *
   * Channel-shaped work behind a port, so this handler never learns what a Graph URL looks like and the
   * WhatsApp adapter never learns what a transcript is.
   */
  fetch(input: {
    readonly workspaceId: string;
    readonly businessProfileId: string;
    readonly channelAccountId: string;
    readonly providerMediaId: string;
  }): Promise<MediaFetchResult>;
  /** Asks the provider to delete its copy. Best effort: the retention record is ours either way. */
  delete(input: {
    readonly workspaceId: string;
    readonly businessProfileId: string;
    readonly channelAccountId: string;
    readonly providerMediaId: string;
  }): Promise<boolean>;
}

export type MediaFetchResult =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly mimeType: string; readonly sizeBytes: number }
  | {
      readonly ok: false;
      /** This codebase's own vocabulary, never the provider's prose. */
      readonly reason: string;
      /** Whether asking again could produce a different answer. */
      readonly retryable: boolean;
      /** Whether the answer will never change, which makes the row terminal rather than merely failed. */
      readonly permanent: boolean;
      readonly code?: string;
    };

export interface TranscriptionHandlerDependencies {
  readonly db: DbClient;
  readonly media: MediaFetchPort;
  /** Absent when the deployment has no transcriber configured, which is a supported configuration. */
  readonly transcription?: TranscriptionProvider;
  /** True when a successful reading should ask the provider to delete its copy of the recording. */
  readonly deleteMediaAfterReading: boolean;
  readonly logger: Logger;
  readonly now: () => Date;
}

/** Thrown only for a failure the queue should try again. Nothing else leaves this handler as an error. */
export class RetryableTranscriptionError extends Error {
  constructor(reason: string) {
    super(`transcription will be retried: ${reason}`);
    this.name = "RetryableTranscriptionError";
  }
}

export function createTranscriptionHandler(dependencies: TranscriptionHandlerDependencies) {
  return async function onMediaTranscription(job: MediaTranscriptionJob): Promise<void> {
    const fields = { correlationId: job.correlationId, workspaceId: job.workspaceId, messageId: job.messageId };
    const outstanding = (await loadTranscriptionWork(dependencies.db, { workspaceId: job.workspaceId, messageId: job.messageId })).filter(
      (work) => work.state === "PENDING",
    );
    if (outstanding.length === 0) {
      // Already read, already given up on, or a redelivered webhook for a message whose rows are settled.
      dependencies.logger.info("worker.transcription_nothing_outstanding", fields);
      return;
    }

    let retryable: string | undefined;
    for (const work of outstanding) {
      const reason = await readOne(dependencies, job, work);
      // The first retryable failure is remembered and the rest of the recordings are still attempted: a
      // throttled provider should not leave the other recordings on this message unread as well.
      retryable ??= reason;
    }
    if (retryable !== undefined) {
      throw new RetryableTranscriptionError(retryable);
    }
  };
}

/** Reads one recording. Returns a reason when the queue should try again, and `undefined` otherwise. */
async function readOne(
  dependencies: TranscriptionHandlerDependencies,
  job: MediaTranscriptionJob,
  work: Awaited<ReturnType<typeof loadTranscriptionWork>>[number],
): Promise<string | undefined> {
  const fields = {
    correlationId: job.correlationId,
    workspaceId: work.workspaceId,
    messageId: work.messageId,
    transcriptId: work.transcriptId,
  };
  const transcriber = dependencies.transcription;
  if (transcriber === undefined) {
    // A supported configuration, not a fault — and still recorded, because the draft path has to know the
    // words are unavailable rather than assume the recording was empty.
    await settle(dependencies, work, { reason: "NOT_CONFIGURED", retryable: false, permanent: true });
    dependencies.logger.info("worker.transcription_not_configured", fields);
    return undefined;
  }

  const fetched = await dependencies.media.fetch({
    workspaceId: work.workspaceId,
    businessProfileId: work.businessProfileId,
    channelAccountId: work.channelAccountId,
    providerMediaId: work.providerMediaId,
  });
  if (!fetched.ok) {
    await settle(dependencies, work, {
      reason: `DOWNLOAD_${fetched.reason}`,
      retryable: fetched.retryable,
      permanent: fetched.permanent,
      ...(fetched.code === undefined ? {} : { code: fetched.code }),
    });
    dependencies.logger.warn("worker.transcription_download_failed", { ...fields, reason: fetched.reason, retryable: fetched.retryable });
    return fetched.retryable ? `download ${fetched.reason}` : undefined;
  }

  const outcome = await transcriber.transcribe({
    audio: fetched.bytes,
    mimeType: fetched.mimeType,
    // Generated here, never a customer's own filename: a name that travelled from a payload would put
    // attacker-chosen text into a provider request. The extension is what the provider uses to identify
    // the container, so it comes from the MIME type rather than from anything typed by a person.
    filename: `${work.transcriptId}.${extensionFor(fetched.mimeType)}`,
  });
  if (!outcome.ok) {
    const retryable = transcriptionRetryable(outcome.reason);
    await settle(dependencies, work, {
      reason: outcome.reason,
      retryable,
      // An unsupported container and a recording too large will answer the same way for ever.
      permanent: outcome.reason === "UNSUPPORTED_AUDIO" || outcome.reason === "TOO_LARGE" || outcome.reason === "NOT_CONFIGURED",
      ...(outcome.code === undefined ? {} : { code: outcome.code }),
    });
    dependencies.logger.warn("worker.transcription_failed", {
      ...fields,
      reason: outcome.reason,
      ...(outcome.code === undefined ? {} : { code: outcome.code }),
      retryable,
    });
    return retryable ? `provider ${outcome.reason}` : undefined;
  }

  const { recorded } = await recordTranscript(dependencies.db, {
    workspaceId: work.workspaceId,
    transcriptId: work.transcriptId,
    transcript: {
      text: outcome.transcript.text,
      provider: outcome.transcript.provider,
      model: outcome.transcript.model,
      ...(outcome.transcript.modelRevision === undefined ? {} : { modelRevision: outcome.transcript.modelRevision }),
      ...(outcome.transcript.language === undefined ? {} : { language: outcome.transcript.language }),
      ...(outcome.transcript.confidence === undefined ? {} : { confidence: outcome.transcript.confidence }),
      ...(outcome.transcript.confidenceSource === undefined ? {} : { confidenceSource: outcome.transcript.confidenceSource }),
      ...(outcome.transcript.durationSeconds === undefined ? {} : { durationSeconds: outcome.transcript.durationSeconds }),
      ...(outcome.transcript.providerRequestId === undefined ? {} : { providerRequestId: outcome.transcript.providerRequestId }),
      latencyMs: outcome.transcript.latencyMs,
    },
    at: dependencies.now(),
  });
  // Never the words, and never a byte of the recording. The length is the only thing about the text that
  // is safe to put in a log line, and it is the one an operator actually needs.
  dependencies.logger.info("worker.transcription_recorded", {
    ...fields,
    recorded,
    provider: outcome.transcript.provider,
    model: outcome.transcript.model,
    characters: outcome.transcript.text.length,
    ...(outcome.transcript.language === undefined ? {} : { language: outcome.transcript.language }),
    hasConfidence: outcome.transcript.confidence !== undefined,
  });

  if (recorded && dependencies.deleteMediaAfterReading) {
    // The retention hook, and the only place it is reachable from: once the words are stored, the
    // recording itself is the provider's copy of something a customer may ask us to forget.
    const deleted = await dependencies.media.delete({
      workspaceId: work.workspaceId,
      businessProfileId: work.businessProfileId,
      channelAccountId: work.channelAccountId,
      providerMediaId: work.providerMediaId,
    });
    if (deleted) {
      await markTranscriptMediaDeleted(dependencies.db, { workspaceId: work.workspaceId, transcriptId: work.transcriptId, at: dependencies.now() });
    }
    dependencies.logger.info("worker.transcription_media_deleted", { ...fields, deleted });
  }
  return undefined;
}

async function settle(
  dependencies: TranscriptionHandlerDependencies,
  work: Awaited<ReturnType<typeof loadTranscriptionWork>>[number],
  failure: { readonly reason: string; readonly retryable: boolean; readonly permanent: boolean; readonly code?: string },
): Promise<void> {
  await recordTranscriptionFailure(dependencies.db, {
    workspaceId: work.workspaceId,
    transcriptId: work.transcriptId,
    reason: failure.reason,
    retryable: failure.retryable,
    permanentlyUnsupported: failure.permanent,
    ...(failure.code === undefined ? {} : { code: failure.code }),
    at: dependencies.now(),
  });
}

/**
 * The extension a provider will read the container from.
 *
 * Derived from the MIME type the provider that *sent* the recording reported, which is the only
 * description of the bytes anybody has. An unknown type still gets a name — the transcriber's own answer
 * is what settles whether it can read it, and refusing here would be inventing a rule.
 */
function extensionFor(mimeType: string): string {
  const [base] = mimeType.split(";");
  const subtype = (base ?? "").trim().toLowerCase().split("/")[1] ?? "bin";
  return subtype === "mpeg" ? "mp3" : subtype === "x-m4a" ? "m4a" : subtype;
}
