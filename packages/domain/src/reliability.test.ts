import { describe, expect, it } from "vitest";

import { activeSuspension, automatedOutboundAllowed, createAutomationSuspension, type AutomationSuspension } from "./suspension";
import { aggregateIncidents, warrantsNotification, type FailureSignal } from "./incident";
import { overallHealth, outboundBlockedByHealth, type ComponentHealth } from "./health";
import { toBusinessProfileId, toChannelAccountId, toWorkspaceId } from "./ids";

const AT = new Date("2026-09-19T12:00:00.000Z");
const WS = toWorkspaceId("01a0b40c-0000-7000-8000-0000000000w1".replace("w", "a"));
const BP = toBusinessProfileId("01a0b40c-0000-7000-8000-0000000000b1".replace("b", "a"));
const CA = toChannelAccountId("01a0b40c-0000-7000-8000-0000000000c1".replace("c", "a"));

const target = { workspaceId: WS, businessProfileId: BP, channelAccountId: CA };

const suspension = (overrides: Partial<AutomationSuspension> = {}): AutomationSuspension => ({
  scope: "BUSINESS_PROFILE",
  workspaceId: WS,
  businessProfileId: BP,
  reason: "OPERATOR",
  since: AT,
  ...overrides,
});

describe("the kill switch stops outbound at a chosen scope", () => {
  it("stops a send at every scope that covers it", () => {
    for (const scope of ["GLOBAL", "WORKSPACE", "BUSINESS_PROFILE", "CHANNEL_ACCOUNT"] as const) {
      const applies = suspension({ scope, ...(scope === "GLOBAL" ? { workspaceId: undefined } : {}), channelAccountId: CA });
      expect(automatedOutboundAllowed(target, [applies], AT)).toBe(false);
    }
  });

  it("leaves other tenants alone", () => {
    const elsewhere = suspension({ workspaceId: toWorkspaceId("01a0b40c-0000-7000-8000-00000000000f") });

    // One expired credential must not silence a platform, which is the whole reason scopes exist.
    expect(automatedOutboundAllowed(target, [elsewhere], AT)).toBe(true);
  });

  it("reports which suspension applies, widest first", () => {
    const narrow = suspension({ scope: "CHANNEL_ACCOUNT", channelAccountId: CA, reason: "CHANNEL_UNHEALTHY" });
    const wide = suspension({ scope: "GLOBAL", workspaceId: undefined, businessProfileId: undefined, reason: "OPERATOR" });

    // "Paused for this account" and "paused everywhere" are different things to the person reading it.
    expect(activeSuspension(target, [narrow, wide], AT)?.scope).toBe("GLOBAL");
    expect(activeSuspension(target, [narrow], AT)?.reason).toBe("CHANNEL_UNHEALTHY");
  });

  it("ignores one that has not started or has already lapsed", () => {
    const future = suspension({ since: new Date(AT.getTime() + 60_000) });
    const lapsed = suspension({ until: new Date(AT.getTime() - 1) });

    expect(automatedOutboundAllowed(target, [future], AT)).toBe(true);
    expect(automatedOutboundAllowed(target, [lapsed], AT)).toBe(true);
    // A precaution with no end stays until a person lifts it, which is the safe default.
    expect(automatedOutboundAllowed(target, [suspension()], new Date(AT.getTime() + 10 * 365 * 24 * 3_600_000))).toBe(false);
  });

  it("refuses a narrow scope that names nothing, because it would be a global stop in disguise", () => {
    expect(() => createAutomationSuspension(suspension({ scope: "BUSINESS_PROFILE", businessProfileId: undefined }))).toThrow(/businessProfileId/);
    expect(() => createAutomationSuspension(suspension({ scope: "WORKSPACE", workspaceId: undefined }))).toThrow(/workspaceId/);
    expect(() => createAutomationSuspension(suspension({ scope: "CHANNEL_ACCOUNT", channelAccountId: undefined }))).toThrow(/channelAccountId/);
    expect(() => createAutomationSuspension(suspension({ until: AT }))).toThrow(/until/);
    expect(createAutomationSuspension(suspension()).scope).toBe("BUSINESS_PROFILE");
  });
});

