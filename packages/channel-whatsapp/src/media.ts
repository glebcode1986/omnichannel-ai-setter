/**
 * Fetching a customer's media, and deleting it (Issue #21).
 *
 * Re-verified against Meta's live media reference on 2026-10-04. Every number here is the provider's, and
 * five facts from that reading shape the whole file.
 *
 * **A download is two requests.** `GET /<MEDIA_ID>` answers with a URL, a MIME type, a `sha256` and a
 * `file_size`; the bytes come from a second `GET` on that URL, which fails without the access token. The
 * **URL lives five minutes**, so it is resolved immediately before the download and never stored.
 *
 * **A media ID from a webhook lives seven days** — not the thirty an uploaded one gets. A transcription
 * that retries for longer than that is retrying against something the provider has already forgotten.
 *
 * **The size limit depends on the type**, and the differences are large: 5 MB for an image, 16 MB for
 * audio and video, 100 MB for a document, 100 KB for a static sticker. Meta also caps a media *message*
 * at 100 MB and reports a bigger one as error 131052 rather than delivering it.
 *
 * **`phone_number_id` is a tenancy check the provider will perform for us.** It is optional, and when it
 * is supplied Meta honours the request only if the media was uploaded for that business phone number. It
 * is always supplied here: a media ID is a bare string in a webhook, and without this a forged one could
 * reach another business's media through our own credential.
 *
 * **OGG is OPUS-only and mono-only.** That is not a detail: a voice note in any other OGG codec is a
 * recording this product cannot read, and saying so is better than handing it to a transcriber that will
 * answer with something.
 *
 * Nothing here transcribes, interprets or logs a byte of the media. The bytes leave as bytes.
 */
import type { ResolvedWhatsAppConfig } from "./config";
import { formatErrorCode, parseWhatsAppError } from "./errors";
import type { WhatsAppHttpResult } from "./http";

/** A media ID that arrived in a webhook is downloadable for seven days; an uploaded one gets thirty. */
export const WEBHOOK_MEDIA_ID_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** The resolved download URL expires after five minutes, so it is never persisted or queued. */
export const MEDIA_URL_TTL_MS = 5 * 60 * 1000;
/** Meta's own ceiling for a media message, whatever the type-specific limit says. */
export const MAX_MEDIA_BYTES = 100 * 1024 * 1024;

const MB = 1024 * 1024;
const KB = 1024;

/**
 * Size limits by MIME type, as Meta publishes them.
 *
 * Kept as a table rather than one number because the spread is what matters: accepting a 100 MB "voice
 * note" because documents may be that large would hand a transcriber a file six times the size the
 * platform allows for audio.
 */
export const MEDIA_LIMITS: Readonly<Record<string, number>> = {
  "audio/aac": 16 * MB,
  "audio/amr": 16 * MB,
  "audio/mpeg": 16 * MB,
  "audio/mp4": 16 * MB,
  "audio/ogg": 16 * MB,
  "image/jpeg": 5 * MB,
  "image/png": 5 * MB,
  "image/webp": 500 * KB,
  "video/3gpp": 16 * MB,
  "video/mp4": 16 * MB,
  "text/plain": 100 * MB,
  "application/pdf": 100 * MB,
  "application/msword": 100 * MB,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": 100 * MB,
  "application/vnd.ms-excel": 100 * MB,
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": 100 * MB,
  "application/vnd.ms-powerpoint": 100 * MB,
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": 100 * MB,
};

/** The audio types a voice note can arrive as. Transcription is offered for these and nothing else. */
export const TRANSCRIBABLE_MIME_TYPES = ["audio/aac", "audio/amr", "audio/mpeg", "audio/mp4", "audio/ogg"] as const;

const MEDIA_TIMEOUT_MS = 20_000;

/** Why media could not be fetched. Fixed vocabulary; the provider's prose never travels with it. */
export type MediaFailureReason =
  /**
   * The number this media belongs to is not connected.
   *
   * Refused here rather than left to the provider, because the provider would often allow it: a token in
   * the table outlives the authorization it was granted under, so a business that removed the integration
   * would keep having its customers' recordings downloaded until the credential happened to expire. The
   * send path and the window calculation refuse on this same value, and this is the third call that acts
   * on the business's behalf.
   */
  | "ACCOUNT_NOT_CONNECTED"
  | "UNSUPPORTED_TYPE"
  | "TOO_LARGE"
  | "MIME_MISMATCH"
  | "EXPIRED"
  | "NOT_FOUND"
  | "PROVIDER_REJECTED"
  | "UNAVAILABLE"
  | "NO_CREDENTIALS"
  | "INVALID_RESPONSE";

export type MediaResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: MediaFailureReason; readonly code?: string };

/** What `GET /<MEDIA_ID>` answers with. The URL is good for five minutes and is not stored. */
export interface MediaLocation {
  readonly url: string;
  readonly mimeType: string;
  /** The provider's own hash of the bytes, which is what makes a download verifiable. */
  readonly sha256?: string;
  /** The provider's own size, read *before* downloading so an oversize file costs no bytes. */
  readonly fileSizeBytes?: number;
}

