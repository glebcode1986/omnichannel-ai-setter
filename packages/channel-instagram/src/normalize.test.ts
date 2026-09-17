import { describe, expect, it } from "vitest";

import { createInstagramAdapter } from "./adapter";
import {
  AT_MS,
  BINDING,
  CUSTOMER_ID,
  echo,
  envelope,
  inboundText,
  postback,
  reaction,
  readReceipt,
  signedWebhook,
  testConfig,
} from "./__fixtures__/payloads";

const normalize = (body: unknown) => createInstagramAdapter(testConfig()).normalizeWebhook(signedWebhook(body));

describe("inbound normalization", () => {
  it("maps an inbound text message and stamps the scope from the binding, not the payload", async () => {
    const [event, ...rest] = await normalize(envelope(inboundText()));

    expect(rest).toHaveLength(0);
    expect(event).toEqual({
      type: "INBOUND_MESSAGE",
      workspaceId: BINDING.workspaceId,
      businessProfileId: BINDING.businessProfileId,
      channel: "INSTAGRAM",
      channelAccountId: BINDING.channelAccountId,
      sourceEventId: "msg:mid.inbound-1",
      occurredAt: new Date(AT_MS),
      senderExternalId: CUSTOMER_ID,
      externalMessageId: "mid.inbound-1",
      messageKind: "TEXT",
      text: "Are you open on Saturday?",
      media: [],
    });
  });

  it("keeps Instagram millisecond timestamps exact and skips items whose timestamp is unusable", async () => {
    const [event] = await normalize(envelope(inboundText()));
    const skipped = await normalize(
      envelope({ ...inboundText(), timestamp: undefined }, { ...inboundText(), timestamp: Number.NaN }),
    );

    expect(event?.occurredAt.getTime()).toBe(AT_MS);
    expect(skipped).toEqual([]);
  });

  it("carries a reply reference and derives the message kind from attachments", async () => {
    const [reply] = await normalize(envelope(inboundText({ reply_to: { mid: "mid.previous" } })));
    const [image] = await normalize(
      envelope(inboundText({ text: undefined, attachments: [{ type: "image", payload: { url: "https://example.test/i.jpg" } }] })),
    );
    const [document] = await normalize(envelope(inboundText({ text: undefined, attachments: [{ type: "file", payload: {} }] })));

    expect(reply).toMatchObject({ replyToExternalMessageId: "mid.previous" });
    expect(image).toMatchObject({ messageKind: "IMAGE", media: [{ kind: "IMAGE" }] });
    expect(document).toMatchObject({ messageKind: "DOCUMENT", media: [{ kind: "DOCUMENT" }] });
    // Provider URLs are not copied into the normalized event.
    expect(JSON.stringify(image)).not.toContain("example.test");
  });

  it("represents media it cannot interpret as UNKNOWN without inventing content", async () => {
    const unsupported = await normalize(envelope(inboundText({ text: undefined, is_unsupported: true })));
    const sticker = await normalize(envelope(inboundText({ text: undefined, attachments: [{ type: "sticker", payload: {} }] })));
    const storyMention = await normalize(envelope(inboundText({ text: undefined, attachments: [{ type: "story_mention", payload: {} }] })));

    for (const [event] of [unsupported, sticker, storyMention]) {
      expect(event).toMatchObject({ messageKind: "UNKNOWN", media: [] });
      expect(event).not.toHaveProperty("text");
    }
  });

  it("keeps a caption but still reports UNKNOWN when Meta flags the media as unsupported", async () => {
    const [withCaption] = await normalize(envelope(inboundText({ is_unsupported: true })));
    const [withAttachment] = await normalize(
      envelope(inboundText({ text: undefined, is_unsupported: true, attachments: [{ type: "image", payload: {} }] })),
    );

    // The caption is real text, but the message also contains something we cannot see, so it is not TEXT.
    expect(withCaption).toMatchObject({ messageKind: "UNKNOWN", text: "Are you open on Saturday?", media: [] });
    expect(withAttachment).toMatchObject({ messageKind: "UNKNOWN", media: [] });
  });

  it("drops deleted messages, which the normalized contract cannot express", async () => {
    expect(await normalize(envelope(inboundText({ is_deleted: true })))).toEqual([]);
  });
});

