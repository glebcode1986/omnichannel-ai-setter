import type { WebhookIngestionRequest, WebhookIngestionResult } from "@omnichannel/application";
import type { RawWebhook } from "@omnichannel/channel-core";
import type { Logger } from "@omnichannel/observability";

/** Meta webhook batches are small; anything larger is refused before it is read into memory twice. */
export const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

export interface WebhookRouteContext {
  readonly params: Promise<{ readonly channel: string; readonly channelAccountId: string }>;
}

export interface WebhookHandlerOptions {
  readonly ingest: (request: WebhookIngestionRequest) => Promise<WebhookIngestionResult>;
  readonly newCorrelationId: () => string;
  readonly logger: () => Logger;
}

/**
 * Thin transport for `/api/webhooks/{channel}/{channelAccountId}`: captures the raw request for
 * verification, delegates everything else to the application use case and maps the result to HTTP. It
 * never parses provider payloads, calls a model or waits for a delay.
 */
export function createWebhookHandlers(options: WebhookHandlerOptions) {
  async function handle(request: Request, context: WebhookRouteContext): Promise<Response> {
    const supplied = request.headers.get("x-correlation-id");
    const correlationId = supplied !== null && CORRELATION_ID_PATTERN.test(supplied) ? supplied : options.newCorrelationId();

    try {
      const params = await context.params;
      const rawBody = request.method === "POST" ? await readBody(request) : new Uint8Array();
      if (rawBody === undefined) {
        return respond(413, { status: "payload_too_large" }, correlationId);
      }
      const webhook: RawWebhook = {
        method: request.method === "GET" ? "GET" : "POST",
        headers: Object.fromEntries(request.headers),
        query: Object.fromEntries(new URL(request.url).searchParams),
        rawBody,
        receivedAt: new Date(),
      };
      const result = await options.ingest({
        channel: params.channel.toUpperCase(),
        channelAccountId: params.channelAccountId,
        webhook,
        correlationId,
      });
      return toResponse(result, correlationId);
    } catch (error) {
      // Nothing was acknowledged, so the provider retries; ingestion is idempotent.
      options.logger().error("webhook.ingestion_failed", {
        correlationId,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      return respond(500, { status: "error" }, correlationId);
    }
  }

  return { GET: handle, POST: handle };
}

async function readBody(request: Request): Promise<Uint8Array | undefined> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BODY_BYTES) {
    return undefined;
  }
  const body = new Uint8Array(await request.arrayBuffer());
  return body.byteLength > MAX_WEBHOOK_BODY_BYTES ? undefined : body;
}

function toResponse(result: WebhookIngestionResult, correlationId: string): Response {
  switch (result.kind) {
    case "CHALLENGE":
      return new Response(result.responseBody, {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Correlation-Id": correlationId },
      });
    case "ACCEPTED":
      return respond(200, { status: "accepted" }, correlationId);
    case "UNAUTHORIZED":
      return respond(401, { status: "unauthorized" }, correlationId);
    case "INVALID_PAYLOAD":
      return respond(400, { status: "invalid_payload" }, correlationId);
    case "NOT_FOUND":
    case "ADAPTER_UNAVAILABLE":
      // Unknown accounts and channels without an adapter look the same from outside.
      return respond(404, { status: "not_found" }, correlationId);
  }
}

function respond(status: number, body: Readonly<Record<string, string>>, correlationId: string): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Correlation-Id": correlationId } });
}
