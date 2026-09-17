import { describe, expect, it } from "vitest";

import { createInstagramAdapter } from "./adapter";
import { APP_SECRET, envelope, inboundText, signedWebhook, subscriptionWebhook, testConfig, VERIFY_TOKEN } from "./__fixtures__/payloads";

const adapter = () => createInstagramAdapter(testConfig());

describe("subscription handshake", () => {
  it("echoes the challenge only for a subscribe with the configured verify token", async () => {
    const challenge = await adapter().verifyWebhook(
      subscriptionWebhook({ "hub.mode": "subscribe", "hub.verify_token": VERIFY_TOKEN, "hub.challenge": "1158201444" }),
    );

    expect(challenge).toEqual({ status: "CHALLENGE", responseBody: "1158201444" });
  });

  it("rejects a wrong, missing or empty token, a missing challenge and a non-subscribe handshake", async () => {
    const queries: Readonly<Record<string, string>>[] = [
      { "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "c" },
      { "hub.mode": "subscribe", "hub.challenge": "c" },
      { "hub.mode": "subscribe", "hub.verify_token": "", "hub.challenge": "c" },
      { "hub.mode": "subscribe", "hub.verify_token": VERIFY_TOKEN },
      { "hub.mode": "unsubscribe", "hub.verify_token": VERIFY_TOKEN, "hub.challenge": "c" },
    ];
    const rejected = await Promise.all(queries.map((query) => adapter().verifyWebhook(subscriptionWebhook(query))));

    for (const result of rejected) {
      expect(result.status).toBe("REJECTED");
      const reason = result.status === "REJECTED" ? result.reason : "";
      expect(reason.length).toBeGreaterThan(0);
      // A reason is sent to logs: it must not echo the token.
      expect(reason).not.toContain(VERIFY_TOKEN);
    }
  });
});

describe("payload signature", () => {
  const body = envelope(inboundText());

  it("verifies a payload signed with the app secret, including multi-byte text", async () => {
    const unicode = envelope(inboundText({ text: "Здравствуйте 👋 открыто?" }));

    expect(await adapter().verifyWebhook(signedWebhook(body))).toEqual({ status: "VERIFIED" });
    expect(await adapter().verifyWebhook(signedWebhook(unicode))).toEqual({ status: "VERIFIED" });
  });

  it("rejects a tampered body, a wrong secret, a missing header, a malformed prefix and a non-hex digest", async () => {
    const tampered = signedWebhook(body, { tamper: true });
    const wrongSecret = signedWebhook(body, { secret: "not-the-app-secret" });
    const missingHeader = { ...signedWebhook(body), headers: {} };
    const wrongPrefix = { ...signedWebhook(body), headers: { "x-hub-signature-256": "sha1=abcdef" } };
    const notHex = { ...signedWebhook(body), headers: { "x-hub-signature-256": "sha256=zzzz" } };

    for (const input of [tampered, wrongSecret, missingHeader, wrongPrefix, notHex]) {
      expect((await adapter().verifyWebhook(input)).status).toBe("REJECTED");
    }
  });

  it("rejects everything when no app secret is configured, instead of accepting unsigned payloads", async () => {
    const config = testConfig();
    const blind = createInstagramAdapter({
      ...config,
      secrets: { ...config.secrets, appSecret: "" },
    });

    expect((await blind.verifyWebhook(signedWebhook(body))).status).toBe("REJECTED");
  });

  it("never normalizes an unverified payload, even when destructured from the adapter", async () => {
    const { normalizeWebhook } = adapter();

    await expect(normalizeWebhook(signedWebhook(body, { secret: "wrong" }))).rejects.toThrow(/unverified/);
    await expect(normalizeWebhook(signedWebhook(body))).resolves.toHaveLength(1);
    expect(APP_SECRET.length).toBeGreaterThan(0);
  });
});
