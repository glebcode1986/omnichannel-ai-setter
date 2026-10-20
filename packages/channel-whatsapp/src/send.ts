/**
 * Outbound transport: free-form text, approved templates, and the read/typing presence effect.
 *
 * Three invariants from WHATSAPP_ADAPTER.md and ADR-012 decide the shape of this file.
 *
 * **Ambiguity is never converted into a rejection.** A timeout or a socket failure after the request left
 * us means Meta may have the message. Reporting that as retryable would send a customer the same reply
 * twice; it is `AMBIGUOUS`, and the delivery coordinator quarantines it for a person.
 *
 * **Validation happens before provider side effects.** Text length, template parameters and the account's
 * connection state are checked locally, so a refusal that could be known in advance costs no request and
 * reads as a sentence rather than as a provider error code.
 *
 * **A template is a data substitution, never a rewrite.** The command names an approved template, its
 * language and its parameter values; nothing in this file composes body text, and nothing here asks a model
 * anything.
 */
import type { OutboundMessageCommand, SendResult, TemplateParameter } from "@omnichannel/channel-core";
import { templateParameterFormatOf } from "@omnichannel/domain";

import { MAX_TEXT_LENGTH, messagesUrl, type ResolvedWhatsAppConfig } from "./config";
import { classifyWhatsAppError, formatErrorCode, OUTSIDE_SERVICE_WINDOW_CODE, parseAcceptedMessageId, parseWhatsAppError } from "./errors";
import type { WhatsAppHttpResult } from "./http";


const SEND_TIMEOUT_MS = 10_000;
/** Presence is best-effort, so it gets a shorter budget than a reply: it must never delay one. */
const PRESENCE_TIMEOUT_MS = 3_000;

/**
 * The outbound payload for a free-form text reply.
 *
 * `preview_url: false` on purpose. Link previews are fetched by Meta from the customer's side and change
 * what the message looks like after it is sent; a business reply should render as the words that were
 * reviewed and nothing else.
 */
export function buildTextPayload(command: OutboundMessageCommand, text: string): Readonly<Record<string, unknown>> {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: command.recipientExternalId,
    type: "text",
    text: { preview_url: false, body: text },
    ...(command.replyToExternalMessageId === undefined ? {} : { context: { message_id: command.replyToExternalMessageId } }),
  };
}

/**
 * The outbound payload for an approved template.
 *
 * **Named and positional templates serialize differently**, which this did not distinguish until Issue
 * #20. Meta's two parameter formats are `positional` — `{{1}}`, `{{2}}`, values in order and unnamed — and
 * `named` — `{{snake_case}}`, every value carrying its own `parameter_name`. A named template sent with
 * positional values is refused by the provider, so a business whose templates use names could not send at
 * all. The format is derived from the names, because Meta's two formats partition the name space: a
 * positional parameter's name *is* a number and a named one's cannot be.
 *
 * The approved template owns the wording. Nothing here composes text, and the values have already been
 * validated against the approved shape by the application (`templateVariablesProblem`).
 */
export function buildTemplatePayload(
  command: OutboundMessageCommand,
  template: { readonly templateName: string; readonly languageCode: string; readonly parameters: readonly TemplateParameter[] },
): Readonly<Record<string, unknown>> {
  const named = templateParameterFormatOf(template.parameters) === "NAMED";
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: command.recipientExternalId,
    type: "template",
    template: {
      name: template.templateName,
      language: { code: template.languageCode },
      ...(template.parameters.length === 0
        ? {}
        : {
            components: [
              {
                type: "body",
                parameters: template.parameters.map((parameter) => ({
                  type: "text",
                  ...(named ? { parameter_name: parameter.name } : {}),
                  text: parameter.value,
                })),
              },
            ],
          }),
    },
  };
}

/** Local refusals, in the order that costs the least. Returns `undefined` when the command may be sent. */
export function checkSendable(config: ResolvedWhatsAppConfig, command: OutboundMessageCommand): SendResult | undefined {
  if (config.connectionState !== "CONNECTED") {
    // Retryable: the content is fine and a reconnect makes the same send valid.
    return { outcome: "REJECTED", retryable: true, code: "ACCOUNT_NOT_CONNECTED", message: "channel account is not connected" };
  }
  if (command.content.type === "TEXT") {
    const text = command.content.text;
    if (text.trim() === "") {
      return { outcome: "REJECTED", retryable: false, code: "EMPTY_TEXT", message: "a reply cannot be empty" };
    }
    if (text.length > MAX_TEXT_LENGTH) {
      // Refused here rather than letting Meta 400: the answer cannot change on a retry.
      return { outcome: "REJECTED", retryable: false, code: "UNSUPPORTED_CONTENT", message: `message text exceeds ${String(MAX_TEXT_LENGTH)} characters` };
    }
    return undefined;
  }
  const template = command.content;
  if (template.templateName.trim() === "" || template.languageCode.trim() === "") {
    return { outcome: "REJECTED", retryable: false, code: "UNSUPPORTED_CONTENT", message: "a template send needs a template name and language" };
  }
  if (template.parameters.some((parameter) => parameter.value.trim() === "")) {
    // An empty parameter renders as a gap in an approved template. Meta may accept it; a customer reading
    // "your order  is ready" is the failure this prevents.
    return { outcome: "REJECTED", retryable: false, code: "UNSUPPORTED_CONTENT", message: "a template parameter cannot be empty" };
  }
  return undefined;
}

