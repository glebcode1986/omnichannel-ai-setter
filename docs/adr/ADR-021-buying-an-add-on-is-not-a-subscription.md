# ADR-021: Buying an add-on is not a subscription, and needs its own narrow purchase path

**Status:** Proposed — awaiting the product owner. Nothing in this ADR is implemented.

**Context:** Issue #44 requires that "recurring BP/seat add-ons and one-time voice top-ups update
entitlements correctly". `PRICING_PACKAGING.md` §186-209 settles the policy: five self-serve add-ons
(+1 Business Profile €25/mo, +1 seat €7/mo, and 500/2,000/5,000 voice minutes at €8/€25/€49), capacity
raised without upgrading the feature class, recurring ones prorated mid-cycle "where the billing provider
supports reliable proration", removal at the end of the paid period, top-ups never bought automatically,
unused top-up minutes carrying through the end of the *next* billing period, and top-up consumed only
after the included allowance. ADR-017 (provider-neutral billing), ADR-019 (routing and seller profiles),
ADR-020 (adapters without an SDK).

**The gap this ADR exists for.** The grant side is built and correct. `grantUsageTopUp` writes a balance
with an expiry, `setWorkspaceAddOn` holds a recurring quantity, `readTopUpBalance` and `consumeTopUp` are
wired into the ledger, and `spendPurchasedAllowance` already implements §205 — the included allowance is
spent first and only the overflow is taken from a bought balance, attributed exactly when a commit
straddles the boundary. `publishAcceptedCatalog` publishes and prices all five add-ons.

**Nothing can buy one.** Every caller of `grantUsageTopUp` and `setWorkspaceAddOn` is a test file, and
`addOnVersionId` appears nowhere outside `catalog-store.ts`: no offer, no checkout and no web path can
name an add-on. So a customer can be shown a priced add-on, and a settled charge would grant nothing.

## What this repository has already decided

The design space is much narrower than it looks, because four existing constraints already answer parts
of it — each deliberately, each with its reason written down.

1. **The two add-on kinds are already split, and the split is enforced.** `setWorkspaceAddOn` refuses a
   `ONE_TIME_ALLOWANCE` outright: *"a one-time top-up is granted as a balance, not held as a
   subscription"*. `grantUsageTopUp` is the other half. Neither needs changing.
2. **A top-up is not an arrangement.** The routing migration says so in its own CHECK comment —
   `billing_routes_terms_check` forbids `ONE_TIME` from a route's `intervals` because *"`ONE_TIME` is a
   top-up, which is not an arrangement at all; a route offering one as a billing interval would describe a
   subscription nobody could cancel."*
3. **A workspace may have only one live arrangement.** `billing_arrangements_one_live_key` is a partial
   unique index on `workspace_id` where the state is neither `ENDED` nor `SUPERSEDED`. A top-up modelled
   as an arrangement would collide with the subscription the customer is buying minutes *for*.
4. **No route capability describes a one-off charge.** The thirteen in `BILLING_CAPABILITIES` cover
   recurring subscriptions, prepaid *terms*, refunds, disputes, tax, invoices, portal, verified webhooks,
   authoritative reconciliation, proration, multi-currency and timed quotes. `PREPAID_TERM` is a
   subscription paid up front, not the purchase of an allowance.

Read together: the commercial core models **subscriptions**, on purpose, and a one-off purchase of an
allowance is a different transaction shape. That is the finding, and it is why this is an ADR rather than
a task.

## Proposed decision

**1. Keep the kind split exactly as it is.** `ONE_TIME_ALLOWANCE` → a balance via `grantUsageTopUp`.
`RECURRING_CAPACITY` → a quantity via `setWorkspaceAddOn`. No change to either function.

