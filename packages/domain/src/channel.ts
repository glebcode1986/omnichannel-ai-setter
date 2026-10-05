import { literalGuard } from "./enum";

/**
 * Channel-neutral vocabulary shared by the domain and the channel boundary (`@omnichannel/channel-core`
 * re-exports these). Adding a channel is an ADR-level change (ADR-001, ADR-007).
 */
export const CHANNEL_TYPES = ["INSTAGRAM", "WHATSAPP"] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];
export const isChannelType = literalGuard(CHANNEL_TYPES);

/** Automation policy mode. Separate from takeover state and after-window policies (HUMAN_HANDOFF.md). */
export const AI_MODES = ["OFF", "DRAFT", "AUTOPILOT"] as const;
export type AiMode = (typeof AI_MODES)[number];
export const isAiMode = literalGuard(AI_MODES);

export const MESSAGE_KINDS = [
  "TEXT",
  "IMAGE",
  "VIDEO",
  "AUDIO",
  "DOCUMENT",
  "INTERACTIVE",
  "TEMPLATE",
  "REACTION",
  "UNKNOWN",
] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];
export const isMessageKind = literalGuard(MESSAGE_KINDS);

/** What a channel account can currently do; features are capability-gated (ADR-001). */
export interface ChannelCapabilities {
  readonly text: boolean;
  readonly image: boolean;
  readonly video: boolean;
  readonly audio: boolean;
  readonly document: boolean;
  readonly interactive: boolean;
  readonly templates: boolean;
  readonly reactions: boolean;
  readonly readReceipts: boolean;
  readonly typingIndicator: boolean;
  /**
   * Whether this product is told about replies a person sends outside it.
   *
   * A visibility fact, not a feature: when it is false, somebody can answer a customer from the provider's
   * own app and nothing here will ever know. The assistant would then keep drafting into a conversation a
   * colleague is already handling, which is the one failure human takeover exists to prevent — so a
   * channel account that cannot see native replies must say so rather than behave as though none happen.
   *
   * Channel-neutral on purpose. Why a given account can or cannot see them is the adapter's business.
   */
  readonly nativeOutboundVisible: boolean;
}

export const CHANNEL_CAPABILITY_KEYS = [
  "text",
  "image",
  "video",
  "audio",
  "document",
  "interactive",
  "templates",
  "reactions",
  "readReceipts",
  "typingIndicator",
  "nativeOutboundVisible",
] as const satisfies readonly (keyof ChannelCapabilities)[];

export const NO_CAPABILITIES: ChannelCapabilities = {
  text: false,
  image: false,
  video: false,
  audio: false,
  document: false,
  interactive: false,
  templates: false,
  reactions: false,
  readReceipts: false,
  typingIndicator: false,
  // False by default, and that is the safe direction: a product that assumes it can see native replies
  // when it cannot will draft over a colleague, while one that assumes it cannot will merely say so.
  nativeOutboundVisible: false,
};
