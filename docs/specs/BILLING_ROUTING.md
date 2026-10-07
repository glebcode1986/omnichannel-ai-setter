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

The quote is judged by the product, not taken from the provider: `PAYMENT_SETTLED` means the money arrived
in the adapter's vocabulary and `SETTLED` means it arrived **in time and in full**. An overpayment settles,
because refusing service to somebody who sent too much is absurd; a full payment that arrived after the
window closed is `AMBIGUOUS`, which is the one case that looks like success and is not.

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
because copying it in would create a second authority on what it says. It must be an absolute `https` URL
(`legal_documents_content_ref_check`), because the checkout renders it as the link somebody reads *before*
they tick the box: a path fragment resolves against the checkout route and 404s, which is a checkbox asking
for consent to something unreadable.

`legal_acceptances` is append-only and carries `locale` — the language of the *page* somebody accepted on,
canonicalised at the entry point. Not the document's locale, which is on the document and may differ: a
product that has not translated its offer shows an English one to a Russian reader, and the question a
dispute asks is whether this person was shown terms in a language they read. That is not derivable from the
document row, which only knows what language it is in.

### Which document each reader is offered

One per kind, chosen in this order, and the order is the point:

1. **Already in force.** A version published for next month exists and is offered to nobody.
2. **Specificity before language.** If the selling entity has published this kind at all, the choice is
   made among *its* versions only. Choosing the language first would hand a Russian reader the platform's
   generic offer whenever the entity had published its own in English alone — for a checkout whose contract
   names that entity's legal name and jurisdiction.
3. **Then the language**, by `negotiateDocumentLocale`: the exact tag, then the same language in another
   region, then the fallback the product publishes everything in. Nothing at all is `DOCUMENT_UNAVAILABLE`
   — operator misconfiguration, refused with its own reason.
4. **The newest in force**, then the highest version.

The requirement is a property of the **kind**, not of a version or a locale: a kind is required when the
current document of that kind in any applicable locale requires it. `readLegalDocumentOffers` and
`current_legal_documents()` compute all of this twice, in TypeScript and in SQL, and the integration suite
holds the two derivations against each other — because the store decides what a person is *shown* while the
triggers decide what may be *written*, and a disagreement is either a checkout that cannot commit or an
acceptance of something nobody saw.

### What the triggers enforce

- `legal_acceptances_applicable` refuses an acceptance that names another workspace's checkout, another
  selling entity's document, a version not yet in force, or a version that is **no longer current**. The
  last clause is what makes "the current required versions are accepted" a database fact.
- `checkout_contracts_acceptance_present` is a **deferred** constraint trigger — it has to be, because the
  acceptances carry a foreign key to the contract, so the contract is written first and a plain
  `AFTER INSERT` would fire before any acceptance could exist.

Both read requirement from the current version, so a withdrawn requirement actually stops being required.

`openCheckoutContract` takes the same advisory lock `publishLegalDocument` takes, so a publication cannot
commit between the documents being resolved and the acceptances being written; and it translates either
trigger's exception into the refusal it would have produced itself, so no Postgres sentence can reach a
page.

### Refusals, and whose fault each one is

`TERMS_NOT_ACCEPTED` means a box was left unticked. `DOCUMENT_SUPERSEDED` means the terms changed while the
page was open — including the case where a requirement **appeared** after the page was drawn, which the
form distinguishes by declaring the ticks it rendered in a hidden `offered` field. Without that field the
store cannot tell the two apart and says the conservative thing; with it, nobody is blamed for a control
they never saw. `PROVIDER_UNAVAILABLE` is checked **last**, after the acceptance checks, so a person who
left a box unticked is told that rather than being told about this deployment's missing adapter.

A refused attempt writes nothing — no contract, no acceptance, no audit row. The contract id *is* the
checkout attempt reference the acceptance points at, and an attempt that was refused offered nothing to
consent to. Recording "they did not tick a box at 14:02" would be surveillance rather than evidence.

`checkout_contracts` copies the seller's registered name and jurisdiction in rather than reading them
through the foreign key. Changing a selling entity must not rewrite what a customer was told last March.

## The acceptance surface

`apps/web/.../settings/billing/checkout` is the explicit acceptance step: the seller's legal identity, the
price, who remits the tax, whether anything renews, and one unticked checkbox per required document version
with a link to read it. A Merchant-of-Record route additionally says that the provider is the seller of
record and its own terms apply at its payment page.

The submit control is **absent**, not disabled, when `checkoutReady` is false — there is nothing on the far
side of it until a provider adapter exists. It is *not* disabled when boxes are unticked: the server's
refusal names the missing document, and a disabled button is a refusal nobody can read.

The route is reachable exactly when `checkoutAvailable` is true — at least one enabled route whose provider
has an adapter registered in this process. That is derived, not a constant: a hard-coded `false` (which is
what #42 shipped) made the whole surface unreachable however a deployment was configured, and left somebody
to remember to edit a file on the day an adapter landed. Until #41 chooses a provider nothing is
registered, so the billing page says so and renders no link — deliberately, and asserted in both
directions by `billing-panes.test.tsx`.

## What is not here

- No provider adapter. The registry takes one; none is registered outside tests (`#41`).
- No payment redirect. The acceptance step records the contract and stops; where the customer goes next
  is the adapter's, which is `#41`.
- No in-provider plan change. An upgrade on a live recurring arrangement is proration, which is a
  capability a route declares and an adapter performs.
- No final legal wording, governing law or jurisdiction-specific requirement. ADR-019 reserves all of it.
