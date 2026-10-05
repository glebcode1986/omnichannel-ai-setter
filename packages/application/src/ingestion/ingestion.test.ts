import type { ChannelAdapter, RawWebhook } from "@omnichannel/channel-core";
import { NO_CAPABILITIES } from "@omnichannel/domain";
import { describe, expect, it, vi } from "vitest";

import {
  ingestWebhook,
  isEligibleForInboundDebounce,
  nextDeliveryStatus,
  outboxRetryDelayMs,
  sampleDelayMs,
  VERIFICATION_FAILURES,
  type IngestionDependencies,
  type IngestionStore,
  type WebhookAccount,
} from "../index";

const account: WebhookAccount = {
  workspaceId: "ws_1",
  businessProfileId: "bp_1",
  channelAccountId: "ca_1",
  channel: "INSTAGRAM",
  status: "CONNECTED",
  externalAccountId: "ig_1",
};

const webhook: RawWebhook = { method: "POST", headers: {}, query: {}, rawBody: new Uint8Array(), receivedAt: new Date() };

function adapter(overrides: Partial<ChannelAdapter> = {}): ChannelAdapter {
  return {
    channel: "INSTAGRAM",
    verifyWebhook: () => Promise.resolve({ status: "VERIFIED" }),
    normalizeWebhook: () => Promise.resolve([]),
    getCapabilities: () => Promise.resolve(NO_CAPABILITIES),
    evaluateWindow: () => Promise.resolve({ state: "UNKNOWN", reason: "test" }),
    send: () => Promise.resolve({ outcome: "REJECTED", retryable: false, message: "test" }),
    ...overrides,
  };
}

function dependencies(options: { account?: WebhookAccount; adapter?: ChannelAdapter; accountEvents?: IngestionDependencies["accountEvents"] } = {}) {
  const transaction = vi.fn(() => Promise.reject(new Error("no transaction expected")));
  const store = {
    findWebhookAccount: vi.fn(() => Promise.resolve(options.account)),
    transaction,
    claimOutboxEntries: vi.fn(() => Promise.resolve([])),
    markOutboxDispatched: vi.fn(() => Promise.resolve()),
    markOutboxFailed: vi.fn(() => Promise.resolve()),
  } satisfies IngestionStore;
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deps: IngestionDependencies = {
    store,
    adapters: { adapterFor: () => options.adapter },
    scheduler: { scheduleInboundDebounce: vi.fn(() => Promise.resolve()) },
    transcription: { scheduleMediaTranscription: vi.fn(() => Promise.resolve()) },
    log,
    now: () => new Date("2026-09-17T10:00:00.000Z"),
    random: () => 0,
    ...(options.accountEvents === undefined ? {} : { accountEvents: options.accountEvents }),
  };
  return { deps, store, transaction, log };
}

const request = (overrides: Partial<Parameters<typeof ingestWebhook>[1]> = {}) => ({
  channel: "INSTAGRAM",
  channelAccountId: "ca_1",
  webhook,
  correlationId: "corr_1",
  ...overrides,
});

