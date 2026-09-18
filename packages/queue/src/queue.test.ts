import { DEFAULT_DEBOUNCE_WINDOW_MS, DEFAULT_DELIVERY_DELAY_MS } from "@omnichannel/domain";
import { describe, expect, it } from "vitest";
import type { z } from "zod";

import {
  AI_DRAFT_GENERATION,
  aiDraftGenerationJobSchema,
  buildJobId,
  DELIVERY,
  deliveryJobSchema,
  INBOUND_DEBOUNCE,
  inboundDebounceJobSchema,
  JOB_FAMILIES,
  JobPayloadValidationError,
  planDelay,
  RECONCILIATION,
  reconciliationJobSchema,
  type DeliveryJob,
} from "./index";
import { parsePayload } from "./payloads";

const delivery: DeliveryJob = {
  schemaVersion: 1,
  workspaceId: "ws_1",
  businessProfileId: "bp_1",
  correlationId: "corr_1",
  conversationId: "conv_1",
  draftId: "draft_1",
  deliveryJobId: "djob_1",
  operationId: "op_1",
  scheduledFor: "2026-09-17T10:01:00.000Z",
  selectedDelayMs: 60_000,
};

describe("job payload schemas", () => {
  it("accept identifier-only payloads for every job family", () => {
    expect(parsePayload(DELIVERY.schema, DELIVERY.jobName, delivery)).toEqual(delivery);
    expect(
      inboundDebounceJobSchema.parse({
        schemaVersion: 1,
        workspaceId: "ws_1",
        businessProfileId: "bp_1",
        correlationId: "corr_1",
        channelAccountId: "ca_1",
        conversationId: "conv_1",
        anchorMessageId: "msg_1",
        anchorInboundAt: "2026-09-17T10:00:00.000Z",
      }),
    ).toBeDefined();
    expect(
      aiDraftGenerationJobSchema.parse({
        schemaVersion: 1,
        workspaceId: "ws_1",
        businessProfileId: "bp_1",
        correlationId: "corr_1",
        conversationId: "conv_1",
        anchorMessageId: "msg_1",
        trigger: { kind: "HUMAN_REQUEST", requestedByUserId: "user_7", requestedAt: "2026-09-18T10:00:00.000Z", requestId: "req_1" },
      }),
    ).toBeDefined();
    expect(
      reconciliationJobSchema.parse({
        schemaVersion: 1,
        workspaceId: "ws_1",
        businessProfileId: "bp_1",
        correlationId: "corr_1",
        conversationId: "conv_1",
        deliveryJobId: "djob_1",
        operationId: "op_1",
        reason: "AMBIGUOUS_SEND_RESULT",
        detectedAt: "2026-09-17T10:02:00.000Z",
      }),
    ).toBeDefined();
  });

  it.each<[string, unknown]>([
    ["unknown schema version", { ...delivery, schemaVersion: 2 }],
    ["missing operation id", { ...delivery, operationId: undefined }],
    ["identifier with whitespace", { ...delivery, workspaceId: "ws 1" }],
    ["copied message text", { ...delivery, text: "customer message" }],
    ["non-ISO schedule", { ...delivery, scheduledFor: "tomorrow" }],
    ["negative delay", { ...delivery, selectedDelayMs: -1 }],
    ["fractional delay", { ...delivery, selectedDelayMs: 1.5 }],
    ["non-object payload", "op_1"],
  ])("rejects %s", (_name, input) => {
    expect(() => parsePayload(deliveryJobSchema, DELIVERY.jobName, input)).toThrow(JobPayloadValidationError);
  });

  it("rejects missing or malformed Business Profile scope for every job family", () => {
    const valid: [string, z.ZodType<unknown>, Record<string, unknown>][] = [
      [
        INBOUND_DEBOUNCE.jobName,
        inboundDebounceJobSchema,
        {
          schemaVersion: 1,
          workspaceId: "ws_1",
          businessProfileId: "bp_1",
          correlationId: "corr_1",
          channelAccountId: "ca_1",
          conversationId: "conv_1",
          anchorMessageId: "msg_1",
          anchorInboundAt: "2026-09-17T10:00:00.000Z",
        },
      ],
      [
        AI_DRAFT_GENERATION.jobName,
        aiDraftGenerationJobSchema,
        {
          schemaVersion: 1,
          workspaceId: "ws_1",
          businessProfileId: "bp_1",
          correlationId: "corr_1",
          conversationId: "conv_1",
          anchorMessageId: "msg_1",
          trigger: { kind: "AUTOMATIC", reason: "DEBOUNCE_ELAPSED" },
        },
      ],
      [DELIVERY.jobName, deliveryJobSchema, { ...delivery }],
      [
        RECONCILIATION.jobName,
        reconciliationJobSchema,
        {
          schemaVersion: 1,
          workspaceId: "ws_1",
          businessProfileId: "bp_1",
          correlationId: "corr_1",
          conversationId: "conv_1",
          deliveryJobId: "djob_1",
          operationId: "op_1",
          reason: "AMBIGUOUS_SEND_RESULT",
          detectedAt: "2026-09-17T10:02:00.000Z",
        },
      ],
    ];
    for (const [jobName, schema, payload] of valid) {
      expect(parsePayload(schema, jobName, payload)).toEqual(payload);
      const { businessProfileId: _omitted, ...withoutProfile } = payload;
      for (const invalid of [withoutProfile, { ...payload, businessProfileId: "" }, { ...payload, businessProfileId: "  " }, { ...payload, businessProfileId: "bp 1" }, { ...payload, businessProfileId: 7 }]) {
        let error: unknown;
        try {
          parsePayload(schema, jobName, invalid);
        } catch (caught) {
          error = caught;
        }
        expect(error, jobName).toBeInstanceOf(JobPayloadValidationError);
        expect((error as JobPayloadValidationError).issues.map((issue) => issue.path)).toContain("businessProfileId");
      }
    }
  });

  it("will not let a job claim a person asked for it without naming the person", () => {
    const base = {
      schemaVersion: 1,
      workspaceId: "ws_1",
      businessProfileId: "bp_1",
      correlationId: "corr_1",
      conversationId: "conv_1",
      anchorMessageId: "msg_1",
    };
    const automatic = { kind: "AUTOMATIC", reason: "DEBOUNCE_ELAPSED" };
    const human = { kind: "HUMAN_REQUEST", requestedByUserId: "user_7", requestedAt: "2026-09-18T10:00:00.000Z", requestId: "req_1" };

    expect(aiDraftGenerationJobSchema.safeParse({ ...base, trigger: automatic }).success).toBe(true);
    expect(aiDraftGenerationJobSchema.safeParse({ ...base, trigger: human }).success).toBe(true);

    // Mode OFF permits a draft only when a person asked, so the claim has to carry the person. A
    // background job has nobody to name and therefore cannot make it.
    expect(aiDraftGenerationJobSchema.safeParse({ ...base, trigger: { kind: "HUMAN_REQUEST", requestId: "req_1" } }).success).toBe(false);
    expect(aiDraftGenerationJobSchema.safeParse({ ...base, trigger: { ...human, requestedByUserId: "" } }).success).toBe(false);
    // Nor by smuggling the fields alongside an automatic trigger.
    expect(aiDraftGenerationJobSchema.safeParse({ ...base, trigger: { ...automatic, requestedByUserId: "user_7" } }).success).toBe(false);
    expect(aiDraftGenerationJobSchema.safeParse({ ...base, trigger: automatic, requestedByUserId: "user_7" }).success).toBe(false);
    // A bare string is no longer a trigger at all.
    expect(aiDraftGenerationJobSchema.safeParse({ ...base, trigger: "HUMAN_REQUEST" }).success).toBe(false);
  });

  it("reports paths and codes without echoing values", () => {
    const secret = "customer-secret-value";
    let error: unknown;
    try {
      parsePayload(deliveryJobSchema, DELIVERY.jobName, { ...delivery, workspaceId: `${secret} x`, text: secret });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(JobPayloadValidationError);
    expect((error as JobPayloadValidationError).message).not.toContain(secret);
    expect(JSON.stringify((error as JobPayloadValidationError).issues)).not.toContain(secret);
  });
});

describe("job identity", () => {
  it("is deterministic per logical action and valid for BullMQ", () => {
    expect(DELIVERY.jobId(delivery)).toBe(DELIVERY.jobId({ ...delivery, correlationId: "other", selectedDelayMs: 1 }));
    expect(DELIVERY.jobId(delivery)).not.toBe(DELIVERY.jobId({ ...delivery, operationId: "op_2" }));
    expect(DELIVERY.jobId(delivery)).not.toBe(DELIVERY.jobId({ ...delivery, workspaceId: "ws_2" }));

    for (const id of [DELIVERY.jobId(delivery), buildJobId("x", 1, "a:b", "123")]) {
      expect(id).not.toContain(":");
      expect(`${Number.parseInt(id, 10)}`).not.toBe(id);
    }
  });

  it("keeps identical IDs in different Business Profiles distinct for every job family", () => {
    const bp2 = { businessProfileId: "bp_2" };
    const debounce = {
      schemaVersion: 1 as const,
      workspaceId: "ws_1",
      businessProfileId: "bp_1",
      correlationId: "corr_1",
      channelAccountId: "ca_1",
      conversationId: "conv_1",
      anchorMessageId: "msg_1",
      anchorInboundAt: "2026-09-17T10:00:00.000Z",
    };
    const draft = { ...debounce, trigger: { kind: "AUTOMATIC", reason: "DEBOUNCE_ELAPSED" } as const };
    const reconciliation = {
      ...delivery,
      reason: "AMBIGUOUS_SEND_RESULT" as const,
      detectedAt: "2026-09-17T10:02:00.000Z",
    };
    expect(INBOUND_DEBOUNCE.jobId(debounce)).not.toBe(INBOUND_DEBOUNCE.jobId({ ...debounce, ...bp2 }));
    expect(AI_DRAFT_GENERATION.jobId(draft)).not.toBe(AI_DRAFT_GENERATION.jobId({ ...draft, ...bp2 }));
    expect(DELIVERY.jobId(delivery)).not.toBe(DELIVERY.jobId({ ...delivery, ...bp2 }));
    expect(RECONCILIATION.jobId(reconciliation)).not.toBe(RECONCILIATION.jobId({ ...reconciliation, ...bp2 }));
  });

  it("cannot collide through separator characters inside identifiers", () => {
    expect(buildJobId("f", 1, "a|b", "c")).not.toBe(buildJobId("f", 1, "a", "b|c"));
  });

  it("keeps queues and versioned job names unique", () => {
    expect(new Set(JOB_FAMILIES.map((family) => family.queueName)).size).toBe(JOB_FAMILIES.length);
    expect(JOB_FAMILIES.map((family) => family.jobName)).toEqual([
      INBOUND_DEBOUNCE.jobName,
      AI_DRAFT_GENERATION.jobName,
      DELIVERY.jobName,
      RECONCILIATION.jobName,
    ]);
    for (const family of JOB_FAMILIES) {
      expect(family.jobName).toMatch(/\.v\d+$/);
      expect(family.jobOptions.removeOnComplete).toBeTruthy();
    }
  });
});

describe("planDelay", () => {
  const now = new Date("2026-09-17T10:00:00.000Z");

  it("selects an auditable delay inside the configured range", () => {
    expect(planDelay(DEFAULT_DELIVERY_DELAY_MS, now, () => 0)).toEqual({
      selectedDelayMs: 30_000,
      scheduledFor: new Date("2026-09-17T10:00:30.000Z"),
    });
    expect(planDelay(DEFAULT_DELIVERY_DELAY_MS, now, () => 0.999_999_9).selectedDelayMs).toBe(120_000);
    expect(planDelay(DEFAULT_DEBOUNCE_WINDOW_MS, now, () => 0.5).selectedDelayMs).toBe(9_500);
  });

  it("rejects invalid ranges and random sources", () => {
    expect(() => planDelay({ minMs: 10, maxMs: 5 }, now)).toThrow();
    expect(() => planDelay({ minMs: 0, maxMs: 8 * 24 * 60 * 60 * 1000 }, now)).toThrow(RangeError);
    expect(() => planDelay(DEFAULT_DELIVERY_DELAY_MS, now, () => 1)).toThrow(RangeError);
    expect(() => planDelay(DEFAULT_DELIVERY_DELAY_MS, now, () => Number.NaN)).toThrow(RangeError);
  });
});
