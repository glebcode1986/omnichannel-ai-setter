/**
 * Reading a voice note (Issue #21).
 *
 * Two properties carry this file. **No confidence is ever invented** — the recommended model publishes
 * none, and a number made up here would be a certainty nobody measured attached to a reading of a
 * customer's own words. And **a refusal is never a transcript**: every unhappy path returns a typed
 * reason, because a draft written against an empty string answers a recording nobody heard.
 *
 * The third is about this provider specifically: WhatsApp voice notes are `audio/ogg; codecs=opus`, which
 * is not in the documented input list, so the adapter sends it and lets the provider's own answer settle
 * the question rather than inventing a rule either way.
 */
import { describe, expect, it } from "vitest";

import {
  createOpenAiTranscriptionProvider,
  DEFAULT_TRANSCRIPTION_MODEL,
  MAX_TRANSCRIPTION_BYTES,
  OPENAI_TRANSCRIPTION_URL,
} from "./transcription-provider";
import type { ModelHttpPort, ModelHttpRequest, ModelHttpResult } from "./transport";

const API_KEY = "sk-test-not-a-real-key";
const BOUNDARY = "test-boundary";

const audio = (size = 32): Uint8Array => {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) {
    // Deliberately includes bytes that are not valid UTF-8, which is the whole reason the transport
    // carries `Uint8Array`: a string body would have replaced them.
    bytes[index] = (index * 37) % 256;
  }
  return bytes;
};

const ok = (body: Readonly<Record<string, unknown>>, extra: Partial<Extract<ModelHttpResult, { kind: "RESPONSE" }>> = {}): ModelHttpResult => ({
  kind: "RESPONSE",
  status: 200,
  body: JSON.stringify(body),
  ...extra,
});

const failed = (status: number, body: unknown, extra: Partial<Extract<ModelHttpResult, { kind: "RESPONSE" }>> = {}): ModelHttpResult => ({
  kind: "RESPONSE",
  status,
  body: typeof body === "string" ? body : JSON.stringify(body),
  ...extra,
});

function provider(results: readonly ModelHttpResult[], options: { readonly model?: string } = {}) {
  const queued = [...results];
  const requests: ModelHttpRequest[] = [];
  const http: ModelHttpPort = {
    send(request) {
      requests.push(request);
      return Promise.resolve(queued.shift() ?? { kind: "NO_RESPONSE", reason: "NETWORK" });
    },
  };
  let clock = 1_000;
  return {
    requests,
    transcriber: createOpenAiTranscriptionProvider({
      apiKey: API_KEY,
      http,
      newBoundary: () => BOUNDARY,
      now: () => {
        clock += 25;
        return clock;
      },
      ...(options.model === undefined ? {} : { model: options.model }),
    }),
  };
}

const voiceNote = { audio: audio(), mimeType: "audio/ogg; codecs=opus", filename: "voice-note.ogg" } as const;

const bodyBytes = (request: ModelHttpRequest | undefined): Buffer => {
  const body = request?.body;
  if (body === undefined) {
    return Buffer.alloc(0);
  }
  return typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body);
};

describe("the model this adapter asks for", () => {
  it("defaults to the one with a future, not the deprecated one", () => {
    // `whisper-1` is removed from the API on 2027-02-26; `gpt-transcribe` is the named replacement.
    expect(DEFAULT_TRANSCRIPTION_MODEL).toBe("gpt-transcribe");
    expect(provider([]).transcriber.model).toBe("gpt-transcribe");
  });

  it("lets an operator name another, and reports what it was told to run", () => {
    expect(provider([], { model: "whisper-1" }).transcriber.model).toBe("whisper-1");
  });
});

