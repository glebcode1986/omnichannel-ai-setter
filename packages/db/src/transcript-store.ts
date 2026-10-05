/**
 * Readings of the recordings customers send (Issue #21).
 *
 * Scoped by provider assets rather than by a `BusinessProfileContext`, for the same reason the template
 * catalogue is: both callers are background work with no person behind them. A transcription runs in a
 * worker and a retention sweep runs on a timer, and inventing an authorization context so the call would
 * type-check is how a background path acquires authority nobody granted. Every function therefore takes
 * the workspace explicitly and every query is bounded by it.
 *
 * **A pending row is created in the same transaction as the message.** That is what makes the work
 * recoverable: if the worker never runs, the row is still there to be found, and the draft path can see
 * that a recording is owed a reading rather than drafting over silence.
 *
 * **A failed reading never carries words.** The database enforces it, because the failure mode that
 * matters is not an empty transcript — it is a half-written one reaching a customer's reply as though the
 * recording had been understood.
 */
import type { DbExecutor } from "./client";

export type TranscriptionStateValue = "PENDING" | "READY" | "FAILED" | "UNSUPPORTED";

/** One recording owed a reading, as the worker needs it. */
export interface TranscriptionWork {
  readonly transcriptId: string;
  readonly workspaceId: string;
  readonly businessProfileId: string;
  readonly messageId: string;
  readonly channelAccountId: string;
  readonly providerMediaId: string;
  readonly mimeType: string | undefined;
  readonly state: TranscriptionStateValue;
  readonly attemptCount: number;
  /** When the message arrived, which is what the provider's media-ID lifetime is counted from. */
  readonly messageOccurredAt: Date;
}

/** A reading as the draft context needs it: the words, and enough to know how much to trust them. */
export interface MessageTranscriptRecord {
  readonly messageId: string;
  readonly providerMediaId: string;
  readonly state: TranscriptionStateValue;
  readonly text: string | undefined;
  readonly language: string | undefined;
  readonly provider: string | undefined;
  readonly model: string | undefined;
  readonly confidence: number | undefined;
  readonly failureReason: string | undefined;
}

export interface PendingTranscriptInput {
  readonly providerMediaId: string;
  readonly mimeType?: string;
  readonly sizeBytes?: number;
}

/**
 * Records that each of these recordings is owed a reading.
 *
 * Called inside the transaction that writes the inbound message, so a voice note cannot be stored without
 * the product knowing it has not been read yet. Idempotent on the message and media pair: a redelivered
 * webhook — which Meta sends for up to seven days — must not queue a second reading of one recording.
 */
export async function createPendingTranscripts(
  db: DbExecutor,
  input: {
    readonly workspaceId: string;
    readonly businessProfileId: string;
    readonly messageId: string;
    readonly media: readonly PendingTranscriptInput[];
    readonly at: Date;
  },
): Promise<{ readonly created: number }> {
  if (input.media.length === 0) {
    return { created: 0 };
  }
  const written = await db.messageTranscript.createMany({
    data: input.media.map((media) => ({
      workspaceId: input.workspaceId,
      businessProfileId: input.businessProfileId,
      messageId: input.messageId,
      providerMediaId: media.providerMediaId,
      mimeType: media.mimeType ?? null,
      sizeBytes: media.sizeBytes ?? null,
      state: "PENDING" as const,
      requestedAt: input.at,
    })),
    // A redelivered webhook is ordinary rather than exceptional, and a second row for one recording would
    // mean two readings of it and two chances to disagree.
    skipDuplicates: true,
  });
  return { created: written.count };
}

/** Everything the worker needs to read one message's recordings, or an empty list if there is nothing. */
export async function loadTranscriptionWork(
  db: DbExecutor,
  scope: { readonly workspaceId: string; readonly messageId: string },
): Promise<readonly TranscriptionWork[]> {
  const rows = await db.messageTranscript.findMany({
    where: { workspaceId: scope.workspaceId, messageId: scope.messageId },
    orderBy: { providerMediaId: "asc" },
    select: {
      id: true,
      workspaceId: true,
      businessProfileId: true,
      messageId: true,
      providerMediaId: true,
      mimeType: true,
      state: true,
      attemptCount: true,
      message: { select: { channelAccountId: true, occurredAt: true } },
    },
  });
  return rows.map((row) => ({
    transcriptId: row.id,
    workspaceId: row.workspaceId,
    businessProfileId: row.businessProfileId,
    messageId: row.messageId,
    channelAccountId: row.message.channelAccountId,
    providerMediaId: row.providerMediaId,
    mimeType: row.mimeType ?? undefined,
    state: row.state,
    attemptCount: row.attemptCount,
    messageOccurredAt: row.message.occurredAt,
  }));
}

export interface RecordedTranscript {
  readonly text: string;
  readonly provider: string;
  readonly model: string;
  readonly modelRevision?: string;
  readonly language?: string;
  readonly confidence?: number;
  readonly confidenceSource?: "PROVIDER" | "DERIVED";
  readonly durationSeconds?: number;
  readonly providerRequestId?: string;
  readonly latencyMs?: number;
}

