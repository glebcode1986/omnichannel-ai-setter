# A key written inside a conditional spread is not type-checked

**Measured 2026-11-09 on `fix/conditional-spread-key-safety`, branched from #135 at `89bce19`.**

This repository passes an optional field it may not have by spreading a conditional:

```ts
where: {
  workspaceId: scope.workspaceId,
  ...(filter.status === undefined ? {} : { status: filter.status }),
}
```

Rename that key to `statusZZ` and **nothing fails**. Excess-property checking does not apply to the
result of a spread, so the key is dropped and the call still compiles. Written as a plain property the
very same key raises `TS2561` with a "Did you mean to write 'status'?" — which is the control that shows
the checker knows the name and is blind only to this form.

The pattern is not a mistake: `exactOptionalPropertyTypes` is on, so an optional property cannot simply be
assigned `undefined`, and spreading a conditional is the idiom that remains.

## What the type checker does and does not catch

Measured with a four-case probe rather than reasoned about:

| the spread writes | the literal also has | target | result |
|---|---|---|---|
| an unknown key | nothing else | every property optional | **caught** — `TS2559`, no property in common |
| an unknown key | one known key | every property optional | **silent** |
| an unknown key | a required key | one property required | **silent** |
| an unknown key, guarded with `satisfies` | anything | anything | **caught** — `TS2561` |

So the one protection that exists needs the literal to consist of *nothing but* unknown keys. Across this
repository that is true of **one** site out of 570.

## Not a new finding: Prisma's `where` keys are unchecked, and this branch's base says so

`89bce19` — the commit this branch is based on — already records it, with the generated signature that
explains it: `findMany<T extends …FindManyArgs>(args?: Prisma.SelectSubset<T, …>)` infers the target type
*from the argument*, so there is no fixed type for excess-property checking to bite on. Reproduced here,
on `suspension-covering.ts`: renaming the plainly written top-level key `liftedAt` to `liftedAtZZ` gives
**0 errors**.

**But "never checks" is too strong, and the correction matters for how a control is written.** The
variable is not the position — it is whether a key the target *knows* sits beside the misspelled one. Six
shapes against the real generated client, one variable:

| where the unknown key was written | alone in its literal | beside a known key |
|---|---|---|
| top level of `where` | **`TS2561`** | **0 errors** |
| an element of `OR` | **`TS2561`** | **0 errors** |
| an element of `AND` | **`TS2561`** | **0 errors** |

Position makes no difference at all; the companion does. So every real site here is silent for one
reason: a `where` that filters anything carries a tenancy key, and that key is the companion. It also
means a positive control written as `{ where: { typoZZ: v } }` **passes for the wrong reason** — it proves
the lone-key rule, not the hole. A control for this hole needs a companion key, which is why the fixtures
in `spread-key-audit.test.ts` carry one and why the classifier's verdict turns on exactly that
(`weakTypeMayCatch`, which one site out of 572 qualifies for).

What is added here is the sharper rule and the two measurements that fix the boundary.

**Values are checked. Keys are not.** Controls run in this package, so a silent `tsc` cannot be mistaken
for a target that resolved to `any` — the failure mode `89bce19` warns about:

| what was written | `tsc` |
|---|---|
| a real key, a **wrong value type**, as a direct property (`businessProfileId: 12345`) | `TS2322`, naming `string \| StringNullableFilter<"AutomationSuspension">` |
| a real key, a wrong value type, inside an **unguarded** spread branch | `TS2322` at the enclosing literal |
| a real key, a wrong value type, inside a **guarded** branch | `TS2322`, twice |
| an **unknown key**, as a direct property in a Prisma `where` | **0 errors** |
| an unknown key, inside an unguarded spread branch | **0 errors** |
| an unknown key, inside a guarded branch | `TS2561`, "Did you mean …" |

So the compiler ran, the generated types resolved, and the hole is specifically the **key**.

**The two guards compose, and the boundary between them is exact.** A `satisfies` on the whole `where`
reaches further than "the keys written directly" — measured against the generated client, every unknown
key below having a companion inside its own literal:

| where the unknown key is | no annotation | `satisfies` on the whole `where` |
|---|---|---|
| a direct key of `where` | 0 errors | **`TS2561`** |
| inside an `OR` element | 0 errors | **`TS2561`** |
| inside an `AND` element | 0 errors | **`TS2561`** |
| an `AND` element arriving by an **array** spread | 0 errors | **caught** (code varies — see below) |
| **spread into the `where` object itself** | 0 errors | **0 errors** |

So one annotation on the literal buys everything except the last row — and the last row is exactly what
`satisfies` on the spread's **branch** catches. Neither guard is a substitute for the other, and together
they are complete. This change applies the branch form, the class it was asked to close; the whole-`where`
form is the other half and belongs to its own change.

The one code worth not quoting is the array-spread row's, because it is incidental: it depends on what
else is in the array. Measured four ways —

| the array holds | code |
|---|---|
| the spread and nothing else | `TS2322` |
| a predicate of a declared type beside the spread | `TS2561` |
| (and without an annotation, every form is silent) | — |

So "caught" is the fact; `TS2322` or `TS2561` is the shape of the array. Both reproduce here. The session
on #135 found the discrepancy between our two tables and explained it rather than picking a winner.

**Why a control here is easy to get wrong** — the check applies to the **literal**, not to the call, and
at the depth being measured. A companion added to the outer `where` makes *that* literal two-keyed and
silences it, while an `AND` element one level down stays single-keyed and is still caught. The companion
has to sit inside the literal whose behaviour is under test. Two sessions measuring this got confident and
opposite answers before noticing that.

## The guard, and a form that looks like one but is not

The guard is `satisfies` on the spread's branch:

