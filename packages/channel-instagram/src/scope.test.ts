/**
 * The boundary between "this adapter" and "someone else's account or someone else's conversation".
 *
 * Both cases here were found by independent review (R2 on PR #63) and both reached the HTTP transport with
 * `ACCEPTED` before this: a tagged message sent to the wrong person on somebody's still-open window, and a
 * command naming a foreign workspace dispatched through this account's token.
 */
import type { ConversationPolicyContext, OutboundMessageCommand } from "@omnichannel/channel-core";
import { describe, expect, it } from "vitest";

import { createInstagramAdapter } from "./adapter";
import { AT_MS, BINDING, CUSTOMER_ID, jsonResponse, scriptedHttp, testConfig } from "./__fixtures__/payloads";

const OTHER_CUSTOMER = "17841400000000999";
const HOUR = 60 * 60 * 1000;

const command = (overrides: Partial<OutboundMessageCommand> = {}): OutboundMessageCommand => ({
  workspaceId: BINDING.workspaceId,
  businessProfileId: BINDING.businessProfileId,
  channelAccountId: BINDING.channelAccountId,
  conversationId: "conv_1",
  recipientExternalId: CUSTOMER_ID,
  operationId: "op_scope_1",
  content: { type: "TEXT", text: "Your booking is confirmed." },
  ...overrides,
});

const context = (overrides: Partial<ConversationPolicyContext> = {}): ConversationPolicyContext => ({
  workspaceId: BINDING.workspaceId,
  channelAccountId: BINDING.channelAccountId,
  conversationId: "conv_1",
  participantExternalId: CUSTOMER_ID,
  // Well inside the seven-day human-support window and outside the standard one.
  lastInboundAt: new Date(AT_MS - 30 * HOUR),
  now: new Date(AT_MS),
  ...overrides,
});

const actor = { userId: "user_1", actedAt: new Date(AT_MS) };

const approved = () => {
  const http = scriptedHttp([jsonResponse(200, { recipient_id: CUSTOMER_ID, message_id: "mid.should-not-happen" })]);
  return { http, adapter: createInstagramAdapter(testConfig({ http: http.port, humanAgentApproval: "APPROVED" })) };
};

describe("a human-support window belongs to one person", () => {
  it("refuses to spend one customer's open window on a message to another", async () => {
    const { http, adapter } = approved();

    // The context is genuine and eligible — it is simply about somebody else. Eligibility computed from it
    // says nothing about whether this recipient wrote to us, and Meta permits the tag only as support for
    // the person whose window it is.
    const result = await adapter.sendAsHumanAgent(command({ recipientExternalId: OTHER_CUSTOMER }), actor, context());

    expect(result).toMatchObject({ outcome: "REJECTED", retryable: false, code: "SCOPE_MISMATCH" });
    expect(http.requests).toHaveLength(0);
  });

  it("refuses a context describing a different conversation on the same account", async () => {
    const { http, adapter } = approved();

    const result = await adapter.sendAsHumanAgent(command(), actor, context({ conversationId: "conv_somebody_else" }));

    expect(result).toMatchObject({ outcome: "REJECTED", code: "SCOPE_MISMATCH" });
    expect(http.requests).toHaveLength(0);
  });

  it("still sends when the context really is about this recipient", async () => {
    const http = scriptedHttp([jsonResponse(200, { recipient_id: CUSTOMER_ID, message_id: "mid.human-ok" })]);
    const adapter = createInstagramAdapter(testConfig({ http: http.port, humanAgentApproval: "APPROVED" }));

    // The negatives above must be failing for the reason claimed, not because the fixture cannot send.
    expect(await adapter.sendAsHumanAgent(command(), actor, context())).toEqual({ outcome: "ACCEPTED", platformMessageId: "mid.human-ok" });
    expect(http.requests).toHaveLength(1);
  });
});

describe("an adapter sends only for the account it is bound to", () => {
  const foreign = [
    ["workspaceId", { workspaceId: "01a0b40c-0000-7000-8000-0000000000f1" }],
    ["businessProfileId", { businessProfileId: "01a0b40c-0000-7000-8000-0000000000f2" }],
    ["channelAccountId", { channelAccountId: "01a0b40c-0000-7000-8000-0000000000f3" }],
  ] as const;

  it.each(foreign)("refuses an automated send whose %s is not ours", async (_field, overrides) => {
    const http = scriptedHttp([jsonResponse(200, { message_id: "mid.should-not-happen" })]);
    const adapter = createInstagramAdapter(testConfig({ http: http.port }));

    // One tenant's command must not be dispatched through another tenant's token, which is what this
    // adapter holds. Nothing is resolved and nothing is sent.
    const result = await adapter.send(command(overrides));

    expect(result).toMatchObject({ outcome: "REJECTED", retryable: false, code: "SCOPE_MISMATCH" });
    expect(http.requests).toHaveLength(0);
  });

  it.each(foreign)("refuses a human-agent send whose %s is not ours", async (_field, overrides) => {
    const { http, adapter } = approved();

    const result = await adapter.sendAsHumanAgent(command(overrides), actor, context());

    expect(result).toMatchObject({ outcome: "REJECTED", code: "SCOPE_MISMATCH" });
    expect(http.requests).toHaveLength(0);
  });

  it("refuses a blank identifier rather than letting two blanks match", async () => {
    const http = scriptedHttp([jsonResponse(200, { message_id: "mid.should-not-happen" })]);
    const adapter = createInstagramAdapter(testConfig({ http: http.port }));

    for (const blank of [{ workspaceId: "" }, { channelAccountId: "   " }, { recipientExternalId: "" }]) {
      expect(await adapter.send(command(blank))).toMatchObject({ outcome: "REJECTED", code: "SCOPE_MISMATCH" });
    }
    expect(http.requests).toHaveLength(0);
  });

  it("names the field that disagreed and never the identifiers", async () => {
    const http = scriptedHttp([jsonResponse(200, { message_id: "mid.should-not-happen" })]);
    const adapter = createInstagramAdapter(testConfig({ http: http.port }));
    const intruder = "01a0b40c-0000-7000-8000-0000000000f1";

    const result = await adapter.send(command({ workspaceId: intruder }));

    // A rejection is read by an operator and kept by a log; tenant identifiers do not belong in either.
    expect(result).toMatchObject({ code: "SCOPE_MISMATCH" });
    const message = "message" in result ? result.message : "";
    expect(message).toContain("workspaceId");
    expect(message).not.toContain(intruder);
    expect(message).not.toContain(BINDING.workspaceId);
  });

  it("refuses a foreign command before it refuses its content", async () => {
    const http = scriptedHttp([jsonResponse(200, { message_id: "mid.should-not-happen" })]);
    const adapter = createInstagramAdapter(testConfig({ http: http.port }));

    // Both wrong. The answer must be the one that matters: this is not ours to send at all.
    const result = await adapter.send(
      command({ workspaceId: "01a0b40c-0000-7000-8000-0000000000f1", content: { type: "TEXT", text: "я".repeat(1_000) } }),
    );

    expect(result).toMatchObject({ code: "SCOPE_MISMATCH" });
  });
});
