import { describe, expect, expectTypeOf, it } from "vitest";

import {
  AI_DRAFT_STATUSES,
  allowsAutomatedSend,
  assertNever,
  CHANNEL_CAPABILITY_KEYS,
  createAutomationPolicy,
  DEFAULT_DEBOUNCE_WINDOW_MS,
  DEFAULT_DELIVERY_DELAY_MS,
  DELIVERY_JOB_STATUSES,
  DomainValidationError,
  FINAL_DELIVERY_JOB_STATUSES,
  HUMAN_TAKEOVER_STATES,
  isAiMode,
  isChannelType,
  isDeliveryJobStatus,
  isFinalDeliveryJobStatus,
  isLeadStage,
  isMessageKind,
  isReasonCode,
  isValidIdentifier,
  MANDATORY_REVIEW_REASON_CODES,
  NO_CAPABILITIES,
  toAutomationPolicyId,
  toConfidence,
  toConversationId,
  toDurationRangeMs,
  toQuietHours,
  toWorkspaceId,
  type ChannelCapabilities,
  type ConversationId,
  type HumanTakeoverState,
  type Message,
  type WorkspaceId,
} from "./index";

const NUL = String.fromCharCode(0);

describe("identifiers", () => {
  it("accepts non-empty identifiers without whitespace or control characters and rejects everything else", () => {
    expect(toWorkspaceId("ws_123")).toBe("ws_123");
    for (const invalid of ["", " ", "ws 1", "ws\n1", "a".repeat(256), `ws${NUL}1`]) {
      expect(isValidIdentifier(invalid)).toBe(false);
      expect(() => toWorkspaceId(invalid)).toThrow(DomainValidationError);
    }
  });

  it("does not echo the rejected value in the error", () => {
    const error = captureDomainError(() => toConversationId("secret value"));
    expect(error.message).toBe(
      "conversationId: must be a non-empty identifier of at most 255 characters without whitespace",
    );
  });

  it("brands identifiers so different entities cannot be mixed up", () => {
    const workspaceId = toWorkspaceId("same");
    expectTypeOf(workspaceId).toEqualTypeOf<WorkspaceId>();
    expectTypeOf(workspaceId).not.toEqualTypeOf<ConversationId>();
    // @ts-expect-error a workspace id is not a conversation id
    const wrong: ConversationId = workspaceId;
    expect(wrong).toBe("same");
  });
});

describe("value objects", () => {
  it("limits confidence to finite values in [0, 1]", () => {
    expect(toConfidence(0)).toBe(0);
    expect(toConfidence(1)).toBe(1);
    for (const invalid of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => toConfidence(invalid)).toThrow(DomainValidationError);
    }
  });

  it("validates duration ranges and keeps the documented initial targets", () => {
    expect(toDurationRangeMs(0, 0, "range")).toEqual({ minMs: 0, maxMs: 0 });
    expect(() => toDurationRangeMs(5, 4, "range")).toThrow(/minMs must not exceed maxMs/);
    expect(() => toDurationRangeMs(-1, 4, "range")).toThrow(DomainValidationError);
    expect(() => toDurationRangeMs(1.5, 4, "range")).toThrow(DomainValidationError);
    expect(DEFAULT_DEBOUNCE_WINDOW_MS).toEqual({ minMs: 7_000, maxMs: 12_000 });
    expect(DEFAULT_DELIVERY_DELAY_MS).toEqual({ minMs: 30_000, maxMs: 120_000 });
  });

  it("validates quiet hours including periods that span midnight", () => {
    expect(toQuietHours("Europe/Berlin", "22:00", "07:30")).toEqual({
      timeZone: "Europe/Berlin",
      start: "22:00",
      end: "07:30",
    });
    expect(() => toQuietHours("Not/AZone", "22:00", "07:00")).toThrow(/time zone/);
    expect(() => toQuietHours("UTC", "24:00", "07:00")).toThrow(/HH:MM/);
    expect(() => toQuietHours("UTC", "7:00", "08:00")).toThrow(/HH:MM/);
    expect(() => toQuietHours("UTC", "08:00", "08:00")).toThrow(/must differ/);
  });
});

describe("enumerations", () => {
  it("guards closed literal sets", () => {
    expect(isChannelType("INSTAGRAM")).toBe(true);
    expect(isChannelType("THREADS")).toBe(false);
    expect(isAiMode("AUTOPILOT")).toBe(true);
    expect(isAiMode("autopilot")).toBe(false);
    expect(isMessageKind("UNKNOWN")).toBe(true);
    expect(isLeadStage("BOOKED")).toBe(true);
    expect(isReasonCode("MISSING_FACT")).toBe(true);
    expect(isReasonCode(42)).toBe(false);
  });

  it("covers every ChannelCapabilities key", () => {
    expect([...CHANNEL_CAPABILITY_KEYS].sort()).toEqual(Object.keys(NO_CAPABILITIES).sort());
    expectTypeOf<(typeof CHANNEL_CAPABILITY_KEYS)[number]>().toEqualTypeOf<keyof ChannelCapabilities>();
  });

  it("treats ambiguous delivery as final so automation never resends it", () => {
    expect(isFinalDeliveryJobStatus("HELD_AMBIGUOUS")).toBe(true);
    expect(isFinalDeliveryJobStatus("SCHEDULED")).toBe(false);
    expect(isFinalDeliveryJobStatus("SENDING")).toBe(false);
    expect(isFinalDeliveryJobStatus("HELD_REVIEW")).toBe(false);
    for (const status of FINAL_DELIVERY_JOB_STATUSES) {
      expect(isDeliveryJobStatus(status)).toBe(true);
    }
    expect(DELIVERY_JOB_STATUSES).toContain("CANCELLED_HUMAN_TAKEOVER");
    expect(AI_DRAFT_STATUSES).toContain("HELD_AMBIGUOUS");
  });
});

