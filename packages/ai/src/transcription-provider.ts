/**
 * Reading a voice note with OpenAI's audio transcription endpoint (Issue #21).
 *
 * Verified against the live documentation on 2026-10-05, which has moved: `platform.openai.com` now
 * answers 403 and 301, and the reference lives at `developers.openai.com`. Five facts from that reading
 * are load-bearing, and two of them are the reason this file looks the way it does.
 *
 * **The default model is `gpt-transcribe`, and it reports no confidence at all.** There is no
 * whole-response confidence field anywhere in the API. Per-token `logprobs` exist only on the
 * `gpt-4o-transcribe` family and per-segment `avg_logprob` only on `whisper-1` through `verbose_json` —
 * and every one of those models is removed on 2027-02-26. So this adapter asks for nothing of the kind
 * and returns no `confidence`: a number invented here would be a certainty nobody measured, attached to a
 * reading of a customer's own words.
 *
 * **`whisper-1` is deprecated.** Notified 2026-08-26, removed from the API on 2027-02-26, with
 * `gpt-transcribe` named as the replacement. The model is configuration rather than a constant, so moving
 * is an environment change — but the default is the one with a future.
 *
 * **The documented input formats are `mp3`, `mp4`, `mpeg`, `mpga`, `m4a`, `wav` and `webm`.** WhatsApp
 * voice notes are `audio/ogg; codecs=opus`, which is *not* in that list — though the official OpenAPI
 * spec still names `ogg`, a list that looks like a Whisper-era leftover. This adapter sends what it was
 * given, with an accurate filename and content type, and lets the provider's own answer settle it. A
 * refusal is a typed refusal that becomes a review item; it is never a transcript. Guessing the provider's
 * rule either way would be inventing one, and the undocumented container is logged so that the day it
 * starts failing the reason is already in the logs.
 *
 * **The size limit is 25 MB and no status code is published for breaking it**, so it is enforced here.
 *
 * **`usage` is a union discriminated on `type`** — `{type:"tokens",…}` or `{type:"duration",seconds}` —
 * and reading one shape as the other is the parsing trap this endpoint sets.
 *
 * Nothing in this file logs a byte of audio, a transcript or a key.
 */
import { randomUUID } from "node:crypto";

import type { Logger } from "@omnichannel/observability";
import type { TranscriptionOutcome, TranscriptionProvider, TranscriptionRequest } from "@omnichannel/application";

import { createFetchModelHttpPort, type ModelHttpPort, type ModelHttpResult } from "./transport";

export const OPENAI_TRANSCRIPTION_URL = "https://api.openai.com/v1/audio/transcriptions";
/** The current recommended model. `whisper-1` is removed from the API on 2027-02-26. */
export const DEFAULT_TRANSCRIPTION_MODEL = "gpt-transcribe";
/** "Files can be up to 25 MB." No status code is documented for exceeding it, so it is checked here. */
export const MAX_TRANSCRIPTION_BYTES = 25 * 1024 * 1024;
/** The formats the live guide lists. Anything else is still sent; the provider decides. */
export const DOCUMENTED_TRANSCRIPTION_FORMATS = ["mp3", "mp4", "mpeg", "mpga", "m4a", "wav", "webm"] as const;

const TRANSCRIPTION_TIMEOUT_MS = 120_000;

/**
 * Error codes that mean money rather than weather.
 *
 * Read as codes, never as prose. They arrive on 429 beside ordinary throttling, and the difference
 * matters: retrying a spend limit is how a bill becomes a loop.
 */
const QUOTA_CODES: ReadonlySet<string> = new Set([
  "insufficient_quota",
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
]);

export interface OpenAiTranscriptionConfig {
  readonly apiKey: string;
  /** Defaults to `gpt-transcribe`. An operator may name another; the result records what actually ran. */
  readonly model?: string;
  readonly url?: string;
  readonly http?: ModelHttpPort;
  readonly logger?: Logger;
  /** Injected so a test can assert the exact multipart body. Defaults to a random boundary. */
  readonly newBoundary?: () => string;
  readonly now?: () => number;
}