describe("health degrades by capability, not by tenant", () => {
  const component = (overrides: Partial<ComponentHealth>): ComponentHealth => ({
    kind: "CHANNEL_ACCOUNT",
    id: CA,
    state: "OPERATIONAL",
    summary: "connected",
    since: AT,
    ...overrides,
  });

  it("lets the worst component decide the single line at the top", () => {
    expect(overallHealth([])).toBe("ALL_SYSTEMS_OPERATIONAL");
    expect(overallHealth([component({ state: "DEGRADED", summary: "replies delayed" })])).toBe("SOME_FEATURES_DEGRADED");
    expect(
      overallHealth([component({ state: "DEGRADED" }), component({ id: "other", state: "ACTION_REQUIRED", summary: "reconnect needed" })]),
    ).toBe("ACTION_REQUIRED");
  });

  it("blocks outbound only for the things that make a send unsafe", () => {
    const aiDown = component({ kind: "AI_PROVIDER", id: "anthropic", state: "ACTION_REQUIRED", summary: "unavailable" });
    const otherChannel = component({ id: "another-account", state: "ACTION_REQUIRED", summary: "reconnect needed" });
    const thisChannel = component({ state: "ACTION_REQUIRED", summary: "reconnect needed" });
    const dbDown = component({ kind: "DATABASE", id: "primary", state: "ACTION_REQUIRED", summary: "unavailable" });

    // No new drafts is a delay, and delay is the right outcome — not a halt of what was already approved.
    expect(outboundBlockedByHealth([aiDown], CA)).toBe(false);
    // Another account's problem is not this account's problem.
    expect(outboundBlockedByHealth([otherChannel], CA)).toBe(false);
    expect(outboundBlockedByHealth([thisChannel], CA)).toBe(true);
    // Nothing can be claimed durably without the database, so nothing may be sent.
    expect(outboundBlockedByHealth([dbDown], CA)).toBe(true);
  });
});

describe("one outage is one incident", () => {
  const signal = (overrides: Partial<FailureSignal> = {}): FailureSignal => ({
    kind: "AI_PROVIDER",
    id: "anthropic",
    code: "TIMEOUT",
    at: AT,
    ...overrides,
  });

  it("folds many identical failures into one, with a count", () => {
    const incidents = aggregateIncidents([
      signal({ conversationId: "conv_1" }),
      signal({ conversationId: "conv_2", at: new Date(AT.getTime() + 1_000) }),
      signal({ conversationId: "conv_1", at: new Date(AT.getTime() + 2_000) }),
    ]);

    expect(incidents).toHaveLength(1);
    // Four hundred identical alerts carry the same information as none, and cost more attention.
    expect(incidents[0]).toMatchObject({ occurrences: 3, affectedConversations: 2 });
    expect(incidents[0]?.firstSeen.toISOString()).toBe(AT.toISOString());
    expect(incidents[0]?.lastSeen.toISOString()).toBe(new Date(AT.getTime() + 2_000).toISOString());
  });

  it("keeps different failures apart, because they need different actions", () => {
    const incidents = aggregateIncidents([signal(), signal({ code: "UNAUTHORIZED" }), signal({ kind: "CHANNEL_ACCOUNT", id: CA, code: "TIMEOUT" })]);

    expect(incidents).toHaveLength(3);
  });

  it("produces the same result whatever order the failures arrive in", () => {
    const signals = [signal({ conversationId: "a" }), signal({ conversationId: "b", at: new Date(AT.getTime() + 5) }), signal({ code: "UNAUTHORIZED" })];

    expect(JSON.stringify(aggregateIncidents(signals))).toBe(JSON.stringify(aggregateIncidents([...signals].reverse())));
  });

  it("notifies for sustained or widespread failure, and stays quiet for a blip", () => {
    const thresholds = { occurrences: 5, conversations: 3 };
    const blip = aggregateIncidents([signal({ conversationId: "conv_1" })])[0];
    const sustained = aggregateIncidents(Array.from({ length: 6 }, (_v, i) => signal({ conversationId: `conv_${String(i)}` })))[0];

    // An alert for a single retryable blip trains people to ignore alerts.
    expect(blip === undefined ? false : warrantsNotification(blip, thresholds)).toBe(false);
    expect(sustained === undefined ? false : warrantsNotification(sustained, thresholds)).toBe(true);
  });
});
