/**
 * What the Instagram transport can carry. This is a platform fact, not a statement about what the product
 * sends today: automated replies are text only (INSTAGRAM_ADAPTER.md), while the transport itself also
 * accepts media, reactions and read receipts.
 */
import type { ChannelCapabilities } from "@omnichannel/channel-core";
import { NO_CAPABILITIES } from "@omnichannel/domain";

export const INSTAGRAM_CAPABILITIES: ChannelCapabilities = {
  ...NO_CAPABILITIES,
  text: true,
  image: true,
  video: true,
  audio: true,
  document: true,
  reactions: true,
  readReceipts: true,
  typingIndicator: true,
  // Instagram has no pre-approved named templates (that is the WhatsApp concept OutboundContent models),
  // and generic/button templates are not part of the MVP transport.
  interactive: false,
  templates: false,
};