describe("echoes, statuses and interactions", () => {
  it("reports an echo with the customer as recipient and no classification of its own", async () => {
    const [event] = await normalize(envelope(echo()));

    expect(event).toEqual({
      type: "OUTBOUND_ECHO",
      workspaceId: BINDING.workspaceId,
      businessProfileId: BINDING.businessProfileId,
      channel: "INSTAGRAM",
      channelAccountId: BINDING.channelAccountId,
      sourceEventId: "echo:mid.echo-1",
      occurredAt: new Date(AT_MS),
      platformMessageId: "mid.echo-1",
      recipientExternalId: CUSTOMER_ID,
      messageKind: "TEXT",
      text: "We open at 10.",
    });
    // Instagram echoes carry no app_id, so ADR-013 correlation by message ID is the only signal.
    expect(event).not.toHaveProperty("sendingApplicationId");
  });

  it("produces identical output for our own send and a human's manual reply", async () => {
    const [ours] = await normalize(envelope(echo({ mid: "mid.same", text: "Same words." })));
    const [theirs] = await normalize(envelope(echo({ mid: "mid.same", text: "Same words." })));

    expect(ours).toEqual(theirs);
  });

  it("maps read receipts, reactions and postbacks, and never emits a delivery status", async () => {
    const events = await normalize(envelope(readReceipt(), reaction("react"), reaction("unreact", AT_MS + 1_000), postback()));

    expect(events.map((event) => event.type)).toEqual(["READ_STATUS", "REACTION", "REACTION", "POSTBACK"]);
    expect(events[0]).toMatchObject({ readerExternalId: CUSTOMER_ID, platformMessageId: "mid.inbound-1" });
    expect(events[1]).toMatchObject({ action: "REACT", reaction: "❤️", reactorExternalId: CUSTOMER_ID });
    expect(events[2]).toMatchObject({ action: "UNREACT" });
    expect(events[3]).toMatchObject({ payload: "BOOK_NOW", title: "Book now", relatedMessageId: "mid.postback-1" });
    // Instagram has no delivery webhook at all (message_deliveries is Messenger-only).
    expect(events.some((event) => event.type === "DELIVERY_STATUS")).toBe(false);
  });
});

describe("batching, determinism and foreign accounts", () => {
  it("gives every event type on one message ID its own deterministic source event ID", async () => {
    const events = await normalize(envelope(inboundText(), echo({ mid: "mid.inbound-1" }), readReceipt(), reaction("react")));
    const ids = events.map((event) => event.sourceEventId);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      "msg:mid.inbound-1",
      `echo:mid.inbound-1`,
      `read:${CUSTOMER_ID}:mid.inbound-1`,
      `reaction:mid.inbound-1:REACT:${String(AT_MS)}`,
    ]);
  });

  it("is deterministic across redeliveries and independent of the receive time", async () => {
    const body = envelope(inboundText(), reaction("react"));
    const first = await normalize(body);
    const later = await createInstagramAdapter(testConfig()).normalizeWebhook({
      ...signedWebhook(body),
      receivedAt: new Date(AT_MS + 900_000),
    });

    expect(later).toEqual(first);
  });

  it("skips unknown items instead of failing the batch, and refuses only a body that is not an envelope", async () => {
    const mixed = await normalize(envelope({ sender: { id: CUSTOMER_ID }, timestamp: AT_MS, message_edit: { mid: "m", text: "t" } }, inboundText()));

    expect(mixed.map((event) => event.type)).toEqual(["INBOUND_MESSAGE"]);
    await expect(normalize({ object: "page", entry: [] })).rejects.toThrow(/Instagram webhook/);
    await expect(normalize("not json")).rejects.toThrow(/Instagram webhook/);
  });

  it("ignores entries for another Instagram account", async () => {
    const foreign = { object: "instagram", entry: [{ id: "17841400000000999", time: AT_MS, messaging: [inboundText()] }] };
    const mixed = {
      object: "instagram",
      entry: [
        { id: "17841400000000999", time: AT_MS, messaging: [inboundText()] },
        { id: BINDING.externalAccountId, time: AT_MS, messaging: [inboundText()] },
      ],
    };

    expect(await normalize(foreign)).toEqual([]);
    expect(await normalize(mixed)).toHaveLength(1);
  });
});

describe("scope safety", () => {
  it("refuses an entry that does not name the bound account, including one with no id at all", async () => {
    const anonymous = { object: "instagram", entry: [{ time: AT_MS, messaging: [inboundText()] }] };

    // An entry that names no account is not evidence that it is ours; the binding is the only authority.
    expect(await normalize(anonymous)).toEqual([]);
  });

  it("never turns our own account into a customer", async () => {
    const selfTest = await normalize(envelope({ ...inboundText(), message: { mid: "mid.self", text: "test", is_self: true } }));
    const fromUs = await normalize(
      envelope({
        sender: { id: BINDING.externalAccountId },
        recipient: { id: BINDING.externalAccountId },
        timestamp: AT_MS,
        message: { mid: "mid.loop", text: "test" },
      }),
    );

    expect(selfTest).toEqual([]);
    expect(fromUs).toEqual([]);
  });

  it("drops only the offending event when one item cannot satisfy the contract", async () => {
    // An empty sender id cannot be a scope identifier, so this event is unrepresentable — but the good
    // message in the same delivery must still be ingested, or Meta redelivers the batch for 36 hours.
    const mixed = await normalize(envelope({ ...inboundText(), sender: { id: "" } }, inboundText({ mid: "mid.good" })));

    expect(mixed.map((event) => event.sourceEventId)).toEqual(["msg:mid.good"]);
  });

  it("keeps long postbacks distinct instead of truncating away what makes them unique", async () => {
    const longPayload = (suffix: string) => ({
      sender: { id: CUSTOMER_ID },
      recipient: { id: BINDING.externalAccountId },
      timestamp: AT_MS,
      postback: { title: "t", payload: `${"x".repeat(600)}${suffix}` },
    });
    const events = await normalize(envelope(longPayload("a"), longPayload("b")));

    expect(events).toHaveLength(2);
    expect(events[0]?.sourceEventId).not.toBe(events[1]?.sourceEventId);
    for (const event of events) {
      expect(event.sourceEventId.length).toBeLessThanOrEqual(512);
      expect(event.sourceEventId.startsWith("postback:")).toBe(true);
    }
  });
});
