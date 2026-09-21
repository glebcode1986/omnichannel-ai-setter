/**
 * Outbound sending. Two paths share the transport but never the gate:
 *
 * - `send` is the automation path. It never attaches a message tag, so automation physically cannot use the
 *   Human Agent exception (Meta's policy forbids automated messages under that tag).
 * - `sendAsHumanAgent` (human-agent.ts) is the human path and adds the tag after an explicit human action.
 *
 * Ambiguity is never hidden: once the request may have reached Meta, the outcome is AMBIGUOUS and the caller
 * must quarantine rather than retry (ADR-012).
 */
import type { OutboundMessageCommand, SendResult } from "@omnichannel/channel-core";
import type { Logger } from "@omnichannel/observability";

import { MAX_TEXT_BYTES, type ResolvedInstagramConfig } from "./config";
import { classifyMetaError, formatErrorCode, parseMetaError, parseMetaSuccess } from "./errors";
import { checkCommandScope } from "./scope";
import type { InstagramHttpResult } from "./http";

const SEND_TIMEOUT_MS = 10_000;

export interface InstagramSendRequestBody {
  readonly recipient: { readonly id: string };
  readonly message: { readonly text: string };
  readonly tag?: "HUMAN_AGENT";
}

/** Text the adapter refuses to hand to Meta, with the reason the caller should record. */
export function checkSendableText(command: OutboundMessageCommand): { readonly text: string } | SendResult {
  if (command.content.type !== "TEXT") {
    return {
      outcome: "REJECTED",
      retryable: false,
      code: "UNSUPPORTED_CONTENT",
      message: "the Instagram adapter sends text only",
    };
  }
  const text = command.content.text;
  if (new TextEncoder().encode(text).length > MAX_TEXT_BYTES) {
    // Rejected here rather than letting Meta 400: the answer cannot change on a retry.
    return {
      outcome: "REJECTED",
      retryable: false,
      code: "UNSUPPORTED_CONTENT",
      message: `message text exceeds ${String(MAX_TEXT_BYTES)} UTF-8 bytes`,
    };
  }
  return { text };
}

export function buildSendUrl(config: ResolvedInstagramConfig): string {
  return `https://${config.graphHost}/${config.graphVersion}/${config.binding.externalAccountId}/messages`;
}

export async function dispatch(
  config: ResolvedInstagramConfig,
  body: InstagramSendRequestBody,
  operationId?: string,
): Promise<SendResult> {
  const accessToken = await config.secrets.accessToken();
  if (accessToken === undefined || accessToken.length === 0) {
    // Nothing was dispatched, so this is a clean, retryable failure once credentials are restored.
    return { outcome: "REJECTED", retryable: true, code: "NO_CREDENTIALS", message: "no usable access token for this account" };
  }
  const result = await config.http.send({
    url: buildSendUrl(config),
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(body),
    timeoutMs: SEND_TIMEOUT_MS,
  });
  return mapResult(result, config.logger, operationId);
}

export function mapResult(result: InstagramHttpResult, logger?: Logger, operationId?: string): SendResult {
  if (result.kind === "NO_RESPONSE") {
    if (result.reason === "PRE_DISPATCH") {
      return { outcome: "REJECTED", retryable: true, code: "PRE_DISPATCH", message: result.message };
    }
    // The request may have reached Meta: never retried, always reconciled.
    return { outcome: "AMBIGUOUS", code: result.reason, message: result.message };
  }

  if (result.status >= 200 && result.status < 300) {
    const success = parseMetaSuccess(result.body);
    if (success?.messageId !== undefined) {
      return { outcome: "ACCEPTED", platformMessageId: success.messageId };
    }
    // A 2xx we cannot read may still have sent the message, so it is ambiguous, not a rejection.
    return { outcome: "AMBIGUOUS", code: "UNREADABLE_SUCCESS", message: "accepted response without a message id" };
  }

  const error = parseMetaError(result.body);
  const code = error === undefined ? `HTTP_${String(result.status)}` : (formatErrorCode(error) ?? `HTTP_${String(result.status)}`);
  // Identifiers and codes only: a provider message can quote customer content.
  logger?.warn("instagram.send_rejected", {
    ...(operationId === undefined ? {} : { operationId }),
    status: result.status,
    code,
    ...(error?.traceId === undefined ? {} : { providerRequestId: error.traceId }),
  });
  if (result.status >= 500) {
    // Meta failed after receiving the request; whether the message was created is unknown, whatever the
    // body says about transience. Never a retry (ADR-012).
    return { outcome: "AMBIGUOUS", code, message: "provider error after dispatch" };
  }
  if (error === undefined) {
    return { outcome: "REJECTED", retryable: false, code, message: "unreadable provider error" };
  }
  return { outcome: "REJECTED", retryable: classifyMetaError(error), code, message: "provider rejected the message" };
}

export async function sendStandardText(config: ResolvedInstagramConfig, command: OutboundMessageCommand): Promise<SendResult> {
  // The same boundary as the tagged path, for the same reason: without it a command naming another
  // workspace's channel account is dispatched through this account's token.
  const foreign = checkCommandScope(config, command);
  if (foreign !== undefined) {
    return foreign;
  }
  const checked = checkSendableText(command);
  if ("outcome" in checked) {
    return checked;
  }
  if (config.connectionState !== "CONNECTED") {
    return { outcome: "REJECTED", retryable: true, code: "ACCOUNT_NOT_CONNECTED", message: "channel account is not connected" };
  }
  // No `tag` and no `messaging_type`: the automated path is standard-window only, by construction.
  return dispatch(config, { recipient: { id: command.recipientExternalId }, message: { text: checked.text } }, command.operationId);
}
