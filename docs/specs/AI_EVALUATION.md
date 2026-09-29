# AI Evaluation Harness — v0.1

## Purpose

Repeatable offline evaluation of the AI reply path before AUTOPILOT is enabled broadly (P2-08, Issue #15).

The harness runs the **real** draft engine and the **real** policy engine against golden conversations. It
does not reimplement either. A harness that re-derived the rules it grades would pass while production
failed, which is the one thing an evaluation suite must never do.

## One command

```
pnpm evals                     # human-readable report to stdout
pnpm evals --json results.json # plus a machine-readable report
```

Exit code is non-zero when any assertion failed. Quality regressions are printed but do not change it.

## Two kinds of expectation, kept apart

**Assertions are deterministic.** Whether a closed window blocks a send, whether a mandatory-review
category forces review, whether a citation the model was never given is stripped — these have one correct
answer, and no model is consulted about them. They pass or fail, and any failure fails the run.

**Scores are judgements about text.** Whether a reply mentions what a good answer would mention, whether it
is written in the customer's language. These are graded by pluggable graders, reported separately, and
never gate a run on their own.

Keeping them apart is the point. A suite that grades policy decisions with an LLM cannot tell a regression
from a bad mood, and the day it disagrees with itself is the day nobody trusts it. Assertions gate; scores
inform.

## Comparing providers and prompts

Every report records the provider, model, prompt version and schema version of the run. Two runs are
therefore comparable without touching the goldens: a drop in scores after a model swap is a fact about the
model, and without those versions recorded it would look like a fact about the suite.

A live provider can be supplied through `runSuite({ model, provider, modelName })`. It still cannot send:
the `ReplyModel` port has no transport, recipient or tools, so a live run cannot reach a customer — a
property of the contract rather than a promise the harness makes.

## Adding a golden case

Add an entry to `packages/evals/src/cases/index.ts` with:

- an `id` nothing else uses (two cases sharing one would silently overwrite each other across runs, and the
  suite refuses to start if that happens);
- a `category` and an `intent` — one sentence on what the case protects, which appears in the report. A
  case whose purpose nobody remembers is a case that gets deleted the first time it is inconvenient;
- the conversation, plus whatever knowledge or style examples the business would genuinely have;
- `fixtureReply`: what the model answers, including deliberately bad answers — a refusal, unreadable
  output, a citation that was never supplied. A harness that can only produce well-formed answers cannot
  test what happens when a model misbehaves;
- `assertions`: what must be true, checked exactly;
- `quality`, only if the case is about wording.

Never put a policy expectation in `quality`. A decision that can be graded away is not a decision.

**A fixture that states a classification must assert it.** The model's `intent` and its suggested lead
stage are the one part of an answer that can change while the reply, the citations and the policy decision
all stay identical — a booking that stops being recognised as a booking goes out looking exactly the same.
So `assertions.modelIntent` and `assertions.leadStage` pin them, `null` asserts that nothing was
classified (a conversation that must not be read as a lead is where a wrong reading would be quietest),
and a harness self-test fails any golden that supplies a classification without asserting one.

Cases are TypeScript rather than JSON so that a change to a contract breaks the goldens at compile time.

## Coverage

Factual answers with provenance, missing facts, every mandatory-review escalation category, unsupported
media, prompt injection both from the customer and inside a knowledge chunk, multilingual style fidelity,
malformed and refused model output, deterministic policy cases for mode, window, after-window policy,
takeover and reply-cycle ownership, and the intent/lead-stage classification wherever a case states one.

No production customer data is used or required; the businesses in these conversations do not exist.
