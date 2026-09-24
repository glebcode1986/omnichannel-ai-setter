import { allowsFreeformSend, type ConversationPolicyContext } from "@omnichannel/channel-core";
import { describe, expect, it } from "vitest";

import { createInstagramAdapter } from "./adapter";
import { AT_MS, BINDING, CUSTOMER_ID, testConfig } from "./__fixtures__/payloads";

const HOUR = 60 * 60 * 1000;

const context = (lastInboundAt: Date | undefined, now = new Date(AT_MS)): ConversationPolicyContext => ({
  workspaceId: BINDING.workspaceId,
  channelAccountId: BINDING.channelAccountId,
  conversationId: "conv_1",
  participantExternalId: CUSTOMER_ID,
  ...(lastInboundAt === undefined ? {} : { lastInboundAt }),
  now,
});

describe("standard messaging window", () => {
  const adapter = createInstagramAdapter(testConfig());

  it("is open for 24 hours after the customer's message and closed afterwards", async () => {
    const fresh = await adapter.evaluateWindow(context(new Date(AT_MS - HOUR)));
    const expiring = await adapter.evaluateWindow(context(new Date(AT_MS - 24 * HOUR + 1)));
    const closed = await adapter.evaluateWindow(context(new Date(AT_MS - 24 * HOUR)));

    expect(fresh).toEqual({ state: "OPEN_FREEFORM", expiresAt: new Date(AT_MS - HOUR + 24 * HOUR) });
    expect(allowsFreeformSend(fresh, new Date(AT_MS))).toBe(true);
    expect(expiring.state).toBe("OPEN_FREEFORM");
    // Exactly at expiry the window is closed, not open.
    expect(closed).toEqual({ state: "NOT_ELIGIBLE", reason: "standard messaging window closed" });
    expect(allowsFreeformSend(closed, new Date(AT_MS))).toBe(false);
  });

  it("is not eligible without a user-initiated conversation and unknown when the account is not connected", async () => {
    const noInbound = await adapter.evaluateWindow(context(undefined));
    const broken = await createInstagramAdapter(testConfig({ connectionState: "NEEDS_REAUTH" })).evaluateWindow(
      context(new Date(AT_MS - HOUR)),
    );

    expect(noInbound).toEqual({ state: "NOT_ELIGIBLE", reason: "no user-initiated conversation" });
    // Fails closed: UNKNOWN never permits an automated free-form send.
    expect(broken.state).toBe("UNKNOWN");
    expect(allowsFreeformSend(broken, new Date(AT_MS))).toBe(false);
  });

  it("never reports TEMPLATE_ONLY, which Instagram does not have", async () => {
    const decisions = await Promise.all(
      [0, 12, 24, 48, 24 * 8].map((hours) => adapter.evaluateWindow(context(new Date(AT_MS - hours * HOUR)))),
    );

    expect(decisions.every((decision) => decision.state !== "TEMPLATE_ONLY")).toBe(true);
  });
});

describe("human agent eligibility", () => {
  const approved = createInstagramAdapter(testConfig({ humanAgentApproval: "APPROVED" }));

  it("is evaluated separately from the automated window: closed for automation, open for a human", async () => {
    const dayOld = context(new Date(AT_MS - 30 * HOUR));

    const automated = await approved.evaluateWindow(dayOld);
    const human = await approved.evaluateHumanAgentEligibility(dayOld);

    expect(automated).toEqual({ state: "NOT_ELIGIBLE", reason: "standard messaging window closed" });
    expect(human).toEqual({ state: "ELIGIBLE", expiresAt: new Date(AT_MS - 30 * HOUR + 7 * 24 * HOUR) });
  });

  it("expires after seven days and requires an approved, connected account", async () => {
    const stale = context(new Date(AT_MS - 7 * 24 * HOUR));

    expect(await approved.evaluateHumanAgentEligibility(stale)).toMatchObject({ state: "EXPIRED" });
    expect(await approved.evaluateHumanAgentEligibility(context(undefined))).toMatchObject({ state: "EXPIRED" });
    expect(
      await createInstagramAdapter(testConfig({ humanAgentApproval: "NOT_APPROVED" })).evaluateHumanAgentEligibility(
        context(new Date(AT_MS - HOUR)),
      ),
    ).toMatchObject({ state: "NOT_APPROVED" });
    // Approval defaults to UNKNOWN, which must not be read as permission.
    expect(await createInstagramAdapter(testConfig()).evaluateHumanAgentEligibility(context(new Date(AT_MS - HOUR)))).toMatchObject({
      state: "UNKNOWN",
    });
    expect(
      await createInstagramAdapter(testConfig({ humanAgentApproval: "APPROVED", connectionState: "DISCONNECTED" })).evaluateHumanAgentEligibility(
        context(new Date(AT_MS - HOUR)),
      ),
    ).toMatchObject({ state: "UNKNOWN" });
  });
});
