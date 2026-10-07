/**
 * Running one golden case through the real engine (P2-08).
 *
 * "The real engine" is not a figure of speech: the case is turned into the same `DraftGenerationCommand`
 * the worker builds, run through the same `generateDraft`, and judged by the same `evaluatePolicy`. A
 * harness that reimplemented any of that would pass while production failed, which is the one thing an
 * evaluation suite must never do.
 *
 * Nothing here can send. The `ReplyModel` port has no transport, no recipient and no tools, so even a live
 * run against a real provider cannot reach a customer — that is a property of the contract rather than a
 * promise this file makes.
 */
import {
  evaluatePolicy,
  generateDraft,
  noRetrieval,
  type AiDraftStore,
  type DraftGenerationDependencies,
  type PolicyDecision,
  type PolicyInput,
  type ReplyModel,
  type SaveDraftInput,
} from "@omnichannel/application";
import { NO_CAPABILITIES, resolveStyleProfile, type ReasonCode } from "@omnichannel/domain";

import type { CaseAssertions, GoldenCase } from "./case";
import { createFixtureModel, FIXTURE_MODEL, FIXTURE_PROVIDER } from "./fixture-model";
import { DEFAULT_GRADERS, type Grader } from "./graders";

const NOW = new Date("2026-09-19T12:00:00.000Z");
const PROMPT_VERSION = "reply.v1";
const SCHEMA_VERSION = "ai-draft.v1";

export interface CaseResult {
  readonly id: string;
  readonly category: GoldenCase["category"];
  readonly intent: string;
  /** Deterministic outcomes. Any failure here fails the suite. */
  readonly failures: readonly string[];
  /** Graded outcomes, reported separately and never used to gate on their own. */
  readonly scores: readonly { readonly grader: string; readonly score: number }[];
  readonly qualityBelowThreshold: boolean;
  readonly reply?: string;
  readonly reasonCodes: readonly ReasonCode[];
  readonly policy?: PolicyDecision;
}

export interface RunOptions {
  /** Supply a live model to compare a provider against the same goldens; omitted means the fixture. */
  readonly model?: (kase: GoldenCase) => ReplyModel;
  readonly graders?: readonly Grader[];
  readonly now?: Date;
}

export async function runCase(kase: GoldenCase, options: RunOptions = {}): Promise<CaseResult> {
  const now = options.now ?? NOW;
  const saved: SaveDraftInput[] = [];
  const drafts: AiDraftStore = {
    saveDraft: (input) => {
      saved.push(input);
      return Promise.resolve({ aiDraftId: `draft_${kase.id}` });
    },
  };
  const dependencies: DraftGenerationDependencies = {
    model: options.model?.(kase) ?? createFixtureModel(kase.fixtureReply),
    drafts,
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    now: () => now,
    // Fixed, so a failure is reproducible: the fence marker is not what any case is about.
    newNonce: () => `fence-${kase.id}`,
    promptVersion: PROMPT_VERSION,
    schemaVersion: SCHEMA_VERSION,
  };

  const inbound = kase.turns
    .filter((turn) => turn.from === "CUSTOMER")
    .map((turn, index) => ({ kind: "INBOUND" as const, provenance: `msg_${String(index)}`, text: turn.text, occurredAt: now }));
  const history = kase.turns
    .filter((turn) => turn.from === "BUSINESS")
    .map((turn, index) => ({ kind: "OUTBOUND" as const, provenance: `out_${String(index)}`, text: turn.text, occurredAt: now }));

  const outcome = await generateDraft(dependencies, {
    scope: { workspaceId: "ws_eval", businessProfileId: "bp_eval", conversationId: `conv_${kase.id}` },
    anchorMessageId: `msg_${String(Math.max(0, inbound.length - 1))}`,
    anchorStateVersion: 1,
    trigger: { kind: "AUTOMATIC", reason: "DEBOUNCE_ELAPSED" },
    snapshot: {
      conversationId: `conv_${kase.id}`,
      status: "OPEN",
      aiEnabled: true,
      takeoverState: "NONE",
      mode: kase.mode,
      stateVersion: 1,
      anchorSuperseded: false,
      commercial: { paidWorkAllowed: true, aiDrafts: true, autopilot: true },
    },
    styleProfile: resolveStyleProfile([kase.styleProfile ?? {}]),
    channel: kase.channel,
    capabilityHints: ["text"],
    inbound,
    history,
    retrieval: {
      knowledge: (kase.knowledge ?? []).map((chunk) => ({ chunkId: chunk.chunkId, text: chunk.text })),
      style: (kase.styleExamples ?? []).map((example) => ({ exampleId: example.exampleId, text: example.text })),
      supplied: {
        ...noRetrieval("OK"),
        knowledge: (kase.knowledge ?? []).map((chunk) => ({
          chunkId: chunk.chunkId,
          documentId: `doc_${chunk.chunkId}`,
          documentVersion: 1,
          scopeLevel: "WORKSPACE" as const,
          score: 0.03,
        })),
      },
    },
  });

  const draft = saved[0];
  const reply = draft?.text ?? undefined;
  const reasonCodes = draft?.reasonCodes ?? [];
  const policy = kase.policy === undefined ? undefined : evaluatePolicy(policyInputFor(kase, draft, now));

  return {
    id: kase.id,
    category: kase.category,
    intent: kase.intent,
    failures: assertionFailures(kase.assertions, { outcome, draft, reply, reasonCodes, policy }),
    ...scoreQuality(kase, reply, options.graders ?? DEFAULT_GRADERS),
    ...(reply === undefined ? {} : { reply }),
    reasonCodes,
    ...(policy === undefined ? {} : { policy }),
  };
}