describe("human takeover", () => {
  const since = new Date("2026-09-17T10:00:00.000Z");
  const states: HumanTakeoverState[] = [
    { state: "NONE" },
    { state: "REVIEW_REQUIRED", reason: "HUMAN_AGENT_REVIEW", reviewMode: "HUMAN_AGENT", since },
    { state: "HUMAN_ACTIVE", reason: "UNMATCHED_OUTBOUND_ECHO", since, actor: { kind: "NATIVE_APP" } },
  ];

  it("allows automated sending only when nobody owns or reviews the conversation", () => {
    expect(states.map(allowsAutomatedSend)).toEqual([true, false, false]);
  });

  it("is an exhaustive discriminated union", () => {
    const describeState = (takeover: HumanTakeoverState): string => {
      switch (takeover.state) {
        case "NONE":
          return "none";
        case "REVIEW_REQUIRED":
          return `review:${takeover.reviewMode}`;
        case "HUMAN_ACTIVE":
          return `human:${takeover.reason}`;
        default:
          return assertNever(takeover, "takeover");
      }
    };

    expect(states.map(describeState)).toEqual(["none", "review:HUMAN_AGENT", "human:UNMATCHED_OUTBOUND_ECHO"]);
    expect([...HUMAN_TAKEOVER_STATES]).toEqual(states.map((takeover) => takeover.state));
    expect(() => describeState({ state: "PAUSED" } as unknown as HumanTakeoverState)).toThrow(DomainValidationError);
  });
});

describe("messages", () => {
  it("separates inbound participant messages from outbound messages at the type level", () => {
    const narrow = (message: Message) => (message.direction === "OUT" ? message.transportPath : message.source);
    expectTypeOf(narrow).returns.toEqualTypeOf<"STANDARD" | "HUMAN_AGENT" | "PARTICIPANT">();
  });
});

describe("createAutomationPolicy", () => {
  const base = { id: toAutomationPolicyId("policy_1"), workspaceId: toWorkspaceId("ws_1") };

  it("applies conservative defaults", () => {
    const policy = createAutomationPolicy(base);

    expect(policy).toMatchObject({
      mode: "OFF",
      confidenceThreshold: 0.8,
      debounceWindowMs: DEFAULT_DEBOUNCE_WINDOW_MS,
      deliveryDelayMs: DEFAULT_DELIVERY_DELAY_MS,
      takeoverPauseMs: 6 * 60 * 60 * 1000,
      instagramAfterWindowPolicy: "STANDARD_ONLY",
      whatsappAfterWindowPolicy: "SERVICE_WINDOW_ONLY",
      whatsappTemplateAutomationAllowlist: [],
    });
    expect(policy.mandatoryReviewReasons).toEqual(expect.arrayContaining([...MANDATORY_REVIEW_REASON_CODES]));
    expect(policy).not.toHaveProperty("channelAccountId");
  });

  it("never lets configuration remove mandatory-review categories", () => {
    const policy = createAutomationPolicy({ ...base, mandatoryReviewReasons: ["QUIET_HOURS"] });

    expect(policy.mandatoryReviewReasons).toEqual(
      expect.arrayContaining([...MANDATORY_REVIEW_REASON_CODES, "QUIET_HOURS"]),
    );
  });

  it("rejects invalid configuration and names the field", () => {
    const invalid: [string, Parameters<typeof createAutomationPolicy>[0]][] = [
      ["mode", { ...base, mode: "YOLO" as never }],
      ["confidenceThreshold", { ...base, confidenceThreshold: 1.5 }],
      ["deliveryDelayMs", { ...base, deliveryDelayMs: { minMs: 120_000, maxMs: 30_000 } }],
      ["debounceWindowMs", { ...base, debounceWindowMs: { minMs: -1, maxMs: 30_000 } }],
      ["takeoverPauseMs", { ...base, takeoverPauseMs: 0 }],
      ["instagramAfterWindowPolicy", { ...base, instagramAfterWindowPolicy: "ALWAYS" as never }],
      ["whatsappAfterWindowPolicy", { ...base, whatsappAfterWindowPolicy: "FREEFORM" as never }],
      ["whatsappTemplateAutomationAllowlist", { ...base, whatsappTemplateAutomationAllowlist: [" "] }],
      ["mandatoryReviewReasons", { ...base, mandatoryReviewReasons: ["NOT_A_REASON" as never] }],
    ];

    for (const [field, input] of invalid) {
      expect(captureDomainError(() => createAutomationPolicy(input)).field).toBe(field);
    }
  });

  it("keeps TEMPLATE_AUTOPILOT with an empty allowlist (no unattended template sends) and de-duplicates entries", () => {
    const policy = createAutomationPolicy({
      ...base,
      whatsappAfterWindowPolicy: "TEMPLATE_AUTOPILOT",
      whatsappTemplateAutomationAllowlist: ["order_update", "order_update"],
    });

    expect(policy.whatsappTemplateAutomationAllowlist).toEqual(["order_update"]);
    expect(
      createAutomationPolicy({ ...base, whatsappAfterWindowPolicy: "TEMPLATE_AUTOPILOT" }).whatsappTemplateAutomationAllowlist,
    ).toEqual([]);
  });
});

function captureDomainError(action: () => unknown): DomainValidationError {
  try {
    action();
  } catch (error) {
    if (error instanceof DomainValidationError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a DomainValidationError");
}
