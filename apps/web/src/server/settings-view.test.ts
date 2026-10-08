/**
 * The AI-settings screen's own decisions, run without a request or a database (Issue #30).
 *
 * Every case here is one of Astra's R5 findings expressed as a property:
 *
 * - a refused high-impact change must come back with the values that were proposed, not the stored ones;
 * - an acknowledgement must name the impacts it acknowledges, so a tick cannot stand for a summary that
 *   was never shown;
 * - the history must be reachable past its first page, and show both sides of every field that moved;
 * - the playground's channel, window and connection must be chosen rather than assumed.
 *
 * They are tested here rather than through the page because each is a rule, and a rule that can only be
 * exercised by rendering a route is a rule nobody re-tests after the next redesign.
 */
import { describe, expect, it } from "vitest";

import {
  acknowledges,
  auditHistoryHref,
  decodeAuditCursor,
  decodeProposal,
  encodeAuditCursor,
  encodeProposal,
  impactsFromQuery,
  MAX_PROPOSAL_FIELD_CHARS,
  mayEditSettings,
  policyChangeDiff,
  simulationInputsFrom,
  type PolicyProposal,
} from "./settings-view";

const PROPOSAL: PolicyProposal = {
  mode: "AUTOPILOT",
  businessGoal: "Book consultations",
  qualificationCriteria: ["has a budget", "wants a date this month"],
  confidencePreset: "AGGRESSIVE",
  timingPreset: "CUSTOM",
  timing: { debounceWindowMs: { minMs: 2_000, maxMs: 5_000 }, deliveryDelayMs: { minMs: 6_000, maxMs: 11_000 } },
  takeoverPauseHours: 12,
  instagramAfterWindowPolicy: "HUMAN_ASSISTED_EXTENDED",
  whatsappAfterWindowPolicy: "TEMPLATE_AUTOPILOT",
  whatsappTemplateAutomationAllowlist: ["booking_reminder"],
  expectedVersion: 7,
};

describe("the refused proposal", () => {
  it("survives the round trip whole", () => {
    // The finding: the refusal used to carry only the impact codes, so the form was rebuilt from stored
    // values and the effect summary ended up describing a change that was no longer on screen.
    expect(decodeProposal(encodeProposal(PROPOSAL))).toEqual(PROPOSAL);
  });

  it("is URL-safe, so the link that carries it survives being a link", () => {
    const encoded = encodeProposal(PROPOSAL);

    expect(encoded).toBe(encodeURIComponent(encoded));
  });

  it("is absent rather than partial when the version is not a usable number", () => {
    for (const version of [0, -1, 1.5, "7", null]) {
      const encoded = Buffer.from(JSON.stringify({ ...PROPOSAL, expectedVersion: version }), "utf8").toString("base64url");

      // Without a version there is nothing to bind an acknowledgement to, so there is no proposal —
      // the form falls back to the stored values and the save is refused by the store's own check.
      expect(decodeProposal(encoded), `version ${String(version)}`).toBeUndefined();
    }
  });

  it("drops a value nobody defined instead of carrying it into a save", () => {
    const encoded = Buffer.from(
      JSON.stringify({ ...PROPOSAL, mode: "SEMI_AUTO", instagramAfterWindowPolicy: "ANYTHING_GOES", whatsappAfterWindowPolicy: "" }),
      "utf8",
    ).toString("base64url");

    const decoded = decodeProposal(encoded);

    // The parameter is user-editable. A mode nobody defined reads as "this proposal says nothing about
    // the mode", which the save then takes from the stored policy.
    expect(decoded?.mode).toBeUndefined();
    expect(decoded?.instagramAfterWindowPolicy).toBeUndefined();
    expect(decoded?.whatsappAfterWindowPolicy).toBeUndefined();
    expect(decoded?.expectedVersion).toBe(7);
  });

  it("keeps a timing range out when it is not fully a range", () => {
    for (const timing of [
      { debounceWindowMs: { minMs: 1_000 }, deliveryDelayMs: { minMs: 1_000, maxMs: 2_000 } },
      { debounceWindowMs: { minMs: 1_000, maxMs: 2_000 } },
      { debounceWindowMs: { minMs: -1, maxMs: 2_000 }, deliveryDelayMs: { minMs: 1_000, maxMs: 2_000 } },
      "fast",
    ]) {
      const encoded = Buffer.from(JSON.stringify({ ...PROPOSAL, timing }), "utf8").toString("base64url");

      // Half a range would be completed from stored values, which mixes a typed number with a previous
      // one and produces a window the owner never chose.
      expect(decodeProposal(encoded)?.timing, JSON.stringify(timing)).toBeUndefined();
    }
  });

  it("refuses a goal longer than the round trip can carry, rather than truncating it", () => {
    const encoded = Buffer.from(JSON.stringify({ ...PROPOSAL, businessGoal: "x".repeat(MAX_PROPOSAL_FIELD_CHARS + 1) }), "utf8").toString("base64url");

    expect(decodeProposal(encoded)).toBeUndefined();
  });

  it("is absent for anything that is not a proposal at all", () => {
    for (const encoded of [undefined, "", "not base64url!!", Buffer.from("[]", "utf8").toString("base64url"), Buffer.from("{", "utf8").toString("base64url")]) {
      expect(decodeProposal(encoded), String(encoded)).toBeUndefined();
    }
  });
});

