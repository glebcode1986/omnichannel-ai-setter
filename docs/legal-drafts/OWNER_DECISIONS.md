# Owner decisions required

> Part of the Issue #121 drafting task. **Nothing here is published or approved.**
>
> Every item is a decision for the owner or a question for a legal professional. Nothing in this file is
> a recommendation about tax, jurisdiction, corporate form or financial terms, and nothing below has been
> decided by writing it down.

## Values the owner has already stated

Recorded from the owner's own messages so the drafts do not re-ask. These are **owner attestations as of
30 October 2026**, not independently verified facts, and each still carries the verification item noted
against it.

| Value | What the owner stated | Still outstanding |
| --- | --- | --- |
| Brand | Mixamart | — |
| Product domain | `mixamart.com`, with the `t`. An earlier spelling without the `t` was a transcription error and is retracted; it is deliberately not reproduced anywhere in this directory, so that it cannot be copied out of it | Not acquired or verified. D-2 |
| Sign-in sender | `no-reply@mixamart.com` via Resend | Domain not verified, no account, no DNS. D-5 |
| Seller / merchant | SOTCO GROUP S.R.L. (Romania), CUI `50512210`, ONRC `J2024020487003` | Registered office and contact details for public legal copy. D-3 |
| Payment routes | Stripe is the implemented first adapter; PayPal is separately planned and **not** active | Which routes are enabled at launch. D-7 |
| Romanian SaaS activity | The owner confirms the additional software-development CAEN classes **are already registered**. The 2026-04-30 ONRC extract is an older snapshot and is not evidence of their absence | Refreshed registry evidence only if a bank, payment provider or regulator asks for it |

Two things are deliberately **not** carried into any draft. The company extract itself and any personal
details in it stay out of this repository entirely. And the earlier assertion that the business lacked
software activity is withdrawn — it was read from a superseded document and must not be repeated.

## Placeholder registry

Every `{{PLACEHOLDER}}` in the drafts, and what resolves it. Searchable: no placeholder appears in a
draft without a row here.

| Placeholder | Resolved by | Status |
| --- | --- | --- |
| `{{PRODUCT_NAME}}` | Brand decision | Stated: Mixamart |
| `{{PRODUCT_DOMAIN}}` | Domain decision | Stated: `mixamart.com`; not acquired. D-2 |
| `{{SERVICE_URL}}` | Whether the application is served from the root domain or a subdomain | **Unresolved.** D-2 |
| `{{SELLER_LEGAL_NAME}}` | `seller_profiles.legal_name` | Stated for the first route |
| `{{SELLER_DISPLAY_NAME}}` | `seller_profiles.display_name` | D-3 |
| `{{SELLER_JURISDICTION}}` | `seller_profiles.jurisdiction`, ISO 3166-1 alpha-2 | Stated: `RO` |
| `{{SELLER_REGISTRATION}}` | Registry identifiers as they should appear publicly | Stated: CUI `50512210`, ONRC `J2024020487003`. Public form to confirm. D-3 |
| `{{SELLER_ADDRESS}}` | Registered office as it should appear in public legal copy | **Unresolved.** D-3 |
| `{{SELLER_VAT}}` | Whether a VAT identifier is shown, and which | **Unresolved.** D-4 |
| `{{SUPPORT_EMAIL}}` | `seller_profiles.support_email` | **Unresolved.** D-3 |
| `{{PRIVACY_EMAIL}}` | Mailbox for data-subject requests | **Unresolved.** D-3 |
| `{{LEGAL_EMAIL}}` | Mailbox for notices and disputes | **Unresolved.** D-3 |
| `{{GOVERNING_LAW}}` | Governing law | **Unresolved. Legal advice required.** D-8 |
| `{{FORUM}}` | Courts or arbitration, and seat | **Unresolved. Legal advice required.** D-8 |
| `{{SUPERVISORY_AUTHORITY}}` | The authority a data subject may complain to | **Unresolved**, follows establishment. D-8 |
| `{{LIABILITY_CAP}}` | Liability cap and its basis | **Unresolved. Legal advice required.** D-8 |
| `{{REFUND_WINDOW}}` | Days within which a refund may be requested | **Unresolved. Legal advice required.** D-8 |
| `{{REFUND_DECISION_DAYS}}` | Days to decide a refund request | **Unresolved.** D-8 |
| `{{REFUND_PAYOUT_DAYS}}` | Days to return funds once approved | **Unresolved.** D-8 |
| `{{WITHDRAWAL_CLAUSE}}` | Whether and how a consumer withdrawal right is addressed | **Unresolved. Legal advice required.** D-8 |
| `{{MINIMUM_AGE}}` | Minimum age for an account | **Unresolved.** D-16 |
| `{{ACCOUNT_DATA_RETENTION}}` | Retention for account and workspace data after closure | **Unresolved.** D-11 |
| `{{BILLING_RECORD_RETENTION}}` | Retention for invoices and billing records | **Unresolved**, likely set by Romanian accounting law. D-11 |
| `{{LEGAL_RECORD_RETENTION}}` | Retention for acceptance evidence | **Unresolved.** D-11 |
| `{{CONVERSATION_RETENTION}}` | Default retention for conversation content, if any | **Unresolved.** D-11 |
| `{{HOSTING_REGION}}` | Where the database and application run | **Unresolved.** D-10 |
| `{{DPO_OR_REPRESENTATIVE}}` | Whether a data protection officer or representative is appointed and named | **Unresolved.** D-17 |
| `{{EFFECTIVE_DATE}}` | The date a published version takes effect, matching `legal_documents.effective_from` | Set at publication |
| `{{DOCUMENT_VERSION}}` | The integer in `legal_documents.version` | Set at publication |

