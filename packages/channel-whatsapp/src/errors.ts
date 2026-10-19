/**
 * Meta error classification for the Cloud API. Codes re-verified 2026-10-04 against Meta's live WhatsApp
 * error reference; the table is private to this package and callers only ever see the normalized
 * `SendResult`.
 *
 * `131047` is quoted there as "Last message sent to recipient was more than 24 hours ago. Send a template
 * message instead", which is the platform stating this adapter's whole window model in one line.
 *
 * Classification rule: retryable means "the same request can be sent again later and is expected to behave
 * differently" — throttling, a transient platform fault. Anything policy-, window- or permission-shaped is
 * final, because retrying it produces the same refusal and burns the delivery's attempts.
 *
 * **Unknown codes are final.** WhatsApp errors carry no transience flag, so there is nothing to consult,
 * and a wrong guess in the retryable direction is the expensive one: it turns one refusal into a loop
 * against a customer's conversation.
 */
import { z } from "zod";

const errorBodySchema = z.looseObject({
  error: z.looseObject({
    message: z.string().optional(),
    type: z.string().optional(),
    code: z.number().optional(),
    error_subcode: z.number().optional(),
    fbtrace_id: z.string().optional(),
    error_data: z.looseObject({ details: z.string().optional() }).optional(),
  }),
});

const successBodySchema = z.looseObject({
  messaging_product: z.string().optional(),
  messages: z.array(z.looseObject({ id: z.string().optional(), message_status: z.string().optional() })).optional(),
});

export interface WhatsAppError {
  readonly code?: number;
  readonly subcode?: number;
  readonly traceId?: string;
}

/**
 * Transient conditions. Everything not listed here is treated as final.
 *
 * - `130429` messaging throughput exceeded, and `80007` the application rate limit: the request is fine,
 *   there have been too many of them.
 * - `131048` is the spam-rate limit — a quality restriction rather than a per-request fault, and it does
 *   lift, so a later attempt can legitimately differ.
 * - `131000` and `500` are Meta's own "something went wrong".
 * - `133016` means the number is temporarily blocked by a rate limit hit during registration.
 */
const RETRYABLE_CODES: ReadonlySet<number> = new Set([130429, 80007, 131048, 131000, 500, 133016]);

/**
 * Final conditions: policy, window, permission, recipient state.
 *
 * - `131047` is the one worth naming: the 24-hour customer-service window has closed, so free-form text is
 *   refused and only an approved template can reach this customer. Retrying the same free-form send would
 *   fail identically every time until the customer writes again.
 * - `131026` the message is undeliverable (recipient not on WhatsApp, or cannot receive it).
 * - `131051` unsupported message type; `131052` their download of our media failed, `131053` their upload
 *   of it failed. All three are about this payload and none of them changes on a retry of it.
 * - `131031` the account is restricted; `368` temporarily blocked for policy violations — a human has to
 *   act, and a retry cannot.
 * - `132000`–`132015` are the template failures: parameter count mismatch, missing or paused template.
 *   None of them changes on a retry of the same payload.
 */
const NON_RETRYABLE_CODES: ReadonlySet<number> = new Set([
  131047, 131026, 131051, 131052, 131053, 131031, 368, 131008, 131009, 132000, 132001, 132005, 132007, 132012, 132015, 133010, 190, 200, 10,
]);

/** The code the window closed on, which the send path reads to explain itself in one sentence. */
export const OUTSIDE_SERVICE_WINDOW_CODE = 131047;

export function classifyWhatsAppError(error: WhatsAppError): boolean {
  if (error.code !== undefined && NON_RETRYABLE_CODES.has(error.code)) {
    return false;
  }
  if (error.code !== undefined && RETRYABLE_CODES.has(error.code)) {
    return true;
  }
  // Nothing to consult and no reason to guess upward.
  return false;
}

export function parseWhatsAppError(body: string): WhatsAppError | undefined {
  const parsed = errorBodySchema.safeParse(safeJson(body));
  if (!parsed.success) {
    return undefined;
  }
  const error = parsed.data.error;
  return {
    ...(error.code === undefined ? {} : { code: error.code }),
    ...(error.error_subcode === undefined ? {} : { subcode: error.error_subcode }),
    ...(error.fbtrace_id === undefined ? {} : { traceId: error.fbtrace_id }),
  };
}

/** The `wamid` of an accepted send, or `undefined` when the response cannot be read as one. */
export function parseAcceptedMessageId(body: string): string | undefined {
  const parsed = successBodySchema.safeParse(safeJson(body));
  if (!parsed.success) {
    return undefined;
  }
  const id = parsed.data.messages?.[0]?.id;
  return id === undefined || id === "" ? undefined : id;
}

/** `code` or `code/subcode`, for logs and the normalized result. Never the provider's prose. */
export function formatErrorCode(error: WhatsAppError): string | undefined {
  if (error.code === undefined) {
    return undefined;
  }
  return error.subcode === undefined ? String(error.code) : `${String(error.code)}/${String(error.subcode)}`;
}

/**
 * True when Meta refused because the credential is finished rather than because the message was.
 *
 * Kept here with the table for the same reason the Instagram adapter keeps its own: the rest of the system
 * sees a normalized `SendResult`, and a caller matching on `"190"` itself would be holding a copy of Meta's
 * vocabulary outside the one package allowed to know it.
 */
export function isAccessTokenRejection(code: string | undefined): boolean {
  if (code === undefined) {
    return false;
  }
  const [leading] = code.split("/");
  return leading !== undefined && Number.parseInt(leading, 10) === 190;
}

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}