describe("the acknowledgement", () => {
  it("covers exactly the impacts that were computed", () => {
    expect(acknowledges(["AUTOPILOT_ENABLED", "CONFIDENCE_LOWERED"], ["CONFIDENCE_LOWERED", "AUTOPILOT_ENABLED"])).toBe(true);
  });

  it("does not cover a different set, in either direction", () => {
    // Fewer: the owner acknowledged one thing and the save would do two.
    expect(acknowledges(["AUTOPILOT_ENABLED"], ["AUTOPILOT_ENABLED", "CONFIDENCE_LOWERED"])).toBe(false);
    // More: the list the owner read is not the list the server computed, which is equally wrong.
    expect(acknowledges(["AUTOPILOT_ENABLED", "CONFIDENCE_LOWERED"], ["AUTOPILOT_ENABLED"])).toBe(false);
  });

  it("is not satisfied by a flag", () => {
    // The finding: the checkbox was always rendered and the server only asked whether `confirm=on` had
    // been posted, so "show the effect summary before save" was skippable by ticking it first. A bare
    // affirmative now acknowledges nothing.
    expect(acknowledges(["on"], ["AUTOPILOT_ENABLED"])).toBe(false);
    expect(acknowledges([], ["AUTOPILOT_ENABLED"])).toBe(false);
  });

  it("is satisfied by nothing when nothing widens", () => {
    expect(acknowledges([], [])).toBe(true);
  });

  it("reads only impacts the domain defines out of a URL", () => {
    expect(impactsFromQuery("AUTOPILOT_ENABLED, NOT_A_REAL_IMPACT ,CONFIDENCE_LOWERED")).toEqual(["AUTOPILOT_ENABLED", "CONFIDENCE_LOWERED"]);
    expect(impactsFromQuery(undefined)).toEqual([]);
  });
});

describe("the history's cursor", () => {
  it("round-trips the instant and the row it ended on", () => {
    const cursor = { changedAt: new Date("2026-09-01T10:00:00.000Z"), id: "pca_1" };

    expect(decodeAuditCursor(encodeAuditCursor(cursor))).toEqual(cursor);
  });

  it("is absent for anything this module did not write", () => {
    for (const encoded of [undefined, "", "nonsense", Buffer.from("no separator", "utf8").toString("base64url"), Buffer.from("not-a-date|pca_1", "utf8").toString("base64url"), Buffer.from("2026-09-01T10:00:00.000Z|", "utf8").toString("base64url")]) {
      expect(decodeAuditCursor(encoded), String(encoded)).toBeUndefined();
    }
  });

  it("keeps the rest of the URL when it continues the history", () => {
    const proposal = encodeProposal(PROPOSAL);
    const href = auditHistoryHref(
      "/settings",
      { ask: "do you deliver?", simChannel: "WHATSAPP", auditCursor: "stale", outcome: "CONFIRM", impacts: "AUTOPILOT_ENABLED", proposal },
      { changedAt: new Date("2026-09-01T10:00:00.000Z"), id: "pca_9" },
    );

    // The playground's question and inputs survive paging the history: losing them would re-run the
    // simulation with different inputs for no reason the reader could see.
    expect(href).toContain("ask=do+you+deliver%3F");
    expect(href).toContain("simChannel=WHATSAPP");
    // And so does a pending confirmation. Reading the history is exactly what somebody does *before*
    // acknowledging a change, and dropping the proposal there would silently reset the form they were
    // about to confirm — the same defect as the refusal that forgot what was proposed.
    expect(decodeProposal(new URLSearchParams(href.slice(href.indexOf("?") + 1)).get("proposal") ?? undefined)).toEqual(PROPOSAL);
    expect(href).toContain("impacts=AUTOPILOT_ENABLED");
    // And the old cursor is replaced rather than repeated, or the link would not advance.
    expect(href.match(/auditCursor=/gu)).toHaveLength(1);
    expect(href).not.toContain("auditCursor=stale");
  });
});

