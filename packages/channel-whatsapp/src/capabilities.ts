/**
 * What the WhatsApp Cloud API transport can carry. A platform fact, not a statement about what the product
 * sends today: P4-01 implements text and approved templates outbound, while the transport itself also
 * accepts media and interactive messages, which later Phase 4 tasks turn on.
 *
 * `templates: true` is the capability that distinguishes this channel from Instagram, and the reason
 * `OutboundContent` has a TEMPLATE variant at all: outside the customer-service window it is the only
 * route to a customer.
 */
import type { ChannelCapabilities } from "@omnichannel/channel-core";
import { NO_CAPABILITIES } from "@omnichannel/domain";

export const WHATSAPP_CAPABILITIES: ChannelCapabilities = {
  ...NO_CAPABILITIES,
  text: true,
  image: true,
  video: true,
  audio: true,
  document: true,
  reactions: true,
  readReceipts: true,
  typingIndicator: true,
  // Inbound interactive replies normalize today (a button press arrives as its title); sending interactive
  // messages is capability-gated and arrives with P4-03.
  interactive: false,
  templates: true,
};
