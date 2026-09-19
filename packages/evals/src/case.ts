/**
 * What a golden case is (P2-08; AI_BEHAVIOR.md, POLICY_ENGINE.md, RETRIEVAL.md).
 *
 * The central distinction in this file is between two kinds of expectation, and it is the reason the
 * harness exists at all:
 *
 * - **assertions** are deterministic. Whether a closed window blocks a send, whether a mandatory-review
 *   category forces review, whether a citation the model was never given is stripped — these have one
 *   correct answer, and a model is not consulted about them. They pass or fail.
 * - **scores** are judgements about text. Whether a reply sounds like the business, whether it answers the
 *   question — these are graded, and a grader can be a heuristic or another model.
 *
 * Keeping them apart is the whole point. A suite that grades policy decisions with an LLM cannot tell a
 * regression from a bad mood, and the day it disagrees with itself is the day nobody trusts the suite.
 * Assertions gate; scores inform.
 *
 * Cases are written in TypeScript rather than JSON so a change to a contract breaks the goldens at compile
 * time instead of at three in the morning.
 */
import type { ChannelType } from "@omnichannel/channel-core";
import type { AiMode, ReasonCode, StyleProfile } from "@omnichannel/domain";

export const CASE_CATEGORIES = [
  "FACTUAL",
  "MISSING_FACT",
  "ESCALATION",
  "UNSUPPORTED_MEDIA",
  "PROMPT_INJECTION",
  "STYLE",
  "POLICY",
  "LEAD_QUALIFICATION",
] as const;
export type CaseCategory = (typeof CASE_CATEGORIES)[number];

/** A customer message, or an earlier turn of the conversation. */
export interface CaseTurn {
  readonly from: "CUSTOMER" | "BUSINESS";
  readonly text: string;
}

/** Knowledge the business genuinely has, with the IDs a correct answer would cite. */
export interface CaseKnowledge {
  readonly chunkId: string;
  readonly text: string;
}

export interface CaseStyleExample {
  readonly exampleId: string;
  readonly text: string;
  /** BCP-47; absent means language-agnostic. */
  readonly language?: string;
}

/**
 * The deterministic half. Every field here is checked exactly, and a mismatch fails the suite.
 *
 * `reasonCodes` is a *subset* check rather than equality: a case asserts what must be present, so adding a
 * new code elsewhere in the system does not rewrite every golden. `forbiddenReasonCodes` covers the
 * opposite — the codes whose presence would be a bug.
 */
export interface CaseAssertions {
  readonly needsReview?: boolean;
  readonly reasonCodes?: readonly ReasonCode[];
  readonly forbiddenReasonCodes?: readonly ReasonCode[];
  /** Exactly the chunk IDs the draft may end up citing; an invented citation must not survive. */
  readonly citedSourceIds?: readonly string[];
  readonly policyAction?: "SKIP" | "HOLD_REVIEW" | "SCHEDULE";
  readonly policyReasons?: readonly ReasonCode[];
  /** The draft must be stored but unusable — a held generation with its audit row intact. */
  readonly held?: boolean;
  /** Strings that must never appear in the reply, whatever the model was asked to do. */
  readonly replyMustNotContain?: readonly string[];
}

/** The graded half. Absent means the case makes no claim about text quality. */
export interface CaseQuality {
  /** Terms a good answer would be expected to use; scored, never asserted. */
  readonly expectedTerms?: readonly string[];
  /** The language the reply should be written in, as a BCP-47 tag. */
  readonly expectedLanguage?: string;
  /** Minimum combined score, 0-1, below which the case is reported as a quality regression. */
  readonly minimumScore?: number;
}

export interface GoldenCase {
  readonly id: string;
  readonly category: CaseCategory;
  /** One sentence on what this case is protecting. It appears in the report. */
  readonly intent: string;
  readonly channel: ChannelType;
  readonly mode: AiMode;
  readonly styleProfile?: Partial<StyleProfile>;
  readonly turns: readonly CaseTurn[];
  readonly knowledge?: readonly CaseKnowledge[];
  readonly styleExamples?: readonly CaseStyleExample[];
  /** What the model will answer, in the fixture provider. Live runs ignore it. */
  readonly fixtureReply: FixtureReply;
  readonly assertions: CaseAssertions;
  readonly quality?: CaseQuality;
  /** Conditions the policy engine is given, for cases that exercise it. */
  readonly policy?: CasePolicy;
}

/**
 * What the fixture model returns. Deliberately the *raw* shape a provider would produce, including invalid
 * ones: a harness that can only produce valid output cannot test what happens when a model misbehaves.
 */
export type FixtureReply =
  | { readonly kind: "OUTPUT"; readonly output: Record<string, unknown> }
  | { readonly kind: "MALFORMED"; readonly output: unknown }
  | { readonly kind: "REFUSAL" }
  | { readonly kind: "UNAVAILABLE" };

export interface CasePolicy {
  readonly windowOpen: boolean;
  readonly takeover?: "NONE" | "REVIEW_REQUIRED" | "HUMAN_ACTIVE";
  readonly accountConnected?: boolean;
  readonly afterWindowPolicy?: "STANDARD_ONLY" | "HUMAN_ASSISTED_EXTENDED";
  readonly humanAgentEligible?: boolean;
  readonly quietHours?: { readonly timeZone: string; readonly start: string; readonly end: string };
  readonly replyCycleSuperseded?: boolean;
}
