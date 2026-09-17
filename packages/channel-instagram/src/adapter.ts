/**
 * The adapter itself: the six frozen `ChannelAdapter` members, plus two Instagram-only members for the
 * Human Agent exception, which the channel-neutral contract deliberately does not model.
 *
 * Core code takes this as a plain `ChannelAdapter` and can therefore never reach the tagged send path.
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
import { parseNormalizedChannelEvents } from "@omnichannel/channel-core";
import { NO_CAPABILITIES } from "@omnichannel/domain";

import { INSTAGRAM_CAPABILITIES } from "./capabilities";
import { resolveConfig, type InstagramAdapterConfig } from "./config";
import { sendAsHumanAgent, type HumanActor } from "./human-agent";
import { normalizeInstagramWebhook } from "./normalize";
import { parseInstagramWebhookBody } from "./payload";
import { sendStandardText } from "./send";
import { assertVerified, verifyInstagramWebhook } from "./verify";
import { evaluateHumanAgentEligibility, evaluateStandardWindow, type HumanAgentEligibility } from "./window";

/**
 * Instagram-specific surface. `sendAsHumanAgent` is intentionally *not* part of `ChannelAdapter`: only a
 * caller that knows it is on Instagram and holds a human actor can reach it.
 */
export interface InstagramAdapter extends ChannelAdapter {
  // Declared as function properties, not methods: they are unbound functions, so callers may destructure or
  // pass them around freely (the channel-neutral contract has to declare methods for other adapters' sake).
  readonly verifyWebhook: (input: RawWebhook) => Promise<VerificationResult>;
  readonly normalizeWebhook: (input: RawWebhook) => Promise<NormalizedChannelEvent[]>;
  readonly getCapabilities: (channelAccountId: string) => Promise<ChannelCapabilities>;
  readonly evaluateWindow: (ctx: ConversationPolicyContext) => Promise<WindowDecision>;
  readonly send: (command: OutboundMessageCommand) => Promise<SendResult>;
  readonly evaluateHumanAgentEligibility: (ctx: ConversationPolicyContext) => Promise<HumanAgentEligibility>;
  readonly sendAsHumanAgent: (command: OutboundMessageCommand, actor: HumanActor, ctx: ConversationPolicyContext) => Promise<SendResult>;
}

export function createInstagramAdapter(config: InstagramAdapterConfig): InstagramAdapter {
  const resolved = resolveConfig(config);

  // Module-level helpers only: the adapter must keep working when its members are destructured.
  const verify = (input: RawWebhook): VerificationResult => verifyInstagramWebhook(input, resolved);

  // Arrow properties, not methods: every member stays correct when it is destructured or passed around,
  // because none of them can depend on `this`.
  return {
    channel: "INSTAGRAM",

    verifyWebhook: (input: RawWebhook): Promise<VerificationResult> => Promise.resolve(verify(input)),

    // Async so that every failure — unverified payload, unparsable body, contract violation — reaches the
    // caller as a rejected promise rather than a synchronous throw.
    normalizeWebhook: (input: RawWebhook): Promise<NormalizedChannelEvent[]> =>
      Promise.resolve().then(() => {
        assertVerified(verify(input));
        const body = parseInstagramWebhookBody(input.rawBody);
        // Validated against the shared schemas before leaving the package, so a mapping bug surfaces here.
        return parseNormalizedChannelEvents(normalizeInstagramWebhook(body, resolved.binding));
      }),

    // Capabilities belong to the bound account; another account's are simply not ours to report.
    getCapabilities: (channelAccountId: string): Promise<ChannelCapabilities> =>
      Promise.resolve(channelAccountId === resolved.binding.channelAccountId ? INSTAGRAM_CAPABILITIES : NO_CAPABILITIES),

    evaluateWindow: (ctx: ConversationPolicyContext): Promise<WindowDecision> => Promise.resolve(evaluateStandardWindow(ctx, resolved)),

    evaluateHumanAgentEligibility: (ctx: ConversationPolicyContext): Promise<HumanAgentEligibility> =>
      Promise.resolve(evaluateHumanAgentEligibility(ctx, resolved)),

    send: (command: OutboundMessageCommand): Promise<SendResult> => sendStandardText(resolved, command),

    sendAsHumanAgent: (command: OutboundMessageCommand, actor: HumanActor, ctx: ConversationPolicyContext): Promise<SendResult> =>
      sendAsHumanAgent(resolved, command, actor, ctx),
  };
}