export interface DownloadedMedia {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly sizeBytes: number;
}

/** The limit for this type, or `undefined` for a type the platform does not carry. */
export function mediaLimitFor(mimeType: string): number | undefined {
  return MEDIA_LIMITS[baseMimeType(mimeType)];
}

/**
 * Whether this product will fetch media of this type at all.
 *
 * Separate from the limit because "we do not carry that" and "that one is too big" are different answers,
 * and the first one never changes for the same file.
 */
export function mediaSupported(mimeType: string): boolean {
  return mediaLimitFor(mimeType) !== undefined;
}

/**
 * Whether this is audio a transcriber may be offered.
 *
 * `audio/ogg` passes here on its MIME type alone, which is as far as a MIME type can take us: Meta accepts
 * OGG only in the OPUS codec and only in mono, and neither fact is in the type. A file that claims OGG and
 * is something else is the transcriber's refusal to report, not ours to guess — what matters is that the
 * refusal becomes a review item rather than an invented transcript.
 */
export function transcribableMimeType(mimeType: string): boolean {
  return (TRANSCRIBABLE_MIME_TYPES as readonly string[]).includes(baseMimeType(mimeType));
}

/** True while a media ID from a webhook is still downloadable. */
export function mediaIdUsable(receivedAt: Date, now: Date): boolean {
  return now.getTime() - receivedAt.getTime() < WEBHOOK_MEDIA_ID_TTL_MS;
}

/**
 * Resolves the download URL for a media ID.
 *
 * `phone_number_id` is always sent. Meta then honours the request only if the media belongs to that
 * business phone number, which turns a provider-side check into this product's cross-tenant guarantee:
 * a media ID is a bare string in an untrusted payload, and without this one parameter a forged one could
 * reach another business's media through our own credential.
 */
export async function resolveMediaUrl(config: ResolvedWhatsAppConfig, mediaId: string): Promise<MediaResult<MediaLocation>> {
  if (config.connectionState !== "CONNECTED") {
    return { ok: false, reason: "ACCOUNT_NOT_CONNECTED" };
  }
  const accessToken = await config.secrets.accessToken();
  if (accessToken === undefined || accessToken.length === 0) {
    return { ok: false, reason: "NO_CREDENTIALS" };
  }
  const url = new URL(`https://${config.graphHost}/${config.graphVersion}/${encodeURIComponent(mediaId)}`);
  url.searchParams.set("phone_number_id", config.binding.phoneNumberId);
  const result = await config.http.send({
    url: url.toString(),
    method: "GET",
    headers: { authorization: `Bearer ${accessToken}` },
    timeoutMs: MEDIA_TIMEOUT_MS,
  });
  const payload = readJson(result);
  if (!payload.ok) {
    return payload.failure;
  }
  const location = payload.value["url"];
  const mimeType = payload.value["mime_type"];
  if (typeof location !== "string" || location === "" || typeof mimeType !== "string" || mimeType === "") {
    return { ok: false, reason: "INVALID_RESPONSE" };
  }
  const sha256 = payload.value["sha256"];
  // `file_size` arrives as a string in Meta's own example, and as a number in practice. Both are read,
  // because the whole point of it is refusing an oversize file *before* downloading it.
  const fileSize = Number(payload.value["file_size"]);
  return {
    ok: true,
    value: {
      url: location,
      mimeType,
      ...(typeof sha256 === "string" && sha256 !== "" ? { sha256 } : {}),
      ...(Number.isFinite(fileSize) && fileSize > 0 ? { fileSizeBytes: Math.trunc(fileSize) } : {}),
    },
  };
}

/**
 * Downloads the bytes, refusing anything the platform would not have carried.
 *
 * The checks are ordered by what they cost. The type and the provider's own stated size are free, so an
 * unsupported or oversize file is refused before a byte moves. The length of what actually arrived is
 * checked afterwards too, because a stated size is a claim: a response that is larger than its own
 * `file_size` said is exactly the case a caller trusting the claim would read into memory.
 */