export function createOpenAiTranscriptionProvider(config: OpenAiTranscriptionConfig): TranscriptionProvider {
  const http = config.http ?? createFetchModelHttpPort();
  const model = config.model ?? DEFAULT_TRANSCRIPTION_MODEL;
  const url = config.url ?? OPENAI_TRANSCRIPTION_URL;
  const newBoundary = config.newBoundary ?? (() => `omnichannel-${randomUUID()}`);
  const now = config.now ?? (() => Date.now());

  return {
    provider: "openai",
    model,

    async transcribe(request: TranscriptionRequest): Promise<TranscriptionOutcome> {
      if (!request.mimeType.toLowerCase().startsWith("audio/")) {
        // A guard against being handed the wrong attachment entirely. The container question is the
        // provider's to answer; "this is not audio" is ours, and it cannot change on a retry.
        return { ok: false, reason: "UNSUPPORTED_AUDIO", code: "NOT_AUDIO" };
      }
      if (request.audio.byteLength === 0) {
        return { ok: false, reason: "UNSUPPORTED_AUDIO", code: "EMPTY_AUDIO" };
      }
      if (request.audio.byteLength > MAX_TRANSCRIPTION_BYTES) {
        // No documented status for this, so refusing locally is the only way it reads as a sentence.
        return { ok: false, reason: "TOO_LARGE", code: "OVER_25MB" };
      }
      if (!documentedFormat(request.filename)) {
        // Not a refusal: the provider decides. Logged so that the day an undocumented container starts
        // failing, the reason is already in the logs rather than something to go looking for.
        config.logger?.info("ai.transcription_undocumented_format", { model, mimeType: baseMimeType(request.mimeType) });
      }

      const boundary = newBoundary();
      const startedAt = now();
      const result = await http.send({
        url,
        headers: { authorization: `Bearer ${config.apiKey}`, "content-type": `multipart/form-data; boundary=${boundary}` },
        body: multipartBody(boundary, request, model),
        timeoutMs: TRANSCRIPTION_TIMEOUT_MS,
      });
      const latencyMs = Math.max(0, now() - startedAt);

      return readOutcome(result, { provider: "openai", model, latencyMs });
    },
  };
}

function readOutcome(
  result: ModelHttpResult,
  context: { readonly provider: string; readonly model: string; readonly latencyMs: number },
): TranscriptionOutcome {
  if (result.kind === "NO_RESPONSE") {
    // Nothing was produced, so another attempt is safe — unlike an outbound send, a failed reading
    // leaves nothing behind.
    return { ok: false, reason: "UNAVAILABLE", code: result.reason };
  }
  if (result.status < 200 || result.status >= 300) {
    return failureFor(result);
  }
  const payload = safeJson(result.body);
  if (payload === undefined) {
    return { ok: false, reason: "MALFORMED_RESULT" };
  }
  const text = typeof payload["text"] === "string" ? payload["text"].trim() : undefined;
  if (text === undefined) {
    return { ok: false, reason: "MALFORMED_RESULT" };
  }
  if (text === "") {
    // A reading with no words is not a transcript of silence: the difference is whether a person should
    // look, and a draft written against "" would answer a recording nobody heard.
    return { ok: false, reason: "EMPTY_RESULT" };
  }
  return {
    ok: true,
    transcript: {
      text,
      provider: context.provider,
      // What actually ran, when the provider says so, rather than the alias that was asked for.
      model: typeof payload["model"] === "string" && payload["model"] !== "" ? payload["model"] : context.model,
      latencyMs: context.latencyMs,
      ...optional("language", firstLanguage(payload)),
      ...optional("providerRequestId", result.requestId),
      ...durationOf(payload),
      // No `confidence`. The default model publishes none, and the two mechanisms that do exist live on
      // models removed on 2027-02-26. An invented number would be a certainty nobody measured.
    },
  };
}

function failureFor(result: Extract<ModelHttpResult, { kind: "RESPONSE" }>): TranscriptionOutcome {
  const payload = safeJson(result.body);
  const error = payload === undefined ? undefined : payload["error"];
  const code = typeof error === "object" && error !== null ? stringField(error as Record<string, unknown>, "code") : undefined;
  const retryAfter = result.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: result.retryAfterSeconds };
  const named = code === undefined ? `HTTP_${String(result.status)}` : code;

  if (code !== undefined && QUOTA_CODES.has(code)) {
    // Money, not weather. Retrying this is how a spend limit becomes a loop.
    return { ok: false, reason: "QUOTA_EXHAUSTED", code };
  }
  if (result.status === 429 || result.status >= 500) {
    return { ok: false, reason: "UNAVAILABLE", code: named, ...retryAfter };
  }
  // Everything else — 400 for a container the provider will not read, 401, 403 — is the same refusal
  // every time. It is deliberately *not* reported as `UNSUPPORTED_AUDIO`: distinguishing a rejected
  // codec from any other bad request would mean reading the provider's prose, and the provider's prose
  // can quote the recording. The code is recorded instead, and the behaviour is identical either way.
  return { ok: false, reason: "PROVIDER_REJECTED", code: named };
}

