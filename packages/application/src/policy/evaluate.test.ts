import { NO_CAPABILITIES, toQuietHours, type ReasonCode } from "@omnichannel/domain";
import { describe, expect, it } from "vitest";

import { evaluatePolicy } from "./evaluate";
import type { PolicyInput } from "./inputs";

const NOW = new Date("2026-09-18T12:00:00.000Z");
const TEXT_ONLY = { ...NO_CAPABILITIES, text: true };

/**
 * A conversation where every gate passes. Each case below changes exactly one thing, so a failure names the
 * gate that broke rather than "the policy changed".
 */
const passing = (): PolicyInput => ({
  mode: "AUTOPILOT",
  aiEnabled: true,
  takeover: { state: "NONE" },
  draft: { usable: true, confidence: 0.9, reasonCodes: [], citedSourceIds: ["chunk_1"], contentType: "TEXT" },
  retrieval: { suppliedSourceIds: ["chunk_1", "chunk_2"], corpusReachable: true },
  limits: {
    confidenceThreshold: 0.8,
    mandatoryReviewReasons: ["MISSING_FACT", "PAYMENT_DISPUTE", "LEGAL_INTERPRETATION", "HIGH_VALUE_COMMITMENT"],
    afterWindow: { channel: "INSTAGRAM", policy: "STANDARD_ONLY" },
  },
  account: "CONNECTED",
  capabilities: TEXT_ONLY,
  window: { state: "OPEN_FREEFORM", expiresAt: new Date(NOW.getTime() + 60_000) },
  humanAgent: { state: "UNAVAILABLE", reason: "NOT_APPROVED" },
  replyCycle: "OWNED",
  now: NOW,
});

const decide = (overrides: Partial<PolicyInput> = {}) => evaluatePolicy({ ...passing(), ...overrides });

describe("the only path to an automatic send", () => {
  it("schedules when every gate passes, and carries no reasons", () => {
    expect(decide()).toEqual({ action: "SCHEDULE", reasons: [] });
  });

  it("never schedules on the strength of the model's own advice", () => {
    // `should_send` is not an input at all. A draft cannot argue its way past a gate.
    const held = decide({ draft: { ...passing().draft, confidence: 0.1 } });

    expect(held.action).toBe("HOLD_REVIEW");
    expect(Object.keys(passing().draft)).not.toContain("shouldSend");
  });
});