describe("the request a provider receives", () => {
  it("posts multipart with the audio, the model and the content type", async () => {
    const test = provider([ok({ text: "Hello, are you open on Saturday?" })]);

    await test.transcriber.transcribe(voiceNote);

    const request = test.requests[0];
    expect(request?.url).toBe(OPENAI_TRANSCRIPTION_URL);
    expect(request?.headers["authorization"]).toBe(`Bearer ${API_KEY}`);
    expect(request?.headers["content-type"]).toBe(`multipart/form-data; boundary=${BOUNDARY}`);
    const body = bodyBytes(request).toString("latin1");
    expect(body).toContain(`Content-Disposition: form-data; name="model"`);
    expect(body).toContain("gpt-transcribe");
    expect(body).toContain(`filename="voice-note.ogg"`);
    expect(body).toContain("Content-Type: audio/ogg; codecs=opus");
  });

  it("carries the audio bytes through unchanged", async () => {
    // The reason the transport takes `Uint8Array`: these bytes are not valid UTF-8, and a string body
    // would have replaced them with U+FFFD before the provider ever saw the recording.
    const test = provider([ok({ text: "unchanged" })]);
    const sent = audio(64);

    await test.transcriber.transcribe({ ...voiceNote, audio: sent });

    const body = bodyBytes(test.requests[0]);
    expect(body.includes(Buffer.from(sent))).toBe(true);
  });

  it("sends the language and keyword hints as repeated fields", async () => {
    const test = provider([ok({ text: "da" })]);

    await test.transcriber.transcribe({ ...voiceNote, languageHints: ["ru", "en"], keywords: ["Omnichannel"] });

    const body = bodyBytes(test.requests[0]).toString("latin1");
    expect(body.match(/name="languages\[\]"/gu)).toHaveLength(2);
    expect(body).toContain("name=\"keywords[]\"");
    expect(body).toContain("Omnichannel");
  });

  it("does not name a response format, because the default is the only shape this model produces", async () => {
    const test = provider([ok({ text: "x" })]);

    await test.transcriber.transcribe(voiceNote);

    expect(bodyBytes(test.requests[0]).toString("latin1")).not.toContain("response_format");
  });

  it("asks for no logprobs, because a confidence it cannot measure must not be implied", async () => {
    const test = provider([ok({ text: "x" })]);

    await test.transcriber.transcribe(voiceNote);

    expect(bodyBytes(test.requests[0]).toString("latin1")).not.toContain("logprobs");
  });

  it("never puts the key anywhere but the header", async () => {
    const test = provider([ok({ text: "x" })]);

    await test.transcriber.transcribe(voiceNote);

    expect(bodyBytes(test.requests[0]).toString("latin1")).not.toContain(API_KEY);
    expect(test.requests[0]?.url).not.toContain(API_KEY);
  });

  it("strips a filename that could forge another multipart part", async () => {
    // The caller generates the name, so this is defence rather than cleaning: a quote or a newline would
    // let it break out of its own Content-Disposition header.
    const test = provider([ok({ text: "x" })]);

    await test.transcriber.transcribe({ ...voiceNote, filename: 'a"\r\n--boundary\r\nContent-Disposition: form-data; name="model"\r\n\r\nevil' });

    const body = bodyBytes(test.requests[0]).toString("latin1");
    // Every character that could close the quoted string or start a header is gone, so the forged part
    // collapses into one harmless filename.
    expect(body).toContain('filename="a--boundaryContent-Dispositionform-datanamemodelevil"');
    expect(body.match(/name="model"/gu)).toHaveLength(1);
  });
});

describe("a reading that succeeded", () => {
  it("returns the text, the model that ran and how long it took", async () => {
    const test = provider([ok({ text: "  Are you open on Saturday?  ", model: "gpt-transcribe-2026-09-01" }, { requestId: "req_1" })]);

    const outcome = await test.transcriber.transcribe(voiceNote);

    expect(outcome).toMatchObject({
      ok: true,
      transcript: {
        text: "Are you open on Saturday?",
        provider: "openai",
        // What actually ran, rather than the alias that was asked for.
        model: "gpt-transcribe-2026-09-01",
        providerRequestId: "req_1",
        latencyMs: 25,
      },
    });
  });

  it("carries no confidence at all, because the provider reports none", async () => {
    const test = provider([ok({ text: "heard clearly" })]);

    const outcome = await test.transcriber.transcribe(voiceNote);

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect("confidence" in outcome.transcript).toBe(false);
      expect("confidenceSource" in outcome.transcript).toBe(false);
    }
  });

  it("reads the detected language as a code, and an empty array as no answer", async () => {
    const detected = provider([ok({ text: "da", languages: [{ code: "ru" }] })]);
    const outcome = await detected.transcriber.transcribe(voiceNote);
    expect(outcome.ok && outcome.transcript.language).toBe("ru");

    // An empty array is the provider saying it could not tell. That is a real answer, not a default.
    const undetected = provider([ok({ text: "mmm", languages: [] })]);
    const second = await undetected.transcriber.transcribe(voiceNote);
    expect(second.ok && "language" in second.transcript).toBe(false);
  });

  it("reads a duration from either place the provider puts one", async () => {
    const fromUsage = provider([ok({ text: "x", usage: { type: "duration", seconds: 4 } })]);
    expect((await fromUsage.transcriber.transcribe(voiceNote)).ok && true).toBe(true);
    const outcome = await provider([ok({ text: "x", usage: { type: "duration", seconds: 4 } })]).transcriber.transcribe(voiceNote);
    expect(outcome.ok && outcome.transcript.durationSeconds).toBe(4);

    const verbose = await provider([ok({ text: "x", duration: 3.32 })]).transcriber.transcribe(voiceNote);
    expect(verbose.ok && verbose.transcript.durationSeconds).toBe(3.32);
  });

  it("does not read the token usage variant as a duration", async () => {
    // `usage` is a union discriminated on `type`, and reading one shape as the other is the trap this
    // endpoint sets: 59 total tokens is not a 59-second recording.
    const outcome = await provider([
      ok({ text: "x", usage: { type: "tokens", input_tokens: 14, output_tokens: 45, total_tokens: 59 } }),
    ]).transcriber.transcribe(voiceNote);

    expect(outcome.ok && "durationSeconds" in outcome.transcript).toBe(false);
  });
});

