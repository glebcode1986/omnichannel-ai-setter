/**
 * The presence effect on the wire (#22, P4-05).
 *
 * Two questions a unit test cannot answer: whether the request Meta receives is the documented one, and
 * whether a number that is no longer connected is refused before its credential is even read. Everything
 * the call is bound to is re-read per announcement, so the account row is changed between calls here and
 * the wire is asserted against it.
 */
import {
  authorizeBusinessProfileAccess,
  authorizeWorkspaceAccess,
  createBusinessProfile,
  createChannelAccount,
  createCredentialCipher,
  createWorkspaceWithOwner,
  writeChannelCredential,
} from "@omnichannel/db";
import { NO_CAPABILITIES } from "@omnichannel/domain";
import type { WhatsAppHttpPort, WhatsAppHttpResult } from "@omnichannel/channel-whatsapp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createWhatsAppPresenceAnnouncer } from "./whatsapp-presence";
import { createEndToEndInfrastructure, endToEndTestsEnabled, type EndToEndInfrastructure } from "./testing/infrastructure";

const NOW = new Date("2026-10-05T12:00:00.000Z");
/**
 * Anchored to the real clock, not to this file's frozen instant.
 *
 * `channel_credentials` stamps `created_at` itself and `channel_credentials_lifetime_check` requires the
 * expiry to come after it. An expiry computed from a fixed date therefore holds only until the real clock
 * passes it, and then every case here fails because of the date rather than because of a change — which is
 * exactly how PR #90 sat red for five days. The frozen instant stays frozen for everything the database
 * does not constrain; this value cannot be one of them.
 */
const CREDENTIAL_EXPIRES = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
const PHONE_NUMBER_ID = "wa-phone-presence-wire";
const WABA_ID = "wa-messaging-account-presence";
const WAMID = "wamid.HBgLMTY1MDM4Nzk0MzkVAgARGBJDQjZCMzlEQUE4OTJBMTE4RTUA";
/** Fake, and distinctive, so a log line or a URL carrying it would be unmistakable. */
const TOKEN = "EAAwa-presence-token-canary-3b71e9";
const CIPHER_KEY_ID = "test-key";
const CIPHER = createCredentialCipher({ keyId: CIPHER_KEY_ID, keys: { [CIPHER_KEY_ID]: Buffer.alloc(32, 5) } });

const success = (): WhatsAppHttpResult => ({ kind: "RESPONSE", status: 200, body: JSON.stringify({ success: true }) });

