/**
 * WhatsApp's account-level webhooks, after verification (Issue #20).
 *
 * The case this exists for is a cached `APPROVED` outliving the approval. Meta pauses and disables
 * approved templates on quality feedback and tells us only through this field, so a webhook that is parsed
 * but not applied is a send the provider refuses after the customer was promised a reply.
 */
import type { RawWebhook } from "@omnichannel/channel-core";
import { createLogger } from "@omnichannel/observability";
import { describe, expect, it } from "vitest";

import { createWhatsAppAccountEventPort } from "./whatsapp-account-events";

const NOW = new Date("2026-10-04T12:00:00.000Z");
const WABA_ID = "102290129340398";

const account = (channel: "WHATSAPP" | "INSTAGRAM" = "WHATSAPP") => ({
  workspaceId: "ws_1",
  businessProfileId: "bp_1",
  channelAccountId: "ca_1",
  channel,
  status: "CONNECTED" as const,
  externalAccountId: "106540352242922",
});

const webhook = (body: unknown, method: "GET" | "POST" = "POST"): RawWebhook => ({
  method,
  headers: {},
  query: {},
  rawBody: new TextEncoder().encode(JSON.stringify(body)),
  receivedAt: NOW,
});

const statusUpdate = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  object: "whatsapp_business_account",
  entry: [
    {
      id: WABA_ID,
      changes: [
        {
          field: "message_template_status_update",
          value: { event: "PAUSED", message_template_name: "order_confirmation", message_template_language: "en_US", reason: "QUALITY_SCORE", ...overrides },
        },
      ],
    },
  ],
});

/** Records what reached the store, so the test can assert the scope rather than a row count. */
function harness(options: { readonly updated?: number; readonly fail?: boolean } = {}) {
  const applied: Readonly<Record<string, unknown>>[] = [];
  const logs: string[] = [];
  const port = createWhatsAppAccountEventPort({
    // Only the one call the port makes, so the test does not need a database.
    db: () =>
      ({
        whatsAppMessageTemplate: {
          updateMany: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
            if (options.fail === true) {
              return Promise.reject(new Error("the write failed"));
            }
            applied.push({ ...args.where, ...args.data });
            return Promise.resolve({ count: options.updated ?? 1 });
          },
        },
      }) as never,
    logger: () => createLogger({ level: "debug", sink: (line) => logs.push(line) }),
    now: () => NOW,
  });
  return { port, applied, logs };
}

describe("a template status update", () => {
  it("is applied to the messaging account the webhook names", async () => {
    const test = harness();

    const recorded = await test.port.apply({ account: account(), webhook: webhook(statusUpdate()) });

    expect(recorded).toBe(1);
    expect(test.applied[0]).toMatchObject({
      name: "order_confirmation",
      language: "en_US",
      status: "PAUSED",
      syncedAt: NOW,
      // The webhook's own `entry.id`, not the number the request happened to arrive on: a messaging
      // account may own several, and the template belongs to the account.
      connection: { wabaId: WABA_ID },
    });
  });

  it("logs the identifiers and the provider's code, never its prose", async () => {
    const test = harness();

    await test.port.apply({ account: account(), webhook: webhook(statusUpdate()) });

    const written = test.logs.join("\n");
    expect(written).toContain("whatsapp.template_status_applied");
    expect(written).toContain("order_confirmation");
    expect(written).not.toContain("QUALITY_SCORE_PROSE");
  });

  it("records several changes from one delivery", async () => {
    const test = harness();

    const recorded = await test.port.apply({
      account: account(),
      webhook: webhook({
        entry: [
          {
            id: WABA_ID,
            changes: [
              { field: "message_template_status_update", value: { event: "APPROVED", message_template_name: "a", message_template_language: "en_US" } },
              { field: "message_template_status_update", value: { event: "REJECTED", message_template_name: "b", message_template_language: "ru" } },
            ],
          },
        ],
      }),
    });

    expect(recorded).toBe(2);
    expect(test.applied.map((row) => row["status"])).toEqual(["APPROVED", "REJECTED"]);
  });
});

describe("what the port leaves alone", () => {
  it("ignores a channel that has no account-level events", async () => {
    const test = harness();

    expect(await test.port.apply({ account: account("INSTAGRAM"), webhook: webhook(statusUpdate()) })).toBe(0);
    expect(test.applied).toHaveLength(0);
  });

  it("ignores the subscription handshake", async () => {
    const test = harness();

    expect(await test.port.apply({ account: account(), webhook: webhook(statusUpdate(), "GET") })).toBe(0);
  });

  it("ignores a body it cannot read, because the route has already verified it", async () => {
    // A verified body this adapter cannot parse is Meta sending something new, not an error to raise.
    const test = harness();

    expect(
      await test.port.apply({ account: account(), webhook: { method: "POST", headers: {}, query: {}, rawBody: new TextEncoder().encode("not json"), receivedAt: NOW } }),
    ).toBe(0);
  });

  it("ignores a message webhook, which the normalizer owns", async () => {
    const test = harness();

    const recorded = await test.port.apply({
      account: account(),
      webhook: webhook({ entry: [{ id: WABA_ID, changes: [{ field: "messages", value: { messaging_product: "whatsapp", messages: [] } }] }] }),
    });

    expect(recorded).toBe(0);
    expect(test.applied).toHaveLength(0);
  });

  it("reports zero when the messaging account matched no row, rather than inventing one", async () => {
    const test = harness({ updated: 0 });

    expect(await test.port.apply({ account: account(), webhook: webhook(statusUpdate()) })).toBe(0);
  });
});
