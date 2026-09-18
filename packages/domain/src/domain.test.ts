import { describe, expect, expectTypeOf, it } from "vitest";

import {
  AI_DRAFT_STATUSES,
  allowsAutomatedSend,
  assertNever,
  BUSINESS_PROFILE_ACCESS_SCOPES,
  BUSINESS_PROFILE_STATUSES,
  CHANNEL_CAPABILITY_KEYS,
  createAutomationPolicy,
  DEFAULT_DEBOUNCE_WINDOW_MS,
  DEFAULT_DELIVERY_DELAY_MS,
  DELIVERY_JOB_STATUSES,
  DomainValidationError,
  FINAL_DELIVERY_JOB_STATUSES,
  hasBusinessProfileAccess,
  HUMAN_TAKEOVER_STATES,
  isAiMode,
  isBusinessProfileAccessScope,
  isBusinessProfileStatus,
  isChannelType,
  isContactPointStatus,
  isContactPointType,
  isDeliveryJobStatus,
  isFinalDeliveryJobStatus,
  isLeadStage,
  isMessageKind,
  isReasonCode,
  isSameChannelIdentity,
  isStaleAnchor,
  isValidIdentifier,
  isWithinQuietHours,
  MANDATORY_REVIEW_REASON_CODES,
  NO_CAPABILITIES,
  PLATFORM_STYLE_FALLBACK,
  resolveStyleProfile,
  toAutomationPolicyId,
  toBusinessProfileId,
  toChannelAccountId,
  toConfidence,
  toConversationId,
  toConversationStateVersion,
  toDurationRangeMs,
  toQuietHours,
  toWorkspaceId,
  type AiDraft,
  type AutomationPolicy,
  type AutomationPolicyInput,
  type BusinessProfileId,
  type ChannelAccount,
  type ChannelAccountId,
  type ChannelCapabilities,
  type ChannelIdentity,
  type ChannelIdentityId,
  type Contact,
  type ContactId,
  type ContactPoint,
  type Conversation,
  type ConversationId,
  type ConversationStateVersion,
  type DeliveryJobRecord,
  type InboundMessage,
  type MemberBusinessProfileAccess,
  type OutboundMessage,
  type HumanTakeoverState,
  type Message,
  type QuietHours,
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
    // @ts-expect-error a workspace id is not a Business Profile id
    const notProfile: BusinessProfileId = workspaceId;
    // @ts-expect-error a Business Profile id is not a workspace id
    const notWorkspace: WorkspaceId = toBusinessProfileId("same");
    expect([notProfile, notWorkspace]).toEqual(["same", "same"]);
  });

  it("validates Business Profile identifiers without echoing the value", () => {
    expect(toBusinessProfileId("bp_1")).toBe("bp_1");
    for (const invalid of ["", "   ", "bp 1", `bp${NUL}`]) {
      expect(() => toBusinessProfileId(invalid)).toThrow(DomainValidationError);
    }
    expect(captureDomainError(() => toBusinessProfileId("secret bp")).message).toBe(
      "businessProfileId: must be a non-empty identifier of at most 255 characters without whitespace",
    );
  });
});

