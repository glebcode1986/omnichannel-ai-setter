/**
 * Outbound transport and its three outcomes (#18, ADR-012).
 *
 * The case this file exists for is `AMBIGUOUS`. A timeout after the request left us means Meta may have the
 * message, and the only safe answer is "we do not know" — reporting it as retryable sends a customer the
 * same reply twice, and reporting it as a plain failure tells a business something was not sent when it may
 * have been. Every other case here is a way of arriving at a verdict that can be acted on.
 */
import { describe, expect, it } from "vitest";

import { resolveConfig, MAX_TEXT_LENGTH } from "./config";
import { buildTemplatePayload, buildTextPayload, checkSendable, markReadAndTyping, sendMessage } from "./send";
import { accepted, CUSTOMER_WA_ID, config, providerError, scriptedHttp } from "./__fixtures__/payloads";

const command = (overrides: Partial<Parameters<typeof buildTextPayload>[0]> = {}) => ({
  workspaceId: "ws_1",
  businessProfileId: "bp_1",
  channelAccountId: "ca_1",
  conversationId: "cv_1",
  recipientExternalId: CUSTOMER_WA_ID,
  operationId: "op_1",
  content: { type: "TEXT" as const, text: "We open at 10 on Saturday." },
  ...overrides,
});

const template = (overrides: Record<string, unknown> = {}) =>
  command({
    content: {
      type: "TEMPLATE" as const,
      templateName: "appointment_reminder",
      languageCode: "en_US",
      parameters: [{ name: "time", value: "10:00" }],
      ...overrides,
    },
  });

describe("the payload that goes on the wire", () => {
  it("sends text with link previews off", () => {
    // Previews are fetched by Meta from the customer's side and change what the message looks like after
    // it is sent. A reviewed reply should render as the words that were reviewed.
    expect(buildTextPayload(command(), "hello")).toMatchObject({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: CUSTOMER_WA_ID,
      type: "text",
      text: { preview_url: false, body: "hello" },
    });
  });

  it("threads a reply when the command names one", () => {
    expect(buildTextPayload(command({ replyToExternalMessageId: "wamid.theirs" }), "hello")).toMatchObject({
      context: { message_id: "wamid.theirs" },
    });
  });

  it("sends a template as a name, a language and parameter values — never as rewritten text", () => {
    const payload = buildTemplatePayload(template(), {
      templateName: "appointment_reminder",
      languageCode: "en_US",
      parameters: [{ value: "10:00" }],
    });

    expect(payload).toMatchObject({
      type: "template",
      template: {
        name: "appointment_reminder",
        language: { code: "en_US" },
        components: [{ type: "body", parameters: [{ type: "text", text: "10:00" }] }],
      },
    });
    // Nothing in the payload carries body text: the approved template owns the wording.
    expect(JSON.stringify(payload)).not.toContain("We open at");
  });

  it("omits components for a template with no parameters, rather than sending an empty body", () => {
    const payload = buildTemplatePayload(template(), { templateName: "hello", languageCode: "en_US", parameters: [] });

    expect(payload).toMatchObject({ template: { name: "hello" } });
    expect((payload as { template?: { components?: unknown } }).template?.components).toBeUndefined();
  });
});

describe("refusals that cost no request", () => {
  it("refuses an empty reply and one over the platform limit", () => {
    const resolved = resolveConfig(config());

    expect(checkSendable(resolved, command({ content: { type: "TEXT", text: "   " } }))).toMatchObject({ code: "EMPTY_TEXT", retryable: false });
    expect(checkSendable(resolved, command({ content: { type: "TEXT", text: "x".repeat(MAX_TEXT_LENGTH + 1) } }))).toMatchObject({
      code: "UNSUPPORTED_CONTENT",
      retryable: false,
    });
  });

  it("refuses a template with a missing name, language or an empty parameter", () => {
    const resolved = resolveConfig(config());

    expect(checkSendable(resolved, template({ templateName: " " }))).toMatchObject({ code: "UNSUPPORTED_CONTENT" });
    expect(checkSendable(resolved, template({ languageCode: "" }))).toMatchObject({ code: "UNSUPPORTED_CONTENT" });
    // An empty value renders as a gap in approved wording: "your order  is ready" reaches the customer.
    expect(checkSendable(resolved, template({ parameters: [{ name: "time", value: "" }] }))).toMatchObject({ code: "UNSUPPORTED_CONTENT" });
  });

  it("refuses a disconnected account, and says a retry could work", () => {
    const resolved = resolveConfig(config({ connectionState: "NEEDS_REAUTH" }));

    expect(checkSendable(resolved, command())).toEqual({
      outcome: "REJECTED",
      retryable: true,
      code: "ACCOUNT_NOT_CONNECTED",
      message: "channel account is not connected",
    });
  });

  it("refuses with no token, without reaching the network", async () => {
    const http = scriptedHttp([accepted()]);
    const resolved = resolveConfig(
      config({ http: http.port, secrets: { appSecret: "s", verifyToken: "v", accessToken: () => Promise.resolve(undefined) } }),
    );

    expect(await sendMessage(resolved, command())).toMatchObject({ outcome: "REJECTED", retryable: true, code: "NO_CREDENTIALS" });
    expect(http.requests).toHaveLength(0);
  });
});