/** Each row fails exactly one gate and states what must come out. */
const gates: { name: string; input: Partial<PolicyInput>; action: "SKIP" | "HOLD_REVIEW"; reason: ReasonCode }[] = [
  { name: "mode OFF", input: { mode: "OFF" }, action: "SKIP", reason: "MODE_NOT_AUTOPILOT" },
  { name: "mode DRAFT", input: { mode: "DRAFT" }, action: "HOLD_REVIEW", reason: "MODE_NOT_AUTOPILOT" },
  { name: "AI disabled", input: { aiEnabled: false }, action: "SKIP", reason: "AI_DISABLED" },
  {
    name: "a human owns the conversation",
    input: { takeover: { state: "HUMAN_ACTIVE", reason: "HUMAN_SENT_FROM_INBOX", since: NOW } },
    action: "SKIP",
    reason: "HUMAN_TAKEOVER",
  },
  {
    name: "a review is already pending",
    input: { takeover: { state: "REVIEW_REQUIRED", reason: "MANDATORY_REVIEW", reviewMode: "NORMAL", since: NOW } },
    action: "HOLD_REVIEW",
    reason: "REVIEW_PENDING",
  },
  { name: "the customer has spoken since", input: { replyCycle: "SUPERSEDED" }, action: "SKIP", reason: "SUPERSEDED_BY_NEWER_INBOUND" },
  {
    name: "the generation was unusable",
    input: { draft: { usable: false, confidence: 0, reasonCodes: [], citedSourceIds: [], contentType: "TEXT" } },
    action: "HOLD_REVIEW",
    reason: "INVALID_MODEL_OUTPUT",
  },
  { name: "the account needs re-auth", input: { account: "NEEDS_REAUTH" }, action: "HOLD_REVIEW", reason: "ACCOUNT_UNHEALTHY" },
  { name: "the account is disconnected", input: { account: "DISCONNECTED" }, action: "HOLD_REVIEW", reason: "ACCOUNT_UNHEALTHY" },
  {
    name: "confidence is below the threshold",
    input: { draft: { usable: true, confidence: 0.79, reasonCodes: [], citedSourceIds: [], contentType: "TEXT" } },
    action: "HOLD_REVIEW",
    reason: "LOW_CONFIDENCE",
  },
  {
    name: "a mandatory-review category is present",
    input: { draft: { usable: true, confidence: 0.95, reasonCodes: ["PAYMENT_DISPUTE"], citedSourceIds: [], contentType: "TEXT" } },
    action: "HOLD_REVIEW",
    reason: "PAYMENT_DISPUTE",
  },
  {
    name: "the factual corpus could not be consulted",
    input: { retrieval: { suppliedSourceIds: [], corpusReachable: false } },
    action: "HOLD_REVIEW",
    reason: "RETRIEVAL_UNAVAILABLE",
  },
  {
    name: "a citation was never supplied",
    input: { draft: { usable: true, confidence: 0.95, reasonCodes: [], citedSourceIds: ["invented"], contentType: "TEXT" } },
    action: "HOLD_REVIEW",
    reason: "MISSING_FACT",
  },
  { name: "the channel cannot send this content", input: { capabilities: NO_CAPABILITIES }, action: "HOLD_REVIEW", reason: "UNSUPPORTED_MEDIA" },
  {
    // No permitted send path exists under STANDARD_ONLY, so a review item would be one nobody could act on.
    name: "the standard window is closed",
    input: { window: { state: "NOT_ELIGIBLE", reason: "standard messaging window closed" } },
    action: "SKIP",
    reason: "WINDOW_CLOSED",
  },
  {
    name: "the window state is unknown",
    input: { window: { state: "UNKNOWN", reason: "channel account is not connected" } },
    action: "SKIP",
    reason: "WINDOW_CLOSED",
  },
  {
    // Quiet hours block only when there is no compliant later time; here waiting would miss the deadline.
    name: "quiet hours run past the provider's dispatch deadline",
    input: {
      limits: { ...passing().limits, quietHours: toQuietHours("UTC", "22:00", "23:00") },
      now: new Date("2026-09-18T22:30:00.000Z"),
      dispatchDeadline: new Date("2026-09-18T22:30:30.000Z"),
      window: { state: "OPEN_FREEFORM", expiresAt: new Date("2026-09-19T22:00:00.000Z") },
    },
    action: "HOLD_REVIEW",
    reason: "QUIET_HOURS",
  },
];

describe("every gate fails independently", () => {
  for (const gate of gates) {
    it(`blocks when ${gate.name}`, () => {
      const decision = decide(gate.input);

      expect(decision.action).toBe(gate.action);
      expect(decision.reasons).toContain(gate.reason);
    });
  }

  it("covers every gate the specification lists", () => {
    // A gate with no row here is a gate nobody is testing.
    expect(gates).toHaveLength(17);
  });
});

describe("the window is a fact about time, not a stored verdict", () => {
  it("treats an already-expired open window as closed", () => {
    // The decision may have been computed a moment ago; a stale "open" is exactly the race that sends a
    // message out of window.
    const decision = decide({ window: { state: "OPEN_FREEFORM", expiresAt: new Date(NOW.getTime() - 1) } });

    expect(decision.reasons).toContain("WINDOW_CLOSED");
    expect(decision.action).toBe("SKIP");
  });

  it("accepts an open window with no stated expiry", () => {
    expect(decide({ window: { state: "OPEN_FREEFORM" } })).toEqual({ action: "SCHEDULE", reasons: [] });
  });
});