describe("Business Profile scope", () => {
  const workspaceId = toWorkspaceId("ws_1");
  const bp1 = toBusinessProfileId("bp_1");
  const bp2 = toBusinessProfileId("bp_2");
  const now = new Date("2026-09-17T10:00:00.000Z");

  it("keeps contacts and channel identities with the same provider user ID independent per Business Profile", () => {
    const identity = (businessProfileId: BusinessProfileId, channelAccountId: string, username?: string): ChannelIdentity => ({
      id: `${businessProfileId}-identity` as ChannelIdentity["id"],
      workspaceId,
      businessProfileId,
      contactId: `${businessProfileId}-contact` as ChannelIdentity["contactId"],
      channelAccountId: toChannelAccountId(channelAccountId),
      channel: "INSTAGRAM",
      externalUserId: "igsid-shared",
      ...(username === undefined ? {} : { username }),
      createdAt: now,
      updatedAt: now,
    });
    const inBp1 = identity(bp1, "ca_bp1");
    const inBp2 = identity(bp2, "ca_bp2");

    expect(isSameChannelIdentity(inBp1, inBp2)).toBe(false);
    // Each scope field alone keeps identities apart, even with the same account and provider user ID.
    expect(isSameChannelIdentity(inBp1, { ...inBp1, businessProfileId: bp2 })).toBe(false);
    expect(isSameChannelIdentity(inBp1, { ...inBp1, workspaceId: toWorkspaceId("ws_2") })).toBe(false);
    expect(isSameChannelIdentity(inBp1, { ...inBp1, channelAccountId: inBp2.channelAccountId })).toBe(false);
    expect(isSameChannelIdentity(inBp1, { ...inBp1, externalUserId: "igsid-other" })).toBe(false);
    // Mutable attributes are not identity.
    expect(isSameChannelIdentity(inBp1, identity(bp1, "ca_bp1", "renamed_handle"))).toBe(true);
  });

  it("requires Business Profile scope on BP-owned contracts", () => {
    // @ts-expect-error a contact without a Business Profile is not a valid contract
    const unscoped: Contact = { id: "c" as Contact["id"], workspaceId, createdAt: now, updatedAt: now };
    expect(unscoped.workspaceId).toBe(workspaceId);
    expectTypeOf<Contact["businessProfileId"]>().toEqualTypeOf<BusinessProfileId>();
    expectTypeOf<ChannelIdentity["businessProfileId"]>().toEqualTypeOf<BusinessProfileId>();
    expectTypeOf<ChannelAccount["businessProfileId"]>().toEqualTypeOf<BusinessProfileId>();
    expectTypeOf<Conversation["businessProfileId"]>().toEqualTypeOf<BusinessProfileId>();
    expectTypeOf<InboundMessage["businessProfileId"]>().toEqualTypeOf<BusinessProfileId>();
    expectTypeOf<OutboundMessage["businessProfileId"]>().toEqualTypeOf<BusinessProfileId>();
    expectTypeOf<AiDraft["businessProfileId"]>().toEqualTypeOf<BusinessProfileId>();
    expectTypeOf<DeliveryJobRecord["businessProfileId"]>().toEqualTypeOf<BusinessProfileId>();
    expectTypeOf<AutomationPolicy["businessProfileId"]>().toEqualTypeOf<BusinessProfileId>();
    expectTypeOf<AutomationPolicyInput["businessProfileId"]>().toEqualTypeOf<BusinessProfileId>();
    expectTypeOf<ContactPoint["businessProfileId"]>().toEqualTypeOf<BusinessProfileId>();
    expectTypeOf<MemberBusinessProfileAccess["businessProfileId"]>().toEqualTypeOf<BusinessProfileId>();
    // A conversation names its whole scope, and anchors are typed state versions.
    expectTypeOf<Conversation["contactId"]>().toEqualTypeOf<ContactId>();
    expectTypeOf<Conversation["channelIdentityId"]>().toEqualTypeOf<ChannelIdentityId>();
    expectTypeOf<Conversation["channelAccountId"]>().toEqualTypeOf<ChannelAccountId>();
    expectTypeOf<Conversation["stateVersion"]>().toEqualTypeOf<ConversationStateVersion>();
    expectTypeOf<AiDraft["anchorStateVersion"]>().toEqualTypeOf<ConversationStateVersion>();
  });

  it("guards Business Profile statuses and access scopes", () => {
    expect([...BUSINESS_PROFILE_STATUSES]).toEqual(["SETUP", "ACTIVE", "INACTIVE"]);
    expect(isBusinessProfileStatus("ACTIVE")).toBe(true);
    expect(isBusinessProfileStatus("DELETED")).toBe(false);
    expect([...BUSINESS_PROFILE_ACCESS_SCOPES]).toEqual(["ALL", "SELECTED"]);
    expect(isBusinessProfileAccessScope("SELECTED")).toBe(true);
    expect(isBusinessProfileAccessScope("NONE")).toBe(false);
  });

  it("grants Business Profile access by role and scope, never by default", () => {
    expect(hasBusinessProfileAccess({ role: "OWNER", businessProfileScope: "SELECTED", grantedBusinessProfileIds: [] }, bp2)).toBe(true);
    expect(hasBusinessProfileAccess({ role: "ADMIN", businessProfileScope: "ALL", grantedBusinessProfileIds: [] }, bp2)).toBe(true);
    expect(hasBusinessProfileAccess({ role: "ADMIN", businessProfileScope: "SELECTED", grantedBusinessProfileIds: [bp1] }, bp2)).toBe(false);
    expect(hasBusinessProfileAccess({ role: "AGENT", businessProfileScope: "SELECTED", grantedBusinessProfileIds: [bp1] }, bp1)).toBe(true);
    expect(hasBusinessProfileAccess({ role: "AGENT", businessProfileScope: "SELECTED", grantedBusinessProfileIds: [] }, bp1)).toBe(false);
  });

  it("guards contact point types and statuses", () => {
    expect(isContactPointType("PHONE")).toBe(true);
    expect(isContactPointType("USERNAME")).toBe(false);
    expect(isContactPointStatus("SUPERSEDED")).toBe(true);
    expect(isContactPointStatus("MATCHED")).toBe(false);
  });
});

