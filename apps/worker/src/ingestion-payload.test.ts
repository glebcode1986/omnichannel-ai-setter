import type { InboundDebouncePayload } from "@omnichannel/application";
import { INBOUND_DEBOUNCE, inboundDebounceJobSchema, type InboundDebounceJob } from "@omnichannel/queue";
import { describe, expect, expectTypeOf, it } from "vitest";

/**
 * The outbox stores the application's InboundDebouncePayload and the worker enqueues it through the strict
 * queue schema, so the two definitions must not drift apart (both carry the Business Profile scope).
 */
describe("inbound debounce payload contract", () => {
  const payload: InboundDebouncePayload = {
    schemaVersion: 1,
    workspaceId: "ws_1",
    businessProfileId: "bp_1",
    correlationId: "corr_1",
    channelAccountId: "ca_1",
    conversationId: "conv_1",
    anchorMessageId: "msg_1",
    anchorInboundAt: "2026-09-17T10:00:00.000Z",
  };

  it("keeps the application payload and the queue job type key for key identical", () => {
    expectTypeOf<keyof InboundDebouncePayload>().toEqualTypeOf<keyof InboundDebounceJob>();
    expectTypeOf<InboundDebouncePayload>().toExtend<InboundDebounceJob>();
    expectTypeOf<InboundDebounceJob>().toExtend<InboundDebouncePayload>();
    expectTypeOf<InboundDebouncePayload["businessProfileId"]>().toEqualTypeOf<string>();
  });

  it("accepts an application payload unchanged and derives a Workspace + Business Profile scoped job ID", () => {
    expect(inboundDebounceJobSchema.parse(payload)).toEqual(payload);
    expect(INBOUND_DEBOUNCE.jobId(payload)).toBe("inbound-debounce|v1|ws_1|bp_1|conv_1|msg_1");
    expect(INBOUND_DEBOUNCE.jobId({ ...payload, businessProfileId: "bp_2" })).not.toBe(INBOUND_DEBOUNCE.jobId(payload));

    const { businessProfileId: _businessProfileId, ...withoutProfile } = payload;
    expect(inboundDebounceJobSchema.safeParse(withoutProfile).success).toBe(false);
  });
});