describe("what a change actually changed", () => {
  it("reports both sides of every field that moved, and no field that did not", () => {
    const changes = policyChangeDiff(
      { mode: "DRAFT", businessGoal: "Answer questions", confidenceThreshold: 0.8, takeoverPauseMs: 21_600_000 },
      { mode: "AUTOPILOT", businessGoal: "Answer questions", confidenceThreshold: 0.65, takeoverPauseMs: 21_600_000 },
    );

    // The finding: the screen rendered actor, time and impact labels only, so the old and new values the
    // spec requires were stored and never shown.
    expect(changes).toEqual([
      { field: "mode", before: "DRAFT", after: "AUTOPILOT" },
      { field: "confidenceThreshold", before: "0.8", after: "0.65" },
    ]);
  });

  it("does not report a list that was merely reordered", () => {
    const changes = policyChangeDiff(
      { mandatoryReviewReasons: ["PAYMENT_DISPUTE", "LOW_CONFIDENCE"] },
      { mandatoryReviewReasons: ["LOW_CONFIDENCE", "PAYMENT_DISPUTE"] },
    );

    // `mandatoryReviewReasons` is written from a Set, so its order is an implementation detail; reporting
    // it would make every save look like it touched the review topics.
    expect(changes).toEqual([]);
  });

  it("distinguishes a field that was absent from a field that was empty", () => {
    const changes = policyChangeDiff({ businessGoal: null }, { businessGoal: "Book consultations" });
    expect(changes).toEqual([{ field: "businessGoal", before: "", after: "Book consultations" }]);

    const added = policyChangeDiff({}, { businessGoal: "Book consultations" });
    // No `before` key at all, rather than an empty one: "there was no goal recorded" and "the goal was
    // blank" are different facts, and the audit's own JSON keeps them apart.
    expect(added).toEqual([{ field: "businessGoal", after: "Book consultations" }]);
  });

  it("says nothing about a snapshot that is not an object", () => {
    expect(policyChangeDiff(null, { mode: "DRAFT" })).toEqual([]);
    expect(policyChangeDiff("DRAFT", "AUTOPILOT")).toEqual([]);
  });

  it("tells two nested values apart rather than calling both an object", () => {
    // Every audited field is a scalar or a list of them today. The snapshots are stored JSON, so a field
    // that is neither would render as the same four words on both sides — and a change would be reported
    // as no change.
    expect(policyChangeDiff({ qualificationCriteria: [{ a: 1 }] }, { qualificationCriteria: [{ a: 2 }] })).toEqual([
      { field: "qualificationCriteria", before: '{"a":1}', after: '{"a":2}' },
    ]);
  });

  it("ignores a stored field the screen has no label for", () => {
    // Named fields only. A column added to the policy table would otherwise reach this screen with no
    // label and no translation, which the i18n gate cannot catch because it depends on stored data.
    expect(policyChangeDiff({ quietHoursStart: "22:00" }, { quietHoursStart: "23:00" })).toEqual([]);
  });
});

describe("the playground's hypothetical facts", () => {
  it("defaults to the case where something would actually be sent, except the exception", () => {
    // Three permissive defaults and one conservative: a human-support exception is something a business
    // has to have been approved for, and assuming it would show a review path their account may not have.
    expect(simulationInputsFrom({})).toEqual({ channel: "INSTAGRAM", window: "OPEN", account: "CONNECTED", humanSupport: "UNAVAILABLE" });
  });

  it("takes all four from the link", () => {
    expect(
      simulationInputsFrom({ simChannel: "WHATSAPP", simWindow: "AFTER", simAccount: "DISCONNECTED", simHumanSupport: "AVAILABLE" }),
    ).toEqual({ channel: "WHATSAPP", window: "AFTER", account: "DISCONNECTED", humanSupport: "AVAILABLE" });
  });

  it("falls back to the default for a value nobody defined", () => {
    expect(simulationInputsFrom({ simChannel: "TELEGRAM", simWindow: "SOMETIME", simAccount: "MAYBE", simHumanSupport: "SURE" })).toEqual({
      channel: "INSTAGRAM",
      window: "OPEN",
      account: "CONNECTED",
      humanSupport: "UNAVAILABLE",
    });
  });
});

describe("who the screen offers the form to", () => {
  it("is the roles the store accepts, and nobody else", () => {
    expect(mayEditSettings("OWNER")).toBe(true);
    expect(mayEditSettings("ADMIN")).toBe(true);
    // An agent may read the profile. `ONBOARDING_UX.md` constrains policy changes by role, the store
    // refuses one, and a form offered here would be a form that cannot be submitted.
    expect(mayEditSettings("AGENT")).toBe(false);
    expect(mayEditSettings("")).toBe(false);
  });
});
