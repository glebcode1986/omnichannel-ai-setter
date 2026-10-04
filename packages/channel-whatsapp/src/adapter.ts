/**
 * The adapter itself: the frozen `ChannelAdapter` members, plus one WhatsApp-only member for the
 * read/typing presence effect, which the channel-neutral contract deliberately does not model.
 *
 * Core code takes this as a plain `ChannelAdapter` and therefore cannot reach the presence call — which is
 * right, because presence is a timing decision the application owns and a transport should never take on
 * its own initiative.
 */
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ConversationPolicyContext,
  NormalizedChannelEvent,
  OutboundMessageCommand,
  RawWebhook,
  SendResult,
  VerificationResult,
  WindowDecision,
} from "@omnichannel/channel-core";
import { ContractValidationError, parseNormalizedChannelEvents } from "@omnichannel/channel-core";
import { NO_CAPABILITIES } from "@omnichannel/domain";

import { WHATSAPP_CAPABILITIES } from "./capabilities";
import { resolveConfig, type WhatsAppAdapterConfig } from "./config";
import { normalizeWhatsAppWebhook } from "./normalize";
import { markReadAndTyping, sendMessage } from "./send";
import { assertVerified, verifyWhatsAppWebhook } from "./verify";
import { evaluateServiceWindow } from "./window";

/**
 * WhatsApp-specific surface. `markReadAndTyping` is intentionally *not* part of `ChannelAdapter`: only a
 * caller that knows it is on WhatsApp and holds the inbound message ID can reach it, and its boolean result
 * says plainly that nothing depends on it succeeding.
 */
export interface WhatsAppAdapter extends ChannelAdapter {
  // Declared as function properties, not methods: they are unbound functions, so callers may destructure or
  // pass them around freely (the channel-neutral contract has to declare methods for other adapters' sake).
  readonly verifyWebhook: (input: RawWebhook) => Promise<VerificationResult>;
  readonly normalizeWebhook: (input: RawWebhook) => Promise<NormalizedChannelEvent[]>;
  readonly getCapabilities: (channelAccountId: string) => Promise<ChannelCapabilities>;
  readonly evaluateWindow: (ctx: ConversationPolicyContext) => Promise<WindowDecision>;
  readonly send: (command: OutboundMessageCommand) => Promise<SendResult>;
  /** Best effort, and says so: `false` means the effect did not happen, never that the reply should stop. */
  readonly markReadAndTyping: (input: { readonly inboundMessageId: string; readonly typing: boolean }) => Promise<boolean>;
}

export function createWhatsAppAdapter(config: WhatsAppAdapterConfig): WhatsAppAdapter {
  const resolved = resolveConfig(config);

  // Module-level helpers only: the adapter must keep working when its members are destructured.
  const verify = (input: RawWebhook): VerificationResult => verifyWhatsAppWebhook(input, resolved);

  // Arrow properties, not methods: every member stays correct when destructured or passed around, because
  // none of them can depend on `this`.
  return {
    channel: "WHATSAPP",

    verifyWebhook: (input: RawWebhook): Promise<VerificationResult> => Promise.resolve(verify(input)),

    // Async so that every failure — unverified payload, unreadable body, contract violation — reaches the
    // caller as a rejected promise rather than a synchronous throw.
    normalizeWebhook: (input: RawWebhook): Promise<NormalizedChannelEvent[]> =>
      Promise.resolve().then(() => {
        assertVerified(verify(input));
        // Each event is validated against the shared schemas on its own. Validating the batch as one unit
        // would let a single unmappable item discard every real message beside it, which Meta would then
        // redeliver to the same result.
        const valid: NormalizedChannelEvent[] = [];
        for (const candidate of normalizeWhatsAppWebhook(input, resolved)) {
          try {
            valid.push(...parseNormalizedChannelEvents([candidate]));
          } catch (error) {
            // Paths and codes only; the payload itself is customer data.
            resolved.logger?.warn("whatsapp.event_dropped", {
              channelAccountId: resolved.binding.channelAccountId,
              eventType: candidate.type,
              issues: error instanceof ContractValidationError ? error.issues : [],
            });
          }
        }
        return valid;
      }),

    // Capabilities belong to the bound account; another account's are simply not ours to report.
    getCapabilities: (channelAccountId: string): Promise<ChannelCapabilities> =>
      Promise.resolve(channelAccountId === resolved.binding.channelAccountId ? WHATSAPP_CAPABILITIES : NO_CAPABILITIES),

    evaluateWindow: (ctx: ConversationPolicyContext): Promise<WindowDecision> => Promise.resolve(evaluateServiceWindow(ctx, resolved)),

    send: (command: OutboundMessageCommand): Promise<SendResult> => sendMessage(resolved, command),

    markReadAndTyping: (input: { readonly inboundMessageId: string; readonly typing: boolean }): Promise<boolean> =>
      markReadAndTyping(resolved, input),
  };
}