export async function sendMessage(config: ResolvedWhatsAppConfig, command: OutboundMessageCommand): Promise<SendResult> {
  const refusal = checkSendable(config, command);
  if (refusal !== undefined) {
    return refusal;
  }
  const accessToken = await config.secrets.accessToken();
  if (accessToken === undefined || accessToken.length === 0) {
    // Nothing was dispatched, so this is a clean, retryable failure once credentials are restored.
    return { outcome: "REJECTED", retryable: true, code: "NO_CREDENTIALS", message: "no usable access token for this account" };
  }
  const payload =
    command.content.type === "TEXT" ? buildTextPayload(command, command.content.text) : buildTemplatePayload(command, command.content);

  const result = await config.http.send({
    url: messagesUrl(config),
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(payload),
    timeoutMs: SEND_TIMEOUT_MS,
  });
  return mapResult(result, config, command.operationId);
}

export function mapResult(result: WhatsAppHttpResult, config: ResolvedWhatsAppConfig, operationId?: string): SendResult {
  if (result.kind === "NO_RESPONSE") {
    if (result.reason === "PRE_DISPATCH") {
      return { outcome: "REJECTED", retryable: true, code: "PRE_DISPATCH", message: result.message };
    }
    // The request may have reached Meta: never retried, always reconciled (ADR-012).
    return { outcome: "AMBIGUOUS", code: result.reason, message: result.message };
  }

  if (result.status >= 200 && result.status < 300) {
    const messageId = parseAcceptedMessageId(result.body);
    if (messageId !== undefined) {
      return { outcome: "ACCEPTED", platformMessageId: messageId };
    }
    // A 2xx we cannot read may still have sent the message, so it is ambiguous, not a rejection.
    return { outcome: "AMBIGUOUS", code: "UNREADABLE_SUCCESS", message: "accepted response without a message id" };
  }

  const error = parseWhatsAppError(result.body);
  const code = error === undefined ? `HTTP_${String(result.status)}` : (formatErrorCode(error) ?? `HTTP_${String(result.status)}`);
  // Identifiers and codes only: a provider message can quote customer content.
  config.logger?.warn("whatsapp.send_rejected", {
    ...(operationId === undefined ? {} : { operationId }),
    status: result.status,
    code,
    ...(error?.traceId === undefined ? {} : { providerRequestId: error.traceId }),
  });
  if (result.status >= 500) {
    // Meta failed after receiving the request; whether the message was created is unknown, whatever the
    // body says. Never a retry (ADR-012).
    return { outcome: "AMBIGUOUS", code, message: "provider error after dispatch" };
  }
  if (error === undefined) {
    return { outcome: "REJECTED", retryable: false, code, message: "unreadable provider error" };
  }
  return {
    outcome: "REJECTED",
    retryable: classifyWhatsAppError(error),
    code,
    message:
      error.code === OUTSIDE_SERVICE_WINDOW_CODE
        ? "the customer-service window has closed; only an approved template can reach this customer"
        : "provider rejected the message",
  };
}

/**
 * Marks the customer's message read and shows the typing indicator, in one request.
 *
 * Best-effort by contract: the result is a boolean because nothing a caller can do about a failed presence
 * effect is worth cancelling a reply for. Meta answers `{"success": true}` rather than a message id, so
 * the HTTP status is the whole verdict.
 *
 * **It must be called near the send, not at scheduling time.** Meta's own documentation (re-verified
 * 2026-10-04) says the indicator disappears when the reply arrives *or after 25 seconds*, whichever comes
 * first, and the product's human-like delay is 30–120 seconds. Showing typing when the delay starts would
 * therefore display it, drop it, and leave the customer watching nothing for a minute — which is why this
 * function neither waits nor schedules and the application owns the timing.
 */
export async function markReadAndTyping(
  config: ResolvedWhatsAppConfig,
  input: { readonly inboundMessageId: string; readonly typing: boolean },
): Promise<boolean> {
  if (config.connectionState !== "CONNECTED") {
    return false;
  }
  const accessToken = await config.secrets.accessToken();
  if (accessToken === undefined || accessToken.length === 0) {
    return false;
  }
  const result = await config.http.send({
    url: messagesUrl(config),
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      status: "read",
      message_id: input.inboundMessageId,
      ...(input.typing ? { typing_indicator: { type: "text" } } : {}),
    }),
    timeoutMs: PRESENCE_TIMEOUT_MS,
  });
  if (result.kind === "RESPONSE" && result.status >= 200 && result.status < 300) {
    return true;
  }
  // Logged at debug: a failed read receipt is a cosmetic loss, and at warn it would compete with the
  // failures that actually cost a customer something.
  config.logger?.debug("whatsapp.presence_failed", {
    channelAccountId: config.binding.channelAccountId,
    ...(result.kind === "RESPONSE" ? { status: result.status } : { reason: result.reason }),
  });
  return false;
}
