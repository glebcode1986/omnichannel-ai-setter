/**
 * Runtime validation for normalized payloads crossing from channel adapters (or queues/fixtures) into
 * channel-neutral code. Objects are strict: provider-specific fields cannot leak past normalization except
 * inside the retention-controlled `rawMeta`.
 */
import { CHANNEL_TYPES, isValidIdentifier, MESSAGE_KINDS } from "@omnichannel/domain";
import { z } from "zod";

import {
  CONVERSATION_POLICY_CHANGES,
  DELIVERY_STATUS_VALUES,
  type NormalizedChannelEvent,
  type OutboundMessageCommand,
  type SendResult,
  type WindowDecision,
} from "./contracts";

/** Provider-assigned identifiers (event, message, user IDs): opaque, possibly long. */
const identifier = z.string().min(1).max(512);
/** Internal scope identifiers (Workspace, Business Profile, channel account, ...): domain identifier rules. */
const scopeIdentifier = z.string().refine(isValidIdentifier);
const text = z.string().max(65_536);
const validDate = z.date();

const eventBase = {
  workspaceId: scopeIdentifier,
  businessProfileId: scopeIdentifier,
  channel: z.enum(CHANNEL_TYPES),
  channelAccountId: scopeIdentifier,
  sourceEventId: identifier,
  occurredAt: validDate,
  rawMeta: z.unknown().optional(),
};

const mediaAttachmentSchema = z.strictObject({
  kind: z.enum(["IMAGE", "VIDEO", "AUDIO", "DOCUMENT"]),
  providerMediaId: identifier.optional(),
  mimeType: z.string().min(1).max(255).optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  caption: text.optional(),
});

const providerErrorSchema = z.strictObject({
  code: z.string().max(255).optional(),
  message: text.optional(),
});

export const normalizedChannelEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...eventBase,
    type: z.literal("INBOUND_MESSAGE"),
    senderExternalId: identifier,
    senderDisplayName: z.string().max(1_024).optional(),
    senderUsername: z.string().max(1_024).optional(),
    externalMessageId: identifier.optional(),
    messageKind: z.enum(MESSAGE_KINDS),
    text: text.optional(),
    media: z.array(mediaAttachmentSchema).max(100),
    replyToExternalMessageId: identifier.optional(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("OUTBOUND_ECHO"),
    platformMessageId: identifier,
    recipientExternalId: identifier,
    messageKind: z.enum(MESSAGE_KINDS),
    text: text.optional(),
    sendingApplicationId: identifier.optional(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("DELIVERY_STATUS"),
    platformMessageId: identifier,
    status: z.enum(DELIVERY_STATUS_VALUES),
    error: providerErrorSchema.optional(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("READ_STATUS"),
    readerExternalId: identifier,
    platformMessageId: identifier,
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("REACTION"),
    platformMessageId: identifier,
    reactorExternalId: identifier,
    action: z.enum(["REACT", "UNREACT"]),
    reaction: z.string().max(64).optional(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("POSTBACK"),
    senderExternalId: identifier,
    payload: z.string().max(4_096),
    title: z.string().max(1_024).optional(),
    relatedMessageId: identifier.optional(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("CONVERSATION_POLICY"),
    change: z.enum(CONVERSATION_POLICY_CHANGES),
    participantExternalId: identifier.optional(),
    detail: z.string().max(1_024).optional(),
  }),
]) satisfies z.ZodType<NormalizedChannelEvent>;

export const windowDecisionSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("OPEN_FREEFORM"), expiresAt: validDate.optional() }),
  z.strictObject({ state: z.literal("TEMPLATE_ONLY"), expiresAt: validDate.optional() }),
  z.strictObject({ state: z.literal("NOT_ELIGIBLE"), reason: z.string().min(1).max(1_024) }),
  z.strictObject({ state: z.literal("UNKNOWN"), reason: z.string().min(1).max(1_024) }),
]) satisfies z.ZodType<WindowDecision>;

export const outboundContentSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("TEXT"), text: z.string().min(1).max(65_536) }),
  z.strictObject({
    type: z.literal("TEMPLATE"),
    templateName: identifier,
    languageCode: z.string().min(2).max(35),
    parameters: z.array(z.strictObject({ name: identifier, value: z.string().max(4_096) })).max(100),
  }),
]);

export const outboundMessageCommandSchema = z.strictObject({
  workspaceId: scopeIdentifier,
  businessProfileId: scopeIdentifier,
  channelAccountId: scopeIdentifier,
  conversationId: scopeIdentifier,
  recipientExternalId: identifier,
  operationId: scopeIdentifier,
  replyToExternalMessageId: identifier.optional(),
  content: outboundContentSchema,
}) satisfies z.ZodType<OutboundMessageCommand>;

export const sendResultSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("ACCEPTED"),
    platformMessageId: identifier,
    providerRequestId: identifier.optional(),
  }),
  z.strictObject({
    outcome: z.literal("REJECTED"),
    retryable: z.boolean(),
    code: z.string().max(255).optional(),
    message: z.string().max(4_096),
  }),
  // No `retryable` field: an ambiguous outcome can never be marked retryable.
  z.strictObject({
    outcome: z.literal("AMBIGUOUS"),
    providerRequestId: identifier.optional(),
    code: z.string().max(255).optional(),
    message: z.string().max(4_096),
  }),
]) satisfies z.ZodType<SendResult>;

export interface ContractIssue {
  /** Path inside the payload, e.g. `0.media.1.kind`. */
  readonly path: string;
  /** Zod's built-in description; payload values are never included. */
  readonly code: string;
}

/** Raised when a payload does not match a channel contract. Carries paths and issue codes, never values. */
export class ContractValidationError extends Error {
  readonly contract: string;
  readonly issues: readonly ContractIssue[];

  constructor(contract: string, issues: readonly ContractIssue[]) {
    super(`Invalid ${contract}: ${issues.map((issue) => `${issue.path || "(root)"} [${issue.code}]`).join("; ")}`);
    this.name = "ContractValidationError";
    this.contract = contract;
    this.issues = issues;
  }
}

function parseWith<T>(schema: z.ZodType<T>, contract: string, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ContractValidationError(
      contract,
      result.error.issues.map((issue) => ({ path: issue.path.map(String).join("."), code: issue.code })),
    );
  }
  return result.data;
}

export function parseNormalizedChannelEvents(input: unknown): NormalizedChannelEvent[] {
  return parseWith(z.array(normalizedChannelEventSchema), "NormalizedChannelEvent[]", input);
}

export function parseWindowDecision(input: unknown): WindowDecision {
  return parseWith(windowDecisionSchema, "WindowDecision", input);
}

export function parseOutboundMessageCommand(input: unknown): OutboundMessageCommand {
  return parseWith(outboundMessageCommandSchema, "OutboundMessageCommand", input);
}

export function parseSendResult(input: unknown): SendResult {
  return parseWith(sendResultSchema, "SendResult", input);
}