## Decisions

### D-1 — Publish the documents before taking the first payment *(highest priority)*

Not a drafting question. As the system stands, a checkout with no `legal_documents` rows commits with no
acceptance recorded and nothing refuses it: the coverage trigger aggregates over the documents that exist,
and over an empty set it raises nothing. There is also no production path that creates such a row —
`publishLegalDocument` has no caller outside tests, and `billing:publish-routes` publishes sellers and
routes only.

So the order matters: approved text → public pages → `legal_documents` rows with `content_ref` → decide
`required_for_checkout` per kind → first payment. Detail in [`CROSSWALK.md`](CROSSWALK.md), R-1 and R-2.

### D-2 — The domain, and whether the app sits on it

The name is settled. Acquisition and DNS are not, and one consequence is easy to miss: `AUTH_URL` decides
the origin of every sign-in link and must match the Google OAuth callback. The owner has flagged that
whether the application runs on the root domain or a subdomain is not yet decided, so `AUTH_URL` stays
unset rather than guessed.

### D-3 — Seller identity, address and mailboxes, per route

The entity is named. For public legal copy the drafts still need the registered office as it should
appear, the display name a customer sees at checkout, and three working mailboxes — support, privacy and
legal. They may be the same address; what matters is that somebody reads it. `seller_profiles.support_email`
is a required column for exactly that reason: *"a seller nobody can reach is not a seller."*

### D-4 — Tax, invoicing and Merchant of Record, per route

Whether prices are shown inclusive or exclusive of VAT, which VAT identifier appears, who issues the
invoice, and whether any route makes the provider the Merchant of Record. The catalogue stores prices in
minor units of a currency and the drafts state no tax position. Accountant's question.

### D-5 — Resend diligence before e-mail sign-in is enabled

Verify the sending domain with SPF, DKIM and DMARC. Create a scoped API key and put it only in the
deployment's secret storage — never in this repository, a GitHub comment, or chat. Then confirm, in
writing, the data processing agreement for the account, the processing region, and the retention applied
to delivery metadata. Until the last three are confirmed, no draft may state them.

Until the domain is verified, leaving `AUTH_EMAIL_SERVER` and `AUTH_EMAIL_FROM` unset is the safer state:
the sign-in page withholds the e-mail method rather than offering a button that fails.

### D-6 — The sign-in send cap is an availability question

A magic link sits on the critical path into the product and every retry consumes a send, so a plan with a
daily cap can lock out a paying customer. A decision about the plan, not about the drafts.

### D-7 — Which payment routes are enabled at launch

Stripe is implemented. PayPal is planned and not implemented. Each enabled route needs a seller profile,
currencies, intervals, and its own legal document set if its seller differs — which the schema already
supports through `legal_documents.seller_profile_id`.

### D-8 — The legal-advice block

