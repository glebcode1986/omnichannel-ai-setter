/**
 * Instagram webhook payload shapes. Meta's field names live here and nowhere else; everything above this
 * file speaks the normalized contract.
 *
 * Parsing is deliberately lenient: Meta batches up to 1000 mixed updates in one delivery and retries failed
 * deliveries for 36 hours, so an unknown item must be skipped rather than failing the whole batch. Only a
 * body that is not an Instagram webhook envelope at all is a hard error.
 */
import { z } from "zod";

const attachmentSchema = z.looseObject({
  type: z.string().optional(),
  payload: z.looseObject({ url: z.string().optional() }).optional(),
});

const messageSchema = z.looseObject({
  mid: z.string().optional(),
  text: z.string().optional(),
  /** Outbound message observed on the platform (ours or a human's; the application decides which). */
  is_echo: z.boolean().optional(),
  /** Message the user deleted; there is no deletion event in the normalized contract. */
  is_deleted: z.boolean().optional(),
  /** Media Meta itself cannot hand over (expired, unsupported format). */
  is_unsupported: z.boolean().optional(),
  /** Test message sent to your own account. Never to be confused with is_echo. */
  is_self: z.boolean().optional(),
  reply_to: z.looseObject({ mid: z.string().optional() }).optional(),
  attachments: z.array(attachmentSchema).optional(),
});

const messagingItemSchema = z.looseObject({
  sender: z.looseObject({ id: z.string().optional() }).optional(),
  recipient: z.looseObject({ id: z.string().optional() }).optional(),
  /** Milliseconds since the epoch (Instagram, unlike WhatsApp, does not use seconds). */
  timestamp: z.number().optional(),
  message: messageSchema.optional(),
  read: z.looseObject({ mid: z.string().optional() }).optional(),
  reaction: z
    .looseObject({
      mid: z.string().optional(),
      action: z.string().optional(),
      emoji: z.string().optional(),
      reaction: z.string().optional(),
    })
    .optional(),
  postback: z
    .looseObject({ mid: z.string().optional(), title: z.string().optional(), payload: z.string().optional() })
    .optional(),
});

const entrySchema = z.looseObject({
  id: z.string().optional(),
  time: z.number().optional(),
  messaging: z.array(z.unknown()).optional(),
});

/**
 * The envelope is validated strictly enough to know this is an Instagram webhook, but its items are left as
 * `unknown` and parsed one by one below: a single malformed field must cost that item, not the batch.
 */
export const instagramWebhookSchema = z.looseObject({
  object: z.literal("instagram"),
  entry: z.array(z.unknown()),
});

export type InstagramWebhookBody = z.infer<typeof instagramWebhookSchema>;
export type InstagramEntry = z.infer<typeof entrySchema>;

/** Returns undefined instead of throwing, so an unrecognized entry or item is simply skipped. */
export function parseEntry(value: unknown): InstagramEntry | undefined {
  const parsed = entrySchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function parseMessagingItem(value: unknown): InstagramMessagingItem | undefined {
  const parsed = messagingItemSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
export type InstagramMessagingItem = z.infer<typeof messagingItemSchema>;
export type InstagramAttachment = z.infer<typeof attachmentSchema>;

export class InstagramPayloadError extends Error {
  constructor(reason: string) {
    // Reasons describe the shape only: a webhook body is customer data.
    super(`invalid Instagram webhook body: ${reason}`);
    this.name = "InstagramPayloadError";
  }
}

export function parseInstagramWebhookBody(rawBody: Uint8Array): InstagramWebhookBody {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody));
  } catch {
    throw new InstagramPayloadError("body is not UTF-8 JSON");
  }
  const parsed = instagramWebhookSchema.safeParse(json);
  if (!parsed.success) {
    throw new InstagramPayloadError("body is not an Instagram webhook envelope");
  }
  return parsed.data;
}