describe.skipIf(!endToEndTestsEnabled())("the worker's WhatsApp presence announcer", () => {
  let infra: EndToEndInfrastructure;
  let scope: { workspaceId: string; businessProfileId: string };
  let channelAccountId: string;

  beforeAll(async () => {
    infra = await createEndToEndInfrastructure();
    const user = await infra.db.user.create({ data: { name: "Wire Owner", email: "presence-wire@example.test" } });
    const { workspaceId } = await createWorkspaceWithOwner(infra.db, { name: "Wire Workspace", ownerUserId: user.id });
    const workspace = await authorizeWorkspaceAccess(infra.db, { userId: user.id, workspaceId });
    const { businessProfileId } = await createBusinessProfile(infra.db, workspace, { name: "Wire Profile" });
    const context = await authorizeBusinessProfileAccess(infra.db, { userId: user.id, workspaceId, businessProfileId });
    scope = { workspaceId, businessProfileId };

    const account = await createChannelAccount(infra.db, context, {
      channel: "WHATSAPP",
      externalAccountId: PHONE_NUMBER_ID,
      capabilities: { ...NO_CAPABILITIES, text: true, readReceipts: true, typingIndicator: true },
    });
    channelAccountId = account.id;
    await infra.db.whatsAppConnection.create({
      data: { ...scope, channelAccountId, wabaId: WABA_ID, connectedAt: NOW, phoneRegisteredAt: NOW, webhookSubscribedAt: NOW, onboardingMode: "NEW_OR_MIGRATED_CLOUD_NUMBER" },
    });
    const { credentialId } = await writeChannelCredential(infra.db, CIPHER, {
      workspaceId,
      purpose: "WHATSAPP_BUSINESS_TOKEN",
      token: TOKEN,
      expiresAt: CREDENTIAL_EXPIRES,
    });
    await infra.db.channelAccount.update({ where: { id: channelAccountId }, data: { credentialId, status: "CONNECTED" } });
  }, 180_000);

  afterAll(async () => {
    await infra?.dispose();
  });

  beforeEach(() => {
    infra.logs.length = 0;
  });

  function announcer(results: readonly WhatsAppHttpResult[]) {
    const requests: Parameters<WhatsAppHttpPort["send"]>[0][] = [];
    let index = 0;
    const http: WhatsAppHttpPort = {
      send(request) {
        requests.push(request);
        return Promise.resolve(results[Math.min(index++, results.length - 1)] ?? { kind: "NO_RESPONSE", reason: "NETWORK", message: "script exhausted" });
      },
    };
    return { requests, port: createWhatsAppPresenceAnnouncer({ db: infra.db, cipher: CIPHER, graphVersion: "v26.0", http, logger: infra.logger }) };
  }

  const target = (overrides: Partial<{ workspaceId: string; typing: boolean }> = {}) => ({
    ...scope,
    channelAccountId,
    inboundProviderMessageId: WAMID,
    typing: true,
    ...overrides,
  });

  it("sends the documented read-and-typing payload, and nothing else", async () => {
    const { port, requests } = announcer([success()]);

    expect(await port.announce(target())).toBe(true);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.url).toContain(`/v26.0/${PHONE_NUMBER_ID}/messages`);
    // The read status is not optional when the indicator is asked for: Meta documents one payload and it
    // carries both as required fields. There is no typing-only request to send.
    expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({
      messaging_product: "whatsapp",
      status: "read",
      message_id: WAMID,
      typing_indicator: { type: "text" },
    });
  });

  it("omits the indicator when only a read receipt was asked for", async () => {
    const { port, requests } = announcer([success()]);

    await port.announce(target({ typing: false }));

    expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({ messaging_product: "whatsapp", status: "read", message_id: WAMID });
  });

  it("reports a provider refusal as a refusal rather than throwing", async () => {
    // 131009 is the code Meta documents for an invalid message id on this call. Nothing a caller could do
    // about it is worth changing a reply for, so it returns false and the handler carries on.
    const { port } = announcer([{ kind: "RESPONSE", status: 400, body: JSON.stringify({ error: { code: 131009, message: "Parameter value is not valid" } }) }]);

    await expect(port.announce(target())).resolves.toBe(false);
  });

  it("reports an unreachable provider as a refusal", async () => {
    const { port } = announcer([{ kind: "NO_RESPONSE", reason: "TIMEOUT", message: "timed out" }]);

    await expect(port.announce(target())).resolves.toBe(false);
  });

  it("refuses a number that is no longer connected, before reading its credential", async () => {
    await infra.db.channelAccount.update({ where: { id: channelAccountId }, data: { status: "DISCONNECTED" } });
    const { port, requests } = announcer([success()]);

    const announced = await port.announce(target());
    await infra.db.channelAccount.update({ where: { id: channelAccountId }, data: { status: "CONNECTED" } });

    // A business that removed the integration has not agreed to keep signalling to its customers on its
    // behalf, and the provider's own token would often still allow it.
    expect(announced).toBe(false);
    expect(requests).toEqual([]);
  });

  it("refuses an account that is not this Workspace's", async () => {
    const { port, requests } = announcer([success()]);

    expect(await port.announce(target({ workspaceId: "00000000-0000-7000-8000-000000000000" }))).toBe(false);
    expect(requests).toEqual([]);
  });

  it("never puts the access token anywhere but the authorization header", async () => {
    const { port, requests } = announcer([success()]);

    await port.announce(target());

    expect(requests[0]?.url).not.toContain(TOKEN);
    expect(requests[0]?.body ?? "").not.toContain(TOKEN);
    expect(Object.values(requests[0]?.headers ?? {}).some((value) => value.includes(TOKEN))).toBe(true);
    expect(JSON.stringify(infra.logs)).not.toContain(TOKEN);
  });

  it("keeps the customer's message id out of the log even when the provider refuses", async () => {
    const { port } = announcer([{ kind: "RESPONSE", status: 400, body: JSON.stringify({ error: { code: 131009, message: "Parameter value is not valid" } }) }]);

    await port.announce(target());

    const serialized = JSON.stringify(infra.logs);
    // A wamid is enough to mark that conversation's messages read for the next 30 days.
    expect(serialized).not.toContain(WAMID);
    expect(serialized).not.toContain("Parameter value is not valid");
  });
});