These belong together because a lawyer will answer them in one pass, and answering any one of them
separately risks contradicting the others:

- governing law and forum;
- whether any customer is a consumer rather than a business, and what follows. The product sells to
  businesses, but a sole trader subscribing for their own trade is a borderline case in several member
  states, and an EU-established seller cannot exclude a consumer right by drafting;
- the consumer withdrawal right for a distance contract, and whether the digital-services exception is
  available given that the product is supplied immediately. Worth the lawyer knowing: the trial already
  gives fourteen days of use with no card, which is a fact about the product, not an argument about the
  law;
- refund eligibility, exclusions, decision and payout periods;
- the liability cap and what cannot be capped;
- how a dispute is handled before it becomes litigation.

The drafts mark every one of these as a placeholder and assert nothing in either direction.

### D-9 — Whether the subprocessor list is published or furnished

A public page that is updated with notice, or an annex to the DPA given to customers. Either is defensible;
the choice changes what a provider swap costs operationally. See [`SUBPROCESSORS.md`](SUBPROCESSORS.md).

### D-10 — Hosting and data location

Where the database, Redis and the application run, and therefore where conversation content rests. The
privacy draft cannot name a location until this is decided. Note separately that the current staging
environment runs on a server belonging to another product and is not a model for production isolation.

### D-11 — Retention periods, by category

The implemented deletion workflow has four scopes and is specific about what each removes. What it does
not have is a *period*: nothing expires on a clock today except OAuth connect states and customer facts,
which expire on read. Four periods are needed — account and workspace data after closure, conversation
content, billing records, and acceptance evidence.

Two are in tension and the tension is real. Workspace deletion removes every profile's customers but
keeps "records a regulator or payment provider requires" — and acceptance rows are append-only by trigger,
by design, because consent evidence that can be edited is not evidence. So a customer asking for erasure
cannot be given erasure of their acceptance record, and the drafts must say which records survive a
deletion request and on what basis. `PRIVACY_RETENTION_DELETION.md` excludes billing and legal records
because "nothing in this product writes any yet"; Phase 6 now does.

### D-12 — Cookies and analytics

There is no analytics or advertising cookie in the product today, which is why the draft notice is short
and why no consent banner is proposed. That answer changes with the first analytics script, support
widget, embedded video or marketing tag. The decision to own: whether anything of that kind is planned
before launch, and if so, that a consent mechanism is designed with it rather than retrofitted.

### D-13 — Target markets beyond the EU

Which jurisdictions customers may be in. The interface ships in English and Russian, which is a hint
about intent and not a legal determination about anywhere.

### D-14 — Whether provider inputs may be used for model training

The drafts do not state that customer content is excluded from provider model training, because that is a
function of each provider's terms and the account's configuration, and it has not been verified. If the
owner wants the Privacy Policy to say it, each provider's position has to be confirmed first — and then
re-confirmed whenever a provider is changed.

### D-15 — One AI disclosure or two

The reference pack splits an AI Disclaimer from an AI Providers Notice. These drafts merge them. Splitting
is reasonable if the provider list will version more often than the disclaimer.

### D-16 — Minimum age

The product is sold to businesses, so the realistic threshold is contractual capacity rather than a
child-protection threshold — but it still has to be stated, and the privacy draft needs it for the
children's-data section.

### D-17 — Data protection officer or EU representative

Whether either is appointed, and what contact is published. Follows from the establishment and the scale
of processing.

### D-18 — Locales, and keeping them aligned

The interface supports exactly `en` and `ru`, so both drafts are needed. The decision to make explicit:
that a document kind is published in both locales at the same version, in the same pass. The schema will
not enforce it — `version` is monotonic per kind *and* locale, and the reference pack shows what happens
when nobody holds the line: Russian terms a month behind English, two sections missing, and no mention of
a data processing agreement at all in a privacy policy whose English twin cross-references one four times.

### D-19 — Who signs off, and on what

The drafts need a named reviewer and a recorded approval before any of them is published. A technical
review of this pull request is not a legal approval, and the reviewer's own verdict says so.

## What was deliberately not decided here

Not drafted, not assumed, and not quietly resolved: the seller's address and tax position, governing law,
corporate form, liability caps, refund windows, retention periods, the hosting provider, any permission
the customer has not actually given, and any statement that a vendor agreement exists.
