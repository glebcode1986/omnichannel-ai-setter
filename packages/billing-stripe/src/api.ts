/**
 * One authenticated call to Stripe's v1 API.
 *
 * Verified against the live documentation on 2026-10-12: https://docs.stripe.com/api/authentication,
 * https://docs.stripe.com/api/versioning, https://docs.stripe.com/api/idempotent_requests and
 * https://docs.stripe.com/api/errors.
 *
 * - the key travels as `Authorization: Bearer`, which the docs name as the alternative to basic auth;
 * - the API version is **pinned** with `Stripe-Version`, so a monthly release cannot reshape a response
 *   this adapter parses. Inbound webhook payloads are not affected by it — a snapshot event is rendered
 *   at the version fixed when the endpoint was created, which is a separate setting;
 * - writes carry an `Idempotency-Key`, because a retried POST must not become a second charge path;
 * - a request body is `application/x-www-form-urlencoded`. Stripe's v1 API takes no JSON bodies.
 *
 * **Nothing from an error is passed on except codes.** Stripe's error object carries a human-readable
 * `message`, a `request_log_url` and, for card errors, a `charge` — and this adapter's caller logs what it
 * is given. So the failure that leaves here is the status, the provider's own two classification strings
 * and the request id: enough for an operator to find the request in Stripe's dashboard, and nothing that
 * could put a customer's details or a key into a log line.
 */
import { formEncode, type BillingHttpPort, type BillingHttpResult } from "./transport";

/** The version this adapter's parsing was written against. Pinned, never "latest". */
export const STRIPE_API_VERSION = "2026-09-30.endive";

export const STRIPE_API_BASE_URL = "https://api.stripe.com";

/** One attempt. Retry belongs to the queue, never to an adapter. */
export const STRIPE_TIMEOUT_MS = 10_000;

export interface StripeCall {
  readonly method: "GET" | "POST";
  /** A path under the base URL, starting with a slash: `/v1/checkout/sessions`. */
  readonly path: string;
  readonly secretKey: string;
  readonly fields?: Readonly<Record<string, string | number | boolean | undefined>>;
  /** Required for every write. Absent for a read, where the docs say it has no effect. */
  readonly idempotencyKey?: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

export type StripeFailureKind =
  /** Stripe answered with a status outside 2xx. */
  | "REJECTED"
  /** No answer within the timeout. */
  | "TIMEOUT"
  /** No answer, and not because of the clock. */
  | "UNREACHABLE"
  /** Stripe answered 2xx with a body this adapter could not read as the object it asked for. */
  | "UNREADABLE";

/**
 * A call that did not produce a usable object.
 *
 * An `Error` because the port propagates checkout failures rather than swallowing them, and because an
 * operational failure that reached a caller as a value would be a failure a caller could forget to check.
 * The message names codes only.
 */
export class StripeCallFailed extends Error {
  constructor(
    readonly kind: StripeFailureKind,
    readonly detail: {
      readonly status?: number;
      /** Stripe's `error.type`: `api_error`, `card_error`, `idempotency_error`, `invalid_request_error`. */
      readonly errorType?: string;
      /** Stripe's `error.code`, where it sent one. */
      readonly errorCode?: string;
      /** Stripe's `Request-Id`, so an operator can find this exact call in the dashboard. */
      readonly requestId?: string;
      /** Stripe's own `Stripe-Should-Retry`, where it sent one. */
      readonly shouldRetry?: boolean;
    } = {},
  ) {
    super(
      [
        `stripe call ${kind.toLowerCase()}`,
        detail.status === undefined ? undefined : `status=${String(detail.status)}`,
        detail.errorType === undefined ? undefined : `type=${detail.errorType}`,
        detail.errorCode === undefined ? undefined : `code=${detail.errorCode}`,
        detail.requestId === undefined ? undefined : `request=${detail.requestId}`,
      ]
        .filter((part) => part !== undefined)
        .join(" "),
    );
    this.name = "StripeCallFailed";
  }

