import { sendDisposition, type OutboundMessageCommand } from "@omnichannel/channel-core";
import { describe, expect, it } from "vitest";

import { createInstagramAdapter } from "./adapter";
import { ACCESS_TOKEN, BINDING, CUSTOMER_ID, jsonResponse, scriptedHttp, testConfig } from "./__fixtures__/payloads";

const command = (overrides: Partial<OutboundMessageCommand> = {}): OutboundMessageCommand => ({
  workspaceId: BINDING.workspaceId,
  businessProfileId: BINDING.businessProfileId,
  channelAccountId: BINDING.channelAccountId,
  conversationId: "conv_1",
  recipientExternalId: CUSTOMER_ID,
  operationId: "op_1",
  content: { type: "TEXT", text: "We open at 10 on Saturday." },
  ...overrides,
});

describe("standard text send", () => {
  it("posts to the configured Graph host and version, with no message tag", async () => {
    const http = scriptedHttp([jsonResponse(200, { recipient_id: CUSTOMER_ID, message_id: "mid.sent-9" })]);
    const result = await createInstagramAdapter(testConfig({ http: http.port })).send(command());

    expect(result).toEqual({ outcome: "ACCEPTED", platformMessageId: "mid.sent-9" });
    const request = http.requests[0];
    expect(request?.url).toBe(`https://graph.instagram.com/v26.0/${BINDING.externalAccountId}/messages`);
    expect(request?.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(JSON.parse(request?.body ?? "{}")).toEqual({ recipient: { id: CUSTOMER_ID }, message: { text: "We open at 10 on Saturday." } });
    // The automated path must never carry the Human Agent tag or a messaging type.
    expect(request?.body).not.toContain("HUMAN_AGENT");
    expect(request?.body).not.toContain("messaging_type");
    expect(sendDisposition(result)).toBe("COMPLETED");
  });

  it("refuses non-text content and oversized text without calling the provider", async () => {
    const http = scriptedHttp([jsonResponse(200, { message_id: "mid.never" })]);
    const adapter = createInstagramAdapter(testConfig({ http: http.port }));
    const template = command({ content: { type: "TEMPLATE", templateName: "hello", languageCode: "en", parameters: [] } });
    // 1000 characters of a 2-byte character is 2000 bytes: the limit is bytes, not characters.
    const oversized = command({ content: { type: "TEXT", text: "я".repeat(1_000) } });

    expect(await adapter.send(template)).toMatchObject({ outcome: "REJECTED", retryable: false, code: "UNSUPPORTED_CONTENT" });
    expect(await adapter.send(oversized)).toMatchObject({ outcome: "REJECTED", retryable: false, code: "UNSUPPORTED_CONTENT" });
    expect(http.requests).toHaveLength(0);
  });

  it("refuses to send when the account is not connected or has no usable token", async () => {
    const http = scriptedHttp([jsonResponse(200, { message_id: "mid.never" })]);
    const disconnected = createInstagramAdapter(testConfig({ http: http.port, connectionState: "NEEDS_REAUTH" }));
    const config = testConfig({ http: http.port });
    const tokenless = createInstagramAdapter({ ...config, secrets: { ...config.secrets, accessToken: () => Promise.resolve(undefined) } });

    expect(await disconnected.send(command())).toMatchObject({ outcome: "REJECTED", code: "ACCOUNT_NOT_CONNECTED" });
    expect(await tokenless.send(command())).toMatchObject({ outcome: "REJECTED", code: "NO_CREDENTIALS" });
    expect(http.requests).toHaveLength(0);
  });
});

describe("provider outcomes", () => {
  const send = async (result: Parameters<typeof scriptedHttp>[0][number]) => {
    const http = scriptedHttp([result]);
    const outcome = await createInstagramAdapter(testConfig({ http: http.port })).send(command());
    return { outcome, calls: http.requests.length };
  };

  it.each([
    ["outside the allowed window", 10, 2534022, false],
    ["unsupported request", 100, 2018001, false],
    ["invalid access token", 190, undefined, false],
    ["person not available", 551, 1545041, false],
    ["application request limit", 4, undefined, true],
    ["rate limited", 613, 2534040, true],
    ["transient send failure", 2018321, undefined, true],
  ])("classifies %s as retryable=%s and preserves the provider code", async (_label, code, subcode, retryable) => {
    const { outcome, calls } = await send(
      jsonResponse(400, { error: { message: "denied", type: "OAuthException", code, error_subcode: subcode, fbtrace_id: "tr_1" } }),
    );

    expect(outcome).toMatchObject({
      outcome: "REJECTED",
      retryable,
      code: subcode === undefined ? String(code) : `${String(code)}/${String(subcode)}`,
    });
    expect(sendDisposition(outcome)).toBe(retryable ? "RETRY_ALLOWED" : "FAILED");
    // Provider prose never becomes our message; it may quote customer content.
    expect(outcome).toMatchObject({ message: "provider rejected the message" });
    expect(calls).toBe(1);
  });

  it("keeps policy, window and permission errors final even when Meta marks them transient", async () => {
    // Retrying a closed window or a revoked permission cannot change the answer, whatever the flag says.
    for (const code of [10, 100, 190, 200, 551, 2022]) {
      const { outcome } = await send(jsonResponse(400, { error: { code, is_transient: true } }));
      expect(outcome).toMatchObject({ outcome: "REJECTED", retryable: false });
    }
  });

  it("treats an unknown code as final unless Meta marks it transient", async () => {
    const final = await send(jsonResponse(400, { error: { code: 999_999 } }));
    const transient = await send(jsonResponse(400, { error: { code: 999_999, is_transient: true } }));

    expect(final.outcome).toMatchObject({ outcome: "REJECTED", retryable: false });
    expect(transient.outcome).toMatchObject({ outcome: "REJECTED", retryable: true });
  });

  it("never retries internally and reports ambiguity when the request may have reached Meta", async () => {
    const timeout = await send({ kind: "NO_RESPONSE", reason: "TIMEOUT", message: "timed out" });
    const network = await send({ kind: "NO_RESPONSE", reason: "NETWORK", message: "connection reset" });
    const undispatched = await send({ kind: "NO_RESPONSE", reason: "PRE_DISPATCH", message: "could not dispatch" });

    for (const { outcome, calls } of [timeout, network]) {
      expect(outcome.outcome).toBe("AMBIGUOUS");
      expect(outcome).not.toHaveProperty("retryable");
      expect(sendDisposition(outcome)).toBe("QUARANTINE_NO_RETRY");
      expect(calls).toBe(1);
    }
    // Provably never dispatched: safe to retry, and never quarantined.
    expect(undispatched.outcome).toMatchObject({ outcome: "REJECTED", retryable: true, code: "PRE_DISPATCH" });
  });

  it("does not claim success it cannot read, and keeps every 5xx ambiguous", async () => {
    const unreadableSuccess = await send(jsonResponse(200, { recipient_id: CUSTOMER_ID }));
    const serverError = await send({ kind: "RESPONSE", status: 503, body: "<html>service unavailable</html>" });
    const clientError = await send({ kind: "RESPONSE", status: 400, body: "not json" });
    // Meta answers 500 with a readable, "transient" error body. It still failed *after* receiving the
    // request, so whether the message exists is unknown and it must never be retried blindly.
    const readableServerError = await send(
      jsonResponse(500, { error: { message: "please retry", type: "OAuthException", code: 2, is_transient: true, fbtrace_id: "tr_5" } }),
    );

    expect(unreadableSuccess.outcome).toMatchObject({ outcome: "AMBIGUOUS", code: "UNREADABLE_SUCCESS" });
    expect(serverError.outcome).toMatchObject({ outcome: "AMBIGUOUS", code: "HTTP_503" });
    expect(readableServerError.outcome).toMatchObject({ outcome: "AMBIGUOUS", code: "2" });
    expect(sendDisposition(readableServerError.outcome)).toBe("QUARANTINE_NO_RETRY");
    expect(clientError.outcome).toMatchObject({ outcome: "REJECTED", retryable: false, code: "HTTP_400" });
  });
});