describe("what the provider answered", () => {
  it("reports an accepted send with the platform message id", async () => {
    const http = scriptedHttp([accepted("wamid.accepted1")]);
    const resolved = resolveConfig(config({ http: http.port }));

    expect(await sendMessage(resolved, command())).toEqual({ outcome: "ACCEPTED", platformMessageId: "wamid.accepted1" });
    expect(http.requests[0]?.url).toContain("/100000000000001/messages");
    expect(http.requests[0]?.headers["authorization"]).toBe("Bearer test-access-token");
  });

  it("explains a closed customer-service window in a sentence, and does not retry it", async () => {
    // 131047 is the code that means "the 24 hours are up". Retrying the same free-form send fails
    // identically until the customer writes again; a template is the route, and that is a product
    // decision rather than something to retry into.
    const resolved = resolveConfig(config({ http: scriptedHttp([providerError(400, 131047)]).port }));

    expect(await sendMessage(resolved, command())).toEqual({
      outcome: "REJECTED",
      retryable: false,
      code: "131047",
      message: "the customer-service window has closed; only an approved template can reach this customer",
    });
  });

  it("treats throttling as retryable and a policy refusal as final", async () => {
    for (const [code, retryable] of [
      [130429, true],
      [131048, true],
      [131026, false],
      [132000, false],
      // Unknown codes are final: there is no transience flag to consult, and guessing upward turns one
      // refusal into a loop against a customer's conversation.
      [999999, false],
    ] as const) {
      const resolved = resolveConfig(config({ http: scriptedHttp([providerError(400, code)]).port }));
      expect(await sendMessage(resolved, command())).toMatchObject({ outcome: "REJECTED", retryable, code: String(code) });
    }
  });

  it("never turns an unknown outcome into a rejection", async () => {
    for (const result of [
      { kind: "NO_RESPONSE", reason: "TIMEOUT", message: "timed out" },
      { kind: "NO_RESPONSE", reason: "NETWORK", message: "socket reset" },
    ] as const) {
      const resolved = resolveConfig(config({ http: scriptedHttp([result]).port }));
      expect(await sendMessage(resolved, command())).toMatchObject({ outcome: "AMBIGUOUS", code: result.reason });
    }
  });

  it("calls a request that never left us retryable, because nothing was sent", async () => {
    const resolved = resolveConfig(config({ http: scriptedHttp([{ kind: "NO_RESPONSE", reason: "PRE_DISPATCH", message: "bad url" }]).port }));

    expect(await sendMessage(resolved, command())).toMatchObject({ outcome: "REJECTED", retryable: true, code: "PRE_DISPATCH" });
  });

  it("treats a 5xx as ambiguous, whatever the body says", async () => {
    // Meta failed after receiving the request; whether the message was created is unknown.
    const resolved = resolveConfig(config({ http: scriptedHttp([providerError(500, 131000)]).port }));

    expect(await sendMessage(resolved, command())).toMatchObject({ outcome: "AMBIGUOUS", code: "131000" });
  });

  it("treats a 2xx it cannot read as ambiguous, not as success", async () => {
    const resolved = resolveConfig(
      config({ http: scriptedHttp([{ kind: "RESPONSE", status: 200, body: JSON.stringify({ messaging_product: "whatsapp" }) }]).port }),
    );

    expect(await sendMessage(resolved, command())).toMatchObject({ outcome: "AMBIGUOUS", code: "UNREADABLE_SUCCESS" });
  });

  it("keeps the provider's prose out of the normalized result", async () => {
    const resolved = resolveConfig(config({ http: scriptedHttp([providerError(400, 131026)]).port }));

    const result = await sendMessage(resolved, command());

    expect(JSON.stringify(result)).not.toContain("may quote customer content");
  });
});

describe("read and typing presence", () => {
  it("marks read and shows typing in one request", async () => {
    const http = scriptedHttp([{ kind: "RESPONSE", status: 200, body: "{}" }]);
    const resolved = resolveConfig(config({ http: http.port }));

    expect(await markReadAndTyping(resolved, { inboundMessageId: "wamid.theirs", typing: true })).toBe(true);
    expect(http.requests[0]?.body).toMatchObject({
      messaging_product: "whatsapp",
      status: "read",
      message_id: "wamid.theirs",
      typing_indicator: { type: "text" },
    });
  });

  it("marks read without typing when typing was not asked for", async () => {
    const http = scriptedHttp([{ kind: "RESPONSE", status: 200, body: "{}" }]);
    const resolved = resolveConfig(config({ http: http.port }));

    await markReadAndTyping(resolved, { inboundMessageId: "wamid.theirs", typing: false });

    expect((http.requests[0]?.body as { typing_indicator?: unknown }).typing_indicator).toBeUndefined();
  });

  it("answers false rather than throwing when the effect fails", async () => {
    // Best effort by contract: nothing a caller can do about a failed read receipt is worth cancelling a
    // customer's reply for.
    for (const result of [providerError(400, 131026), { kind: "NO_RESPONSE", reason: "TIMEOUT", message: "x" } as const]) {
      const resolved = resolveConfig(config({ http: scriptedHttp([result]).port }));
      expect(await markReadAndTyping(resolved, { inboundMessageId: "wamid.theirs", typing: true })).toBe(false);
    }
  });

  it("does not try at all on a disconnected account", async () => {
    const http = scriptedHttp([{ kind: "RESPONSE", status: 200, body: "{}" }]);
    const resolved = resolveConfig(config({ http: http.port, connectionState: "DISCONNECTED" }));

    expect(await markReadAndTyping(resolved, { inboundMessageId: "wamid.theirs", typing: true })).toBe(false);
    expect(http.requests).toHaveLength(0);
  });
});
