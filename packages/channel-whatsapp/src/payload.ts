/**
 * The provider's webhook shape, parsed once and never trusted twice.
 *
 * Everything is optional and `looseObject`, deliberately. Meta adds fields without notice, and a strict
 * schema would turn a new field into a rejected customer message — the adapter's job is to normalize what
 * it recognizes and leave an auditable record of what it does not, not to insist the platform stops
 * changing. What it does enforce is that a field it *acts* on has the type it needs.
 *
 * Shapes re-verified 2026-09-16 against the Cloud API webhook reference
 * (docs/research/META_WHATSAPP_PHASE4_VERIFICATION.md).
 */
import { z } from "zod";

/** `timestamp` arrives as a string of unix seconds, which is not a thing `z.coerce.date()` reads correctly. */
const providerTimestamp = z.string().min(1).max(32);

const mediaObject = z.looseObject({
  id: z.string().min(1).optional(),
  mime_type: z.string().min(1).max(255).optional(),
  sha256: z.string().optional(),
  caption: z.string().optional(),
  filename: z.string().optional(),
  /** Set by the platform on a voice note, as opposed to an audio file attachment. */
  voice: z.boolean().optional(),
});

const messageObject = z.looseObject({
  id: z.string().min(1).optional(),
  from: z.string().min(1).optional(),
  timestamp: providerTimestamp.optional(),
  type: z.string().min(1).optional(),
  text: z.looseObject({ body: z.string().optional() }).optional(),
  image: mediaObject.optional(),
  video: mediaObject.optional(),
  audio: mediaObject.optional(),
  document: mediaObject.optional(),
  sticker: mediaObject.optional(),
  /** A reply: `context.id` is the message being replied to. */
  context: z
    .looseObject({
      id: z.string().optional(),
      from: z.string().optional(),
      /** Present when the inbound event describes a message the business itself sent (coexistence echo). */
      forwarded: z.boolean().optional(),
    })
    .optional(),
  /** Interactive replies, which arrive as their own type rather than as text. */
  button: z.looseObject({ text: z.string().optional(), payload: z.string().optional() }).optional(),
  interactive: z
    .looseObject({
      type: z.string().optional(),
      button_reply: z.looseObject({ id: z.string().optional(), title: z.string().optional() }).optional(),
      list_reply: z.looseObject({ id: z.string().optional(), title: z.string().optional() }).optional(),
    })
    .optional(),
  reaction: z.looseObject({ message_id: z.string().optional(), emoji: z.string().optional() }).optional(),
  /** Present on an unsupported inbound type; the message itself cannot be rendered. */
  errors: z.array(z.looseObject({ code: z.number().optional(), title: z.string().optional(), message: z.string().optional() })).optional(),
});

const statusObject = z.looseObject({
  id: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
  timestamp: providerTimestamp.optional(),
  recipient_id: z.string().optional(),
  errors: z
    .array(
      z.looseObject({
        code: z.number().optional(),
        title: z.string().optional(),
        message: z.string().optional(),
        error_data: z.looseObject({ details: z.string().optional() }).optional(),
      }),
    )
    .optional(),
});

const changeValue = z.looseObject({
  messaging_product: z.string().optional(),
  metadata: z
    .looseObject({
      display_phone_number: z.string().optional(),
      /** The sending asset this event belongs to. Compared against the binding, never trusted as scope. */
      phone_number_id: z.string().optional(),
    })
    .optional(),
  contacts: z.array(z.looseObject({ wa_id: z.string().optional(), profile: z.looseObject({ name: z.string().optional() }).optional() })).optional(),
  messages: z.array(messageObject).optional(),
  statuses: z.array(statusObject).optional(),
});

export const whatsAppWebhookSchema = z.looseObject({
  object: z.string().optional(),
  entry: z
    .array(
      z.looseObject({
        /** The WABA this event belongs to. */
        id: z.string().optional(),
        changes: z.array(z.looseObject({ field: z.string().optional(), value: changeValue.optional() })).optional(),
      }),
    )
    .optional(),
});

export type WhatsAppWebhook = z.output<typeof whatsAppWebhookSchema>;
export type WhatsAppChangeValue = z.output<typeof changeValue>;
export type WhatsAppMessage = z.output<typeof messageObject>;
export type WhatsAppStatus = z.output<typeof statusObject>;

/**
 * `undefined` for a body that is not a webhook this adapter can read at all.
 *
 * A parse failure is not an error to throw: the route has already verified the signature, so this is Meta
 * sending something new. The caller records it and returns no events, which is the "auditable and fail
 * safe" the spec asks for.
 */
export function parseWebhook(rawBody: Uint8Array): WhatsAppWebhook | undefined {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(rawBody).toString("utf8"));
  } catch {
    return undefined;
  }
  const parsed = whatsAppWebhookSchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Provider seconds to a `Date`, or `undefined` when the field is not a timestamp.
 *
 * Returning `undefined` rather than `new Date(NaN)` matters: an event with an unreadable timestamp must not
 * be ordered against real ones, and `Invalid Date` compares false against everything while still looking
 * like a date.
 */
export function providerTime(value: string | undefined): Date | undefined {
  if (value === undefined || !/^\d{1,13}$/.test(value)) {
    return undefined;
  }
  const seconds = Number.parseInt(value, 10);
  const time = new Date(seconds * 1000);
  return Number.isNaN(time.getTime()) ? undefined : time;
}
