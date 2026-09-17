import { CHANNEL_CAPABILITY_KEYS, NO_CAPABILITIES } from "@omnichannel/domain";
import { describe, expect, expectTypeOf, it } from "vitest";

import { createInstagramAdapter, type InstagramAdapter } from "./adapter";
import { INSTAGRAM_CAPABILITIES } from "./capabilities";
import { BINDING, envelope, inboundText, signedWebhook, testConfig } from "./__fixtures__/payloads";
import type { ChannelAdapter } from "@omnichannel/channel-core";

describe("adapter shape", () => {
  const adapter = createInstagramAdapter(testConfig());

  it("satisfies the frozen ChannelAdapter contract and adds only the Instagram members", () => {
    expectTypeOf<InstagramAdapter>().toExtend<ChannelAdapter>();
    expect(adapter.channel).toBe("INSTAGRAM");
    expect(Object.keys(adapter).sort()).toEqual([
      "channel",
      "evaluateHumanAgentEligibility",
      "evaluateWindow",
      "getCapabilities",
      "normalizeWebhook",
      "send",
      "sendAsHumanAgent",
      "verifyWebhook",
    ]);
  });

  it("keeps working when its members are destructured (no reliance on `this`)", async () => {
    const { verifyWebhook, normalizeWebhook, getCapabilities, evaluateWindow, send } = adapter;
    const webhook = signedWebhook(envelope(inboundText()));

    expect(await verifyWebhook(webhook)).toEqual({ status: "VERIFIED" });
    expect(await normalizeWebhook(webhook)).toHaveLength(1);
    expect((await getCapabilities(BINDING.channelAccountId)).text).toBe(true);
    expect(typeof (await evaluateWindow({
      workspaceId: BINDING.workspaceId,
      channelAccountId: BINDING.channelAccountId,
      conversationId: "conv_1",
      participantExternalId: "user",
      now: new Date(),
    })).state).toBe("string");
    expect(typeof send).toBe("function");
  });

  it("reports the full capability set for the bound account only", async () => {
    const bound = await adapter.getCapabilities(BINDING.channelAccountId);
    const foreign = await adapter.getCapabilities("ca_other");

    expect(Object.keys(bound).sort()).toEqual([...CHANNEL_CAPABILITY_KEYS].sort());
    expect(bound).toEqual(INSTAGRAM_CAPABILITIES);
    expect(bound).toMatchObject({ text: true, image: true, document: true, reactions: true, readReceipts: true });
    // Instagram has no WhatsApp-style approved templates, and the MVP sends no interactive content.
    expect(bound).toMatchObject({ templates: false, interactive: false });
    expect(foreign).toEqual(NO_CAPABILITIES);
  });
});
