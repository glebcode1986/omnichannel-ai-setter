import { isAiMode, type AiMode } from "./channel";
import { literalGuard } from "./enum";
import { DomainValidationError } from "./errors";
import type { AutomationPolicyId, BusinessProfileId, ChannelAccountId, WorkspaceId } from "./ids";
import { isReasonCode, MANDATORY_REVIEW_REASON_CODES, type ReasonCode } from "./reason-codes";
import {
  DEFAULT_DEBOUNCE_WINDOW_MS,
  DEFAULT_DELIVERY_DELAY_MS,
  toConfidence,
  toDurationRangeMs,
  toQuietHours,
  type Confidence,
  type DurationRangeMs,
  type QuietHours,
} from "./values";

/** Instagram behavior after the standard automated window closes (ADR-014). */
export const INSTAGRAM_AFTER_WINDOW_POLICIES = ["STANDARD_ONLY", "HUMAN_ASSISTED_EXTENDED"] as const;
export type InstagramAfterWindowPolicy = (typeof INSTAGRAM_AFTER_WINDOW_POLICIES)[number];
export const isInstagramAfterWindowPolicy = literalGuard(INSTAGRAM_AFTER_WINDOW_POLICIES);

/** WhatsApp behavior outside the customer-service window (ADR-016). */
export const WHATSAPP_AFTER_WINDOW_POLICIES = ["SERVICE_WINDOW_ONLY", "TEMPLATE_REVIEW", "TEMPLATE_AUTOPILOT"] as const;
export type WhatsAppAfterWindowPolicy = (typeof WHATSAPP_AFTER_WINDOW_POLICIES)[number];
export const isWhatsAppAfterWindowPolicy = literalGuard(WHATSAPP_AFTER_WINDOW_POLICIES);

export const DEFAULT_CONFIDENCE_THRESHOLD = 0.8;
export const DEFAULT_TAKEOVER_PAUSE_MS = 6 * 60 * 60 * 1000;

/**
 * Automation settings of a Business Profile (DATA_MODEL.md v0.4 §15): the profile default when
 * `channelAccountId` is absent, or an override for one channel account of the same profile.
 */
export interface AutomationPolicy {
  readonly id: AutomationPolicyId;
  readonly workspaceId: WorkspaceId;
  readonly businessProfileId: BusinessProfileId;
  /** Absent for the Business Profile default; set for a channel-account override. */
  readonly channelAccountId?: ChannelAccountId;
  readonly mode: AiMode;
  readonly confidenceThreshold: Confidence;
  readonly mandatoryReviewReasons: readonly ReasonCode[];
  readonly debounceWindowMs: DurationRangeMs;
  readonly deliveryDelayMs: DurationRangeMs;
  readonly quietHours?: QuietHours;
  readonly takeoverPauseMs: number;
  readonly instagramAfterWindowPolicy: InstagramAfterWindowPolicy;
  readonly whatsappAfterWindowPolicy: WhatsAppAfterWindowPolicy;
  /** Approved template names/use-cases eligible for TEMPLATE_AUTOPILOT; empty means none (ADR-016). */
  readonly whatsappTemplateAutomationAllowlist: readonly string[];
}

export interface AutomationPolicyInput {
  readonly id: AutomationPolicyId;
  readonly workspaceId: WorkspaceId;
  readonly businessProfileId: BusinessProfileId;
  readonly channelAccountId?: ChannelAccountId;
  readonly mode?: AiMode;
  readonly confidenceThreshold?: number;
  readonly mandatoryReviewReasons?: readonly ReasonCode[];
  readonly debounceWindowMs?: DurationRangeMs;
  readonly deliveryDelayMs?: DurationRangeMs;
  readonly quietHours?: QuietHours;
  readonly takeoverPauseMs?: number;
  readonly instagramAfterWindowPolicy?: InstagramAfterWindowPolicy;
  readonly whatsappAfterWindowPolicy?: WhatsAppAfterWindowPolicy;
  readonly whatsappTemplateAutomationAllowlist?: readonly string[];
}

/**
 * Builds a validated policy with conservative defaults: mode OFF, Instagram STANDARD_ONLY, WhatsApp
 * SERVICE_WINDOW_ONLY (no stored choice behaves conservatively, ADR-016), empty template allowlist and
 * every mandatory-review category enabled. Mandatory-review categories cannot be removed.
 */
/**
 * The automation settings every Business Profile starts with, with no identity attached.
 *
 * `createAutomationPolicy` already states them — but it states them *about a policy that exists*, and it
 * needs the three ids to do so. The profile default is written in the same statement that creates the
 * profile, so neither the policy's id nor the profile's exists at the moment the values are needed. This
 * is the same answer in the shape that statement can use.
 *
 * The domain's own suite asserts the two agree field by field. A default with two spellings is a default
 * that will one day be conservative in only one of them, and the conservative one is not the one anybody
 * notices.
 */
