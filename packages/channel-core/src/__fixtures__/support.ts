/**
 * Test-only helpers shared by the fixture adapters. The fixtures prove that Instagram- and WhatsApp-shaped
 * providers fit the same `ChannelAdapter` contract; they are not the real adapters (#9 and Phase 4).
 */
import type { ConversationPolicyContext, OutboundMessageCommand, RawWebhook, SendResult, VerificationResult } from "../contracts";

export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface FixtureAdapterConfig {
  /** Trusted account binding; events take their scope from here, never from the provider payload. */
  readonly workspaceId: string;
  readonly businessProfileId: string;
  readonly channelAccountId: string;
  readonly verifyToken: string;
  /** Stand-in for the HMAC a real adapter computes over the raw body with the app secret. */
  readonly expectedSignature: string;
  /** Scripted provider transport returning what the fake provider did with the request. */
  readonly transport: (command: OutboundMessageCommand) => SendResult;
}

export function verifyFixtureWebhook(input: RawWebhook, config: FixtureAdapterConfig): VerificationResult {
  if (input.method === "GET") {
    const challenge = input.query["hub.challenge"];
    return input.query["hub.mode"] === "subscribe" &&
      input.query["hub.verify_token"] === config.verifyToken &&
      challenge !== undefined
      ? { status: "CHALLENGE", responseBody: challenge }
      : { status: "REJECTED", reason: "invalid subscription handshake" };
  }
  return input.headers["x-hub-signature-256"] === `sha256=${config.expectedSignature}`
    ? { status: "VERIFIED" }
    : { status: "REJECTED", reason: "invalid signature" };
}

/** Normalization refuses anything that did not verify, so rejected payloads never reach core code. */
export function assertVerified(result: VerificationResult): void {
  if (result.status !== "VERIFIED") {
    throw new Error(`Refusing to normalize an unverified webhook (${result.status})`);
  }
}

/** Fixture payloads are ASCII JSON; the pure package has no TextDecoder. */
export function decodeJsonBody(body: Uint8Array): unknown {
  let text = "";
  for (const byte of body) {
    text += String.fromCharCode(byte);
  }
  return JSON.parse(text) as unknown;
}

/** Returns when the free-form window closes, or undefined when it is already closed or never opened. */
export function openWindowExpiry(ctx: ConversationPolicyContext): Date | undefined {
  if (ctx.lastInboundAt === undefined) {
    return undefined;
  }
  const expiresAt = ctx.lastInboundAt.getTime() + SERVICE_WINDOW_MS;
  return expiresAt > ctx.now.getTime() ? new Date(expiresAt) : undefined;
}
