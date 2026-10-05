/**
 * Provider payload to normalized events (#18).
 *
 * The cases worth having are the ones where a reasonable adapter does the wrong thing: a caption dropped
 * because it is not `text.body`, a redelivery that looks new because the dedupe key borrowed the clock, a
 * `sent` discarded because a `delivered` arrived first, a webhook for another business normalized into this
 * one's conversation. Each of those is a sentence a customer would notice, so each gets a test.
 */
import { describe, expect, it } from "vitest";

import { resolveConfig } from "./config";
import { normalizeWhatsAppWebhook } from "./normalize";
import {
  AT,
  BINDING,
  BUSINESS_DISPLAY_NUMBER,
  CUSTOMER_NAME,
  CUSTOMER_WA_ID,
  config,
  envelope,
  inboundMedia,
  inboundText,
  seconds,
  signedWebhook,
  statusEvent,
} from "./__fixtures__/payloads";

const resolved = resolveConfig(config());
const normalize = (body: unknown) => normalizeWhatsAppWebhook(signedWebhook(body), resolved);

describe("an inbound text message", () => {
  it("normalizes with the scope from the binding, not from the payload", () => {
    const [event] = normalize(inboundText());

    expect(event).toMatchObject({
      type: "INBOUND_MESSAGE",
      workspaceId: BINDING.workspaceId,
      businessProfileId: BINDING.businessProfileId,
      channel: "WHATSAPP",
      channelAccountId: BINDING.channelAccountId,
      senderExternalId: CUSTOMER_WA_ID,
      senderDisplayName: CUSTOMER_NAME,
      externalMessageId: "wamid.inbound1",
      messageKind: "TEXT",
      text: "Are you open on Saturday?",
      occurredAt: AT,
    });
  });

  it("gives the same event identity to a redelivery of the same bytes", () => {
    // Meta retries deliveries and tells receivers to deduplicate. The key is built from payload fields
    // only, so a redelivery an hour later must produce the identical `sourceEventId`.
    const first = normalize(inboundText())[0];
    const second = normalize(inboundText())[0];

    expect(first?.sourceEventId).toBe(second?.sourceEventId);
    expect(first?.sourceEventId).toContain("wamid.inbound1");
  });

  it("keeps the reply it answers", () => {
    const [event] = normalize(inboundText({ contextId: "wamid.ourEarlierReply" }));

    expect(event).toMatchObject({ replyToExternalMessageId: "wamid.ourEarlierReply" });
  });

  it("drops a message with no id or no timestamp rather than inventing either", () => {
    // Without an ID there is no dedupe key; without a timestamp there is no place in the thread. A
    // half-usable event is worse than none, because it looks complete.
    const noId = envelope({ messages: [{ from: CUSTOMER_WA_ID, timestamp: seconds(AT), type: "text", text: { body: "hi" } }] });
    const noTime = envelope({ messages: [{ from: CUSTOMER_WA_ID, id: "wamid.x", type: "text", text: { body: "hi" } }] });
    const badTime = envelope({ messages: [{ from: CUSTOMER_WA_ID, id: "wamid.x", timestamp: "not-a-time", type: "text", text: { body: "hi" } }] });

    expect(normalize(noId)).toEqual([]);
    expect(normalize(noTime)).toEqual([]);
    expect(normalize(badTime)).toEqual([]);
  });
});

