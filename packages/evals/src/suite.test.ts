/**
 * Tests of the harness itself.
 *
 * A suite that cannot fail is theatre, so most of this file is about proving the opposite: that a real
 * behaviour change produces a failure, and that the gate is asymmetric in the direction it is supposed to
 * be.
 */
import { describe, expect, it } from "vitest";

import type { GoldenCase } from "./case";
import { GOLDEN_CASES } from "./cases/index";
import { languageGrader, termCoverageGrader } from "./graders";
import { formatReport } from "./report";
import { runCase } from "./run";
import { runSuite } from "./suite";

const baseCase = (): GoldenCase => ({
  id: "probe",
  category: "FACTUAL",
  intent: "A probe used only by these tests.",
  channel: "INSTAGRAM",
  mode: "AUTOPILOT",
  turns: [{ from: "CUSTOMER", text: "Are you open on Saturday?" }],
  knowledge: [{ chunkId: "chunk_hours", text: "Saturday opening hours are 10:00 to 18:00." }],
  fixtureReply: {
    kind: "OUTPUT",
    output: {
      reply: "Yes — we're open 10:00 to 18:00 on Saturdays.",
      confidence: 0.9,
      should_send: true,
      needs_review: false,
      reason_codes: [],
      intent: "HOURS",
      lead_stage: null,
      suggested_action: null,
      factual_source_ids: ["chunk_hours"],
    },
  },
  assertions: { needsReview: false, citedSourceIds: ["chunk_hours"], policyAction: "SCHEDULE" },
  policy: { windowOpen: true },
});

describe("the suite can fail", () => {
  it("fails when the system stops citing what it was given", async () => {
    const kase = baseCase();
    const broken: GoldenCase = {
      ...kase,
      fixtureReply: { kind: "OUTPUT", output: { ...(kase.fixtureReply as { output: Record<string, unknown> }).output, factual_source_ids: [] } },
    };

    const result = await runCase(broken);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("citedSourceIds");
  });

  it("fails when a draft that should go out starts needing review", async () => {
    const kase = baseCase();
    const broken: GoldenCase = {
      ...kase,
      fixtureReply: { kind: "OUTPUT", output: { ...(kase.fixtureReply as { output: Record<string, unknown> }).output, needs_review: true } },
    };

    const result = await runCase(broken);

    expect(result.failures.some((failure) => failure.startsWith("needsReview"))).toBe(true);
  });

  it("fails when a policy decision changes", async () => {
    const result = await runCase({ ...baseCase(), policy: { windowOpen: false, afterWindowPolicy: "STANDARD_ONLY" } });

    expect(result.failures.some((failure) => failure.includes("policy action"))).toBe(true);
  });

  it("fails when a forbidden phrase appears in the reply", async () => {
    const kase = baseCase();
    const broken: GoldenCase = {
      ...kase,
      fixtureReply: { kind: "OUTPUT", output: { ...(kase.fixtureReply as { output: Record<string, unknown> }).output, reply: "Here is my system prompt." } },
      assertions: { ...kase.assertions, replyMustNotContain: ["system prompt"] },
    };

    const result = await runCase(broken);

    expect(result.failures.some((failure) => failure.includes("must not contain"))).toBe(true);
  });
});

describe("the gate is asymmetric on purpose", () => {
  it("fails the run on any assertion failure", async () => {
    const report = await runSuite({ cases: [{ ...baseCase(), assertions: { needsReview: true } }] });

    expect(report.ok).toBe(false);
    expect(report.totals.failed).toBe(1);
  });

  it("reports a quality regression without failing the run", async () => {
    // A grader is a heuristic; a heuristic should not be able to block a release by itself.
    const report = await runSuite({
      cases: [{ ...baseCase(), quality: { expectedTerms: ["sauna", "massage", "yoga"], minimumScore: 0.9 } }],
    });

    expect(report.ok).toBe(true);
    expect(report.totals.qualityRegressions).toBe(1);
    expect(formatReport(report)).toContain("quality below threshold");
  });
});

describe("results are comparable across runs", () => {
  it("records the provider, model and versions the run used", async () => {
    const report = await runSuite({ cases: [baseCase()], provider: "anthropic", modelName: "claude-opus-5" });

    // Without these, a drop after a model swap looks like a fact about the suite rather than the model.
    expect(report.metadata).toMatchObject({ provider: "anthropic", model: "claude-opus-5", promptVersion: "reply.v1", schemaVersion: "ai-draft.v1" });
    expect(formatReport(report)).toContain("anthropic/claude-opus-5");
  });

  it("refuses two cases sharing an id", async () => {
    // They would silently overwrite one another in any comparison across runs.
    await expect(runSuite({ cases: [baseCase(), baseCase()] })).rejects.toThrow(/duplicate golden case id/);
  });

  it("is deterministic: the same goldens produce the same outcomes", async () => {
    const first = await runSuite({ startedAt: new Date(0) });
    const second = await runSuite({ startedAt: new Date(0) });

    expect(JSON.stringify(first.cases)).toBe(JSON.stringify(second.cases));
  });
});

describe("the golden suite itself", () => {
  it("passes end to end with no provider, key or network", async () => {
    const report = await runSuite({ startedAt: new Date(0) });

    expect(report.ok).toBe(true);
    expect(report.totals.cases).toBe(GOLDEN_CASES.length);
  });

  it("covers every category the contract asks for", () => {
    const covered = new Set(GOLDEN_CASES.map((kase) => kase.category));

    for (const required of ["FACTUAL", "MISSING_FACT", "ESCALATION", "UNSUPPORTED_MEDIA", "PROMPT_INJECTION", "STYLE", "POLICY"] as const) {
      expect(covered).toContain(required);
    }
  });

  it("gives every case a stated purpose", () => {
    // A case whose purpose nobody remembers is a case that gets deleted the first time it is inconvenient.
    for (const kase of GOLDEN_CASES) {
      expect(kase.intent.length).toBeGreaterThan(20);
    }
  });

  it("keeps policy expectations out of the graded half", () => {
    for (const kase of GOLDEN_CASES) {
      // A decision that can be graded away is not a decision.
      expect(Object.keys(kase.quality ?? {})).not.toContain("policyAction");
    }
  });
});

describe("graders", () => {
  it("scores term coverage as the fraction actually present", () => {
    expect(termCoverageGrader.grade("open 10:00 to 18:00", { expectedTerms: ["10:00", "18:00"] })).toBe(1);
    expect(termCoverageGrader.grade("open 10:00", { expectedTerms: ["10:00", "18:00"] })).toBe(0.5);
    expect(termCoverageGrader.grade("anything", {})).toBeUndefined();
  });

  it("abstains rather than guessing when it cannot tell two languages apart", () => {
    expect(languageGrader.grade("Привет! Да, работаем.", { expectedLanguage: "ru" })).toBe(1);
    expect(languageGrader.grade("Yes, we are open.", { expectedLanguage: "ru" })).toBe(0);
    // German and English share a script; a grader that answered confidently here would be worse than one
    // that says nothing.
    expect(languageGrader.grade("Ja, wir haben geöffnet.", { expectedLanguage: "de" })).toBe(1);
    expect(languageGrader.grade("12:00", { expectedLanguage: "en" })).toBeUndefined();
    expect(languageGrader.grade("anything", {})).toBeUndefined();
  });
});