describe("conversation state version", () => {
  it("accepts only non-negative integers", () => {
    expect(toConversationStateVersion(0)).toBe(0);
    expect(toConversationStateVersion(42)).toBe(42);
    for (const invalid of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => toConversationStateVersion(invalid)).toThrow(DomainValidationError);
    }
  });

  it("marks anchored actions stale once the conversation state moves on", () => {
    const anchor = toConversationStateVersion(3);
    expect(isStaleAnchor(anchor, toConversationStateVersion(3))).toBe(false);
    expect(isStaleAnchor(anchor, toConversationStateVersion(4))).toBe(true);
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

  it("never discloses the offending discriminant, which may be customer data", () => {
    const secret = "SYNTHETIC_SECRET_DO_NOT_LOG";
    const thrown = captureDomainError(() => assertNever({ type: secret } as never, "event"));

    expect(thrown.field).toBe("event");
    expect(`${String(thrown)} ${thrown.message} ${thrown.stack ?? ""}`).not.toContain(secret);
    expect(thrown.message).toBe("event: unhandled variant (object with an unhandled type discriminant)");
    // The same holds for primitives and for objects without a discriminant.
    expect(captureDomainError(() => assertNever(secret as never)).message).toBe("value: unhandled variant (string)");
    expect(captureDomainError(() => assertNever({ id: secret } as never)).message).toBe(
      "value: unhandled variant (object without a type discriminant)",
    );
  });
});

describe("messages", () => {
  it("separates inbound participant messages from outbound messages at the type level", () => {
    const narrow = (message: Message) => (message.direction === "OUT" ? message.transportPath : message.source);
    expectTypeOf(narrow).returns.toEqualTypeOf<"STANDARD" | "HUMAN_AGENT" | "PARTICIPANT">();
  });
});

describe("createAutomationPolicy", () => {
  const base = {
    id: toAutomationPolicyId("policy_1"),
    workspaceId: toWorkspaceId("ws_1"),
    businessProfileId: toBusinessProfileId("bp_1"),
  };

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
    expect(policy).toMatchObject({ workspaceId: "ws_1", businessProfileId: "bp_1" });
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
      // Quiet hours reach the policy from storage or JavaScript callers, so they are revalidated here.
      ["quietHours.timeZone", { ...base, quietHours: { timeZone: "Mars/Olympus", start: "22:00", end: "08:00" } as never }],
      ["quietHours", { ...base, quietHours: { timeZone: "Europe/Istanbul", start: "24:00", end: "08:00" } as never }],
      ["quietHours", { ...base, quietHours: { timeZone: "Europe/Istanbul", start: "22:00", end: "8:00" } as never }],
      ["quietHours", { ...base, quietHours: { timeZone: "Europe/Istanbul", start: "22:00", end: "22:00" } as never }],
    ];

    for (const [field, input] of invalid) {
      expect(captureDomainError(() => createAutomationPolicy(input)).field).toBe(field);
    }
  });

  it("owns its quiet hours instead of holding the caller's object", () => {
    const quietHours = { timeZone: "Europe/Istanbul", start: "22:00", end: "08:00" } as QuietHours;
    const policy = createAutomationPolicy({ ...base, quietHours });

    expect(policy.quietHours).toEqual(quietHours);
    expect(policy.quietHours).not.toBe(quietHours);

    // A caller that mutates its own input afterwards cannot change the validated policy.
    const mutable = quietHours as { timeZone: string; start: string; end: string };
    mutable.start = "00:00";
    mutable.timeZone = "Mars/Olympus";
    expect(policy.quietHours).toEqual({ timeZone: "Europe/Istanbul", start: "22:00", end: "08:00" });
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

describe("isWithinQuietHours", () => {
  const at = (iso: string) => new Date(iso);

  it("compares the wall clock a person in that zone would read, not UTC", () => {
    const quiet = toQuietHours("Europe/Berlin", "22:00", "07:00");

    // 21:30 UTC is 23:30 in Berlin in September: quiet. A UTC comparison would say otherwise.
    expect(isWithinQuietHours(quiet, at("2026-09-18T21:30:00.000Z"))).toBe(true);
    expect(isWithinQuietHours(quiet, at("2026-09-18T12:00:00.000Z"))).toBe(false);
  });

  it("handles a period that spans midnight", () => {
    const quiet = toQuietHours("UTC", "22:00", "07:00");

    expect(isWithinQuietHours(quiet, at("2026-09-18T23:59:00.000Z"))).toBe(true);
    expect(isWithinQuietHours(quiet, at("2026-09-19T00:00:00.000Z"))).toBe(true);
    expect(isWithinQuietHours(quiet, at("2026-09-19T06:59:00.000Z"))).toBe(true);
    expect(isWithinQuietHours(quiet, at("2026-09-19T07:00:00.000Z"))).toBe(false);
  });

  it("handles a period inside one day", () => {
    const quiet = toQuietHours("UTC", "09:00", "17:00");

    expect(isWithinQuietHours(quiet, at("2026-09-18T08:59:00.000Z"))).toBe(false);
    // Start is inclusive and end exclusive, so a period can never swallow the whole day.
    expect(isWithinQuietHours(quiet, at("2026-09-18T09:00:00.000Z"))).toBe(true);
    expect(isWithinQuietHours(quiet, at("2026-09-18T16:59:00.000Z"))).toBe(true);
    expect(isWithinQuietHours(quiet, at("2026-09-18T17:00:00.000Z"))).toBe(false);
  });

  it("follows the zone across a daylight-saving change", () => {
    const quiet = toQuietHours("Europe/Berlin", "22:00", "07:00");

    // Berlin is UTC+2 in summer and UTC+1 in winter; the same UTC instant falls on different sides.
    expect(isWithinQuietHours(quiet, at("2026-10-24T20:30:00.000Z"))).toBe(true);
    expect(isWithinQuietHours(quiet, at("2026-11-24T20:30:00.000Z"))).toBe(false);
    expect(isWithinQuietHours(quiet, at("2026-11-24T21:30:00.000Z"))).toBe(true);
  });

  it("keeps midnight at the start of the day rather than the end", () => {
    // An `hourCycle` that renders midnight as 24 would put 00:30 outside a 22:00-07:00 period.
    expect(isWithinQuietHours(toQuietHours("UTC", "22:00", "07:00"), at("2026-09-19T00:30:00.000Z"))).toBe(true);
  });
});

describe("resolveStyleProfile", () => {
  it("merges field by field, so a narrow override does not reset the rest", () => {
    const base = { persona: "We are Studio Alpha.", tone: "warm", emoji: "FREELY" as const, replyLength: "MEDIUM" as const };

    const resolved = resolveStyleProfile([base, { signOff: "— the Alpha team" }]);

    // Forgetting to restate the persona in an override must not silently drop a business to the platform
    // default voice.
    expect(resolved.persona).toBe("We are Studio Alpha.");
    expect(resolved.tone).toBe("warm");
    expect(resolved.emoji).toBe("FREELY");
    expect(resolved.signOff).toBe("— the Alpha team");
  });

  it("gives later layers precedence, in the order the caller passes them", () => {
    const resolved = resolveStyleProfile([{ persona: "Workspace voice" }, { persona: "Profile voice" }]);

    expect(resolved.persona).toBe("Profile voice");
  });

  it("falls back to the platform voice only where nothing was configured", () => {
    expect(resolveStyleProfile([])).toEqual(PLATFORM_STYLE_FALLBACK);
    expect(resolveStyleProfile([{ tone: "brisk" }]).persona).toBe(PLATFORM_STYLE_FALLBACK.persona);
  });

  it("rebuilds and bounds what it is given, because it is rendered into system instructions", () => {
    expect(() => resolveStyleProfile([{ persona: "   " }])).toThrow(/persona/);
    expect(() => resolveStyleProfile([{ persona: "x".repeat(2_001) }])).toThrow(/persona/);
    expect(() => resolveStyleProfile([{ avoidedPhrases: ["x".repeat(121)] }])).toThrow(/avoidedPhrases/);
    expect(() => resolveStyleProfile([{ preferredPhrases: Array.from({ length: 51 }, (_v, i) => `p${String(i)}`) }])).toThrow(/preferredPhrases/);
  });

  it("drops blank entries rather than sending the model an empty instruction", () => {
    const resolved = resolveStyleProfile([{ tone: "  ", preferredPhrases: ["", " happy to help ", "happy to help"] }]);

    expect(resolved.tone).toBeUndefined();
    expect(resolved.preferredPhrases).toEqual(["happy to help"]);
  });
});