export async function downloadMedia(
  config: ResolvedWhatsAppConfig,
  location: MediaLocation,
  options: { readonly maxBytes?: number } = {},
): Promise<MediaResult<DownloadedMedia>> {
  const limit = mediaLimitFor(location.mimeType);
  if (limit === undefined) {
    return { ok: false, reason: "UNSUPPORTED_TYPE" };
  }
  if (config.connectionState !== "CONNECTED") {
    // Checked again rather than assumed from the resolve step: the two calls are minutes apart in the
    // worst case, and the second one is the one that moves a customer's recording.
    return { ok: false, reason: "ACCOUNT_NOT_CONNECTED" };
  }
  const cap = Math.min(limit, options.maxBytes ?? MAX_MEDIA_BYTES, MAX_MEDIA_BYTES);
  if (location.fileSizeBytes !== undefined && location.fileSizeBytes > cap) {
    // Refused on the provider's own number, so an oversize file costs no transfer at all.
    return { ok: false, reason: "TOO_LARGE" };
  }
  const accessToken = await config.secrets.accessToken();
  if (accessToken === undefined || accessToken.length === 0) {
    return { ok: false, reason: "NO_CREDENTIALS" };
  }
  const result = await config.http.send({
    url: location.url,
    method: "GET",
    headers: { authorization: `Bearer ${accessToken}` },
    timeoutMs: MEDIA_TIMEOUT_MS,
  });
  if (result.kind === "NO_RESPONSE") {
    return { ok: false, reason: "UNAVAILABLE" };
  }
  if (result.status === 404) {
    // Meta's documented answer for an expired URL, and its documented remedy is to resolve the ID again.
    return { ok: false, reason: "EXPIRED" };
  }
  if (result.status < 200 || result.status >= 300) {
    const error = parseWhatsAppError(result.body);
    const code = error === undefined ? `HTTP_${String(result.status)}` : (formatErrorCode(error) ?? `HTTP_${String(result.status)}`);
    return { ok: false, reason: result.status >= 500 || result.status === 429 ? "UNAVAILABLE" : "PROVIDER_REJECTED", code };
  }
  const bytes = bytesOf(result.body);
  if (bytes.byteLength > cap) {
    // The stated size was a claim and the response broke it. Refused rather than kept: a caller that
    // trusted the claim is exactly who would have read this into memory.
    return { ok: false, reason: "TOO_LARGE" };
  }
  if (bytes.byteLength === 0) {
    return { ok: false, reason: "INVALID_RESPONSE" };
  }
  return { ok: true, value: { bytes, mimeType: location.mimeType, sizeBytes: bytes.byteLength } };
}

/**
 * Deletes the provider's copy of a media object.
 *
 * The retention hook the spec asks for. Meta keeps uploaded media thirty days unless it is deleted
 * sooner, so this is the one call that makes a customer's deletion request reach the provider's storage
 * rather than only ours.
 */
export async function deleteMedia(config: ResolvedWhatsAppConfig, mediaId: string): Promise<MediaResult<true>> {
  if (config.connectionState !== "CONNECTED") {
    return { ok: false, reason: "ACCOUNT_NOT_CONNECTED" };
  }
  const accessToken = await config.secrets.accessToken();
  if (accessToken === undefined || accessToken.length === 0) {
    return { ok: false, reason: "NO_CREDENTIALS" };
  }
  const url = new URL(`https://${config.graphHost}/${config.graphVersion}/${encodeURIComponent(mediaId)}`);
  url.searchParams.set("phone_number_id", config.binding.phoneNumberId);
  // The port offers GET and POST, and Meta accepts the method override on this edge. One transport shape
  // per package means one place where a timeout or a retry opinion can live.
  url.searchParams.set("method", "delete");
  const payload = readJson(
    await config.http.send({
      url: url.toString(),
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
      body: "{}",
      timeoutMs: MEDIA_TIMEOUT_MS,
    }),
  );
  if (!payload.ok) {
    return payload.failure;
  }
  return payload.value["success"] === true ? { ok: true, value: true } : { ok: false, reason: "INVALID_RESPONSE" };
}

/** `audio/ogg; codecs=opus` and `audio/ogg` are the same type as far as a limit is concerned. */
function baseMimeType(mimeType: string): string {
  const [base] = mimeType.split(";");
  return (base ?? "").trim().toLowerCase();
}

function bytesOf(body: string): Uint8Array {
  // The port hands back a string, so the bytes arrive as latin1-decoded text: one character per byte,
  // which is the only encoding that round-trips arbitrary binary through a string without loss.
  return new Uint8Array(Buffer.from(body, "binary"));
}

type JsonObject = Readonly<Record<string, unknown>>;

function readJson(result: WhatsAppHttpResult): { ok: true; value: JsonObject } | { ok: false; failure: MediaResult<never> } {
  if (result.kind === "NO_RESPONSE") {
    return { ok: false, failure: { ok: false, reason: "UNAVAILABLE" } };
  }
  if (result.status === 404) {
    return { ok: false, failure: { ok: false, reason: "NOT_FOUND" } };
  }
  if (result.status < 200 || result.status >= 300) {
    const error = parseWhatsAppError(result.body);
    const code = error === undefined ? `HTTP_${String(result.status)}` : (formatErrorCode(error) ?? `HTTP_${String(result.status)}`);
    return {
      ok: false,
      failure: { ok: false, reason: result.status >= 500 || result.status === 429 ? "UNAVAILABLE" : "PROVIDER_REJECTED", code },
    };
  }
  try {
    const parsed: unknown = JSON.parse(result.body);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? { ok: true, value: parsed as JsonObject }
      : { ok: false, failure: { ok: false, reason: "INVALID_RESPONSE" } };
  } catch {
    return { ok: false, failure: { ok: false, reason: "INVALID_RESPONSE" } };
  }
}
