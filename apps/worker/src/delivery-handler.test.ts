import type { DeliveryChannelState, DeliveryDependencies, DeliverySendContext, DeliveryStateGuard, PolicyLimits } from "@omnichannel/application";
import { createLogger } from "@omnichannel/observability";
import type { DeliveryJob } from "@omnichannel/queue";
import { describe, expect, it } from "vitest";

import { createDeliveryHandler } from "./delivery-handler";

const NOW = new Date("2026-09-19T12:00:00.000Z");

const job: DeliveryJob = {
  schemaVersion: 1,
  workspaceId: "ws_1",
  businessProfileId: "bp_1",
  correlationId: "corr_1",
  conversationId: "conv_1",
  draftId: "draft_1",
  deliveryJobId: "djob_1",
  operationId: "op_1",
  scheduledFor: NOW.toISOString(),
  selectedDelayMs: 60_000,
};

const limits: PolicyLimits = {
  confidenceThreshold: 0.8,
  mandatoryReviewReasons: [],
  afterWindow: { channel: "INSTAGRAM", policy: "STANDARD_ONLY" },
};

const channelState: DeliveryChannelState = {
  window: { state: "OPEN_FREEFORM", expiresAt: new Date(NOW.getTime() + 3_600_000) },
  humanAgent: { state: "UNAVAILABLE", reason: "NOT_APPROVED" },
};

function harness(overrides: { send?: DeliveryDependencies["sender"]["send"]; deliverable?: boolean } = {}) {
  const logs: string[] = [];
  const sendContext: DeliverySendContext = {
    deliveryJobId: "djob_1",
    operationId: "op_1",
    workspaceId: "ws_1",
    commercial: { paidWorkAllowed: true, aiDrafts: true, autopilot: true },
    draftId: "draft_1",
    conversationId: "conv_1",
    channel: "INSTAGRAM",
    recipientExternalId: "ig-user-1",
    channelAccountId: "ca_1",
    text: "We open at 10 on Saturday.",
    status: "SCHEDULED",
    attemptCount: 0,
    mode: "AUTOPILOT",
    aiEnabled: true,
    takeover: { state: "NONE" },
    replyCycle: "OWNED",
    account: "CONNECTED",
    draftNeedsReview: false,
    alreadySent: false,
    limits,
    authority: { kind: "AUTOMATED" },
    // Opaque by design: this handler never looks inside one, it only lets the store see it again.
    guard: {} as DeliveryStateGuard,
  };
  const engine: DeliveryDependencies = {
    store: {
      loadForSend: () => Promise.resolve(overrides.deliverable === false ? undefined : sendContext),
      claim: () => Promise.resolve({ kind: "CLAIMED" }),
      settle: () => Promise.resolve(),
      reschedule: () => Promise.resolve(),
    },
    sender: { send: overrides.send ?? (() => Promise.resolve({ outcome: "ACCEPTED", platformMessageId: "mid_1" })) },
    channel: { stateFor: () => channelState },
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    now: () => NOW,
  };
  const handler = createDeliveryHandler({
    engine,
    logger: createLogger({ level: "debug", sink: (line) => logs.push(line) }),
  });
  return { handler, logs };
}

describe("delivery handler", () => {
  it("hands the queue the raw send result whenever the adapter was called", async () => {
    const { handler } = harness();

    // The queue runs its own disposition on this, including enqueueing reconciliation for an ambiguity.
    expect(await handler(job)).toEqual({ status: "SEND_RESULT", result: { outcome: "ACCEPTED", platformMessageId: "mid_1" } });
  });

  it("passes an ambiguous result out rather than deciding on the queue's behalf", async () => {
    const { handler } = harness({
      send: () => Promise.resolve({ outcome: "AMBIGUOUS", code: "TIMEOUT", message: "no response" }),
    });

    expect(await handler(job)).toEqual({ status: "SEND_RESULT", result: { outcome: "AMBIGUOUS", code: "TIMEOUT", message: "no response" } });
  });

  it("reports a skip when nothing was sent, so the queue never treats it as an attempt", async () => {
    const { handler } = harness({ deliverable: false });

    expect(await handler(job)).toMatchObject({ status: "NOT_CLAIMED", retryable: false });
  });

  it("logs the outcome against the correlation id", async () => {
    const { handler, logs } = harness();

    await handler(job);

    expect(logs.join("\n")).toContain("worker.delivery");
    expect(logs.join("\n")).toContain("corr_1");
  });
});
