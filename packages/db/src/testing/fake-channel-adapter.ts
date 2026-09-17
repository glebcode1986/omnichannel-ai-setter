/**
 * Deterministic fake ChannelAdapter for ingestion tests (P1-05). It is a test mechanism, not a channel
 * implementation: its "provider" payload is a compact fixture format, and nothing provider-specific leaves
 * `normalizeWebhook`.
 */
import type { WebhookAccount } from "@omnichannel/application";
import type { ChannelAdapter, NormalizedChannelEvent, RawWebhook } from "@omnichannel/channel-core";
import { NO_CAPABILITIES } from "@omnichannel/domain";

export const FAKE_SIGNATURE_HEADER = "x-fake-signature";
export const FAKE_VALID_SIGNATURE = "fake-valid-signature";
export const FAKE_VERIFY_TOKEN = "fake-verify-token";

interface FixtureBase {
  /** Provider event ID (becomes sourceEventId). */
  readonly id: string;
  readonly at: string;
  /** Overrides the bound account's workspace, to simulate an adapter emitting foreign events. */
  readonly workspaceId?: string;
}

export type FakeEventFixture =
  | (FixtureBase & { readonly kind: "text"; readonly from: string; readonly mid?: string; readonly text: string; readonly name?: string })
  | (FixtureBase & { readonly kind: "echo"; readonly to: string; readonly mid: string; readonly text?: string })
  | (FixtureBase & { readonly kind: "delivered" | "failed"; readonly mid: string })
  | (FixtureBase & { readonly kind: "read"; readonly mid: string; readonly reader: string })
  | (FixtureBase & { readonly kind: "reaction"; readonly mid: string; readonly from: string })
  | (FixtureBase & { readonly kind: "unknown" });

export function createFakeChannelAdapter(account: WebhookAccount): ChannelAdapter {
  return {
    channel: account.channel,

    verifyWebhook(input) {
      if (input.method === "GET") {
        const challenge = input.query["hub.challenge"];
        return Promise.resolve(
          input.query["hub.verify_token"] === FAKE_VERIFY_TOKEN && challenge !== undefined
            ? { status: "CHALLENGE", responseBody: challenge }
            : { status: "REJECTED", reason: "invalid verify token" },
        );
      }
      return Promise.resolve(
        input.headers[FAKE_SIGNATURE_HEADER] === FAKE_VALID_SIGNATURE
          ? { status: "VERIFIED" }
          : { status: "REJECTED", reason: "invalid signature" },
      );
    },

    normalizeWebhook(input) {
      const body = JSON.parse(new TextDecoder().decode(input.rawBody)) as { events?: FakeEventFixture[] };
      if (!Array.isArray(body.events)) {
        return Promise.reject(new Error("fixture body must contain an events array"));
      }
      return Promise.resolve(body.events.map((fixture) => normalize(account, fixture)));
    },

    getCapabilities() {
      return Promise.resolve({ ...NO_CAPABILITIES, text: true });
    },

    evaluateWindow() {
      return Promise.resolve({ state: "UNKNOWN", reason: "fake adapter" });
    },

    send() {
      return Promise.resolve({ outcome: "REJECTED", retryable: false, code: "FAKE", message: "the fake adapter never sends" });
    },
  };
}

function normalize(account: WebhookAccount, fixture: FakeEventFixture): NormalizedChannelEvent {
  const base = {
    workspaceId: fixture.workspaceId ?? account.workspaceId,
    channel: account.channel,
    channelAccountId: account.channelAccountId,
    sourceEventId: fixture.id,
    occurredAt: new Date(fixture.at),
  };
  switch (fixture.kind) {
    case "text":
      return {
        ...base,
        type: "INBOUND_MESSAGE",
        senderExternalId: fixture.from,
        senderDisplayName: fixture.name,
        externalMessageId: fixture.mid,
        messageKind: "TEXT",
        text: fixture.text,
        media: [],
      };
    case "echo":
      return {
        ...base,
        type: "OUTBOUND_ECHO",
        platformMessageId: fixture.mid,
        recipientExternalId: fixture.to,
        messageKind: "TEXT",
        text: fixture.text,
      };
    case "delivered":
    case "failed":
      return {
        ...base,
        type: "DELIVERY_STATUS",
        platformMessageId: fixture.mid,
        status: fixture.kind === "delivered" ? "DELIVERED" : "FAILED",
      };
    case "read":
      return { ...base, type: "READ_STATUS", platformMessageId: fixture.mid, readerExternalId: fixture.reader };
    case "reaction":
      return { ...base, type: "REACTION", platformMessageId: fixture.mid, reactorExternalId: fixture.from, action: "REACT", reaction: "like" };
    case "unknown":
      // A variant the contract does not know; ingestion must audit and skip it.
      return { ...base, type: "TYPING" } as unknown as NormalizedChannelEvent;
  }
}

export function fakeWebhook(
  events: readonly FakeEventFixture[],
  options: { readonly signature?: string; readonly body?: string } = {},
): RawWebhook {
  return {
    method: "POST",
    headers: { [FAKE_SIGNATURE_HEADER]: options.signature ?? FAKE_VALID_SIGNATURE },
    query: {},
    rawBody: new TextEncoder().encode(options.body ?? JSON.stringify({ events })),
    receivedAt: new Date(),
  };
}