describe("ingestWebhook early exits", () => {
  it("rejects invalid route parameters without looking anything up", async () => {
    const { deps, store } = dependencies({ account, adapter: adapter() });
    expect(await ingestWebhook(deps, request({ channel: "TELEGRAM" }))).toEqual({ kind: "NOT_FOUND" });
    expect(await ingestWebhook(deps, request({ channelAccountId: "ca 1" }))).toEqual({ kind: "NOT_FOUND" });
    expect(store.findWebhookAccount).not.toHaveBeenCalled();
  });

  it("treats unknown and disconnected accounts as not found, and missing or mismatched adapters as unavailable", async () => {
    expect(await ingestWebhook(dependencies({ adapter: adapter() }).deps, request())).toEqual({ kind: "NOT_FOUND" });
    expect(
      await ingestWebhook(dependencies({ account: { ...account, status: "DISCONNECTED" }, adapter: adapter() }).deps, request()),
    ).toEqual({ kind: "NOT_FOUND" });
    expect(await ingestWebhook(dependencies({ account }).deps, request())).toEqual({ kind: "ADAPTER_UNAVAILABLE" });
    expect(await ingestWebhook(dependencies({ account, adapter: adapter({ channel: "WHATSAPP" }) }).deps, request())).toEqual({
      kind: "ADAPTER_UNAVAILABLE",
    });
  });

  it("never normalizes or opens a transaction when verification fails", async () => {
    const normalizeWebhook = vi.fn(() => Promise.resolve([]));
    const { deps, transaction } = dependencies({
      account,
      adapter: adapter({ verifyWebhook: () => Promise.resolve({ status: "REJECTED", reason: "bad signature" }), normalizeWebhook }),
    });

    expect(await ingestWebhook(deps, request())).toEqual({ kind: "UNAUTHORIZED" });
    expect(normalizeWebhook).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("keeps the adapter's rejection detail out of the log entirely", async () => {
    // The adapter sees raw headers, query values and body bytes, and its `reason` is free text it builds
    // from them. Every canary below is something that has plausibly appeared in one: a bearer token, a
    // signature, a query parameter and a fragment of a customer's message.
    const canaries = [
      "Bearer astra-canary-secret-7f3a9c",
      "sha256=canary-signature-4b1d",
      "canary-query-value-91ee",
      "canary body fragment: my card number is",
    ];
    const normalizeWebhook = vi.fn(() => Promise.resolve([]));
    const { deps, transaction, log } = dependencies({
      account,
      adapter: adapter({
        verifyWebhook: () => Promise.resolve({ status: "REJECTED", reason: canaries.join(" | ") }),
        normalizeWebhook,
      }),
    });

    const result = await ingestWebhook(
      deps,
      request({
        webhook: {
          ...webhook,
          headers: { authorization: canaries[0] ?? "", "x-hub-signature-256": canaries[1] ?? "" },
          query: { token: canaries[2] ?? "" },
          // Built without TextEncoder: this package is pure and has no Node.js types, which is the same
          // rule that keeps the production code from reaching for anything platform-specific.
          rawBody: Uint8Array.from([...(canaries[3] ?? "")], (character) => character.charCodeAt(0)),
        },
      }),
    );

    expect(result).toEqual({ kind: "UNAUTHORIZED" });
    expect(normalizeWebhook).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();

    // Everything that reached the log port, serialized whole: a canary hiding in a nested field or in an
    // error's own properties would be missed by checking the top-level ones.
    const emitted = JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls]);
    for (const canary of canaries) {
      expect(emitted).not.toContain(canary);
    }
    expect(log.warn).toHaveBeenCalledWith("ingestion.verification_failed", expect.objectContaining({ reasonCode: "ADAPTER_REJECTED" }));
    // Only the closed code, and nothing shaped like the old free-text field beside it.
    const failure = log.warn.mock.calls.find((call) => call[0] === "ingestion.verification_failed");
    expect(Object.keys((failure?.[1] ?? {}) as Record<string, unknown>)).not.toContain("reason");
  });

  it("pins the verified-but-not-a-delivery case to its own closed code", async () => {
    const { deps, log } = dependencies({ account, adapter: adapter() });

    // Its own code, so a later edit cannot fold the two cases together and reach for free text to tell
    // them apart again.
    expect(await ingestWebhook(deps, request({ webhook: { ...webhook, method: "GET" } }))).toEqual({ kind: "UNAUTHORIZED" });
    expect(log.warn).toHaveBeenCalledWith("ingestion.verification_failed", expect.objectContaining({ reasonCode: "VERIFIED_NON_POST" }));
    expect(VERIFICATION_FAILURES).toEqual(["ADAPTER_REJECTED", "VERIFIED_NON_POST"]);
  });

  it("only accepts verified POSTs and reports normalization failures as invalid payloads", async () => {
    const verifiedGet = dependencies({ account, adapter: adapter() });
    expect(await ingestWebhook(verifiedGet.deps, request({ webhook: { ...webhook, method: "GET" } }))).toEqual({ kind: "UNAUTHORIZED" });

    const broken = dependencies({ account, adapter: adapter({ normalizeWebhook: () => Promise.reject(new SyntaxError("bad json")) }) });
    expect(await ingestWebhook(broken.deps, request())).toEqual({ kind: "INVALID_PAYLOAD" });
    expect(broken.transaction).not.toHaveBeenCalled();
  });

  it("audits invalid events and events outside the resolved Workspace/Business Profile/account/channel", async () => {
    const reaction = {
      type: "REACTION",
      workspaceId: "ws_1",
      businessProfileId: "bp_1",
      channel: "INSTAGRAM",
      channelAccountId: "ca_1",
      sourceEventId: "evt_1",
      occurredAt: new Date(),
      platformMessageId: "mid_1",
      reactorExternalId: "user_1",
      action: "REACT",
    };
    const { deps, transaction, log } = dependencies({
      account,
      adapter: adapter({
        normalizeWebhook: () =>
          Promise.resolve([
            { type: "TYPING", workspaceId: "ws_1" },
            { ...reaction, businessProfileId: undefined },
            { ...reaction, workspaceId: "ws_other" },
            { ...reaction, businessProfileId: "bp_other" },
            { ...reaction, channelAccountId: "ca_other" },
            { ...reaction, channel: "WHATSAPP" },
            { ...reaction, workspaceId: "ws_other", businessProfileId: "bp_other" },
          ] as never),
      }),
    });

    expect(await ingestWebhook(deps, request())).toEqual({
      kind: "ACCEPTED",
      summary: { received: 7, processed: 0, duplicates: 0, rejected: 7, debounceScheduled: 0, debounceDeferred: 0 },
    });
    expect(transaction).not.toHaveBeenCalled();
    // Rejections are attributed to the resolved scope, never to the forged one.
    for (const call of log.warn.mock.calls as unknown as [string, Record<string, unknown>][]) {
      expect(call[1]).toMatchObject({ correlationId: "corr_1", workspaceId: "ws_1", businessProfileId: "bp_1", channelAccountId: "ca_1" });
    }
    expect(
      log.warn.mock.calls.map((call: unknown[]) => {
        const fields = call[1] as { reason?: string; fields?: string[] } | undefined;
        return [call[0], fields?.reason, fields?.fields];
      }),
    ).toEqual([
      ["ingestion.event_rejected", "INVALID_EVENT", undefined],
      ["ingestion.event_rejected", "INVALID_EVENT", undefined],
      ["ingestion.event_rejected", "SCOPE_MISMATCH", ["workspaceId"]],
      ["ingestion.event_rejected", "SCOPE_MISMATCH", ["businessProfileId"]],
      ["ingestion.event_rejected", "SCOPE_MISMATCH", ["channelAccountId"]],
      ["ingestion.event_rejected", "SCOPE_MISMATCH", ["channel"]],
      ["ingestion.event_rejected", "SCOPE_MISMATCH", ["workspaceId", "businessProfileId"]],
    ]);
  });
});

