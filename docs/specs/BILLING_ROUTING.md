# Billing Routing Implementation — v0.1

Companion to `ADR-019`, `ADR-017` and `BILLING_ENTITLEMENTS.md`. Where ADR-019 states the architecture
direction, this says how it is enforced in the code — which rule is a constraint, which is a trigger,
which is a type, and why each one is where it is.

No payment provider is integrated and none is named. Choosing the first production provider and the final
selling entity remain the product owner's (`#41`).

## Four concepts, deliberately separate

| | what it is | where it lives |
|---|---|---|
| `SellerProfile` | the legal entity selling to the customer | `seller_profiles` |
| `BillingRoute` | provider + provider account + seller profile + currencies + intervals + capabilities | `billing_routes` |
| `BillingArrangement` | one workspace's live charge path | `billing_arrangements` |
| `CheckoutContract` | the immutable record of what was offered, and under which terms | `checkout_contracts` |

A direct processor leaves us the seller of record; a Merchant of Record **is** the seller and remits the
tax. The same entity can be used through two providers and the same provider by two entities, so the
provider and the entity are different rows and a route names one of each.

## The client never names a route

`openCheckoutContract` takes a plan version, an interval, an arrangement kind, a currency and an optional
market. There is no parameter for a provider, a provider account or a seller profile, so a forged
identifier has nowhere to arrive — a stronger statement than validating one would be. The route is read
from operator configuration through `selectRoute`, which prefers the lowest `priority` and breaks a tie on
`code`, so the same request never lands on a different selling entity on a different day.

`readCheckoutRouting` is the one read that returns provider vocabulary. It takes an id rather than a
session, because its caller is the composition root that creates the provider's session, and it returns
nothing a page could use.

## Capabilities, and why tax is two of them

A route declares capabilities in the product's own words; nothing assumes recurring subscriptions,
proration, invoices or tax remittance. `TAX_CALCULATION` and `TAX_REMITTANCE` are separate entries because
a processor that can work out VAT has not thereby become the seller who owes it — remittance is what makes
a route a Merchant of Record, and `billing_routes_coherence_check` refuses a `MERCHANT_OF_RECORD` route
that does not declare it.

`VERIFIED_WEBHOOKS` and `AUTHORITATIVE_RECONCILIATION` are the two ways a payment can become a fact. An
enabled route must declare at least one, because a route with neither could never activate anything — and
a browser redirect is not a third option.

The capability list is spelled twice, in `packages/domain/src/billing-routing.ts` and in
`billing_routes_capabilities_known_check`. `billing-routing.integration.test.ts` holds the two spellings
against each other in both directions, which is the only thing keeping them from drifting.

## Activation

`recordVerifiedBillingEvent` takes a `VerifiedBillingEvent`. The only values of that type are the frozen
objects `packages/db/src/billing-events.ts` mints, tracked in a module-private `WeakSet` — the same pattern
`tenancy.ts` uses for authorization contexts. Minting happens in exactly two functions, both of which go
through a registered provider adapter:

- `verifyProviderDelivery` hands the adapter a raw signed delivery to authenticate;
- `reconcileProviderState` asks the provider what it says is true.

A success-page handler cannot produce one. Casting does not help: the WeakSet is unreachable and the
objects are frozen. This is the rule "a browser redirect never activates a paid entitlement", made
structural instead of remembered — the shape of that mistake is a handler that looks correct and is only
missing authority nobody noticed it did not have.

Idempotency is an index: `(billing_route_id, provider_event_id)` is unique, and the store reads before
writing under a transaction-scoped advisory lock, so a provider retrying for an hour neither double-charges
nor double-extends. The scope is the route rather than the workspace because a provider's event identifier
is unique within its own account, which is what a route names.

### What an event may do

`entitlementEffectOf` is a total map over the event kinds, so adding a kind is a type error rather than a
silent `NONE`. A settlement activates, a renewal extends, a failure suspends into grace, and a
cancellation, refund or chargeback ends. Underpayment and an expired quote do nothing.

**An effect the map allows is still refused against settled state: recorded, never resurrected.** A
settlement for an arrangement already `ENDED` or `SUPERSEDED` does not revive it — that would put the
workspace back on a provider it had been moved off. A renewal for a subscription the customer has
cancelled, or one already `INACTIVE`, does not revive that either: `CANCELED_PENDING_END` is the customer's
decision and `INACTIVE` is that decision carried out, and the only way back from the first is the
customer's own `resumeSubscription`, which checks a billing role, refuses once the paid period has passed,
and names itself in the audit trail. A webhook writing `ACTIVE` would bypass all three and charge somebody
who had cancelled.

In that case the arrangement is left alone as well. Moving its period end would leave a row reading like a
live renewal underneath a subscription that is ending, and provider state and application state are never
summed. The event is still written with `effect: NONE` and audited, which is what makes the divergence
findable; resolving it belongs to provider reconciliation.

The quote is judged by the product, not taken from the provider: `PAYMENT_SETTLED` means the money arrived
in the adapter's vocabulary and `SETTLED` means it arrived **in time and in full**. An overpayment settles,
because refusing service to somebody who sent too much is absurd; a full payment that arrived after the
window closed is `AMBIGUOUS`, which is the one case that looks like success and is not.

