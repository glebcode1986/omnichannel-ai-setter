/**
 * @omnichannel/evals
 *
 * Offline evaluation of the AI reply path (P2-08). It runs the real draft engine and the real policy
 * engine against golden conversations, so a passing suite is evidence about production behaviour rather
 * than about a copy of it.
 *
 * Nothing here can send. The `ReplyModel` port has no transport, recipient or tools, so even a live run
 * against a configured provider cannot reach a customer — a property of the contract, not a promise this
 * package makes.
 */
export type {
  CaseAssertions,
  CaseCategory,
  CaseKnowledge,
  CasePolicy,
  CaseQuality,
  CaseStyleExample,
  CaseTurn,
  FixtureReply,
  GoldenCase,
} from "./case";
export { GOLDEN_CASES } from "./cases/index";
export { createFixtureModel, FIXTURE_MODEL, FIXTURE_PROVIDER } from "./fixture-model";
export { DEFAULT_GRADERS, languageGrader, termCoverageGrader, type Grader, type GraderExpectations } from "./graders";
export { buildReport, formatReport, type EvalReport, type EvalRunMetadata } from "./report";
export { runCase, RUN_METADATA, type CaseResult, type RunOptions } from "./run";
export { runSuite } from "./suite";
