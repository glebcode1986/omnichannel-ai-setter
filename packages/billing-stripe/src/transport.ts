/**
 * The only way this package talks to Stripe.
 *
 * The port sits below the mapping so every test scripts responses without a network, an API key or a
 * charge, and it never rejects: a thrown transport error would be indistinguishable from a provider that
 * answered something unusable, and here the difference decides whether a customer is told their payment
 * failed. What matters is "answered" versus "did not answer", and on an answer, what Stripe said.
 *
 * **One attempt, with a hard timeout.** No retry loop, because nothing in this repository retries inside
 * an adapter: the queue owns attempts and backoff, and an adapter that retried as well would multiply the
 * two. For a read that is merely slow this means a `NO_RESPONSE`, which the caller reports rather than
 * guesses past.
 *
 * **No vendor SDK** (ADR-020). Stripe's v1 API is form-encoded requests and JSON responses, and the
 * bearer token is one header; the SDK's contribution would be types we do not use, a retry policy we
 * would have to switch off, and error objects carrying request headers into a logger whose allowlist
 * exists to keep credentials out.
 */
export type BillingHttpMethod = "GET" | "POST";

export interface BillingHttpRequest {
  readonly method: BillingHttpMethod;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Form-encoded for a write, absent for a read. Stripe's v1 API takes no JSON request bodies. */
  readonly body?: string;
  readonly timeoutMs: number;
}

export type BillingHttpResult =
  | {
      readonly kind: "RESPONSE";
      readonly status: number;
      readonly body: string;
      /**
       * Stripe's own `Request-Id`, kept for the audit trail.
       *
       * An identifier, which is the only kind of provider string this package passes outwards: it names a
       * request in Stripe's dashboard without saying anything about the customer, the amount or the key.
       */
      readonly requestId?: string;
      /**
       * Stripe's `Stripe-Should-Retry`, where it sent one.
       *
       * Read because the documentation calls it "retry guidance that might not be available from the
       * status code or response body" — the provider knows something no status-code table does, and
       * ignoring it is how a client retries what will never succeed, or gives up on what would have.
       * Absent leaves the decision to the status code.
       */
      readonly shouldRetry?: boolean;
    }
  | { readonly kind: "NO_RESPONSE"; readonly reason: "TIMEOUT" | "NETWORK" | "PRE_DISPATCH" };

export interface BillingHttpPort {
  send(request: BillingHttpRequest): Promise<BillingHttpResult>;
}

/** Default `fetch`-backed transport. */
export function createFetchBillingHttpPort(): BillingHttpPort {
  return {
    async send(request) {
      try {
        const url = new URL(request.url);
        if (url.protocol !== "https:") {
          // A bearer token may not be put on the wire in clear. `PRE_DISPATCH` rather than a throw,
          // because a misconfigured base URL is an answer the caller has to report like any other.
          return { kind: "NO_RESPONSE", reason: "PRE_DISPATCH" };
        }
      } catch {
        return { kind: "NO_RESPONSE", reason: "PRE_DISPATCH" };
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), request.timeoutMs);
      try {
        const response = await fetch(request.url, {
          method: request.method,
          headers: { ...request.headers },
          ...(request.body === undefined ? {} : { body: request.body }),
          signal: controller.signal,
        });
        const body = await response.text();
        const requestId = response.headers.get("request-id") ?? undefined;
        const shouldRetry = response.headers.get("stripe-should-retry");
        return {
          kind: "RESPONSE",
          status: response.status,
          body,
          ...(requestId === undefined ? {} : { requestId }),
          // Only the two values the header is documented to carry. Anything else is read as absent
          // rather than as one of them.
          ...(shouldRetry === "true" ? { shouldRetry: true } : shouldRetry === "false" ? { shouldRetry: false } : {}),
        };
      } catch {
        return controller.signal.aborted ? { kind: "NO_RESPONSE", reason: "TIMEOUT" } : { kind: "NO_RESPONSE", reason: "NETWORK" };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Stripe's v1 API takes `application/x-www-form-urlencoded`, including for nested and repeated fields.
 *
 * Written here rather than assembled at each call site, because the bracket spelling is the part that
 * goes wrong silently: `line_items[0][price]` is a *flat* key containing brackets, not a structure, and a
 * parameter spelled `line_items[price]` is accepted by the encoder and rejected by Stripe.
 *
 * `undefined` values are dropped rather than sent empty. An empty string is a value to Stripe — it clears
 * a field — so sending one for an option the caller did not set would be an instruction nobody gave.
 */
export function formEncode(fields: Readonly<Record<string, string | number | boolean | undefined>>): string {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) {
      continue;
    }
    body.set(key, typeof value === "string" ? value : String(value));
  }
  return body.toString();
}