describe("Instagram after-window policy (ADR-014)", () => {
  const closed = { state: "NOT_ELIGIBLE", reason: "standard messaging window closed" } as const;

  it("STANDARD_ONLY never offers the human-agent path, even when it is available", () => {
    const decision = decide({
      window: closed,
      limits: { ...passing().limits, afterWindow: { channel: "INSTAGRAM", policy: "STANDARD_ONLY" } as const },
      humanAgent: { state: "ELIGIBLE", expiresAt: new Date(NOW.getTime() + 3_600_000) },
    });

    // The business chose the stricter policy, so there is no send path and no review item to create.
    expect(decision).toEqual({ action: "SKIP", reasons: ["WINDOW_CLOSED"] });
  });

  it("HUMAN_ASSISTED_EXTENDED returns a human-agent review when eligibility is current", () => {
    const decision = decide({
      window: closed,
      limits: { ...passing().limits, afterWindow: { channel: "INSTAGRAM", policy: "HUMAN_ASSISTED_EXTENDED" } as const },
      humanAgent: { state: "ELIGIBLE", expiresAt: new Date(NOW.getTime() + 3_600_000) },
    });

    // A review path, never a schedule: only a deliberate human action may initiate the tagged send.
    expect(decision).toEqual({
      action: "HOLD_REVIEW",
      reasons: ["HUMAN_AGENT_REVIEW_REQUIRED", "WINDOW_CLOSED"],
      reviewMode: "HUMAN_AGENT",
    });
  });

  for (const reason of ["EXPIRED", "NOT_APPROVED", "UNKNOWN", "NOT_SUPPORTED"] as const) {
    it(`HUMAN_ASSISTED_EXTENDED does not invent eligibility when it is ${reason}`, () => {
      const decision = decide({
        window: closed,
        limits: { ...passing().limits, afterWindow: { channel: "INSTAGRAM", policy: "HUMAN_ASSISTED_EXTENDED" } as const },
        humanAgent: { state: "UNAVAILABLE", reason },
      });

      // Eligibility is never invented, so there is no human path either: nothing to review.
      expect(decision).toEqual({ action: "SKIP", reasons: ["WINDOW_CLOSED"] });
    });
  }

  it("never schedules an unattended send while the window is closed, under either policy", () => {
    for (const policy of ["STANDARD_ONLY", "HUMAN_ASSISTED_EXTENDED"] as const) {
      for (const humanAgent of [
        { state: "ELIGIBLE", expiresAt: new Date(NOW.getTime() + 3_600_000) } as const,
        { state: "UNAVAILABLE", reason: "EXPIRED" } as const,
      ]) {
        const decision = decide({
          window: closed,
          limits: { ...passing().limits, afterWindow: { channel: "INSTAGRAM", policy } },
          humanAgent,
        });

        expect(decision.action).not.toBe("SCHEDULE");
      }
    }
  });

  it("keeps an existing human-agent review claim while the path is still usable", () => {
    const decision = decide({
      takeover: { state: "REVIEW_REQUIRED", reason: "HUMAN_AGENT_REVIEW", reviewMode: "HUMAN_AGENT", since: NOW },
      limits: { ...passing().limits, afterWindow: { channel: "INSTAGRAM", policy: "HUMAN_ASSISTED_EXTENDED" } as const },
      humanAgent: { state: "ELIGIBLE", expiresAt: new Date(NOW.getTime() + 3_600_000) },
    });

    expect(decision).toMatchObject({ action: "HOLD_REVIEW", reviewMode: "HUMAN_AGENT" });
  });

  it("drops a human-agent claim once the exception has expired", () => {
    const decision = decide({
      takeover: { state: "REVIEW_REQUIRED", reason: "HUMAN_AGENT_REVIEW", reviewMode: "HUMAN_AGENT", since: NOW },
      limits: { ...passing().limits, afterWindow: { channel: "INSTAGRAM", policy: "HUMAN_ASSISTED_EXTENDED" } as const },
      humanAgent: { state: "UNAVAILABLE", reason: "EXPIRED" },
    });

    // A review mode is a promise about which button will work. Showing HUMAN_AGENT here would send the
    // operator to a send the adapter re-checks and refuses at dispatch.
    expect(decision).toMatchObject({ action: "HOLD_REVIEW", reviewMode: "NORMAL" });
  });

  it("does not offer the human-agent path when the business chose STANDARD_ONLY, even mid-claim", () => {
    const decision = decide({
      takeover: { state: "REVIEW_REQUIRED", reason: "HUMAN_AGENT_REVIEW", reviewMode: "HUMAN_AGENT", since: NOW },
      limits: { ...passing().limits, afterWindow: { channel: "INSTAGRAM", policy: "STANDARD_ONLY" } as const },
      humanAgent: { state: "ELIGIBLE", expiresAt: new Date(NOW.getTime() + 3_600_000) },
    });

    expect(decision).toMatchObject({ action: "HOLD_REVIEW", reviewMode: "NORMAL" });
  });

  it("carries a WhatsApp policy without ever reaching the Instagram exception", () => {
    const decision = decide({
      window: closed,
      limits: { ...passing().limits, afterWindow: { channel: "WHATSAPP", policy: "TEMPLATE_REVIEW" } as const },
      humanAgent: { state: "ELIGIBLE", expiresAt: new Date(NOW.getTime() + 3_600_000) },
    });

    // The union is what makes an Instagram-only exception unrepresentable on another channel, rather than
    // merely discouraged by a comment.
    expect(decision).toEqual({ action: "SKIP", reasons: ["WINDOW_CLOSED"] });
  });
});