describe("ingestion rules", () => {
  it("starts debounce only for open, AI-enabled conversations without takeover", () => {
    const open = { conversationId: "c", contactId: "ct", stateVersion: 0, status: "OPEN", aiEnabled: true, takeoverState: "NONE" } as const;
    expect(isEligibleForInboundDebounce(open)).toBe(true);
    expect(isEligibleForInboundDebounce({ ...open, status: "CLOSED" })).toBe(false);
    expect(isEligibleForInboundDebounce({ ...open, aiEnabled: false })).toBe(false);
    expect(isEligibleForInboundDebounce({ ...open, takeoverState: "HUMAN_ACTIVE" })).toBe(false);
    expect(isEligibleForInboundDebounce({ ...open, takeoverState: "REVIEW_REQUIRED" })).toBe(false);
  });

  it.each([
    [null, "SENT", "SENT"],
    ["PENDING", "DELIVERED", "DELIVERED"],
    ["SENT", "READ", "READ"],
    ["READ", "DELIVERED", undefined],
    ["DELIVERED", "DELIVERED", undefined],
    ["SENT", "FAILED", "FAILED"],
    ["DELIVERED", "FAILED", undefined],
    ["FAILED", "DELIVERED", "DELIVERED"],
  ] as const)("moves delivery status %s + %s -> %s", (current, incoming, expected) => {
    expect(nextDeliveryStatus(current, incoming)).toBe(expected);
  });

  it("samples debounce delays inside the configured window and backs off outbox retries", () => {
    expect(sampleDelayMs({ minMs: 7_000, maxMs: 12_000 }, () => 0)).toBe(7_000);
    expect(sampleDelayMs({ minMs: 7_000, maxMs: 12_000 }, () => 0.999_999)).toBe(12_000);
    expect(() => sampleDelayMs({ minMs: 7_000, maxMs: 12_000 }, () => 1)).toThrow(RangeError);
    expect([1, 2, 3, 20].map(outboxRetryDelayMs)).toEqual([5_000, 10_000, 20_000, 300_000]);
  });
});

/**
 * Account-level webhooks (Issue #20).
 *
 * Some channels deliver facts about the *account* on the same endpoint as messages — WhatsApp's template
 * status changes are the case this exists for. They are not conversation events, so the normalizer never
 * sees them; what matters here is that they are applied only after verification and that a failure in one
 * never costs the conversation events in the same delivery.
 */
describe("account-level events", () => {
  it("applies them only after the webhook has been verified", async () => {
    const calls: string[] = [];
    const accountEvents = {
      apply: () => {
        calls.push("applied");
        return Promise.resolve(1);
      },
    };

    const unverified = dependencies({
      account,
      adapter: adapter({ verifyWebhook: () => Promise.resolve({ status: "REJECTED", reason: "bad signature" }) }),
      accountEvents,
    });
    expect(await ingestWebhook(unverified.deps, request())).toEqual({ kind: "UNAUTHORIZED" });
    // Nothing applied: a body nobody verified is a body from a stranger.
    expect(calls).toEqual([]);

    const verified = dependencies({ account, adapter: adapter(), accountEvents });
    await ingestWebhook(verified.deps, request());
    expect(calls).toEqual(["applied"]);
  });

  it("does not apply them to the subscription handshake", async () => {
    const calls: string[] = [];
    const { deps } = dependencies({
      account,
      adapter: adapter({ verifyWebhook: () => Promise.resolve({ status: "CHALLENGE", responseBody: "42" }) }),
      accountEvents: {
        apply: () => {
          calls.push("applied");
          return Promise.resolve(0);
        },
      },
    });

    expect(await ingestWebhook(deps, request())).toEqual({ kind: "CHALLENGE", responseBody: "42" });
    expect(calls).toEqual([]);
  });

  it("never fails the webhook because an account-level write failed", async () => {
    // Refusing would have the provider replay the whole delivery — including its conversation events —
    // for up to seven days, to fix a write that is not what the customer is waiting for.
    const { deps, log } = dependencies({
      account,
      adapter: adapter(),
      accountEvents: { apply: () => Promise.reject(new Error("the write failed")) },
    });

    const result = await ingestWebhook(deps, request());

    expect(result.kind).not.toBe("ERROR");
    expect(log.warn).toHaveBeenCalledWith("ingestion.account_events_failed", expect.objectContaining({ errorName: "Error" }));
  });
});