  /**
   * Whether the same call could succeed later.
   *
   * Stripe's own table: 429 is throttling, 5xx is Stripe's end, and a connection that never answered says
   * nothing about the request. A 4xx other than 429 is this adapter's request being wrong, and repeating
   * it would be repeating the mistake. 409 is an idempotency conflict — the same key with different
   * parameters — which is a bug here rather than a transient fault.
   */
  get retryable(): boolean {
    if (this.kind === "TIMEOUT" || this.kind === "UNREACHABLE") {
      return true;
    }
    // The provider's own answer wins where it gave one. It is documented as guidance the status code
    // does not carry, so a status-code table that overrode it would be preferring a guess to a fact.
    if (this.detail.shouldRetry !== undefined) {
      return this.detail.shouldRetry;
    }
    const status = this.detail.status ?? 0;
    return status === 429 || status >= 500;
  }
}

/** A parsed Stripe object, as an unknown map. Every reader below narrows what it needs. */
export type StripeObject = Readonly<Record<string, unknown>>;

export async function callStripe(http: BillingHttpPort, call: StripeCall): Promise<StripeObject> {
  const body = call.fields === undefined ? undefined : formEncode(call.fields);
  const result = await http.send({
    method: call.method,
    url: `${call.baseUrl ?? STRIPE_API_BASE_URL}${call.path}`,
    headers: {
      authorization: `Bearer ${call.secretKey}`,
      "stripe-version": STRIPE_API_VERSION,
      ...(body === undefined ? {} : { "content-type": "application/x-www-form-urlencoded" }),
      ...(call.idempotencyKey === undefined ? {} : { "idempotency-key": call.idempotencyKey }),
    },
    ...(body === undefined ? {} : { body }),
    timeoutMs: call.timeoutMs ?? STRIPE_TIMEOUT_MS,
  });
  return read(result);
}

function read(result: BillingHttpResult): StripeObject {
  if (result.kind === "NO_RESPONSE") {
    throw new StripeCallFailed(result.reason === "TIMEOUT" ? "TIMEOUT" : "UNREACHABLE");
  }
  const parsed = parseObject(result.body);
  const requestId = result.requestId === undefined ? {} : { requestId: result.requestId };
  if (result.status < 200 || result.status >= 300) {
    const error = parsed === undefined ? undefined : asObject(parsed["error"]);
    throw new StripeCallFailed("REJECTED", {
      status: result.status,
      ...(result.shouldRetry === undefined ? {} : { shouldRetry: result.shouldRetry }),
      ...(asString(error?.["type"]) === undefined ? {} : { errorType: asString(error?.["type"]) }),
      ...(asString(error?.["code"]) === undefined ? {} : { errorCode: asString(error?.["code"]) }),
      ...requestId,
    });
  }
  if (parsed === undefined) {
    // A 2xx whose body is not an object. Not a rejection and not an outage: something answered, and what
    // it said cannot be acted on, which the caller has to be able to tell apart from both.
    throw new StripeCallFailed("UNREADABLE", { status: result.status, ...requestId });
  }
  return parsed;
}

export function parseObject(body: string): StripeObject | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  return asObject(parsed);
}

export function asObject(value: unknown): StripeObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as StripeObject) : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function asInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/**
 * A Stripe timestamp as a `Date`.
 *
 * Seconds, not milliseconds — every timestamp in the v1 API is "seconds since the Unix epoch", and
 * reading one as milliseconds dates a payment to January 1970 without failing anywhere.
 */
export function asInstant(value: unknown): Date | undefined {
  const seconds = asInteger(value);
  return seconds === undefined || seconds <= 0 ? undefined : new Date(seconds * 1_000);
}

/** Stripe reports currency in lowercase; the product's `Money` uses ISO 4217 as written. */
export function asCurrency(value: unknown): string | undefined {
  return asString(value)?.toUpperCase();
}

/** Reads a metadata value from a Stripe map, which may be absent, null, or hold non-strings. */
export function metadataValue(metadata: unknown, key: string): string | undefined {
  return asString(asObject(metadata)?.[key]);
}
