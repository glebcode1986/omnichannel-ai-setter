# Release process

The operational companion to `LAUNCH_READINESS.md` (#60, P7-02). That document says what has to be true
before a release; this one says how it is recorded, what evidences each gate **today**, and what the
staged rollout actually does to a send.

## The decision, in one sentence

A release is a row: one exact commit SHA, one rollout stage, twenty gate verdicts with their evidence, a
rollback plan, and an independent reviewer's verdict about that same SHA. Nothing judged is stored —
whether a candidate is releasable, and whether a reviewer passed it, are recomputed from those rows every
time they are read, so there is no column that can disagree with the evidence it was derived from.

## Recording one

```bash
pnpm release:record --stage LIMITED_AUTOPILOT \
  --rollback-plan "redeploy the previous tag; no migration is irreversible" \
  --summary "P7-02 launch readiness"
```

It resolves the SHA from git and **refuses a dirty working tree** — an exact-SHA decision is not a
property of a commit you have edited since. It then runs `pnpm verify`, `pnpm test:db` and `pnpm test:e2e`,
derives the gate verdicts from what passed, prints the decision, and records the candidate. `--dry-run`
prints and writes nothing. `--command-results <file>` supplies the exit codes instead of running them,
which is how CI uses it.

The one property worth knowing: **it cannot manufacture a `PASS`.** A gate is passed only when a command
that actually runs its suites succeeded, or when a person wrote the verdict down in a `--verdicts` file. A
gate whose suites nobody ran comes back as not evaluated, which is a blocker. A gate whose covering
command failed comes back as a blocker naming that command.

Recording a candidate that failed its gates is deliberate and is the point of the record. The script
exits non-zero so a pipeline stops.

### The reviewer

```bash
pnpm release:review --sha <40 hex> --reviewer astra --verdict PASS --reference <url>
```

A separate command, because the two are done by different people and a release script that could record
its own approval would make "independent" a word in a document. A verdict is attached to the **commit**
and to nothing else, so the same commit proposed again at the next stage inherits it, and a verdict filed
for the wrong SHA counts for nothing — the command says how many recorded candidates it bears on, and
zero is what a forty-character typo produces.

Both commands need `OPERATE_RELEASE`, which `OPERATIONS` and `PLATFORM_ADMIN` hold, and both write a
platform audit row in the same transaction as the fact they record.

## Reading it back

`/admin/releases` shows the stage in force, each recent candidate with its recomputed decision and
reviewer status, and the capabilities a `HIGH` switched off. The limited-rollout allowlist is on the
workspace screen, beside the profiles it applies to.

## What the staged rollout does to a send

§18's five stages become one boolean the policy engine reads, next to the plan's own `autopilot`:

| release in force | `autopilot` permitted |
| --- | --- |
| nothing recorded at all | yes — there is no stage to enforce |
| `INTERNAL`, `DESIGN_PARTNERS_DRAFT` | no, for everybody ("DRAFT-first") |
| `LIMITED_AUTOPILOT` | only for a profile on the allowlist |
| `COMMERCIAL_BETA` and beyond | yes — the plan decides |
| candidates exist, none approved | **no** — the stage cannot be determined |

The last row is the one that matters most and is the least obvious. Recording ten unreviewed proposals is
the most common state a release candidate is in; if an exhausted search window reported "no release", then
recording *evidence* would have switched the gate off for the whole platform. It reports that it cannot
tell, and that fails closed.

A release whose own gates returned `HIGH` on an autopilot gate keeps autopilot off whatever stage it
names. That is the spec's `HIGH` — "the affected autonomous capability remains disabled" — made real
rather than advisory: the release goes out, the capability does not.

The gate is **authority-aware**: a reply a person approved still goes out. Stages one to three *are*
human-approved sending, so an unconditional gate would block the traffic those stages consist of. Pulling
sending back *immediately*, including replies already approved, is the kill switch's job — it is
unconditional, needs no reviewer, and is the right tool when the reason is that sending is unsafe at all.

## What evidences each gate today

`scripts/release/evidence.ts` is the authoritative table and `scripts/release/gates.test.ts` holds it
against this repository: every gate named, every path exists, every path offered as a suite is a test
file, and the gates nothing automated settles are listed by name. The summary:

- **Fully evidenced by suites:** §3 messaging E2E, §6 knowledge/style, §7 human-review races, §8 tenant
  isolation, §12 privacy/deletion, §13 media, §15 UX/localization/accessibility, §18 staged rollout,
  §20 release evidence.
- **Evidenced with a stated gap:** §4 autopilot headless (the mechanism is tested; observing a full cycle
  needs a deployment), §5 AI regression (**`pnpm evals` is not run by CI** — see below), §9 reliability
  (in-process failures only), §10 load (correctness under contention, not sustained load), §11 billing
  (everything except a real provider event — #41), §17 kill switches (four of the six scopes §17 names),
  §19 per-customer readiness (the rest is an operator judgement).
- **Nothing automated at all:** §2 staging (no staging environment exists), §14 booking (no booking
  capability exists), §16 observability/runbooks (health is computed and logged; there is no alerting
  integration and no runbook document).

## Known limitations of this slice

1. **CI does not run `pnpm evals`.** Neither job in `.github/workflows/verify.yml` invokes it, so §5's
   gate is settled by a person. The one-line fix is staged at `docs/handoff/ci-evals-step.patch` because
   this repository's push credential cannot write `.github/workflows`.
2. **No per-feature rollout.** §18's "new high-impact features repeat a staged rollout rather than
   inheriting global enablement" has one global stage, one per-profile allowlist and the capability list a
   `HIGH` switches off. There is no feature-flag table; `release_records.enabled_flags` records names and
   nothing reads them. The flags panel is deferred with #59's remaining work.
3. **Independence is a process property, not a constraint.** `release_reviews.reviewer` is free text and
   nothing compares it with the release actor, because a reviewer is not a user of this product. The
   record makes a self-review *visible* — same actor on both audit rows — and does not prevent it.
4. **Only `AUTOPILOT` is actually switchable.** `RELEASE_CAPABILITIES` names five; the send path has one.
   A `HIGH` on §13 or §16 is recorded, reported and read by a person, and disables nothing by itself.
