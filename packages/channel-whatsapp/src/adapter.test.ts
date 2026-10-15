/**
 * The adapter as core code holds it (#18).
 *
 * Two properties are worth testing at this level rather than at the function level. An unverified payload
 * must never reach normalization — the guard is the only thing standing between a stranger's POST and a
 * customer's conversation. And one unmappable item in a batch must not discard the real messages beside
 * it, because Meta will redeliver the batch to the same result and the customers in it wait either way.
 */
import type { ChannelAdapter } from "@omnichannel/channel-core";
import { describe, expect, it } from "vitest";

import { createWhatsAppAdapter } from "./adapter";
import { createWhatsAppAdapterRegistry } from "./registry";
import {
  accepted,
  AT,
  BINDING,
  CUSTOMER_WA_ID,
  config,
  envelope,
  handshake,
  inboundText,
  scriptedHttp,
  seconds,
  signedWebhook,
  unsignedWebhook,
  VERIFY_TOKEN,
} from "./__fixtures__/payloads";

describe("the frozen contract", () => {
  it("is a ChannelAdapter for WhatsApp", () => {
    const adapter: ChannelAdapter = createWhatsAppAdapter(config());

    expect(adapter.channel).toBe("WHATSAPP");
  });

  it("keeps working when its members are destructured", async () => {
    // Arrow properties rather than methods, so nothing depends on `this`. A composition root that pulls
    // `send` out and passes it along must not get a different object's behaviour.
    const { verifyWebhook, normalizeWebhook } = createWhatsAppAdapter(config());

    expect(await verifyWebhook(signedWebhook(inboundText()))).toEqual({ status: "VERIFIED" });
    expect(await normalizeWebhook(signedWebhook(inboundText()))).toHaveLength(1);
  });

  it("answers the subscription handshake through the same member", async () => {
    const adapter = createWhatsAppAdapter(config());

    expect(await adapter.verifyWebhook(handshake({ "hub.mode": "subscribe", "hub.verify_token": VERIFY_TOKEN, "hub.challenge": "42" }))).toEqual({
      status: "CHALLENGE",
      responseBody: "42",
    });
  });
});

describe("the guard before normalization", () => {
  it("rejects an unverified payload as a rejected promise, not a throw", async () => {
    const adapter = createWhatsAppAdapter(config());

    // Rejected rather than thrown: the caller is an async route, and a synchronous throw from an async
    // member is the kind of difference that only shows up in production.
    await expect(adapter.normalizeWebhook(unsignedWebhook(inboundText()))).rejects.toThrow(/unverified/u);
  });
});

describe("a batch with one bad item", () => {
  it("keeps the events it could map", async () => {
    const adapter = createWhatsAppAdapter(config());
    const mixed = envelope({
      contacts: [{ wa_id: CUSTOMER_WA_ID }],
      messages: [
        { from: CUSTOMER_WA_ID, id: "wamid.good1", timestamp: seconds(AT), type: "text", text: { body: "first" } },
        // No id: unmappable, and dropped on its own.
        { from: CUSTOMER_WA_ID, timestamp: seconds(AT), type: "text", text: { body: "unmappable" } },
        { from: CUSTOMER_WA_ID, id: "wamid.good2", timestamp: seconds(AT), type: "text", text: { body: "second" } },
      ],
    });

    const events = await adapter.normalizeWebhook(signedWebhook(mixed));

    expect(events.map((event) => (event.type === "INBOUND_MESSAGE" ? event.text : undefined))).toEqual(["first", "second"]);
  });
});

describe("capabilities", () => {
  it("reports templates, which is what distinguishes this channel", async () => {
    const adapter = createWhatsAppAdapter(config());

    expect(await adapter.getCapabilities(BINDING.channelAccountId)).toMatchObject({ text: true, templates: true, audio: true });
  });

  it("reports nothing for an account it is not bound to", async () => {
    const adapter = createWhatsAppAdapter(config());

    // Another account's capabilities are not ours to state, and a confident wrong answer here would let a
    // send be attempted on a connection this adapter knows nothing about.
    expect(await adapter.getCapabilities("ca_someone_else")).toMatchObject({ text: false, templates: false });
  });
});