describe("inbound media", () => {
  it("normalizes a voice note as AUDIO with its media reference", () => {
    // Download and transcription are application services; the adapter's job is to say what arrived and
    // where it can be fetched from.
    const [event] = normalize(inboundMedia("audio", { voice: true }));

    expect(event).toMatchObject({
      messageKind: "AUDIO",
      media: [{ kind: "AUDIO", providerMediaId: "media-audio-1", mimeType: "audio/ogg; codecs=opus" }],
    });
  });

  it("reads a caption as the customer's words", () => {
    // A photo of a receipt captioned "is this the right one?" is a question. Reading only `text.body`
    // would hand the draft engine an image with nothing to answer.
    const [event] = normalize(inboundMedia("image", { caption: "is this the right one?" }));

    expect(event).toMatchObject({ messageKind: "IMAGE", text: "is this the right one?" });
    expect(event).toMatchObject({ media: [{ kind: "IMAGE", caption: "is this the right one?" }] });
  });

  it("normalizes each media type the platform sends", () => {
    for (const [type, kind] of [
      ["image", "IMAGE"],
      ["video", "VIDEO"],
      ["audio", "AUDIO"],
      ["document", "DOCUMENT"],
      // A sticker is an image to everything downstream; calling it UNKNOWN would hide a real message.
      ["sticker", "IMAGE"],
    ] as const) {
      const [event] = normalize(inboundMedia(type));
      expect(event).toMatchObject({ messageKind: kind, media: [{ kind }] });
    }
  });

  it("reports a type it cannot render as UNKNOWN, with no invented text", () => {
    const unsupported = envelope({
      contacts: [{ wa_id: CUSTOMER_WA_ID }],
      messages: [
        {
          from: CUSTOMER_WA_ID,
          id: "wamid.location1",
          timestamp: seconds(AT),
          type: "location",
          location: { latitude: 1, longitude: 2 },
        },
      ],
    });

    const [event] = normalize(unsupported);

    expect(event).toMatchObject({ type: "INBOUND_MESSAGE", messageKind: "UNKNOWN", media: [] });
    expect(event).not.toHaveProperty("text");
  });

  it("treats a button or list reply as INTERACTIVE, carrying its title as the text", () => {
    const button = envelope({
      contacts: [{ wa_id: CUSTOMER_WA_ID }],
      messages: [
        {
          from: CUSTOMER_WA_ID,
          id: "wamid.button1",
          timestamp: seconds(AT),
          type: "interactive",
          interactive: { type: "button_reply", button_reply: { id: "yes", title: "Yes, Saturday" } },
        },
      ],
    });

    // INTERACTIVE rather than TEXT on purpose: a tap on an option the business offered is a different
    // situation from the same words typed freely, and a draft engine should be able to tell.
    expect(normalize(button)[0]).toMatchObject({ messageKind: "INTERACTIVE", text: "Yes, Saturday" });
  });
});

describe("status events", () => {
  it("normalizes sent, delivered and failed by platform message id", () => {
    for (const [provider, status] of [
      ["sent", "SENT"],
      ["delivered", "DELIVERED"],
      ["failed", "FAILED"],
    ] as const) {
      const [event] = normalize(statusEvent(provider));
      expect(event).toMatchObject({ type: "DELIVERY_STATUS", platformMessageId: "wamid.outbound1", status });
    }
  });

  it("normalizes a read receipt as its own event", () => {
    const [event] = normalize(statusEvent("read"));

    expect(event).toMatchObject({ type: "READ_STATUS", platformMessageId: "wamid.outbound1", readerExternalId: CUSTOMER_WA_ID });
  });

  it("gives each state its own identity, so one message's statuses cannot deduplicate onto each other", () => {
    // One `wamid` produces sent, delivered and read. A bare-`wamid` key would let the first arrival
    // silence the rest, and the Inbox would never leave "sent".
    const ids = (["sent", "delivered", "read"] as const).map((state) => normalize(statusEvent(state))[0]?.sourceEventId);

    expect(new Set(ids).size).toBe(3);
  });

  it("does not reorder or discard statuses that arrive out of order", () => {
    // Arrival order is explicitly not chronological on this platform. Each event carries the provider's
    // own timestamp and the application decides precedence; an adapter that dropped the late `sent` would
    // be deciding with less information than the application has.
    const later = new Date(AT.getTime() + 60_000);
    const delivered = normalize(statusEvent("delivered", { at: later }))[0];
    const sent = normalize(statusEvent("sent", { at: AT }))[0];

    expect(delivered).toMatchObject({ status: "DELIVERED", occurredAt: later });
    expect(sent).toMatchObject({ status: "SENT", occurredAt: AT });
  });

  it("keeps the provider's error code on a failure, and not its prose", () => {
    const [event] = normalize(statusEvent("failed", { errorCode: 131026 }));

    expect(event).toMatchObject({ status: "FAILED", error: { code: "131026" } });
    // The provider's `message` field can quote the customer's own text; the title is the safe half.
    expect(JSON.stringify((event as { error?: { message?: string } }).error)).not.toContain("could not be reached");
  });

  it("records a status it does not model rather than mapping it onto one it is not", () => {
    expect(normalize(statusEvent("deleted"))).toEqual([]);
  });
});

describe("what must never be normalized into this account", () => {
  it("refuses an event for another WABA", () => {
    expect(normalizeWhatsAppWebhook(signedWebhook(envelope({ messages: [] }, { wabaId: "999999" })), resolved)).toEqual([]);
  });

  it("refuses an event for another phone number asset", () => {
    const foreign = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: BINDING.wabaId,
          changes: [
            {
              field: "messages",
              value: {
                metadata: { display_phone_number: "+15559999999", phone_number_id: "999999999999999" },
                contacts: [{ wa_id: CUSTOMER_WA_ID }],
                messages: [{ from: CUSTOMER_WA_ID, id: "wamid.foreign", timestamp: seconds(AT), type: "text", text: { body: "hi" } }],
              },
            },
          ],
        },
      ],
    };

    expect(normalize(foreign)).toEqual([]);
  });

  it("returns nothing for a body it cannot read, rather than throwing", () => {
    // The signature already passed, so this is Meta sending something new. Auditable and fail safe.
    expect(normalizeWhatsAppWebhook(signedWebhook("{not json"), resolved)).toEqual([]);
    expect(normalize({ object: "whatsapp_business_account" })).toEqual([]);
  });

  it("ignores a change on a field this adapter does not handle", () => {
    expect(normalize(envelope({ messages: [] }, { field: "message_template_status_update" }))).toEqual([]);
  });
});