describe("gates combine instead of hiding one another", () => {
  it("reports every failing gate, not the first", () => {
    const decision = decide({
      draft: { usable: true, confidence: 0.2, reasonCodes: ["LEGAL_INTERPRETATION"], citedSourceIds: ["invented"], contentType: "TEXT" },
      account: "NEEDS_REAUTH",
      window: { state: "NOT_ELIGIBLE", reason: "closed" },
      retrieval: { suppliedSourceIds: [], corpusReachable: false },
    });

    // An operator who fixes one thing and retries should not meet the next wall one at a time.
    expect(decision.reasons).toEqual([
      "ACCOUNT_UNHEALTHY",
      "LEGAL_INTERPRETATION",
      "LOW_CONFIDENCE",
      "MISSING_FACT",
      "RETRIEVAL_UNAVAILABLE",
      "WINDOW_CLOSED",
    ]);
    // A closed window under STANDARD_ONLY ends the matter even when other gates also failed.
    expect(decision.action).toBe("SKIP");
  });

  it("lets a terminal reason win over reasons that would otherwise ask for a human", () => {
    const decision = decide({ mode: "OFF", draft: { ...passing().draft, confidence: 0.1 } });

    // OFF produces no review item: the business has not opted into automation for this conversation.
    expect(decision.action).toBe("SKIP");
    expect(decision.reasons).toContain("MODE_NOT_AUTOPILOT");
    expect(decision.reasons).toContain("LOW_CONFIDENCE");
  });

  it("orders reasons stably, so two runs produce identical audit rows", () => {
    const once = decide({ account: "DISCONNECTED", window: { state: "UNKNOWN", reason: "x" } });
    const again = decide({ window: { state: "UNKNOWN", reason: "x" }, account: "DISCONNECTED" });

    expect(once).toEqual(again);
    expect(once.reasons).toEqual(["ACCOUNT_UNHEALTHY", "WINDOW_CLOSED"]);
  });
});

describe("the confidence threshold", () => {
  it("lets a draft exactly at the threshold through, and blocks the smallest step below it", () => {
    const at = decide({ draft: { ...passing().draft, confidence: 0.8 } });
    const below = decide({ draft: { ...passing().draft, confidence: 0.8 - Number.EPSILON } });

    // "Meets the threshold" includes equality; an off-by-one here silently holds every borderline draft.
    expect(at).toEqual({ action: "SCHEDULE", reasons: [] });
    expect(below.reasons).toContain("LOW_CONFIDENCE");
  });
});

