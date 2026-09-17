import type { ChannelAdapter, RawWebhook } from "@omnichannel/channel-core";
import { NO_CAPABILITIES } from "@omnichannel/domain";
import { describe, expect, it, vi } from "vitest";

import {
  ingestWebhook,
  isEligibleForInboundDebounce,
  nextDeliveryStatus,
  outboxRetryDelayMs,
  sampleDelayMs,
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

function dependencies(options: { account?: WebhookAccount; adapter?: ChannelAdapter } = {}) {
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
    log,
    now: () => new Date("2026-09-17T10:00:00.000Z"),
    random: () => 0,
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