describe("the registry", () => {
  it("binds the phone number from the account and the WABA from the deployment's own config", async () => {
    // Two identifiers from two sources on purpose: the sending asset is the account row's, and the WABA is
    // the deployment's. Taking either from a payload is how one business's webhook reaches another's data.
    const http = scriptedHttp([accepted()]);
    const registry = createWhatsAppAdapterRegistry({
      bindingFor: () => ({
        secrets: { appSecret: "s", verifyToken: "v", accessToken: () => Promise.resolve("t") },
        wabaId: BINDING.wabaId,
      }),
      http: http.port,
    });

    const adapter = registry.adapterFor({
      workspaceId: BINDING.workspaceId,
      businessProfileId: BINDING.businessProfileId,
      channelAccountId: BINDING.channelAccountId,
      channel: "WHATSAPP",
      status: "CONNECTED",
      externalAccountId: BINDING.phoneNumberId,
    });

    expect(adapter).toBeDefined();
    await adapter?.send({
      workspaceId: BINDING.workspaceId,
      businessProfileId: BINDING.businessProfileId,
      channelAccountId: BINDING.channelAccountId,
      conversationId: "cv_1",
      recipientExternalId: CUSTOMER_WA_ID,
      operationId: "op_1",
      content: { type: "TEXT", text: "hello" },
    });
    expect(http.requests[0]?.url).toContain(`/${BINDING.phoneNumberId}/messages`);
  });

  it("refuses an account on another channel, and one this deployment cannot serve", () => {
    const registry = createWhatsAppAdapterRegistry({
      bindingFor: (account) =>
        account.channelAccountId === "ca_known"
          ? { secrets: { appSecret: "s", verifyToken: "v", accessToken: () => Promise.resolve("t") }, wabaId: "w" }
          : undefined,
      http: scriptedHttp([]).port,
    });
    const account = {
      workspaceId: "ws_1",
      businessProfileId: "bp_1",
      channelAccountId: "ca_known",
      channel: "WHATSAPP" as const,
      status: "CONNECTED" as const,
      externalAccountId: "100000000000001",
    };

    expect(registry.adapterFor({ ...account, channel: "INSTAGRAM" })).toBeUndefined();
    expect(registry.adapterFor({ ...account, channelAccountId: "ca_unknown" })).toBeUndefined();
  });

  it("carries a broken connection into the adapter, so the refusal happens at the transport too", async () => {
    const http = scriptedHttp([accepted()]);
    const registry = createWhatsAppAdapterRegistry({
      bindingFor: () => ({ secrets: { appSecret: "s", verifyToken: "v", accessToken: () => Promise.resolve("t") }, wabaId: "w" }),
      http: http.port,
    });

    const adapter = registry.adapterFor({
      workspaceId: "ws_1",
      businessProfileId: "bp_1",
      channelAccountId: "ca_1",
      channel: "WHATSAPP",
      status: "NEEDS_REAUTH",
      externalAccountId: "100000000000001",
    });

    const result = await adapter?.send({
      workspaceId: "ws_1",
      businessProfileId: "bp_1",
      channelAccountId: "ca_1",
      conversationId: "cv_1",
      recipientExternalId: CUSTOMER_WA_ID,
      operationId: "op_1",
      content: { type: "TEXT", text: "hello" },
    });

    // Refused here rather than only at the policy layer: a gate above it could be bypassed by a new
    // caller, and this one cannot.
    expect(result).toMatchObject({ outcome: "REJECTED", code: "ACCOUNT_NOT_CONNECTED" });
    expect(http.requests).toHaveLength(0);
  });
});