```ts
...(filter.status === undefined ? {} : ({ status: filter.status } satisfies Prisma.HumanTaskWhereInput)),
```

A generic helper **does not work**, and it is worth knowing why, because it reads like the obvious fix:

```ts
declare function only<T extends object>(value: Partial<T>): Partial<T>;
...only(cond ? {} : { statusZZ: x })   // compiles. T is inferred from the argument, not from the target.
```

Contextual type does not flow through a spread into a generic call, so `T` becomes whatever was passed and
the check is vacuous. `only<Prisma.HumanTaskWhereInput>(…)` does work — and once the type is named,
`satisfies` says the same thing with no helper and no import.

## What is guarded, and what is not

`pnpm audit:spread-keys` prints the table; the numbers below are its output at the head of this branch.
A site is a conditional spread whose branches write at least one key — a `...(cond ? {} : {})` writing
nothing cannot carry a misspelling and is not counted.

| | before | after |
|---|---|---|
| total sites | 570 | 572 |
| `exposed` — a renamed key compiles | 510 | **461** |
| `guarded` — `satisfies` on the branch | 0 | **51** |
| `weakTypeMayCatch` — partial, and only one site qualifies | 1 | 1 |
| `indexSignature` — target takes any key, so a guard asserts nothing | 36 | 36 |
| `noContextualType` — the checker has no target here | 23 | 23 |

The two columns are measurements of two different trees, so the rows do not subtract cleanly: the total
rises by two because guarding a nested date filter splits one line into the two branches it always had —
`occurredAt: { gte, lte }` is now two guarded spreads where it was one unguarded site. 510 → 461 exposed
with 51 newly guarded is the arithmetic, and the two extra sites are both in the guarded column.

The `indexSignature` row is the one a text search gets wrong. Thirty-six of these spreads go into
`LogFields = Readonly<Record<string, unknown>>` or Prisma's `JsonObject`, where **any** key is legal:
`satisfies` there would assert nothing at all. Counting them as unguarded inflates the problem by that
much, which is why the audit resolves types instead of matching text.

Exposed sites by what losing the key costs:

| position | before | after |
|---|---|---|
| `filter` — a Prisma `where`: the key vanishes and **the query widens** | 49 | **0** |
| `write` — a `data`/`select`/`orderBy`: a column is lost | 84 | 84 |
| `value` — an ordinary object, whose own type usually requires the field | 377 | 377 |

All 83 of the `write` sites are in `packages/db`, one in `packages/channel-whatsapp`. They are left
because naming each target (`…CreateInput`, `…UpdateInput`, `…Select`, varying per call) is a larger and
less mechanical edit than the `where` types, and 84 more annotations would make this change hard to
review. The gate's ceiling is what keeps them from multiplying.

**Every `filter` site is now guarded.** That is the position with teeth: a dropped `where` key does not
fail, it returns more rows, and that is how a paged read once returned another Business Profile's style
examples. `write` and `value` are left, ceilinged by the gate below; the reason is review size, not safety.

## The gate

`scripts/verification/spread-key-ratchet.test.ts` runs in the ordinary test run — no database, about
seven seconds — and holds three lines:

1. **No exposed spread in a `filter` position.** A new one fails the gate, naming file, line and key.
2. **A ceiling on exposed `write` and `value` sites** (461). Lower it when you guard more.
3. **No unreviewed pair of spreads writing the same key** (below).

`scripts/verification/spread-key-audit.test.ts` pins the classifier itself against fixtures holding one
example of every verdict, so a classifier that silently stopped recognising anything would fail rather
than report zero problems.

## What the guard does not do

It checks the **key**. It does not rescue a value that was cast. `platform-read-store.ts` passes
`{ state: { in: query.states as never } }`, and `as never` makes the value assignable to anything, so the
`satisfies` there asserts that `state` is a real column and nothing about what is being compared to it.
That cast predates this change and is left as it was; it is named here so the guard is not read as more
than it is.

## Two spreads writing the same key — the class `09280cf` hit by hand



This is not hypothetical on this branch: `09280cf`, two commits back, fixes exactly it. `listStyleExamples`
spread the Business-Profile scope and the keyset cursor into one `where`; both are disjunctions, both wrote
`OR`, the later key won, and the scope was discarded on every paged read — leaving `workspaceId` as the
only tenancy predicate. It was found by reading. The audit below is the same judgement made mechanical.

```ts
...(a === undefined ? {} : { conversation: { channelAccountId: a } }),
...(b === undefined ? {} : { conversation: { takeoverReviewMode: b } }),
```

Each spread is valid, so every type check passes. At run time the later one **replaces** the earlier
object, so when both conditions hold the first filter is simply gone. `satisfies` cannot see this; the
audit can, and reports two pairs:

- `apps/web/src/server/inbox-view.ts:66+67` (`takeover`) — **benign.** Both arms compare `view.filter`
  with a different literal and it holds one value, so they cannot both apply.
- `packages/db/src/review-queue-store.ts:156+157` (`conversation`) — **a real defect, reported and not
  fixed here.** `channelAccountId` and `reviewMode` are independent fields of `ReviewQueueFilter`; with
  both set the channel filter is dropped and the queue answers for every channel. Demonstrated directly:
  with both set, `conversation` is `{"takeoverReviewMode":"HUMAN_AGENT"}` and `channelAccountId` is gone.
  It has never been seen because no production caller passes either field — `reviewFilterOf` sets only
  `reasonCode` and `stale` — and no test sets both. Fixing it changes behaviour and needs its own test,
  so it is listed in the gate's reviewed set rather than repaired in a refactor-only change.

Both fields are also dead weight on the public API: declared, exercised separately by the integration
suite, and never passed by anything in production.
