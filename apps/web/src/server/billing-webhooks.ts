/**
 * The transport for a billing provider's webhook (Issue #41, ADR-017).
 *
 * The one thing this file is arranged around: **the HTTP status is this side's decision, never the
 * adapter's.** An adapter that could choose it could answer `200` to a delivery the product refused, and
 * a provider that hears `200` stops retrying. So the port returns one of three facts and this maps them:
 *
 * - `EVENT` — authentic, and the product recorded what it means. `200`.
 * - `ACKNOWLEDGED` — authentic, and nothing here to record. Also `200`: Stripe retries a non-2xx for
 *   three days, and retrying an event nobody will ever act on is a self-inflicted outage.
 * - `REFUSED` — not authentic, or authentic and unreadable. `401`. Nothing is recorded and the provider
 *   is free to redeliver.
 *
 * **The body is read as the exact string the provider signed.** `request.text()` rather than `.json()`,
 * because re-serializing parsed JSON changes whitespace and key order and the signature is over bytes.
 * `RawProviderDelivery.body` is a string for this reason, unlike the channel webhook path, which carries
 * bytes.
 *
 * **Nothing from the payload is logged.** A billing payload names a customer, an amount and a provider
 * account; what goes in a log line here is the correlation id, the outcome, and the product's own route
 * code and event effect once there is one. Not the provider's event id either — it is the provider's
 * vocabulary, and the audit row already holds it.
 */
import type { BillingEventResult, RawProviderDelivery, VerifiedBillingEvent, VerifiedProviderDelivery } from "@omnichannel/db";
import type { Logger } from "@omnichannel/observability";

/** A provider callback is a handful of kilobytes; anything larger is refused before it is read twice. */
export const MAX_BILLING_BODY_BYTES = 64 * 1024;

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/u;

export interface BillingWebhookOptions {
  readonly provider: string;
  /**
   * Authenticates the delivery. The port's registry in production; scripted in a test.
   *
   * Injected rather than imported so that this transport can be driven without a process-wide
   * registration, and so that the one ordering that matters is visible: `ensureAdapters` runs first,
   * because an unregistered provider refuses every delivery and that refusal would look exactly like a
   * forgery.
   */
  readonly verify: (delivery: RawProviderDelivery) => Promise<VerifiedProviderDelivery>;
  /** Records a minted event. The store in production; this route never touches a database itself. */
  readonly record: (event: VerifiedBillingEvent) => Promise<BillingEventResult>;
  readonly logger: () => Logger;
  readonly newCorrelationId: () => string;
  /** Registers the adapters this process can use. Called per request; it is idempotent. */
  readonly ensureAdapters: () => void;
  readonly now?: () => Date;
}

export function createBillingWebhookHandler(options: BillingWebhookOptions): (request: Request) => Promise<Response> {
  const now = options.now ?? (() => new Date());

  return async function handle(request: Request): Promise<Response> {
    const supplied = request.headers.get("x-correlation-id");
    const correlationId = supplied !== null && CORRELATION_ID_PATTERN.test(supplied) ? supplied : options.newCorrelationId();
    const logger = options.logger();

    try {
      options.ensureAdapters();
      const body = await readBody(request);
      if (body === undefined) {
        return respond(413, correlationId);
      }
      const verified = await options.verify({
        provider: options.provider,
        body,
        headers: Object.fromEntries(request.headers),
        receivedAt: now(),
      });

      if (verified.kind === "REFUSED") {
        // Said at `warn`, because a run of these is either a misconfigured secret or somebody probing.
        logger.warn("billing.delivery_refused", { correlationId, provider: options.provider });
        return respond(401, correlationId);
      }
      if (verified.kind === "ACKNOWLEDGED") {
        logger.info("billing.delivery_ignored", { correlationId, provider: options.provider });
        return acknowledge(verified.acknowledgement, correlationId);
      }

      const result = await options.record(verified.event);
      logger.info("billing.delivery_recorded", {
        correlationId,
        provider: options.provider,
        routeCode: verified.event.routeCode,
        outcome: result.outcome,
        effect: result.effect,
      });
      // Every outcome is a success to the provider, including `DUPLICATE` and `UNKNOWN_ROUTE`. A duplicate
      // is a delivery the product has already dealt with, and refusing it would ask for it again for
      // three days; an unknown route is a configuration fact on this side, which the provider cannot fix
      // by redelivering. Both are visible in the log and in the audit trail instead.
      return acknowledge(verified.acknowledgement, correlationId, result);
    } catch (error) {
      // Nothing was acknowledged, so the provider retries — and recording is idempotent on the provider's
      // own event id, so a retry after a crash mid-transaction cannot double-count.
      logger.error("billing.delivery_failed", {
        correlationId,
        provider: options.provider,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      return respond(500, correlationId);
    }
  };
}

async function readBody(request: Request): Promise<string | undefined> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BILLING_BODY_BYTES) {
    return undefined;
  }
  // The exact string the provider signed. Not `.json()`.
  const body = await request.text();
  return Buffer.byteLength(body, "utf8") > MAX_BILLING_BODY_BYTES ? undefined : body;
}

/**
 * `200`, with the provider's own acknowledgement body where it requires one.
 *
 * Only the adapter can produce that body, because only the adapter holds the signing secret — so the port
 * carries it back rather than leaving this route to invent a reply. Where there is none, the status is the
 * acknowledgement, which is all Stripe's documentation requires.
 */
function acknowledge(
  acknowledgement: { readonly body: string; readonly headers?: Readonly<Record<string, string>> } | undefined,
  correlationId: string,
  result?: BillingEventResult,
): Response {
  const headers: Record<string, string> = {
    "Cache-Control": "no-store",
    "X-Correlation-Id": correlationId,
    ...(acknowledgement?.headers ?? {}),
  };
  if (acknowledgement !== undefined) {
    return new Response(acknowledgement.body, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8", ...headers } });
  }
  // The product's own vocabulary, so an operator reading a delivery log in the provider's dashboard can
  // see what this side made of it. No provider identifiers and no amounts.
  return Response.json({ status: "accepted", ...(result === undefined ? {} : { outcome: result.outcome, effect: result.effect }) }, { status: 200, headers });
}

function respond(status: number, correlationId: string): Response {
  const body = status === 401 ? { status: "unauthorized" } : status === 413 ? { status: "payload_too_large" } : { status: "error" };
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Correlation-Id": correlationId } });
}