/**
 * Stores a successful reading.
 *
 * Conditional on the row still being `PENDING`. Two workers reading the same recording would otherwise
 * both write, and the second would overwrite the first's words with its own — a silent disagreement about
 * what a customer said, with nothing to show that it happened.
 */
export async function recordTranscript(
  db: DbExecutor,
  input: {
    readonly workspaceId: string;
    readonly transcriptId: string;
    readonly transcript: RecordedTranscript;
    readonly at: Date;
  },
): Promise<{ readonly recorded: boolean }> {
  const changed = await db.messageTranscript.updateMany({
    where: { workspaceId: input.workspaceId, id: input.transcriptId, state: "PENDING" },
    data: {
      state: "READY",
      text: input.transcript.text,
      provider: input.transcript.provider,
      model: input.transcript.model,
      modelRevision: input.transcript.modelRevision ?? null,
      language: input.transcript.language ?? null,
      // Set together or not at all: the CHECK refuses a number with no source, because a figure nobody
      // can attribute is indistinguishable from one somebody invented.
      confidence: input.transcript.confidence ?? null,
      confidenceSource: input.transcript.confidence === undefined ? null : (input.transcript.confidenceSource ?? "PROVIDER"),
      durationSeconds: input.transcript.durationSeconds ?? null,
      providerRequestId: input.transcript.providerRequestId ?? null,
      latencyMs: input.transcript.latencyMs ?? null,
      failureReason: null,
      failureCode: null,
      completedAt: input.at,
      attemptCount: { increment: 1 },
    },
  });
  return { recorded: changed.count === 1 };
}

/**
 * Stores a failure, and says whether it is the kind that could ever succeed.
 *
 * `UNSUPPORTED` rather than `FAILED` when asking again cannot change the answer, because the two are
 * different sentences to an operator and different decisions for the queue: one is worth retrying and the
 * other only delays the review item somebody is waiting for.
 *
 * `retryable` leaves the row `PENDING` so the queue's own retry can have another go; the attempt is still
 * counted, and the reason is recorded, so a row that keeps failing is visible rather than merely slow.
 */
export async function recordTranscriptionFailure(
  db: DbExecutor,
  input: {
    readonly workspaceId: string;
    readonly transcriptId: string;
    readonly reason: string;
    readonly code?: string;
    readonly retryable: boolean;
    readonly permanentlyUnsupported: boolean;
    readonly at: Date;
  },
): Promise<{ readonly recorded: boolean }> {
  const state = input.retryable ? "PENDING" : input.permanentlyUnsupported ? "UNSUPPORTED" : "FAILED";
  const changed = await db.messageTranscript.updateMany({
    where: { workspaceId: input.workspaceId, id: input.transcriptId, state: "PENDING" },
    data: {
      state,
      // Never words. The CHECK forbids them on anything but READY, and a half-written reading reaching a
      // reply as though the recording had been understood is the failure this prevents.
      text: null,
      failureReason: input.reason,
      failureCode: input.code ?? null,
      attemptCount: { increment: 1 },
      // A pending row has not finished, and the CHECK ties the two together.
      completedAt: input.retryable ? null : input.at,
    },
  });
  return { recorded: changed.count === 1 };
}

/**
 * The readings for these messages, for the draft context.
 *
 * Returns failures as well as successes, because the draft path has to tell "nothing was recorded" from
 * "we tried and could not hear it" — the second one holds the reply for a person.
 */
export async function readMessageTranscripts(
  db: DbExecutor,
  scope: { readonly workspaceId: string; readonly messageIds: readonly string[] },
): Promise<readonly MessageTranscriptRecord[]> {
  if (scope.messageIds.length === 0) {
    return [];
  }
  const rows = await db.messageTranscript.findMany({
    where: { workspaceId: scope.workspaceId, messageId: { in: [...scope.messageIds] } },
    orderBy: [{ messageId: "asc" }, { providerMediaId: "asc" }],
    select: {
      messageId: true,
      providerMediaId: true,
      state: true,
      text: true,
      language: true,
      provider: true,
      model: true,
      confidence: true,
      failureReason: true,
    },
  });
  return rows.map((row) => ({
    messageId: row.messageId,
    providerMediaId: row.providerMediaId,
    state: row.state,
    text: row.text ?? undefined,
    language: row.language ?? undefined,
    provider: row.provider ?? undefined,
    model: row.model ?? undefined,
    confidence: row.confidence ?? undefined,
    failureReason: row.failureReason ?? undefined,
  }));
}

/**
 * Records that the provider's copy of this recording is gone.
 *
 * The retention hook's own memory. The deletion itself happens at the provider; this is what stops a
 * later sweep asking for it again, and what lets an operator answering a customer's deletion request say
 * when it was done rather than that it probably was.
 */
export async function markTranscriptMediaDeleted(
  db: DbExecutor,
  input: { readonly workspaceId: string; readonly transcriptId: string; readonly at: Date },
): Promise<{ readonly marked: boolean }> {
  const changed = await db.messageTranscript.updateMany({
    where: { workspaceId: input.workspaceId, id: input.transcriptId, mediaDeletedAt: null },
    data: { mediaDeletedAt: input.at },
  });
  return { marked: changed.count === 1 };
}
