/**
 * Fetching a customer's media (Issue #21).
 *
 * The cases here are the ones where believing the provider, or the payload, costs something real: a media
 * ID from an untrusted webhook that belongs to another business, a stated size that the response then
 * breaks, a URL that expired while the worker was busy, a type the platform never carried. Each is a
 * well-formed answer to a question nobody asked.
 */
import { describe, expect, it } from "vitest";

import {
  deleteMedia,
  downloadMedia,
  MAX_MEDIA_BYTES,
  MEDIA_LIMITS,
  MEDIA_URL_TTL_MS,
  mediaIdUsable,
  mediaLimitFor,
  mediaSupported,
  resolveMediaUrl,
  TRANSCRIBABLE_MIME_TYPES,
  transcribableMimeType,
  WEBHOOK_MEDIA_ID_TTL_MS,
} from "./media";
import { BINDING, config, scriptedHttp } from "./__fixtures__/payloads";
import { resolveConfig } from "./config";
import type { WhatsAppHttpResult } from "./http";

const MEDIA_ID = "1037543291543636";
const MEDIA_URL = "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1037543291543636";

const ok = (body: Readonly<Record<string, unknown>>): WhatsAppHttpResult => ({ kind: "RESPONSE", status: 200, body: JSON.stringify(body) });
const bytes = (size: number): WhatsAppHttpResult => ({ kind: "RESPONSE", status: 200, body: "\u0000".repeat(size) });
const located = (overrides: Readonly<Record<string, unknown>> = {}) =>
  ok({ messaging_product: "whatsapp", url: MEDIA_URL, mime_type: "audio/ogg", sha256: "abc123", file_size: 2048, id: MEDIA_ID, ...overrides });

const location = (overrides: Partial<{ url: string; mimeType: string; sha256: string; fileSizeBytes: number }> = {}) => ({
  url: MEDIA_URL,
  mimeType: "audio/ogg",
  sha256: "abc123",
  fileSizeBytes: 2048,
  ...overrides,
});

function harness(results: readonly WhatsAppHttpResult[], overrides: Partial<Parameters<typeof config>[0]> = {}) {
  const http = scriptedHttp(results);
  // Resolved, as production resolves it: the defaults — the Graph host, the version, and whether the
  // number is connected — are part of what these calls read, so a test that skipped them would be asking
  // a different question than the adapter answers.
  return { config: resolveConfig(config({ http: http.port, ...overrides })), requests: http.requests };
}