/**
 * The multipart body, as bytes.
 *
 * Hand-built rather than through `FormData` because the transport takes a body it can hand straight to
 * `fetch`, and a `FormData` object would make the request untestable without a network: the suite asserts
 * the exact bytes a provider would receive.
 */
function multipartBody(boundary: string, request: TranscriptionRequest, model: string): Uint8Array {
  const parts: Buffer[] = [];
  const field = (name: string, value: string): void => {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, "utf8"));
  };

  field("model", model);
  // `languages[]` and `keywords[]` are repeated fields rather than JSON arrays, and both are
  // `gpt-transcribe` features. They are hints: detection stays the provider's, and its answer is what
  // gets recorded.
  for (const language of request.languageHints ?? []) {
    field("languages[]", language);
  }
  for (const keyword of request.keywords ?? []) {
    field("keywords[]", keyword);
  }
  // `response_format` is deliberately not sent. The default is `json`, which is the only shape the
  // recommended model produces, and naming it would be one more thing to keep in step with the provider.

  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${sanitizeFilename(request.filename)}"\r\n` +
        `Content-Type: ${request.mimeType}\r\n\r\n`,
      "utf8",
    ),
    Buffer.from(request.audio),
    Buffer.from("\r\n", "utf8"),
    Buffer.from(`--${boundary}--\r\n`, "utf8"),
  );
  return new Uint8Array(Buffer.concat(parts));
}

/**
 * The filename as the provider may see it.
 *
 * The caller generates it, so this is defence rather than cleaning: a quote or a newline here would let
 * the name break out of its own `Content-Disposition` header and forge another part.
 */
function sanitizeFilename(filename: string): string {
  const cleaned = filename.replace(/[^A-Za-z0-9._-]/gu, "");
  return cleaned === "" ? "audio" : cleaned.slice(0, 120);
}

function documentedFormat(filename: string): boolean {
  const extension = filename.toLowerCase().split(".").pop() ?? "";
  return (DOCUMENTED_TRANSCRIPTION_FORMATS as readonly string[]).includes(extension);
}

function baseMimeType(mimeType: string): string {
  const [base] = mimeType.split(";");
  return (base ?? "").trim().toLowerCase();
}

/**
 * The detected language, as ISO-639-1.
 *
 * `gpt-transcribe` answers with `languages: [{code}]` and an empty array means it could not tell — which
 * is a real answer and must not become a guess. Older models answer with a single `language` whose
 * documented value is the English *name* rather than a code, so that path is read but not relabelled.
 */
function firstLanguage(payload: Readonly<Record<string, unknown>>): string | undefined {
  const languages = payload["languages"];
  if (Array.isArray(languages)) {
    for (const entry of languages) {
      if (typeof entry === "object" && entry !== null) {
        const code = stringField(entry as Record<string, unknown>, "code");
        if (code !== undefined) {
          return code;
        }
      }
    }
    return undefined;
  }
  return stringField(payload, "language");
}

/** `usage` is a union discriminated on `type`; only the duration variant carries a length. */
function durationOf(payload: Readonly<Record<string, unknown>>): { readonly durationSeconds?: number } {
  const direct = payload["duration"];
  if (typeof direct === "number" && Number.isFinite(direct) && direct > 0) {
    return { durationSeconds: direct };
  }
  const usage = payload["usage"];
  if (typeof usage !== "object" || usage === null) {
    return {};
  }
  const row = usage as Record<string, unknown>;
  if (row["type"] !== "duration") {
    return {};
  }
  const seconds = row["seconds"];
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? { durationSeconds: seconds } : {};
}

function optional<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}

function stringField(payload: Readonly<Record<string, unknown>>, field: string): string | undefined {
  const value = payload[field];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function safeJson(body: string): Readonly<Record<string, unknown>> | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
