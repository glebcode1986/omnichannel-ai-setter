/**
 * Meta error classification. Codes re-verified 2026-09-17 against Meta's error reference; the table is
 * private to this package and callers only ever see the normalized SendResult.
 *
 * Classification rule: retryable means "the same request can be sent again later and is expected to behave
 * differently" (throttling, transient platform errors). Anything policy- or permission-shaped is final.
 */
import { z } from "zod";

const errorBodySchema = z.looseObject({
  error: z.looseObject({
    message: z.string().optional(),
    type: z.string().optional(),
    code: z.number().optional(),
    error_subcode: z.number().optional(),
    fbtrace_id: z.string().optional(),
    is_transient: z.boolean().optional(),
  }),
});

const successBodySchema = z.looseObject({
  recipient_id: z.string().optional(),
  message_id: z.string().optional(),
});

export interface MetaError {
  readonly code?: number;
  readonly subcode?: number;
  readonly traceId?: string;
  readonly transient: boolean;
}

/** Transient platform/throttling conditions. Everything not listed here is treated as final. */
const RETRYABLE_CODES: ReadonlySet<number> = new Set([
  4, // application request limit reached
  2, // "unexpected error, try again later" (Meta also documents it for blocked customers)
  613, // calls to this API have exceeded the rate limit
  2018321, // temporary send failure
  2018300, // temporary send failure
]);

/** Final conditions: policy, permissions, window, recipient state. Retrying cannot change the answer. */
const NON_RETRYABLE_CODES: ReadonlySet<number> = new Set([
  10, // permission/window errors (2534022, 2018278, 2018108)
  100, // invalid parameter / unsupported request
  190, // invalid or expired access token
  200, // permission error
  551, // this person is not available right now
  2022, // message send failure
]);

export function classifyMetaError(error: MetaError): boolean {
  if (error.code !== undefined && NON_RETRYABLE_CODES.has(error.code)) {
    return false;
  }
  if (error.code !== undefined && RETRYABLE_CODES.has(error.code)) {
    return true;
  }
  // Unknown codes follow Meta's own transience flag, defaulting to final so nothing is retried blindly.
  return error.transient;
}

/**
 * The token endpoint on api.instagram.com answers with a flat envelope instead of the nested one every
 * graph.instagram.com endpoint uses. Code written against only the nested shape reads `undefined` here.
 */
const flatErrorBodySchema = z.looseObject({
  error_type: z.string().optional(),
  code: z.number().optional(),
  error_message: z.string().optional(),
});

export function parseTokenEndpointError(body: string): MetaError | undefined {
  const nested = parseMetaError(body);
  if (nested !== undefined) {
    return nested;
  }
  const parsed = flatErrorBodySchema.safeParse(safeJson(body));
  if (!parsed.success || (parsed.data.error_type === undefined && parsed.data.code === undefined)) {
    return undefined;
  }
  return { ...(parsed.data.code === undefined ? {} : { code: parsed.data.code }), transient: false };
}

export function parseMetaError(body: string): MetaError | undefined {
  const parsed = errorBodySchema.safeParse(safeJson(body));
  if (!parsed.success) {
    return undefined;
  }
  const error = parsed.data.error;
  return {
    ...(error.code === undefined ? {} : { code: error.code }),
    ...(error.error_subcode === undefined ? {} : { subcode: error.error_subcode }),
    ...(error.fbtrace_id === undefined ? {} : { traceId: error.fbtrace_id }),
    transient: error.is_transient ?? false,
  };
}

export function parseMetaSuccess(body: string): { readonly messageId?: string } | undefined {
  const parsed = successBodySchema.safeParse(safeJson(body));
  if (!parsed.success) {
    return undefined;
  }
  return parsed.data.message_id === undefined ? {} : { messageId: parsed.data.message_id };
}

/** Provider error code as reported on SendResult: `code` or `code/subcode`, never the provider's message. */
export function formatErrorCode(error: MetaError): string | undefined {
  if (error.code === undefined) {
    return undefined;
  }
  return error.subcode === undefined ? String(error.code) : `${String(error.code)}/${String(error.subcode)}`;
}

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}
