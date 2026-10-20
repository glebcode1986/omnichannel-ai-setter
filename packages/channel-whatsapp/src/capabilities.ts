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
  /**
   * False for an ordinary Cloud API number, and that is a fact about the platform rather than a gap here.
   *
   * A number that is *only* on Cloud API has no app a person could reply from, so there are no native
   * sends to miss. A coexistence number does — the business keeps using the WhatsApp Business App — and
   * Meta publishes those on `smb_message_echoes`, so visibility is true there. `coexistenceCapabilities`
   * makes that decision per account; this table is the default for a number that is not on coexistence.
   */
  nativeOutboundVisible: false,
};

/**
 * What a channel account can do once it is known whether the business still uses the app (#23).
 *
 * Coexistence is capability-gated and must never be assumed: the spec says so, and Meta reports it only
 * at Embedded Signup finish. `UNKNOWN` therefore behaves like "not coexistence" for every capability the
 * provider confirms, and like "we cannot see native sends" for the one that matters here — because the
 * cost of being wrong is asymmetric. Believing we can see native replies when we cannot means drafting
 * over a colleague; believing we cannot when we can means saying so on a card.
 */
export function coexistenceCapabilities(mode: string): ChannelCapabilities {
  return { ...WHATSAPP_CAPABILITIES, nativeOutboundVisible: mode === "COEXISTENCE_EXISTING_BUSINESS_APP" };
}