describe("a reading that did not", () => {
  it("refuses an attachment that is not audio without asking the provider", async () => {
    const test = provider([ok({ text: "should not happen" })]);

    expect(await test.transcriber.transcribe({ ...voiceNote, mimeType: "image/jpeg", filename: "photo.jpg" })).toEqual({
      ok: false,
      reason: "UNSUPPORTED_AUDIO",
      code: "NOT_AUDIO",
    });
    expect(test.requests).toHaveLength(0);
  });

  it("refuses an empty recording and an oversize one locally", async () => {
    const test = provider([ok({ text: "x" }), ok({ text: "x" })]);

    expect(await test.transcriber.transcribe({ ...voiceNote, audio: new Uint8Array(0) })).toMatchObject({ reason: "UNSUPPORTED_AUDIO", code: "EMPTY_AUDIO" });
    // 25 MB, and no status code is published for breaking it — so it reads as a sentence only if we say it.
    expect(await test.transcriber.transcribe({ ...voiceNote, audio: new Uint8Array(MAX_TRANSCRIPTION_BYTES + 1) })).toMatchObject({
      reason: "TOO_LARGE",
      code: "OVER_25MB",
    });
    expect(test.requests).toHaveLength(0);
  });

  it("sends an undocumented container anyway and reports the provider's own refusal", async () => {
    // WhatsApp voice notes are ogg/opus, which the live guide does not list. Guessing the rule either way
    // would be inventing one; the provider's answer settles it, and a refusal becomes a review item.
    const test = provider([failed(400, { error: { type: "invalid_request_error", message: "Unsupported file format", code: "unsupported_value", param: "file" } })]);

    const outcome = await test.transcriber.transcribe(voiceNote);

    expect(test.requests).toHaveLength(1);
    expect(outcome).toEqual({ ok: false, reason: "PROVIDER_REJECTED", code: "unsupported_value" });
    // Never the provider's prose: it can quote the recording.
    expect(JSON.stringify(outcome)).not.toContain("Unsupported file format");
  });

  it("treats throttling and overload as worth another attempt, and honours Retry-After", async () => {
    const throttled = await provider([failed(429, { error: { code: "rate_limit_exceeded" } }, { retryAfterSeconds: 7 })]).transcriber.transcribe(voiceNote);
    expect(throttled).toEqual({ ok: false, reason: "UNAVAILABLE", code: "rate_limit_exceeded", retryAfterSeconds: 7 });

    const overloaded = await provider([failed(503, { error: { code: "server_is_overloaded" } })]).transcriber.transcribe(voiceNote);
    expect(overloaded).toMatchObject({ reason: "UNAVAILABLE", code: "server_is_overloaded" });

    const unreachable = await provider([{ kind: "NO_RESPONSE", reason: "TIMEOUT" }]).transcriber.transcribe(voiceNote);
    expect(unreachable).toEqual({ ok: false, reason: "UNAVAILABLE", code: "TIMEOUT" });
  });

  it("does not retry money", async () => {
    // Quota arrives on 429 beside ordinary throttling. Retrying a spend limit is how a bill becomes a loop.
    for (const code of ["insufficient_quota", "credit_balance_exhausted", "organization_spend_limit_exceeded", "project_spend_limit_exceeded", "organization_usage_limit_exceeded"]) {
      const outcome = await provider([failed(429, { error: { code } }, { retryAfterSeconds: 60 })]).transcriber.transcribe(voiceNote);
      expect(outcome).toEqual({ ok: false, reason: "QUOTA_EXHAUSTED", code });
    }
  });

  it("reports a refused credential as a refusal rather than an outage", async () => {
    const outcome = await provider([failed(401, { error: { code: "invalid_api_key" } })]).transcriber.transcribe(voiceNote);

    expect(outcome).toEqual({ ok: false, reason: "PROVIDER_REJECTED", code: "invalid_api_key" });
  });

  it("names the status when the provider sends no code", async () => {
    const outcome = await provider([failed(418, "not json at all")]).transcriber.transcribe(voiceNote);

    expect(outcome).toEqual({ ok: false, reason: "PROVIDER_REJECTED", code: "HTTP_418" });
  });

  it("separates a result it cannot read from one with no words in it", async () => {
    const malformed = await provider([ok({ unexpected: "shape" })]).transcriber.transcribe(voiceNote);
    expect(malformed).toEqual({ ok: false, reason: "MALFORMED_RESULT" });

    const unparseable = await provider([{ kind: "RESPONSE", status: 200, body: "<html>" }]).transcriber.transcribe(voiceNote);
    expect(unparseable).toEqual({ ok: false, reason: "MALFORMED_RESULT" });

    // A reading with no words is not a transcript of silence, and a draft against "" would answer a
    // recording nobody heard.
    const empty = await provider([ok({ text: "   " })]).transcriber.transcribe(voiceNote);
    expect(empty).toEqual({ ok: false, reason: "EMPTY_RESULT" });
  });
});
