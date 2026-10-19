/**
 * Messaging eligibility, as a platform fact.
 *
 * WhatsApp needs four states where Instagram needs two, and the extra one carries the product's whole
 * difference: outside the 24-hour customer-service window a conversation is not *closed*, it is
 * `TEMPLATE_ONLY` — an approved template may still reach the customer. Collapsing that into NOT_ELIGIBLE
 * would silently throw away the only legitimate business-initiated route WhatsApp has.
 *
 * What this file does **not** decide is whether to use that route. Whether a `TEMPLATE_ONLY` conversation
 * is held for a person, scheduled, or answered with a template is product policy (WHATSAPP_ADAPTER.md), and
 * putting it here would be the transport choosing when to message a customer.
 *
 * Computed locally from the last inbound message and injected durations: a live Meta call would add a
 * failure mode whose only honest answer is UNKNOWN, and UNKNOWN fails closed, which would block legitimate
 * sends every time the network hiccupped.
 */
import type { ConversationPolicyContext, WindowDecision } from "@omnichannel/channel-core";

import type { ResolvedWhatsAppConfig } from "./config";

/**
 * Only the facts a window decision rests on. Narrower than the full adapter config on purpose: eligibility
 * is a question about time and account state, so answering it must not require credentials or an HTTP port.
 */
export type WindowInputs = Pick<ResolvedWhatsAppConfig, "connectionState" | "serviceWindowMs">;

export function evaluateServiceWindow(ctx: ConversationPolicyContext, config: WindowInputs): WindowDecision {
  if (config.connectionState !== "CONNECTED") {
    // Fail closed: through a broken connection we cannot know the platform state, and a template is as
    // unsendable as free-form text.
    return { state: "UNKNOWN", reason: "channel account is not connected" };
  }
  if (ctx.lastInboundAt === undefined) {
    // No customer message has ever opened a window. A template is the documented way to start a
    // conversation, so this is TEMPLATE_ONLY rather than NOT_ELIGIBLE — the latter would mean the product
    // could never initiate anything, which is not what the platform says.
    return { state: "TEMPLATE_ONLY" };
  }
  const expiresAt = new Date(ctx.lastInboundAt.getTime() + config.serviceWindowMs);
  if (expiresAt.getTime() > ctx.now.getTime()) {
    return { state: "OPEN_FREEFORM", expiresAt };
  }
  // The window has closed. Free-form is refused by Meta from here; an approved template is not.
  return { state: "TEMPLATE_ONLY" };
}