interface Observed {
  readonly outcome: Awaited<ReturnType<typeof generateDraft>>;
  readonly draft?: SaveDraftInput;
  readonly reply?: string;
  readonly reasonCodes: readonly ReasonCode[];
  readonly policy?: PolicyDecision;
}

/** Every mismatch is described in full, so a failing run says what changed rather than that something did. */
function assertionFailures(expected: CaseAssertions, observed: Observed): readonly string[] {
  const failures: string[] = [];
  const say = (what: string, want: unknown, got: unknown) => failures.push(`${what}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);

  if (expected.held !== undefined) {
    const held = observed.draft?.status === "HELD";
    if (held !== expected.held) {
      say("held", expected.held, held);
    }
  }
  if (expected.needsReview !== undefined && observed.draft !== undefined && observed.draft.needsReview !== expected.needsReview) {
    say("needsReview", expected.needsReview, observed.draft.needsReview);
  }
  // Absent on the draft and `null` in a case mean the same thing — nothing was classified — so they are
  // compared as one value rather than as two ways of saying it.
  if (expected.modelIntent !== undefined) {
    const intent = observed.draft?.intent ?? null;
    if (intent !== expected.modelIntent) {
      say("intent", expected.modelIntent, intent);
    }
  }
  if (expected.leadStage !== undefined) {
    const leadStage = observed.draft?.suggestedLeadStage ?? null;
    if (leadStage !== expected.leadStage) {
      say("leadStage", expected.leadStage, leadStage);
    }
  }
  for (const code of expected.reasonCodes ?? []) {
    if (!observed.reasonCodes.includes(code)) {
      say("reasonCodes contains", code, observed.reasonCodes);
    }
  }
  for (const code of expected.forbiddenReasonCodes ?? []) {
    if (observed.reasonCodes.includes(code)) {
      say("reasonCodes must not contain", code, observed.reasonCodes);
    }
  }
  if (expected.citedSourceIds !== undefined) {
    const cited = [...(observed.draft?.factualSourceIds ?? [])].sort();
    const want = [...expected.citedSourceIds].sort();
    if (JSON.stringify(cited) !== JSON.stringify(want)) {
      say("citedSourceIds", want, cited);
    }
  }
  for (const forbidden of expected.replyMustNotContain ?? []) {
    if (observed.reply !== undefined && observed.reply.toLowerCase().includes(forbidden.toLowerCase())) {
      say("reply must not contain", forbidden, observed.reply);
    }
  }
  if (expected.policyAction !== undefined && observed.policy?.action !== expected.policyAction) {
    say("policy action", expected.policyAction, observed.policy?.action);
  }
  for (const reason of expected.policyReasons ?? []) {
    if (!(observed.policy?.reasons ?? []).includes(reason)) {
      say("policy reasons contains", reason, observed.policy?.reasons);
    }
  }
  return failures;
}

function scoreQuality(kase: GoldenCase, reply: string | undefined, graders: readonly Grader[]) {
  if (kase.quality === undefined || reply === undefined) {
    return { scores: [], qualityBelowThreshold: false };
  }
  const scores = graders
    .map((grader) => ({ grader: grader.name, score: grader.grade(reply, kase.quality ?? {}) }))
    .filter((entry): entry is { grader: string; score: number } => entry.score !== undefined);
  if (scores.length === 0 || kase.quality.minimumScore === undefined) {
    return { scores, qualityBelowThreshold: false };
  }
  const mean = scores.reduce((total, entry) => total + entry.score, 0) / scores.length;
  return { scores, qualityBelowThreshold: mean < kase.quality.minimumScore };
}

function policyInputFor(kase: GoldenCase, draft: SaveDraftInput | undefined, now: Date): PolicyInput {
  const conditions = kase.policy ?? { windowOpen: true };
  return {
    mode: kase.mode,
    aiEnabled: true,
    takeover:
      conditions.takeover === "HUMAN_ACTIVE"
        ? { state: "HUMAN_ACTIVE", reason: "HUMAN_CLAIMED", since: now }
        : conditions.takeover === "REVIEW_REQUIRED"
          ? { state: "REVIEW_REQUIRED", reason: "MANDATORY_REVIEW", reviewMode: "NORMAL", since: now }
          : { state: "NONE" },
    draft: {
      usable: draft?.text !== null && draft?.text !== undefined,
      confidence: draft?.confidence ?? 0,
      reasonCodes: draft?.reasonCodes ?? [],
      citedSourceIds: draft?.factualSourceIds ?? [],
      contentType: "TEXT",
    },
    retrieval: { suppliedSourceIds: (kase.knowledge ?? []).map((chunk) => chunk.chunkId), corpusReachable: true },
    // A golden case is about how the assistant behaves, not about what the business pays for. Fixed
    // permissive so a commercial gate cannot silently turn every case into a review item — if a case ever
    // needs to assert a billing refusal it will say so, and the policy engine's own suite is where that
    // gate is pinned (#40).
    commercial: { paidWorkAllowed: true, aiDrafts: true, autopilot: true },
    limits: {
      confidenceThreshold: 0.8,
      mandatoryReviewReasons: ["MISSING_FACT", "PAYMENT_DISPUTE", "LEGAL_INTERPRETATION", "MEDICAL_OR_HIGH_RISK", "CREDENTIAL_OR_SECURITY", "REPUTATIONAL_COMPLAINT", "HIGH_VALUE_COMMITMENT", "UNSUPPORTED_PROMISE", "UNSUPPORTED_MEDIA"],
      ...(conditions.quietHours === undefined ? {} : { quietHours: conditions.quietHours as never }),
      afterWindow: { channel: "INSTAGRAM", policy: conditions.afterWindowPolicy ?? "STANDARD_ONLY" },
    },
    account: conditions.accountConnected === false ? "DISCONNECTED" : "CONNECTED",
    capabilities: { ...NO_CAPABILITIES, text: true },
    window: conditions.windowOpen ? { state: "OPEN_FREEFORM", expiresAt: new Date(now.getTime() + 3_600_000) } : { state: "NOT_ELIGIBLE", reason: "closed" },
    humanAgent: conditions.humanAgentEligible === true ? { state: "ELIGIBLE", expiresAt: new Date(now.getTime() + 3_600_000) } : { state: "UNAVAILABLE", reason: "NOT_APPROVED" },
    replyCycle: conditions.replyCycleSuperseded === true ? "SUPERSEDED" : "OWNED",
    now,
  };
}

export const RUN_METADATA = { promptVersion: PROMPT_VERSION, schemaVersion: SCHEMA_VERSION, provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL };
