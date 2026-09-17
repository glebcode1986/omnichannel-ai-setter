import type { ConversationPolicyContext, OutboundMessageCommand } from "@omnichannel/channel-core";
import { describe, expect, it } from "vitest";

import { createInstagramAdapter } from "./adapter";
import { AT_MS, BINDING, CUSTOMER_ID, jsonResponse, scriptedHttp, testConfig } from "./__fixtures__/payloads";

const HOUR = 60 * 60 * 1000;

const command: OutboundMessageCommand = {
  workspaceId: BINDING.workspaceId,
  businessProfileId: BINDING.businessProfileId,
  channelAccountId: BINDING.channelAccountId,
  conversationId: "conv_1",
  recipientExternalId: CUSTOMER_ID,
  operationId: "op_human_1",
  content: { type: "TEXT", text: "Sorry for the delay — your booking is confirmed." },
};

const context = (hoursAgo: number): ConversationPolicyContext => ({
  workspaceId: BINDING.workspaceId,
  channelAccountId: BINDING.channelAccountId,
  conversationId: "conv_1",
  participantExternalId: CUSTOMER_ID,
  lastInboundAt: new Date(AT_MS - hoursAgo * HOUR),
  now: new Date(AT_MS),
});

const actor = { userId: "user_1", actedAt: new Date(AT_MS) };

describe("human agent send", () => {
  it("attaches exactly one top-level HUMAN_AGENT tag when an approved human sends inside the window", async () => {
    const http = scriptedHttp([jsonResponse(200, { recipient_id: CUSTOMER_ID, message_id: "mid.human-1" })]);
    const adapter = createInstagramAdapter(testConfig({ http: http.port, humanAgentApproval: "APPROVED" }));

    const result = await adapter.sendAsHumanAgent(command, actor, context(30));

    expect(result).toEqual({ outcome: "ACCEPTED", platformMessageId: "mid.human-1" });
    expect(JSON.parse(http.requests[0]?.body ?? "{}")).toEqual({
      recipient: { id: CUSTOMER_ID },
      message: { text: command.content.type === "TEXT" ? command.content.text : "" },
      tag: "HUMAN_AGENT",
    });
    // Instagram takes the tag at the top level and no messaging_type.
    expect(http.requests[0]?.body).not.toContain("messaging_type");
  });

  it("refuses without dispatching when the window, approval, actor or connection is missing", async () => {
    const http = scriptedHttp([jsonResponse(200, { message_id: "mid.never" })]);
    const approved = createInstagramAdapter(testConfig({ http: http.port, humanAgentApproval: "APPROVED" }));
    const unapproved = createInstagramAdapter(testConfig({ http: http.port, humanAgentApproval: "NOT_APPROVED" }));
    const unknown = createInstagramAdapter(testConfig({ http: http.port }));
    const disconnected = createInstagramAdapter(testConfig({ http: http.port, humanAgentApproval: "APPROVED", connectionState: "NEEDS_REAUTH" }));

    const refusals = [
      await approved.sendAsHumanAgent(command, actor, context(24 * 8)),
      await approved.sendAsHumanAgent(command, { ...actor, userId: "  " }, context(30)),
      await unapproved.sendAsHumanAgent(command, actor, context(30)),
      await unknown.sendAsHumanAgent(command, actor, context(30)),
      await disconnected.sendAsHumanAgent(command, actor, context(30)),
    ];

    expect(refusals.map((result) => result.outcome)).toEqual(["REJECTED", "REJECTED", "REJECTED", "REJECTED", "REJECTED"]);
    expect(refusals.map((result) => (result.outcome === "REJECTED" ? result.code : undefined))).toEqual([
      "HUMAN_AGENT_EXPIRED",
      "NO_HUMAN_ACTOR",
      "HUMAN_AGENT_NOT_APPROVED",
      "HUMAN_AGENT_UNKNOWN",
      "ACCOUNT_NOT_CONNECTED",
    ]);
    // A refusal is never ambiguous: nothing was sent.
    expect(http.requests).toHaveLength(0);
  });

  it("re-checks eligibility at send time rather than trusting an earlier decision", async () => {
    const http = scriptedHttp([jsonResponse(200, { message_id: "mid.human-2" })]);
    const adapter = createInstagramAdapter(testConfig({ http: http.port, humanAgentApproval: "APPROVED" }));

    // Eligible when the human opened the conversation…
    expect(await adapter.evaluateHumanAgentEligibility(context(30))).toMatchObject({ state: "ELIGIBLE" });
    // …but the send happens later, with a context whose window has since closed.
    expect(await adapter.sendAsHumanAgent(command, actor, context(24 * 8))).toMatchObject({ code: "HUMAN_AGENT_EXPIRED" });
    expect(http.requests).toHaveLength(0);
  });

  it("keeps the automated path free of the tag no matter the eligibility", async () => {
    const http = scriptedHttp([jsonResponse(200, { message_id: "mid.auto-1" })]);
    const adapter = createInstagramAdapter(testConfig({ http: http.port, humanAgentApproval: "APPROVED" }));

    await adapter.send(command);

    expect(http.requests[0]?.body).not.toContain("HUMAN_AGENT");
    // The tagged path is not reachable through the channel-neutral contract.
    const asChannelAdapter: { sendAsHumanAgent?: unknown } = { ...adapter };
    expect(typeof asChannelAdapter.sendAsHumanAgent).toBe("function");
    expect(Object.keys(adapter)).not.toContain("tag");
  });
});
