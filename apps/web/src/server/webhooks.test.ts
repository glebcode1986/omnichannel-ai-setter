import type { WebhookIngestionRequest, WebhookIngestionResult } from "@omnichannel/application";
import { createLogger } from "@omnichannel/observability";
import { describe, expect, it, vi } from "vitest";

import { createWebhookHandlers, MAX_WEBHOOK_BODY_BYTES } from "./webhooks";

function setup(result: WebhookIngestionResult | Error) {
  const received: WebhookIngestionRequest[] = [];
  const logs: string[] = [];
  const ingest = vi.fn((request: WebhookIngestionRequest) => {
    received.push(request);
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  });
  const handlers = createWebhookHandlers({
    ingest,
    newCorrelationId: () => "generated-correlation-id",
    logger: () => createLogger({ level: "debug", sink: (line) => logs.push(line) }),
  });
  const context = { params: Promise.resolve({ channel: "instagram", channelAccountId: "ca_1" }) };
  return { handlers, context, received, logs, ingest };
}

const accepted: WebhookIngestionResult = {
  kind: "ACCEPTED",
  summary: { received: 1, processed: 1, duplicates: 0, rejected: 0, outboxDispatched: 1, outboxDeferred: 0 },
};

describe("webhook route handlers", () => {
  it("passes the raw request to ingestion unchanged and acknowledges accepted batches", async () => {
    const { handlers, context, received } = setup(accepted);
    const body = new Uint8Array([123, 34, 97, 34, 58, 49, 125, 0xff]);

    const response = await handlers.POST(
      new Request("https://app.test/api/webhooks/instagram/ca_1?x=1", {
        method: "POST",
        headers: { "X-Hub-Signature-256": "sha256=abc", "X-Correlation-Id": "incoming-correlation-1" },
        body,
      }),
      context,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "accepted" });
    expect(response.headers.get("x-correlation-id")).toBe("incoming-correlation-1");
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      channel: "INSTAGRAM",
      channelAccountId: "ca_1",
      correlationId: "incoming-correlation-1",
      webhook: { method: "POST", query: { x: "1" }, rawBody: body },
    });
    expect(received[0]?.webhook.headers["x-hub-signature-256"]).toBe("sha256=abc");
  });

  it("answers verification challenges as plain text", async () => {
    const { handlers, context, received } = setup({ kind: "CHALLENGE", responseBody: "challenge-7" });
    const response = await handlers.GET(new Request("https://app.test/api/webhooks/instagram/ca_1?hub.challenge=challenge-7"), context);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("challenge-7");
    expect(received[0]?.webhook).toMatchObject({ method: "GET", rawBody: new Uint8Array() });
  });

  it.each<[WebhookIngestionResult, number]>([
    [{ kind: "UNAUTHORIZED" }, 401],
    [{ kind: "INVALID_PAYLOAD" }, 400],
    [{ kind: "NOT_FOUND" }, 404],
    [{ kind: "ADAPTER_UNAVAILABLE" }, 404],
  ])("maps %o to HTTP %i", async (result, status) => {
    const { handlers, context } = setup(result);
    const response = await handlers.POST(new Request("https://app.test/x", { method: "POST", body: "{}" }), context);
    expect(response.status).toBe(status);
  });

  it("generates a correlation ID when the supplied one is missing or unsafe", async () => {
    const { handlers, context, received } = setup(accepted);
    const response = await handlers.POST(
      new Request("https://app.test/x", { method: "POST", body: "{}", headers: { "X-Correlation-Id": "bad id <script>" } }),
      context,
    );
    expect(response.headers.get("x-correlation-id")).toBe("generated-correlation-id");
    expect(received[0]?.correlationId).toBe("generated-correlation-id");
  });

  it("refuses oversized bodies before ingestion", async () => {
    const { handlers, context, ingest } = setup(accepted);
    const response = await handlers.POST(
      new Request("https://app.test/x", { method: "POST", body: new Uint8Array(MAX_WEBHOOK_BODY_BYTES + 1) }),
      context,
    );
    expect(response.status).toBe(413);
    expect(ingest).not.toHaveBeenCalled();
  });

  it("returns 500 without error details when ingestion throws, so the provider retries", async () => {
    const { handlers, context, logs } = setup(new Error("database password=fake-secret unreachable"));
    const response = await handlers.POST(new Request("https://app.test/x", { method: "POST", body: "{}" }), context);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ status: "error" });
    expect(response.headers.get("x-correlation-id")).toBe("generated-correlation-id");
    expect(logs.join("\n")).toContain("webhook.ingestion_failed");
    expect(logs.join("\n")).not.toContain("fake-secret");
  });
});
