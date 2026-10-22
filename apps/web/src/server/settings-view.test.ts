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

import { catalogues } from "../i18n/catalogue";
import {
  acknowledgementOffered,
  acknowledges,
  AUDITED_POLICY_FIELDS,
  auditHistoryHref,
  decodeAuditCursor,
  decodeProposal,
  encodeAuditCursor,
  encodeProposal,
  impactsFromQuery,
  MAX_PROPOSAL_FIELD_CHARS,
  mayEditSettings,
  oversizedField,
  pendingReview,
  policyChangeDiff,
  takeoverPauseProblem,
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

  it("carries presence, which the shared fixture above cannot show", () => {
    // The round-trip case above asserts `toEqual(PROPOSAL)`, and `PROPOSAL` states no presence — so it
    // would pass just as well if the decoder dropped these two fields entirely. That is the same
    // one-fixture-on-both-sides shape that made the old coexistence echo case worthless, so presence gets
    // its own case rather than relying on that one.
    const withPresence = { ...PROPOSAL, presenceMode: "READ_AND_TYPING", presenceTypingLeadMs: 6_000 } as const;

    expect(decodeProposal(encodeProposal(withPresence))).toMatchObject({
      presenceMode: "READ_AND_TYPING",
      presenceTypingLeadMs: 6_000,
    });
  });

  it("drops a presence mode nobody defined rather than carrying it into a save", () => {
    const tampered = { ...PROPOSAL, presenceMode: "SHOUTING" } as unknown as PolicyProposal;

    expect(decodeProposal(encodeProposal(tampered))).not.toHaveProperty("presenceMode");
  });

  it("drops a typing lead the provider's own indicator would outlive", () => {
    // Bounded by `MAX_PRESENCE_TYPING_LEAD_MS`, because the parameter is user-editable: a hand-edited URL
    // must not be able to propose a lead the domain would refuse, and leaving the stored value alone is
    // the same answer every other unusable field in this decoder gets.
    const tooLong = { ...PROPOSAL, presenceTypingLeadMs: 999_999 } as const;

    expect(decodeProposal(encodeProposal(tooLong))).not.toHaveProperty("presenceTypingLeadMs");
  });

  it("drops a negative typing lead", () => {
    const negative = { ...PROPOSAL, presenceTypingLeadMs: -1 } as const;

    expect(decodeProposal(encodeProposal(negative))).not.toHaveProperty("presenceTypingLeadMs");
  });

  it("distinguishes two versions of otherwise identical values", () => {
    // What makes "the seal covers the version" true. The seal signs the encoded proposal, and the version
    // is part of it — so this is the property that guarantees an acknowledgement cannot be carried across
    // somebody else's change. If `expectedVersion` ever left the encoding, the seal would silently stop
    // covering it and this is the test that would say so.
    expect(encodeProposal({ ...PROPOSAL, expectedVersion: 7 })).not.toBe(encodeProposal({ ...PROPOSAL, expectedVersion: 8 }));
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
    const cursor = { changedAt: new Date("2026-09-01T10:00:00.000Z"), id: "8f14e45f-ce9a-4b3d-8c1e-2a4b6d8e0f12" };

    expect(decodeAuditCursor(encodeAuditCursor(cursor))).toEqual(cursor);
  });

  it("refuses an id that is not a uuid, because the column is one", () => {
    // Postgres refuses the comparison outright, and this page is rendered inside one `Promise.all` with
    // no error boundary on the route — so a hand-edited cursor used to 500 the whole screen: form,
    // playground and history. A cursor we did not mint is simply not a cursor.
    for (const id of ["42", "pca_1", "'; drop table policy_change_audits; --", "8f14e45f-ce9a-4b3d-8c1e"]) {
      const forged = Buffer.from(`2026-09-01T10:00:00.000Z|${id}`, "utf8").toString("base64url");
      expect(decodeAuditCursor(forged), id).toBeUndefined();
    }
  });

  it("is absent for anything this module did not write", () => {
    for (const encoded of [
      undefined,
      "",
      "nonsense",
      Buffer.from("no separator", "utf8").toString("base64url"),
      Buffer.from("not-a-date|8f14e45f-ce9a-4b3d-8c1e-2a4b6d8e0f12", "utf8").toString("base64url"),
      Buffer.from("2026-09-01T10:00:00.000Z|", "utf8").toString("base64url"),
    ]) {
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

    // The playground's chosen inputs survive paging the history, so re-running afterwards asks the same
    // case. The question itself does not — see the next case for why.
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

  it("drops the playground's question, which would re-run it", () => {
    const href = auditHistoryHref("/settings", { ask: "do you deliver?", simChannel: "WHATSAPP" }, {
      changedAt: new Date("2026-09-01T10:00:00.000Z"),
      id: "pca_9",
    });

    // The page runs the playground on every render that carries a question — embedding it, searching both
    // corpora and calling the reply model. Reading the history is not asking it anything, so carrying the
    // question billed a model request per page and regenerated the answer underneath the reader. The
    // chosen inputs stay, so re-running after paging asks the same case again.
    expect(href).not.toContain("ask=");
    expect(href).toContain("simChannel=WHATSAPP");
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

  it("does not report an unordered list that was merely reordered", () => {
    const changes = policyChangeDiff(
      { mandatoryReviewReasons: ["PAYMENT_DISPUTE", "LOW_CONFIDENCE"] },
      { mandatoryReviewReasons: ["LOW_CONFIDENCE", "PAYMENT_DISPUTE"] },
    );

    // `mandatoryReviewReasons` is written from a Set, so its order is an implementation detail; reporting
    // it would make every save look like it touched the review topics.
    expect(changes).toEqual([]);
  });

  it("reports a criteria change the store recorded as a change", () => {
    // The store's own `changed()` sorts the two unordered lists and deliberately not the criteria, so a
    // reorder writes an audit row. Sorting them here made the screen disagree with the database: the row
    // existed, the diff was empty, and the entry claimed somebody changed something while showing
    // nothing.
    expect(policyChangeDiff({ qualificationCriteria: ["b", "a"] }, { qualificationCriteria: ["a", "b"] })).toEqual([
      { field: "qualificationCriteria", before: "b, a", after: "a, b" },
    ]);

    // And splitting one criterion into two, which the joined strings made identical.
    expect(
      policyChangeDiff({ qualificationCriteria: ["fast replies, polite tone"] }, { qualificationCriteria: ["fast replies", "polite tone"] }),
    ).toHaveLength(1);
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
    expect(simulationInputsFrom({})).toEqual({
      channel: "INSTAGRAM",
      window: "OPEN",
      account: "CONNECTED",
      humanSupport: "UNAVAILABLE",
      replyKind: "ORDINARY",
      templateName: "",
    });
  });

  it("takes all six from the link", () => {
    expect(
      simulationInputsFrom({
        simChannel: "WHATSAPP",
        simWindow: "AFTER",
        simAccount: "DISCONNECTED",
        simHumanSupport: "AVAILABLE",
        simReplyKind: "TEMPLATE",
        simTemplate: "  booking_reminder  ",
      }),
    ).toEqual({
      channel: "WHATSAPP",
      window: "AFTER",
      account: "DISCONNECTED",
      humanSupport: "AVAILABLE",
      replyKind: "TEMPLATE",
      // Trimmed, because it is matched against an allowlist and a stray space is not a different template.
      templateName: "booking_reminder",
    });
  });

  it("falls back to the default for a value nobody defined", () => {
    expect(
      simulationInputsFrom({ simChannel: "TELEGRAM", simWindow: "SOMETIME", simAccount: "MAYBE", simHumanSupport: "SURE", simReplyKind: "SMOKE_SIGNAL" }),
    ).toEqual({
      channel: "INSTAGRAM",
      window: "OPEN",
      account: "CONNECTED",
      humanSupport: "UNAVAILABLE",
      replyKind: "ORDINARY",
      templateName: "",
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

describe("every audited field has a label in every locale", () => {
  it("covers the whole list, so adding a field cannot reach the screen unlabelled", () => {
    // The page renders `policyField.${field}` through a cast, which the compiler cannot check. That cast
    // is the only thing between this list and a raw key on a customer's screen, so the list is compared
    // with the catalogues instead.
    for (const locale of ["en", "ru"] as const) {
      for (const field of AUDITED_POLICY_FIELDS) {
        expect(catalogues[locale][`policyField.${field}`], `${locale} has no label for ${field}`).toBeTruthy();
      }
    }
  });
});

describe("the fields that share one URL parameter", () => {
  it("are bounded together, because a bound on one of them is a bound on nothing", () => {
    const long = "x".repeat(MAX_PROPOSAL_FIELD_CHARS + 1);

    expect(oversizedField([long, "", ""])).toBe(true);
    // The criteria and the allowlist travel in the same parameter as the goal. Bounding only the goal let
    // a pasted criteria list produce a redirect a server will not accept, and the change could then never
    // be confirmed at all.
    expect(oversizedField(["", long, ""])).toBe(true);
    expect(oversizedField(["", "", long])).toBe(true);
    expect(oversizedField(["a", "b", "c"])).toBe(false);
  });

  it("refuses a proposal whose criteria or allowlist are over the bound", () => {
    const long = "x".repeat(MAX_PROPOSAL_FIELD_CHARS + 1);

    for (const field of ["qualificationCriteria", "whatsappTemplateAutomationAllowlist"] as const) {
      const encoded = Buffer.from(JSON.stringify({ ...PROPOSAL, [field]: [long] }), "utf8").toString("base64url");
      expect(decodeProposal(encoded), field).toBeUndefined();
    }
  });
});

describe("the takeover pause", () => {
  it("accepts a whole number of hours inside the product's own bounds", () => {
    expect(takeoverPauseProblem("6")).toBeUndefined();
    expect(takeoverPauseProblem(" 168 ")).toBeUndefined();
  });

  it("refuses a cleared box rather than leaving the stored value in place", () => {
    // A cleared box used to be read as "leave it alone": the field was omitted, the store kept the stored
    // hours, and the save reported success about something else entirely — with the next render refilling
    // the box from storage so nothing on screen disagreed.
    expect(takeoverPauseProblem("")).toBe("INCOMPLETE");
    expect(takeoverPauseProblem("   ")).toBe("INCOMPLETE");
    expect(takeoverPauseProblem("6 or so")).toBe("INCOMPLETE");
  });

  it("refuses hours outside what the form offers", () => {
    // `min` and `max` on a number input are a hint to a browser and nothing to a crafted POST, and the
    // domain asks only for a positive integer — so this used to accept eleven years of silence.
    expect(takeoverPauseProblem("0")).toBe("OUT_OF_RANGE");
    expect(takeoverPauseProblem("-6")).toBe("OUT_OF_RANGE");
    expect(takeoverPauseProblem("100000")).toBe("OUT_OF_RANGE");
  });
});

describe("the change under review on a URL", () => {
  const whole = { mayEdit: true, impacts: ["AUTOPILOT_ENABLED"] as const, proposal: PROPOSAL, seal: "a-seal" };

  it("is one thing, or nothing at all", () => {
    expect(pendingReview(whole)).toEqual({ impacts: ["AUTOPILOT_ENABLED"], proposal: PROPOSAL, seal: "a-seal" });
  });

  it("is nothing when any part of it is missing", () => {
    // Read as three independent parameters, a partial set rendered as a normal pending confirmation: the
    // alarming summary and a live acknowledgement over a form that had fallen back to the stored values,
    // under a sentence saying those values were the ones proposed.
    expect(pendingReview({ ...whole, proposal: undefined }), "no decodable proposal").toBeUndefined();
    expect(pendingReview({ ...whole, seal: "" }), "no seal").toBeUndefined();
    expect(pendingReview({ ...whole, impacts: [] }), "nothing widened").toBeUndefined();
  });

  it("belongs to a reader who may edit", () => {
    // A refusal keeps the proposal in the URL — including the refusal for not being allowed to save — so
    // an admin demoted while their form was open would otherwise read their own unsaved values as the
    // live settings, under a notice saying exactly that.
    expect(pendingReview({ ...whole, mayEdit: false })).toBeUndefined();
  });
});

describe("whether the acknowledgement may be offered", () => {
  const review = { impacts: ["AUTOPILOT_ENABLED"] as const, proposal: PROPOSAL, seal: "a-seal" };

  it("is offered for a review that is current and has a form to sit in", () => {
    expect(acknowledgementOffered(review, false, true)).toBe(true);
  });

  it("is withheld with no review, with a stale one, and with no form", () => {
    // Each of these was a state in which the page still said "tick the box to save them", because the
    // sentence that names the control weighed only staleness while the control weighed everything.
    expect(acknowledgementOffered(undefined, false, true), "no review").toBe(false);
    expect(acknowledgementOffered(review, true, true), "stale").toBe(false);
    expect(acknowledgementOffered(review, false, false), "no form").toBe(false);
  });

  it("does not suppress the review itself when it is stale", () => {
    // Showing the summary and saying it is out of date *is* the recovery path; what a stale review may
    // not do is offer a control that cannot complete. Two questions, two answers.
    expect(pendingReview({ mayEdit: true, impacts: ["AUTOPILOT_ENABLED"], proposal: PROPOSAL, seal: "a-seal" })).toBeDefined();
    expect(acknowledgementOffered(review, true, true)).toBe(false);
  });
});