**2. A one-time allowance purchase gets its own row, not a `CheckoutContract` and not a
`BillingArrangement`.** Call it `allowance_purchases`. It carries what a charge legally needs and nothing
a subscription needs: workspace, actor, add-on version, quantity, the billing route and the frozen seller
snapshot, the base and charge amounts with their currencies, an optional quote expiry, the provider's
opaque reference, and a state. It has no `interval`, because it is not a term, and no place in the
one-live index, because it is not a charge path.

The alternative — a nullable `plan_version_id` on `CheckoutContract` plus an `add_on_version_id` — is
rejected. It would fight constraint 2 (the route cannot offer the interval such a contract would need),
widen a non-nullable column that every existing row depends on, and make `apply`'s `ACTIVATE` branch mean
two different things depending on which column is null. ADR-019's own rule applies: provider state and
application state are never summed, and neither are two transaction shapes in one table.

**3. One new route capability, `ONE_OFF_CHARGES`, decides which routes may sell one.** Without it the
selection would have to infer from `intervals`, which constraint 2 has deliberately emptied of the only
value that would apply. Selection for a top-up is then by currency and capability, with no interval
dimension at all.

**4. One new effect, `GRANT`, in `billing_events.effect`.** The CHECK currently lists
`ACTIVATE, EXTEND, SUSPEND, END, NONE`; `effect` is a `String` column, so this is an altered CHECK rather
than an enum migration. `apply` gains one branch: a verified settlement naming an `allowance_purchases`
row grants the add-on version's quota through `grantUsageTopUp`, with §204's expiry — the end of the
*next* billing period, computed from the workspace's usage cycle rather than from the purchase date, so a
top-up bought on the last day of a cycle is not worth a day less than one bought on the first.

The existing guards carry over unchanged and are the reason to reuse this path rather than invent a
second one: only an event the adapter registry minted is accepted, a duplicate `providerEventId` is
reported as `DUPLICATE` without re-granting, an event naming a purchase on another route resolves to
nothing, and the whole thing is audited. A top-up granted twice is money the customer did not spend.

**5. Recurring capacity add-ons are explicitly out of scope here.** They need two decisions this ADR does
not take: whether a recurring add-on is a second subscription item at the provider or its own arrangement
(constraint 3 makes the second answer costly), and whether proration is attempted at all on the first
provider, given §201's "where the billing provider supports reliable proration". Shipping the one-time
half first is coherent because §205's consumption order, §204's expiry and the ledger attribution are
already built and tested — only the purchase is missing.

## Consequences

- Two migrations: the `allowance_purchases` table with its CHECKs, and the altered `effect` CHECK plus the
  new capability's membership. The capability list is spelled in both the domain and a CHECK, so both move
  together — the drift this repository already guards with a test that asserts every declared capability
  is accepted and an undeclared one refused.
- `apply` gains one branch and one new subject to resolve. Its existing five branches are untouched;
  the `SUSPEND` correction of 2026-10-14 showed what it costs when one branch does not share its
  siblings' guards, so the new branch states its refusals explicitly: an ended purchase is recorded and
  never resurrected, and a purchase whose route does not own it grants nothing.
- The billing UI gains a purchase surface. §209 requires the effective total be shown before
  checkout/update and recurring add-ons be distinguished from one-time top-ups; §203 requires that a
  top-up is never bought automatically, which means no code path may call this without an explicit
  customer action.
- `voice-500`, `voice-2000` and `voice-5000` stop being configuration nothing reads. Until this is
  accepted and built they remain exactly that, and the honest statement of the product's position is that
  it publishes prices for three products it cannot sell.

## What this ADR does not decide

- The provider representation and proration question for recurring add-ons (decision 5).
- Whether a top-up may be bought while a subscription is in `GRACE` or `CANCELED_PENDING_END`. The
  conservative reading of §203 is that buying minutes is the customer's own act and should be allowed,
  but it interacts with the unresolved question of how `GRACE` ends.
- Refund handling for a consumed balance. §202 covers removing a *recurring* add-on; it does not say what
  a refund means once minutes have been spent, and the ledger is append-only by design.
