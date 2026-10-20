import { DEFAULT_DEBOUNCE_WINDOW_MS, DEFAULT_DELIVERY_DELAY_MS } from "@omnichannel/domain";
import { describe, expect, it } from "vitest";
import type { z } from "zod";

import {
  AI_DRAFT_GENERATION,
  aiDraftGenerationJobSchema,
  buildJobId,
  DELIVERY,
  deliveryDelayFor,
  deliveryJobSchema,
  INBOUND_DEBOUNCE,
  MEDIA_TRANSCRIPTION,
  inboundDebounceJobSchema,
  JOB_FAMILIES,
  JobPayloadValidationError,
  MAX_SCHEDULE_DELAY_MS,
  planDelay,
  RECONCILIATION,
  reconciliationJobSchema,
  ScheduleRangeError,
  type DeliveryJob,
  type MediaTranscriptionJob,
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

const transcription: MediaTranscriptionJob = {
  schemaVersion: 1,
  workspaceId: "ws_1",
  businessProfileId: "bp_1",
  correlationId: "corr_1",
  channelAccountId: "ca_1",
  conversationId: "conv_1",
  messageId: "msg_1",
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

  it("will not let a follow-up job claim an attempt the bound does not allow", () => {
    const base = {
      schemaVersion: 1,
      workspaceId: "ws_1",
      businessProfileId: "bp_1",
      correlationId: "corr_1",
      conversationId: "conv_1",
      anchorMessageId: "msg_1",
    };
    const followUp = { kind: "FOLLOW_UP", followUpId: "fu_1", attempt: 1 };

    expect(aiDraftGenerationJobSchema.safeParse({ ...base, trigger: followUp }).success).toBe(true);

    // The attempt is an attempt: there is no zeroth one, the domain's ceiling is three and nothing may
    // ask for a fifth beyond it, and half an attempt is not a number the store could ever have produced.
    expect(aiDraftGenerationJobSchema.safeParse({ ...base, trigger: { ...followUp, attempt: 0 } }).success).toBe(false);
    expect(aiDraftGenerationJobSchema.safeParse({ ...base, trigger: { ...followUp, attempt: 6 } }).success).toBe(false);
    expect(aiDraftGenerationJobSchema.safeParse({ ...base, trigger: { ...followUp, attempt: 1.5 } }).success).toBe(false);
    expect(aiDraftGenerationJobSchema.safeParse({ ...base, trigger: { kind: "FOLLOW_UP", followUpId: "fu_1" } }).success).toBe(false);
    expect(aiDraftGenerationJobSchema.safeParse({ ...base, trigger: { kind: "FOLLOW_UP", attempt: 1 } }).success).toBe(false);
    // A follow-up is automation and has nobody to name, so it cannot borrow a person's authority to
    // generate in mode OFF by carrying one.
    expect(aiDraftGenerationJobSchema.safeParse({ ...base, trigger: { ...followUp, requestedByUserId: "user_7" } }).success).toBe(false);
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
    expect(MEDIA_TRANSCRIPTION.jobId(transcription)).not.toBe(MEDIA_TRANSCRIPTION.jobId({ ...transcription, ...bp2 }));
  });

  it("gives one reading job per message, however often the webhook is redelivered", () => {
    // The provider redelivers for up to seven days, and each redelivery carries a new correlation id.
    // One job per message is what makes a second delivery a no-op rather than a second reading.
    expect(MEDIA_TRANSCRIPTION.jobId(transcription)).toBe(MEDIA_TRANSCRIPTION.jobId({ ...transcription, correlationId: "corr_2" }));
    expect(MEDIA_TRANSCRIPTION.jobId(transcription)).not.toBe(MEDIA_TRANSCRIPTION.jobId({ ...transcription, messageId: "msg_2" }));
    expect(MEDIA_TRANSCRIPTION.jobId(transcription)).not.toBe(MEDIA_TRANSCRIPTION.jobId({ ...transcription, workspaceId: "ws_2" }));
  });

  it("backs a reading off far longer than a reply, because nothing is waiting on it", () => {
    // A customer waits on a reply; the draft that needs a reading holds for a person in the meantime. So
    // hammering a rate-limited transcriber would cost the next recording and buy nothing.
    expect(MEDIA_TRANSCRIPTION.jobOptions.attempts).toBe(4);
    expect(MEDIA_TRANSCRIPTION.jobOptions.backoff).toEqual({ type: "exponential", delay: 15_000 });
    expect((MEDIA_TRANSCRIPTION.jobOptions.backoff as { delay: number }).delay).toBeGreaterThan(
      (INBOUND_DEBOUNCE.jobOptions.backoff as { delay: number }).delay,
    );
  });

  it("makes each follow-up attempt its own job, so a second allowed attempt is not dropped", () => {
    const base = {
      schemaVersion: 1 as const,
      workspaceId: "ws_1",
      businessProfileId: "bp_1",
      correlationId: "corr_1",
      conversationId: "conv_1",
      anchorMessageId: "msg_1",
    };
    const attempt = (n: number) => ({ ...base, trigger: { kind: "FOLLOW_UP", followUpId: "fu_1", attempt: n } as const });

    // Re-enqueueing one attempt is one job: that is what makes the sweeper safe to retry after it
    // claimed but could not enqueue, and it is the duplicate-queue-job case.
    expect(AI_DRAFT_GENERATION.jobId(attempt(1))).toBe(AI_DRAFT_GENERATION.jobId({ ...attempt(1), correlationId: "other" }));
    // A follow-up chasing one silence anchors every attempt to the same message, so without the attempt
    // in the identity the second allowed attempt would be silently dropped as a duplicate of the first.
    expect(AI_DRAFT_GENERATION.jobId(attempt(1))).not.toBe(AI_DRAFT_GENERATION.jobId(attempt(2)));
    // Two follow-ups, and a follow-up versus the debounce-triggered draft, stay distinct on one anchor.
    expect(AI_DRAFT_GENERATION.jobId(attempt(1))).not.toBe(
      AI_DRAFT_GENERATION.jobId({ ...base, trigger: { kind: "FOLLOW_UP", followUpId: "fu_2", attempt: 1 } }),
    );
    expect(AI_DRAFT_GENERATION.jobId(attempt(1))).not.toBe(
      AI_DRAFT_GENERATION.jobId({ ...base, trigger: { kind: "AUTOMATIC", reason: "DEBOUNCE_ELAPSED" } }),
    );
    expect(AI_DRAFT_GENERATION.jobId(attempt(1))).not.toBe(AI_DRAFT_GENERATION.jobId({ ...attempt(1), businessProfileId: "bp_2" }));
  });

  it("cannot collide through separator characters inside identifiers", () => {
    expect(buildJobId("f", 1, "a|b", "c")).not.toBe(buildJobId("f", 1, "a", "b|c"));
  });

  it("keeps queues and versioned job names unique", () => {
    expect(new Set(JOB_FAMILIES.map((family) => family.queueName)).size).toBe(JOB_FAMILIES.length);
    expect(JOB_FAMILIES.map((family) => family.jobName)).toEqual([
      INBOUND_DEBOUNCE.jobName,
      MEDIA_TRANSCRIPTION.jobName,
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

describe("the delay a declared delivery schedule implies", () => {
  const AT = new Date("2026-09-17T10:00:00.000Z");
  const at = (offsetMs: number) => new Date(AT.getTime() + offsetMs).toISOString();
  const scheduled = (offsetMs: number, selectedDelayMs: number): DeliveryJob => ({
    ...delivery,
    scheduledFor: at(offsetMs),
    selectedDelayMs,
  });

  it("waits exactly as long as the schedule says", () => {
    expect(deliveryDelayFor(scheduled(30_000, 60_000), AT)).toBe(30_000);
    expect(deliveryDelayFor(scheduled(MAX_SCHEDULE_DELAY_MS, MAX_SCHEDULE_DELAY_MS), AT)).toBe(MAX_SCHEDULE_DELAY_MS);
  });

  it("refuses a schedule beyond the queue's reach instead of shortening it", () => {
    // Clamping sent a reply declared for next month three weeks early, while the durable payload went on
    // claiming next month. Of the two ways to be wrong, early is the one that reaches a customer.
    const refusal = (() => {
      try {
        deliveryDelayFor(scheduled(MAX_SCHEDULE_DELAY_MS + 1, MAX_SCHEDULE_DELAY_MS), AT);
        return undefined;
      } catch (error) {
        return error;
      }
    })();

    expect(refusal).toBeInstanceOf(ScheduleRangeError);
    expect(refusal).toBeInstanceOf(RangeError);
    expect((refusal as ScheduleRangeError).reason).toBe("OUT_OF_RANGE");
  });

  it("runs a schedule that has already passed immediately", () => {
    // Which is what a resumed operation looks like. The coordinator re-judges before any send, so running
    // now is safe in a way that running early is not.
    expect(deliveryDelayFor(scheduled(-1, 60_000), AT)).toBe(0);
    expect(deliveryDelayFor(scheduled(-3_600_000, 60_000), AT)).toBe(0);
    expect(deliveryDelayFor(scheduled(0, 0), AT)).toBe(0);
  });

  it("refuses a payload whose two statements about the plan disagree", () => {
    // `selectedDelayMs` is the whole delay chosen when the plan was made, and enqueueing happens at or
    // after planning — so the wait still remaining can never exceed it.
    expect(() => deliveryDelayFor(scheduled(60_001, 60_000), AT)).toThrow(
      expect.objectContaining({ name: "ScheduleRangeError", reason: "CONTRADICTORY_METADATA" }),
    );
    // One millisecond the other way is the ordinary case: enqueued a moment after it was planned.
    expect(deliveryDelayFor(scheduled(59_999, 60_000), AT)).toBe(59_999);
    expect(deliveryDelayFor(scheduled(60_000, 60_000), AT)).toBe(60_000);
  });

  it("refuses an instant it cannot read at all", () => {
    expect(() => deliveryDelayFor({ ...delivery, scheduledFor: "not-a-time" }, AT)).toThrow(
      expect.objectContaining({ name: "ScheduleRangeError", reason: "CONTRADICTORY_METADATA" }),
    );
  });
});