describe("mandatory-review categories", () => {
  it("only raises categories the business actually marked mandatory", () => {
    const decision = decide({
      draft: { usable: true, confidence: 0.95, reasonCodes: ["UNSUPPORTED_PROMISE"], citedSourceIds: [], contentType: "TEXT" },
      limits: { ...passing().limits, mandatoryReviewReasons: ["PAYMENT_DISPUTE"] },
    });

    // The code travels with the draft for the audit trail, but this business did not make it a gate.
    expect(decision).toEqual({ action: "SCHEDULE", reasons: [] });
  });

  it("cannot be disabled by the model restating its own codes", () => {
    const decision = decide({
      draft: { usable: true, confidence: 0.99, reasonCodes: ["PAYMENT_DISPUTE", "PAYMENT_DISPUTE"], citedSourceIds: [], contentType: "TEXT" },
    });

    expect(decision.reasons).toEqual(["PAYMENT_DISPUTE"]);
  });
});

describe("quiet hours defer rather than block", () => {
  const quiet = { ...passing().limits, quietHours: toQuietHours("Europe/Berlin", "22:00", "07:00") };
  /** Far enough ahead that the quiet period always fits inside it. */
  const openWindow = { state: "OPEN_FREEFORM", expiresAt: new Date("2026-09-30T00:00:00.000Z") } as const;

  it("schedules for the end of the period when that time is still permitted", () => {
    // 23:30 in Berlin is 21:30 UTC: a UTC comparison would call this outside quiet hours.
    const decision = decide({ limits: quiet, now: new Date("2026-09-18T21:30:00.000Z"), window: openWindow });

    expect(decision.action).toBe("SCHEDULE");
    expect(decision.reasons).toEqual([]);
    // 07:00 Berlin the next morning, which is 05:00 UTC.
    expect(decision.action === "SCHEDULE" ? decision.notBefore?.toISOString() : undefined).toBe("2026-09-19T05:00:00.000Z");
  });

  it("does not defer at all outside the period", () => {
    const decision = decide({ limits: quiet, now: new Date("2026-09-18T12:00:00.000Z"), window: openWindow });

    expect(decision).toEqual({ action: "SCHEDULE", reasons: [] });
  });

  it("holds instead of deferring when waiting would miss the provider's deadline", () => {
    // Instagram's automated budget is seconds long, so there is never a compliant later time on it.
    const decision = decide({
      limits: quiet,
      now: new Date("2026-09-18T21:30:00.000Z"),
      window: openWindow,
      dispatchDeadline: new Date("2026-09-18T21:30:25.000Z"),
    });

    expect(decision).toMatchObject({ action: "HOLD_REVIEW", reviewMode: "NORMAL" });
    expect(decision.reasons).toContain("QUIET_HOURS");
  });

  it("holds instead of deferring when the messaging window closes first", () => {
    const decision = decide({
      limits: quiet,
      now: new Date("2026-09-18T21:30:00.000Z"),
      window: { state: "OPEN_FREEFORM", expiresAt: new Date("2026-09-19T01:00:00.000Z") },
    });

    // Deferring past the window would be a send the provider does not permit; quiet hours must never
    // cause a blind late send.
    expect(decision.reasons).toContain("QUIET_HOURS");
    expect(decision.action).toBe("HOLD_REVIEW");
  });

  it("treats the end of the period as open again", () => {
    // 07:00 Berlin is 05:00 UTC; `end` is exclusive so the first allowed minute is exactly 07:00.
    const atEnd = decide({ limits: quiet, now: new Date("2026-09-18T05:00:00.000Z"), window: openWindow });
    const justBefore = decide({ limits: quiet, now: new Date("2026-09-18T04:59:00.000Z"), window: openWindow });

    expect(atEnd).toEqual({ action: "SCHEDULE", reasons: [] });
    expect(justBefore.action).toBe("SCHEDULE");
    expect(justBefore.action === "SCHEDULE" ? justBefore.notBefore?.toISOString() : undefined).toBe("2026-09-18T05:00:00.000Z");
  });
});

describe("purity", () => {
  it("returns the same decision for the same input, and never mutates it", () => {
    const input = passing();
    // A pure package has no `structuredClone`; serialising is enough to catch a mutated input here.
    const snapshot = JSON.stringify(input);

    const first = evaluatePolicy(input);
    const second = evaluatePolicy(input);

    expect(first).toEqual(second);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