### Where routes come from

From **operator configuration**, in one environment variable: `BILLING_ROUTING`, a JSON document with
`sellers` and `routes`, applied by `pnpm billing:publish-routes`. Before that command existed nothing wrote
a route at all, so `selectRoute` answered `NO_ROUTE` for every checkout and `recordVerifiedBillingEvent`
answered `UNKNOWN_ROUTE` for every webhook, in any deployment a test had not seeded.

Sellers and routes travel in **one** document so a route cannot name a seller the configuration does not
define — split across two variables, that mistake is found by the first customer who tries to pay rather
than by whoever wrote the file.

The document says what a route *is*; `STRIPE_ROUTES` says which credentials speak for it, and the two meet
at `routeCode`. A route configured without credentials registers no adapter and therefore cannot be chosen,
which is the safe direction: an unchosen route refuses a checkout, where a chosen one with no keys would
accept a delivery it cannot authenticate.

Both writes are upserts and re-running is normal — a company changes its support address, a route gains a
currency. That is the difference between this and publishing a catalogue version, which cuts a new one every
time. `--dry-run` reports and writes nothing.

The command validates **shape** and that every route's seller exists; it does not check capability
coherence, currency codes or settlement models. `upsertBillingRoute` does, against the same CHECK the table
enforces, and it names which of the thirteen capabilities is wrong — a second opinion in the command would
be a second place the rule lived. Neither the command nor its refusals ever echo a value from the document,
because it carries provider account references.

## One live charge path

`billing_arrangements_one_live_key` is a partial unique index over `workspace_id` where the state is
neither `ENDED` nor `SUPERSEDED`. `PENDING` counts as live, because a charge path being opened is a charge
path: a second checkout completing while the first was still open is exactly how a customer ends up on two
providers.

The predicate is spelled as two inequalities rather than `state IN ('PENDING','ACTIVE')` because PostgreSQL
rewrites `IN` into `= ANY (ARRAY[...])` with casts, and `db:check-drift` then reports a changed index on
every run. The consequence is that a state added later counts as live until somebody says otherwise — the
safe direction — and the integration suite asserts which states collide so the decision is made rather
than inherited.

A provider switch is `supersedeCurrent: true`, which ends the old arrangement, records `supersededById` on
it and opens the new one in one transaction. The old row keeps its route and its `providerReference` for
reconciliation. Without the flag a second checkout is refused with `ARRANGEMENT_EXISTS`: the default *is*
the rule "never create a second active charge path silently".

The cost of that guarantee is that an unfinished checkout holds the slot, so `expireStaleCheckouts` — run
by `apps/worker/src/billing-sweeper.ts` — releases it when the quote's clock runs out, or after
`CHECKOUT_TTL_MS` for a checkout with no clock. A quote that ran out leaves the contract `EXPIRED`; one
nobody came back to leaves it `ABANDONED`. Both keep the acceptance snapshot the attempt carried.

## Money

Minor units of a named currency or asset, and never a float. `money()` refuses a fraction rather than
rounding it, because a caller that produced 1999.5 minor units has divided something it should not have.
Negative is refused too: a reversal is an event kind, not a negative price.

The catalogue's price book stays ISO 4217 — `plan_prices_currency_check` refuses an asset code — and a
route's `currencies` are the **base** currencies it can take a charge for. A route with `TIMED_QUOTES` may
settle an EUR-priced charge in another asset, and which asset that is belongs to the quote. So a plan keeps
one price book however many providers can take money for it, which is what "the quote does not rewrite the
plan's meaning" amounts to in the schema.

## Legal acceptance

`legal_documents` is versioned and immutable; a correction is a new version, and the old one stays readable
because somebody accepted it. The text is not stored — `contentRef` points at wherever it is published,
because copying it in would create a second authority on what it says.

`legal_acceptances` is append-only. A seller-specific document shadows a global one of the same kind, since
an entity that publishes its own offer has superseded the generic text for its own checkouts.

A checkout cannot commit without an acceptance of every required document kind. That is a **deferred**
constraint trigger and it has to be: the acceptances carry a foreign key to the contract, so the contract
is written first and a plain `AFTER INSERT` trigger would fire before any acceptance could exist. Which
kinds are required is read from `required_for_checkout` on the documents rather than from the route,
because which documents a market requires is a legal decision the owner has not made yet — a jurisdiction
that needs a privacy acceptance at checkout gets one by marking the document, not by changing the trigger.

`checkout_contracts` copies the seller's registered name and jurisdiction in rather than reading them
through the foreign key. Changing a selling entity must not rewrite what a customer was told last March.

## What is not here

- No provider adapter. The registry takes one; none is registered outside tests (`#41`).
- No checkout UI. The acceptance control and the offer screen are `#47`; `CHECKOUT_AVAILABLE` in
  `apps/web/src/server/billing-screen.ts` is still `false`.
- No in-provider plan change. An upgrade on a live recurring arrangement is proration, which is a
  capability a route declares and an adapter performs.
- No final legal wording, governing law or jurisdiction-specific requirement. ADR-019 reserves all of it.