/**
 * Coexistence: what the business sends from the WhatsApp Business App (#23).
 *
 * Meta publishes these on their own webhook field, `smb_message_echoes`, and nowhere else — the `messages`
 * field carries customer-to-business traffic only. The adapter reports an echo and stops there: whether it
 * means a person took the conversation over is the application's decision, made by correlating the message
 * id against this product's own sends (ADR-013), and it has to be, because no field in the payload can
 * answer it.
 */
describe("a message the business sent from its own app", () => {
  const nativeSend = (overrides: Readonly<Record<string, unknown>> = {}) =>
    envelope(
      {
        message_echoes: [
          {
            from: BUSINESS_DISPLAY_NUMBER,
            to: CUSTOMER_WA_ID,
            id: "wamid.nativeSend1",
            timestamp: seconds(AT),
            type: "text",
            text: { body: "Yes, from 10 until 6." },
            ...overrides,
          },
        ],
      },
      { field: "smb_message_echoes" },
    );

  it("normalizes it as an echo, naming the customer it went to", () => {
    const [event] = normalize(nativeSend());

    expect(event).toMatchObject({
      type: "OUTBOUND_ECHO",
      platformMessageId: "wamid.nativeSend1",
      // From the echo itself. The `contacts` array is not populated on this field, and reading the
      // recipient from there is how the previous implementation produced an event with an empty
      // recipient that the contract then rejected — a native send silently lost rather than a takeover.
      recipientExternalId: CUSTOMER_WA_ID,
      text: "Yes, from 10 until 6.",
      occurredAt: AT,
    });
  });

  it("carries no claim about who sent it", () => {
    const [event] = normalize(nativeSend());

    // Meta publishes no device, operator or origin field: a send by the owner on the phone and one by
    // staff on a linked laptop are indistinguishable, and so is one this product made itself. The event
    // therefore says what happened and not who did it.
    expect(event).not.toHaveProperty("senderExternalId");
    expect(Object.keys(event ?? {})).not.toContain("sendingApplicationId");
  });

  it("drops an echo with no recipient rather than emitting one the contract refuses", () => {
    // `recipientExternalId` is a non-empty identifier in the shared schema, so an event with `""` is
    // counted as rejected during ingestion and never reaches the takeover path — while the webhook still
    // answers 200, so the provider never sends it again.
    expect(normalize(nativeSend({ to: undefined }))).toEqual([]);
  });

  it("drops an echo with no id, because there is nothing to correlate against our own sends", () => {
    expect(normalize(nativeSend({ id: undefined }))).toEqual([]);
  });

  it("drops an echo with no timestamp, because a takeover is measured from an instant", () => {
    expect(normalize(nativeSend({ timestamp: undefined }))).toEqual([]);
  });

  it("refuses a `messages` entry that claims to come from the business itself", () => {
    // The provider's contract says this cannot happen on that field. It used to be read as an echo, which
    // never fired on a real native send and, when the two differently formatted numbers failed to match,
    // turned the business's own message into a customer message and started a reply cycle answering
    // ourselves. Refusing costs nothing now that the real echo has a field of its own.
    const impossible = envelope({
      contacts: [{ wa_id: CUSTOMER_WA_ID }],
      messages: [{ from: BUSINESS_DISPLAY_NUMBER, id: "wamid.impossible", timestamp: seconds(AT), type: "text", text: { body: "hello" } }],
    });

    expect(normalize(impossible)).toEqual([]);
  });

  it("still reads ordinary customer messages on the same payload", () => {
    const mixed = envelope({
      contacts: [{ wa_id: CUSTOMER_WA_ID }],
      messages: [{ from: CUSTOMER_WA_ID, id: "wamid.fromCustomer", timestamp: seconds(AT), type: "text", text: { body: "Are you open?" } }],
    });

    expect(normalize(mixed)).toMatchObject([{ type: "INBOUND_MESSAGE", senderExternalId: CUSTOMER_WA_ID }]);
  });
});