export type AutomationPolicySettings = Omit<
  AutomationPolicy,
  "id" | "workspaceId" | "businessProfileId" | "channelAccountId" | "quietHours"
>;

export function defaultAutomationSettings(): AutomationPolicySettings {
  return {
    // OFF, not DRAFT: a profile that has just been created has no knowledge, no style and nobody who has
    // read its settings, and the one mode that cannot surprise its owner is the one that does nothing.
    mode: "OFF",
    confidenceThreshold: toConfidence(DEFAULT_CONFIDENCE_THRESHOLD, "confidenceThreshold"),
    mandatoryReviewReasons: [...MANDATORY_REVIEW_REASON_CODES],
    debounceWindowMs: DEFAULT_DEBOUNCE_WINDOW_MS,
    deliveryDelayMs: DEFAULT_DELIVERY_DELAY_MS,
    takeoverPauseMs: DEFAULT_TAKEOVER_PAUSE_MS,
    instagramAfterWindowPolicy: "STANDARD_ONLY",
    whatsappAfterWindowPolicy: "SERVICE_WINDOW_ONLY",
    whatsappTemplateAutomationAllowlist: [],
  };
}

export function createAutomationPolicy(input: AutomationPolicyInput): AutomationPolicy {
  const mode = input.mode ?? "OFF";
  if (!isAiMode(mode)) {
    throw new DomainValidationError("mode", "must be OFF, DRAFT or AUTOPILOT");
  }
  const reviewReasons = new Set<ReasonCode>([...MANDATORY_REVIEW_REASON_CODES, ...(input.mandatoryReviewReasons ?? [])]);
  for (const reason of reviewReasons) {
    if (!isReasonCode(reason)) {
      throw new DomainValidationError("mandatoryReviewReasons", "contains an unknown reason code");
    }
  }
  const debounce = input.debounceWindowMs ?? DEFAULT_DEBOUNCE_WINDOW_MS;
  const delay = input.deliveryDelayMs ?? DEFAULT_DELIVERY_DELAY_MS;
  const takeoverPauseMs = input.takeoverPauseMs ?? DEFAULT_TAKEOVER_PAUSE_MS;
  if (!Number.isSafeInteger(takeoverPauseMs) || takeoverPauseMs <= 0) {
    throw new DomainValidationError("takeoverPauseMs", "must be a positive integer number of milliseconds");
  }
  const instagramAfterWindowPolicy = input.instagramAfterWindowPolicy ?? "STANDARD_ONLY";
  if (!isInstagramAfterWindowPolicy(instagramAfterWindowPolicy)) {
    throw new DomainValidationError("instagramAfterWindowPolicy", "must be STANDARD_ONLY or HUMAN_ASSISTED_EXTENDED");
  }
  const whatsappAfterWindowPolicy = input.whatsappAfterWindowPolicy ?? "SERVICE_WINDOW_ONLY";
  if (!isWhatsAppAfterWindowPolicy(whatsappAfterWindowPolicy)) {
    throw new DomainValidationError(
      "whatsappAfterWindowPolicy",
      "must be SERVICE_WINDOW_ONLY, TEMPLATE_REVIEW or TEMPLATE_AUTOPILOT",
    );
  }
  const allowlist = [...new Set(input.whatsappTemplateAutomationAllowlist ?? [])];
  if (allowlist.some((entry) => entry.trim() === "")) {
    throw new DomainValidationError("whatsappTemplateAutomationAllowlist", "entries must be non-empty");
  }

  return {
    id: input.id,
    workspaceId: input.workspaceId,
    businessProfileId: input.businessProfileId,
    ...(input.channelAccountId !== undefined ? { channelAccountId: input.channelAccountId } : {}),
    mode,
    confidenceThreshold: toConfidence(input.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD, "confidenceThreshold"),
    mandatoryReviewReasons: [...reviewReasons],
    debounceWindowMs: toDurationRangeMs(debounce.minMs, debounce.maxMs, "debounceWindowMs"),
    deliveryDelayMs: toDurationRangeMs(delay.minMs, delay.maxMs, "deliveryDelayMs"),
    // Rebuilt, not copied: the input may come from JavaScript or storage, and the policy must own its value
    // so later mutation of the caller's object cannot change a validated policy.
    ...(input.quietHours === undefined
      ? {}
      : { quietHours: toQuietHours(input.quietHours.timeZone, input.quietHours.start, input.quietHours.end) }),
    takeoverPauseMs,
    instagramAfterWindowPolicy,
    whatsappAfterWindowPolicy,
    whatsappTemplateAutomationAllowlist: allowlist,
  };
}
