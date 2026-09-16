# Task Contract — P2-08 Claude

**Issue:** #15 `[P2-08] Build AI evaluation harness and golden conversation suite`  
**Branch:** `feat/p2-08-ai-evals`  
**Depends on:** #10–#14 sufficiently stable.  
**Owner:** Claude for harness; Codex/Astra independently adds adversarial cases. Do not merge own PR.

## Read first
`PROJECT_CONTEXT.md`, `AI_BEHAVIOR.md`, `AI_ORCHESTRATION.md`, `RETRIEVAL.md`, `POLICY_ENGINE.md`, `HUMAN_HANDOFF.md`, Issue #15.

## Objective
Create repeatable offline evaluation for response quality, factuality, style fidelity, structured-output validity, review/escalation decisions and deterministic policy behavior before broad AUTOPILOT use.

## Required assets
- synthetic/golden conversations with expected intent, lead stage and review behavior;
- factual Q&A grounded in known knowledge source IDs;
- multilingual style examples;
- missing-fact cases;
- refund/legal/high-risk/security/reputational escalation cases;
- unsupported media scenarios;
- prompt-injection/adversarial messages and malicious knowledge text;
- deterministic policy cases for window/takeover/mode/delay ownership;
- no production customer data required.

## Evaluation separation
Deterministic policy assertions are pass/fail tests and must not be hidden inside subjective LLM grading. Text quality/style/factual-answer scoring may use pluggable evaluators, but goldens and expected policy outcomes remain provider-independent.

## Output
One documented command produces machine-readable results plus a concise human-readable report. Store provider/model/prompt/schema versions with eval results so changes can be compared over time without rewriting goldens.

## Tests/acceptance
Harness itself has deterministic tests, can run with fixture/fake provider for CI, and can optionally run a configured live model without making channel sends. Include thresholds/gates for regression rather than only raw scores.

## PR requirements
Document how to add a golden case and compare providers/prompts. No live customer sends/tools. Run root checks and the offline suite. Do not merge.
