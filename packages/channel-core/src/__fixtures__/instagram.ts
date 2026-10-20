import { z } from "zod";

import type { ChannelAdapter, ChannelCapabilities, NormalizedChannelEvent } from "../contracts";
import { parseNormalizedChannelEvents } from "../schemas";
import { assertVerified, decodeJsonBody, openWindowExpiry, verifyFixtureWebhook, type FixtureAdapterConfig } from "./support";

/** Simplified Instagram-like webhook body. Provider field names stay inside the adapter. */
const instagramPayloadSchema = z.object({
  object: z.literal("instagram"),
  entry: z.array(
    z.object({
      messaging: z.array(
        z.object({
          sender: z.object({ id: z.string() }),
          recipient: z.object({ id: z.string() }),
          timestamp: z.number(),
          message: z
            .object({
              mid: z.string(),
              text: z.string().optional(),
              is_echo: z.boolean().optional(),
              app_id: z.string().optional(),
              reply_to: z.object({ mid: z.string() }).optional(),
            })
            .optional(),
          read: z.object({ mid: z.string() }).optional(),
          reaction: z
            .object({ mid: z.string(), action: z.enum(["react", "unreact"]), emoji: z.string().optional() })
            .optional(),
        }),
      ),
    }),
  ),
});

type InstagramMessagingItem = z.infer<typeof instagramPayloadSchema>["entry"][number]["messaging"][number];

export const INSTAGRAM_FIXTURE_CAPABILITIES: ChannelCapabilities = {
  text: true,
  image: true,
  video: true,
  audio: true,
  document: false,
  interactive: false,
  templates: false,
  reactions: true,
  readReceipts: true,
  typingIndicator: true,
  // Instagram echoes every outbound message, including ones a person sent from the native app.
  nativeOutboundVisible: true,
};

export function createInstagramFixtureAdapter(config: FixtureAdapterConfig): ChannelAdapter {
  return {
    channel: "INSTAGRAM",

    verifyWebhook(input) {
      return Promise.resolve(verifyFixtureWebhook(input, config));
    },

    async normalizeWebhook(input) {
      assertVerified(await this.verifyWebhook(input));
      const payload = instagramPayloadSchema.parse(decodeJsonBody(input.rawBody));
      const events = payload.entry.flatMap((entry) => entry.messaging.flatMap((item) => normalizeItem(item, config)));
      return parseNormalizedChannelEvents(events);
    },

    getCapabilities() {
      return Promise.resolve(INSTAGRAM_FIXTURE_CAPABILITIES);
    },

    evaluateWindow(ctx) {
      if (ctx.lastInboundAt === undefined) {
        return Promise.resolve({ state: "NOT_ELIGIBLE", reason: "no user-initiated conversation" });
      }
      const expiresAt = openWindowExpiry(ctx);
      return Promise.resolve(
        expiresAt === undefined
          ? { state: "NOT_ELIGIBLE", reason: "standard messaging window closed" }
          : { state: "OPEN_FREEFORM", expiresAt },
      );
    },

    send(command) {
      if (command.content.type !== "TEXT") {
        return Promise.resolve({
          outcome: "REJECTED",
          retryable: false,
          code: "UNSUPPORTED_CONTENT",
          message: "content type is not supported on this channel",
        });
      }
      return Promise.resolve(config.transport(command));
    },
  };
}

function normalizeItem(item: InstagramMessagingItem, config: FixtureAdapterConfig): NormalizedChannelEvent[] {
  const base = {
    workspaceId: config.workspaceId,
    businessProfileId: config.businessProfileId,
    channel: "INSTAGRAM",
    channelAccountId: config.channelAccountId,
    occurredAt: new Date(item.timestamp),
  } as const;

  if (item.message?.is_echo === true) {
    return [
      {
        ...base,
        type: "OUTBOUND_ECHO",
        sourceEventId: item.message.mid,
        platformMessageId: item.message.mid,
        recipientExternalId: item.recipient.id,
        messageKind: item.message.text === undefined ? "UNKNOWN" : "TEXT",
        text: item.message.text,
        sendingApplicationId: item.message.app_id,
      },
    ];
  }
  if (item.message !== undefined) {
    return [
      {
        ...base,
        type: "INBOUND_MESSAGE",
        sourceEventId: item.message.mid,
        senderExternalId: item.sender.id,
        externalMessageId: item.message.mid,
        messageKind: item.message.text === undefined ? "UNKNOWN" : "TEXT",
        text: item.message.text,
        media: [],
        replyToExternalMessageId: item.message.reply_to?.mid,
      },
    ];
  }
  if (item.read !== undefined) {
    return [
      {
        ...base,
        type: "READ_STATUS",
        sourceEventId: `read:${item.sender.id}:${item.read.mid}`,
        readerExternalId: item.sender.id,
        platformMessageId: item.read.mid,
      },
    ];
  }
  if (item.reaction !== undefined) {
    return [
      {
        ...base,
        type: "REACTION",
        sourceEventId: `reaction:${item.sender.id}:${item.reaction.mid}:${item.timestamp}`,
        platformMessageId: item.reaction.mid,
        reactorExternalId: item.sender.id,
        action: item.reaction.action === "react" ? "REACT" : "UNREACT",
        reaction: item.reaction.emoji,
      },
    ];
  }
  // Unknown messaging items are skipped deterministically rather than guessed at.
  return [];
}