describe("the platform numbers this file is pinned to", () => {
  it("states the provider's own limits rather than one of our own", () => {
    // Re-verified 2026-10-04. The spread is the point: accepting a 100 MB "voice note" because documents
    // may be that large would hand a transcriber a file six times what the platform allows for audio.
    expect(MEDIA_LIMITS["audio/ogg"]).toBe(16 * 1024 * 1024);
    expect(MEDIA_LIMITS["image/jpeg"]).toBe(5 * 1024 * 1024);
    expect(MEDIA_LIMITS["application/pdf"]).toBe(100 * 1024 * 1024);
    expect(MEDIA_LIMITS["image/webp"]).toBe(500 * 1024);
    expect(MAX_MEDIA_BYTES).toBe(100 * 1024 * 1024);
  });

  it("states the two lifetimes, which are different and both short", () => {
    // A media ID from a webhook lives seven days — not the thirty an uploaded one gets — and the resolved
    // URL lives five minutes, which is why it is never persisted.
    expect(WEBHOOK_MEDIA_ID_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(MEDIA_URL_TTL_MS).toBe(5 * 60 * 1000);
  });

  it("offers transcription for the five audio types and nothing else", () => {
    expect([...TRANSCRIBABLE_MIME_TYPES]).toEqual(["audio/aac", "audio/amr", "audio/mpeg", "audio/mp4", "audio/ogg"]);
    expect(transcribableMimeType("audio/ogg; codecs=opus")).toBe(true);
    for (const mimeType of ["image/jpeg", "video/mp4", "application/pdf", "audio/wav"]) {
      expect(transcribableMimeType(mimeType)).toBe(false);
    }
  });

  it("reads a parameterised MIME type as its base type", () => {
    expect(mediaLimitFor("audio/ogg; codecs=opus")).toBe(16 * 1024 * 1024);
    expect(mediaSupported("IMAGE/JPEG")).toBe(true);
    expect(mediaSupported("audio/wav")).toBe(false);
  });
});

describe("a media ID from a webhook", () => {
  it("is usable for seven days and not after", () => {
    const received = new Date("2026-10-04T12:00:00.000Z");

    expect(mediaIdUsable(received, new Date(received.getTime() + WEBHOOK_MEDIA_ID_TTL_MS - 1))).toBe(true);
    // A retry that outlives this is retrying against something the provider has forgotten.
    expect(mediaIdUsable(received, new Date(received.getTime() + WEBHOOK_MEDIA_ID_TTL_MS))).toBe(false);
  });
});

describe("resolving the download URL", () => {
  it("reads the URL, type, hash and size", async () => {
    const test = harness([located()]);

    const result = await resolveMediaUrl(test.config, MEDIA_ID);

    expect(result).toEqual({ ok: true, value: { url: MEDIA_URL, mimeType: "audio/ogg", sha256: "abc123", fileSizeBytes: 2048 } });
  });

  it("always names the business phone number, which is the provider's own tenancy check", async () => {
    // A media ID is a bare string in an untrusted payload. Meta honours the request only if the media
    // belongs to this phone number, so this one parameter is what stops a forged ID reaching another
    // business's media through our credential.
    const test = harness([located()]);

    await resolveMediaUrl(test.config, MEDIA_ID);

    const url = new URL(test.requests[0]?.url ?? "");
    expect(url.pathname).toContain(MEDIA_ID);
    expect(url.searchParams.get("phone_number_id")).toBe(BINDING.phoneNumberId);
    expect(test.requests[0]?.headers["authorization"]).toMatch(/^Bearer /u);
  });

  it("reads a size the provider sent as a string, because its own example does", async () => {
    const test = harness([located({ file_size: "4096" })]);

    const result = await resolveMediaUrl(test.config, MEDIA_ID);

    expect(result.ok && result.value.fileSizeBytes).toBe(4096);
  });

  it("reports a media ID the provider does not know as not found", async () => {
    const test = harness([{ kind: "RESPONSE", status: 404, body: JSON.stringify({ error: { code: 100 } }) }]);

    expect(await resolveMediaUrl(test.config, MEDIA_ID)).toEqual({ ok: false, reason: "NOT_FOUND" });
  });

  it("reports a refusal with its code and never the provider's prose", async () => {
    const test = harness([{ kind: "RESPONSE", status: 403, body: JSON.stringify({ error: { message: `no access to ${MEDIA_ID}`, code: 200 } }) }]);

    const result = await resolveMediaUrl(test.config, MEDIA_ID);

    expect(result).toEqual({ ok: false, reason: "PROVIDER_REJECTED", code: "200" });
    expect(JSON.stringify(result)).not.toContain("no access to");
  });

  it("reports an unreachable provider as unavailable, which is safe to retry", async () => {
    const test = harness([{ kind: "NO_RESPONSE", reason: "TIMEOUT", message: "timed out" }]);

    expect(await resolveMediaUrl(test.config, MEDIA_ID)).toEqual({ ok: false, reason: "UNAVAILABLE" });
  });

  it("refuses a response with no URL or no type rather than guessing", async () => {
    for (const body of [located({ url: undefined }), located({ mime_type: "" })]) {
      const test = harness([body]);
      expect(await resolveMediaUrl(test.config, MEDIA_ID)).toEqual({ ok: false, reason: "INVALID_RESPONSE" });
    }
  });

  it("does not call the provider at all without a usable credential", async () => {
    const test = harness([located()]);
    const unauthenticated = { ...test.config, secrets: { ...test.config.secrets, accessToken: () => Promise.resolve(undefined) } };

    expect(await resolveMediaUrl(unauthenticated, MEDIA_ID)).toEqual({ ok: false, reason: "NO_CREDENTIALS" });
    expect(test.requests).toHaveLength(0);
  });
});

describe("downloading the bytes", () => {
  it("returns them with the type and the length that actually arrived", async () => {
    const test = harness([bytes(2048)]);

    const result = await downloadMedia(test.config, location());

    expect(result.ok && result.value.sizeBytes).toBe(2048);
    expect(result.ok && result.value.mimeType).toBe("audio/ogg");
    expect(test.requests[0]?.url).toBe(MEDIA_URL);
    // Without the token the provider refuses the download outright.
    expect(test.requests[0]?.headers["authorization"]).toMatch(/^Bearer /u);
  });

  it("refuses a type the platform never carried, before any transfer", async () => {
    const test = harness([bytes(16)]);

    expect(await downloadMedia(test.config, location({ mimeType: "audio/wav" }))).toEqual({ ok: false, reason: "UNSUPPORTED_TYPE" });
    expect(test.requests).toHaveLength(0);
  });

  it("refuses an oversize file on the provider's own number, costing no transfer", async () => {
    const test = harness([bytes(64)]);

    expect(await downloadMedia(test.config, location({ fileSizeBytes: 17 * 1024 * 1024 }))).toEqual({ ok: false, reason: "TOO_LARGE" });
    expect(test.requests).toHaveLength(0);
  });

  it("honours a caller's tighter limit as well as the platform's", async () => {
    const test = harness([bytes(64)]);

    expect(await downloadMedia(test.config, location({ fileSizeBytes: 4096 }), { maxBytes: 1024 })).toEqual({ ok: false, reason: "TOO_LARGE" });
  });

  it("refuses a response larger than its own stated size, because a stated size is a claim", async () => {
    // The case a caller trusting `file_size` would have read into memory.
    const test = harness([bytes(5000)]);

    expect(await downloadMedia(test.config, location({ fileSizeBytes: 1024 }), { maxBytes: 2048 })).toEqual({ ok: false, reason: "TOO_LARGE" });
  });

  it("reports an expired URL as expired, which the caller resolves again", async () => {
    // Meta's documented answer for a URL past its five minutes, and its documented remedy.
    const test = harness([{ kind: "RESPONSE", status: 404, body: "" }]);

    expect(await downloadMedia(test.config, location())).toEqual({ ok: false, reason: "EXPIRED" });
  });

  it("separates a provider refusal from an outage, because only one is worth retrying", async () => {
    const rejected = harness([{ kind: "RESPONSE", status: 400, body: JSON.stringify({ error: { code: 131053 } }) }]);
    expect(await downloadMedia(rejected.config, location())).toMatchObject({ ok: false, reason: "PROVIDER_REJECTED", code: "131053" });

    const outage = harness([{ kind: "RESPONSE", status: 503, body: "" }]);
    expect(await downloadMedia(outage.config, location())).toMatchObject({ ok: false, reason: "UNAVAILABLE" });

    const timeout = harness([{ kind: "NO_RESPONSE", reason: "TIMEOUT", message: "timed out" }]);
    expect(await downloadMedia(timeout.config, location())).toEqual({ ok: false, reason: "UNAVAILABLE" });
  });

  it("refuses an empty body rather than calling it a zero-byte recording", async () => {
    const test = harness([{ kind: "RESPONSE", status: 200, body: "" }]);

    expect(await downloadMedia(test.config, location())).toEqual({ ok: false, reason: "INVALID_RESPONSE" });
  });

  it("does not download without a usable credential", async () => {
    const test = harness([bytes(16)]);
    const unauthenticated = { ...test.config, secrets: { ...test.config.secrets, accessToken: () => Promise.resolve("") } };

    expect(await downloadMedia(unauthenticated, location())).toEqual({ ok: false, reason: "NO_CREDENTIALS" });
    expect(test.requests).toHaveLength(0);
  });
});

describe("deleting the provider's copy", () => {
  it("names the media and the business phone number", async () => {
    const test = harness([ok({ success: true })]);

    expect(await deleteMedia(test.config, MEDIA_ID)).toEqual({ ok: true, value: true });
    const url = new URL(test.requests[0]?.url ?? "");
    expect(url.searchParams.get("method")).toBe("delete");
    expect(url.searchParams.get("phone_number_id")).toBe(BINDING.phoneNumberId);
  });

  it("does not treat an unreadable 200 as a deletion", async () => {
    // A retention hook that reports success without the provider agreeing is the one that leaves a
    // customer's recording in Meta's storage after they asked for it to be gone.
    const test = harness([ok({ unexpected: "shape" })]);

    expect(await deleteMedia(test.config, MEDIA_ID)).toEqual({ ok: false, reason: "INVALID_RESPONSE" });
  });
});

describe("what never reaches a log or a result", () => {
  it("keeps the bytes and the token out of every refusal", async () => {
    const test = harness([{ kind: "RESPONSE", status: 400, body: JSON.stringify({ error: { message: "secret-bearing prose", code: 100 } }) }]);

    const result = await downloadMedia(test.config, location());

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("secret-bearing prose");
    expect(serialized).not.toContain("Bearer");
  });
});

/**
 * Whether this number is ours to act for, asked on the media calls too.
 *
 * The send path and the window calculation both refuse a number that is not connected, and these are the
 * third set of calls made on a business's behalf. Leaving it to the provider does not work: a token in our
 * table outlives the authorization it was granted under, so a business that removed the integration would
 * keep having its customers' recordings downloaded until the credential happened to expire.
 */
describe("a number that is no longer connected", () => {
  const states = ["DISCONNECTED", "NEEDS_REAUTH"] as const;

  for (const connectionState of states) {
    it(`refuses to resolve, download or delete media for a ${connectionState} number`, async () => {
      const resolving = harness([located()], { connectionState });
      expect(await resolveMediaUrl(resolving.config, MEDIA_ID)).toEqual({ ok: false, reason: "ACCOUNT_NOT_CONNECTED" });
      expect(resolving.requests).toEqual([]);

      const downloading = harness([bytes(2048)], { connectionState });
      expect(await downloadMedia(downloading.config, location())).toEqual({ ok: false, reason: "ACCOUNT_NOT_CONNECTED" });
      expect(downloading.requests).toEqual([]);

      const deleting = harness([ok({ success: true })], { connectionState });
      expect(await deleteMedia(deleting.config, MEDIA_ID)).toEqual({ ok: false, reason: "ACCOUNT_NOT_CONNECTED" });
      expect(deleting.requests).toEqual([]);
    });
  }

  it("refuses before reading the token, so a revoked connection never touches the credential", async () => {
    let reads = 0;
    const http = scriptedHttp([located()]);
    const resolved = resolveConfig(
      config({
        http: http.port,
        connectionState: "DISCONNECTED",
        secrets: {
          appSecret: "",
          verifyToken: "",
          accessToken: () => {
            reads += 1;
            return Promise.resolve("should-never-be-read");
          },
        },
      }),
    );

    await resolveMediaUrl(resolved, MEDIA_ID);
    await downloadMedia(resolved, location());
    await deleteMedia(resolved, MEDIA_ID);

    // Decrypting a token for a call that is not going to be made is work nobody authorized.
    expect(reads).toBe(0);
  });

  it("checks again before the download, because that is the call that moves the recording", async () => {
    // The two calls are up to five minutes apart in the worst case — the lifetime of the resolved URL —
    // and the connection can be withdrawn in between.
    const downloading = harness([bytes(2048)], { connectionState: "DISCONNECTED" });
    expect(await downloadMedia(downloading.config, location())).toEqual({ ok: false, reason: "ACCOUNT_NOT_CONNECTED" });
  });
});
