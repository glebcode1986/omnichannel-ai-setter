# Section-level crosswalk: FastyAds pack → this product

> Part of the Issue #121 drafting task. **Nothing here is published or approved.**

## How to read this

Each table maps a section of the reference pack onto the draft in `en/` and `ru/`, with one of five
dispositions:

| Disposition | Meaning |
| --- | --- |
| **reuse** | The section belongs here and its substance transfers. Wording still rewritten for this product. |
| **rewrite** | This product needs the section, but what it has to say is different. |
| **replace** | The source's concept does not exist here; a different section occupies the same place. |
| **drop** | No counterpart. The source section is about something this product does not do. |
| **new** | This product needs a section the source has no equivalent of. |

The product facts below are taken from accepted specifications and from the code, not assumed. Where a
fact is in a specification, the specification is named.

## Why nothing can be copied with substitutions

Four things change at once between the two products, and each changes the meaning of sections that look
transferable.

**The seller is in a different country.** The source is governed by Ukrainian law with a Ukrainian sole
trader as controller and seller. This product's first launch route is a Romanian company. That is not a
change of address: an EU-established seller is inside the GDPR as a matter of establishment rather than
"where applicable", its supervisory authority and the reader's right to complain to one are different,
every transfer to a US processor needs an Article 46 instrument, and EU consumer law applies to any
customer who is a consumer. A find-and-replace on the entity name would leave a Ukrainian-law refund
section sitting under a Romanian seller.

**The commercial model is different.** The source sells credits: 93 references to credits against 9 to
subscriptions and 1 to a trial. Its refund eligibility is built on unused credit balances, and its
"Use of Credits" section has no counterpart here at all. This product sells subscriptions with capacity
limits, recurring add-ons, one-time top-ups and a 14-day trial that needs no card. A refund rule written
for an unused balance says nothing about a month of service already delivered.

**The product acts on the customer's behalf, to third parties.** The source generates media for the
person who asked for it. This product writes messages to *that person's* customers, over Instagram and
WhatsApp, sometimes without a human looking first. That introduces a second set of data subjects who
never visited the site and never accepted anything, a controller/processor split that actually matters
rather than being a footnote, and platform terms imposed by Meta that flow through to the customer.

**There is a metered resource the source has no concept of.** Voice-note transcription is this product's
one customer-metered allowance, with a published minute grant per plan and purchasable top-ups. The word
"voice" appears 11 times in the source and every one of them is about voice cloning and deepfakes in
generated media.

## Privacy Policy

Source: 19 sections. Draft: [`en/privacy-policy.md`](en/privacy-policy.md).

| Source section | Disposition | Note |
| --- | --- | --- |
| 1. General Overview | rewrite | Must cover two populations: the customer's own staff, and the customer's customers who never visited us. |
| 2. Data Controller and Processor Roles | rewrite | The split is load-bearing here, not a footnote. We are controller for account and billing data; processor for conversation content. |
| 3. Categories of Personal Data | rewrite | Replaced with this product's actual categories, including transcripts and derived customer facts. |
| 4. Sources of Personal Data | rewrite | Our main source is a Meta webhook, not a form the data subject filled in. |
| 5. Purposes of Processing | rewrite | Credits and generation workflows out; drafting, gating, delivery, retrieval and metering in. |
| 6. Marketing and Transactional Communications | rewrite | Our only transactional mail today is the sign-in link. No marketing mail exists. |
| 7. Legal Bases | rewrite | Contract and legitimate interests for our own processing; the customer's instruction for conversation content. |
| 8. AI Processing and Third-Party Providers | rewrite | Named providers from the environment contract — see [`SUBPROCESSORS.md`](SUBPROCESSORS.md). |
| 9. International Data Transfers | rewrite | EU controller to US processors. Mechanism per processor is unresolved and marked so. |
| 10. Data Retention and Account Deletion | rewrite | We have a real, implemented deletion workflow with four scopes. It is more specific than the source and, in one respect, narrower. |
| 11. Data Sharing | reuse | Structure transfers. |
| 12. Cookies and Similar Technologies | rewrite | Short, because there is almost nothing to say. See [`ADJUNCT_ASSESSMENT.md`](ADJUNCT_ASSESSMENT.md). |
| 13. Security Measures | rewrite | Envelope-encrypted credentials and the no-secrets-in-logs rule are specific and true here. |
| 14. Your Rights | rewrite | Must say who to ask: a data subject whose data we hold as processor has to go to the customer, not to us. |
| 15. Automated Processing and AI Output | rewrite | This is the section the product most needs, and the source's version is about generated images. |
| 16. Children's Data | reuse | Structure transfers; age threshold is a placeholder. |
| 17. Policy Updates | rewrite | Must match how versioning actually works: a new version is a new row, never an edit. |
| 18. Contact Information | reuse | All placeholders. |
| 19. Final Provisions | reuse | — |
| — | **new** | *Human review and takeover*: that a person can take over a conversation at any time, and what that means for the record. |
| — | **new** | *What we do not do*: no advertising or analytics cookies, no sale of data, no training of third-party models on customer content without a decision recorded here. |

> The last of those is flagged as a decision rather than stated. Whether provider API inputs are excluded
> from model training is a function of each provider's terms and the account's configuration, and this
> draft does not assert it. See [`OWNER_DECISIONS.md`](OWNER_DECISIONS.md), D-14.

## Terms of Service

Source: 18 sections. Draft: [`en/terms-of-service.md`](en/terms-of-service.md).

| Source section | Disposition | Note |
| --- | --- | --- |
| 1. Acceptance of the Terms | rewrite | Acceptance is recorded as a row against a document version, before any payment page. |
| 2. About the Service | rewrite | Describes an inbox and an assistant that drafts and sometimes sends, not an editor. |
| 3. Eligibility and Accounts | rewrite | Workspaces, business profiles, members and roles — the actual model. |
| 4. Acceptable Use | replace | Kept as a cross-reference to a real AUP in this directory, rather than 10 references to an absent one. |
| 5. Payments, Credits, and Pricing | replace | Subscriptions, intervals, add-ons, top-ups and the trial. |
| 6. Third-Party Providers, AI Models, Production Modes | rewrite | Meta's platform terms flow through to the customer; provider outages are a named, expected state. |
| 7. AI Output and User Responsibility | rewrite | Can now be specific: the modes, the gates, and what the product refuses to send unreviewed. |
| 8. User Content and Generated Content | rewrite | Must distinguish the customer's own content from their customers' messages, which are not theirs to license to us. |
| 9. Platform Intellectual Property | reuse | Structure transfers. |
| 10. Privacy, Data Processing, Cookies | reuse | Cross-reference. |
| 11. Suspension, Termination, Account Closure | rewrite | Must track the implemented states, including that inbound messages keep being stored when billing lapses. |
| 12. Disclaimer of Warranties | reuse | — |
| 13. Limitation of Liability | rewrite | Caps are placeholders; the structure needs a carve-out the source has no reason for. |
| 14. Indemnification | reuse | — |
| 15. Governing Law and Dispute Resolution | rewrite | Unresolved. Romanian seller, EU consumer rules, mandatory-law carve-out. |
| 16. Changes to the Terms | rewrite | Must match versioned acceptance: a change is a new version somebody is asked to accept. |
| 17. General Provisions | reuse | — |
| 18. Contacts | reuse | Placeholders. |
| — | **new** | *Authorizations you give us*: connecting an Instagram or WhatsApp account is an authorization with a scope and an expiry, and revoking it stops the service for that profile. |
| — | **new** | *Messaging-window and policy constraints*: the product cannot send outside a platform's window, and the customer's expectations have to match that. |
| — | **new** | *Your obligations to your own customers*: lawful basis for messaging them, and honouring opt-outs. |

## Public Offer / Service Agreement

Source: 20 sections. Draft: [`en/public-offer.md`](en/public-offer.md).

| Source section | Disposition | Note |
| --- | --- | --- |
| 1. General Provisions | reuse | Structure transfers; the offer mechanism is the same shape. |
| 2. Definitions | rewrite | Workspace, Business Profile, Draft, Autopilot, Review Queue, Takeover — the product's own vocabulary. |
| 3. Subject of the Agreement | rewrite | Access to a subscription service, not a credit balance. |
| 4. Acceptance of the Offer | rewrite | Must describe what is actually recorded: document kind, version, locale of the page, actor, instant. |
| 5. Registration, Eligibility, Account Security | reuse | — |
| 6. Payments, Credits, and Billing | replace | Plans, intervals, currency, renewal, grace, upgrade and downgrade timing. |
| 7. Use of Credits | **drop** | No counterpart. Replaced by *Capacity, allowances and top-ups*. |
| 8. Permitted Use and Restrictions | reuse | Cross-reference to the AUP. |
| 9. AI-Specific Acknowledgments | rewrite | The specific acknowledgments this product needs, including that Autopilot sends without prior human review. |
| 10. Intellectual Property | reuse | — |
| 11. Personal Data and Confidentiality | rewrite | Points at the DPA, which must then exist. |
| 12. Suspension, Restriction, Termination | rewrite | Matches implemented states. |
| 13. Refunds | reuse | Cross-reference. |
| 14. Disclaimer of Warranties | reuse | — |
| 15. Limitation of Liability | rewrite | As Terms §13. |
| 16. Indemnification | reuse | — |
| 17. Governing Law and Dispute Resolution | rewrite | Unresolved. |
| 18. Force Majeure | rewrite | Should name provider and platform outage explicitly, because it is the realistic case. |
| 19. Amendments and Final Provisions | rewrite | Versioned acceptance again. |
| 20. Contacts | reuse | Placeholders. |
| — | **new** | *Capacity, allowances and top-ups*: Business Profile slots, seats, voice minutes, and what happens at exhaustion. |
| — | **new** | *The trial*: 14 days, no card, when it starts, and what survives its expiry. |
| — | **new** | *Which entity you are contracting with*: the route decides the seller, and the seller is named in the checkout record. |

## Refund and Cancellation Policy

Source: 14 sections. Draft: [`en/refund-and-cancellation.md`](en/refund-and-cancellation.md).

This is the document that transfers least. The source's eligibility logic is about unused credits; this
product has no credits.

| Source section | Disposition | Note |
| --- | --- | --- |
| 1. General Provisions | reuse | — |
| 2. Nature of the Digital Product | rewrite | A subscription to a running service, not a consumable balance. |
| 3. Refund Eligibility | replace | Written around subscription terms, the trial, and the day the term was charged. |
| 4. Non-Refundable Cases | rewrite | Must not contradict mandatory consumer law. Marked as the lawyer's section. |
| 5. Third-Party Providers and AI Processing | rewrite | Provider cost is not a reason to refuse a refund the law requires. |
| 6. Refund Request Procedure | reuse | Structure transfers; the mailbox is a placeholder. |
| 7. Review and Processing Time | rewrite | Periods are placeholders, not the source's numbers. |
| 8. Exceptional Refunds | reuse | — |
| 9. Chargebacks, Fraud Prevention, Technical Records | rewrite | Can be specific: a dispute may restrict paid automated actions while it is reviewed. |
| 10. Account Suspension, Closure, Deletion | rewrite | A refund does not delete anything. That is implemented and can be stated plainly. |
| 11. Limitation of Liability | reuse | — |
| 12. Governing Law | rewrite | Unresolved. |
| 13. Changes to this Policy | rewrite | Versioned. |
| 14. Contacts | reuse | Placeholders. |
| — | **new** | *Cancellation*: cancel-at-period-end by default, what stops and when, and that nothing is deleted. |
| — | **new** | *Failed renewal*: the 3-day grace period and what it does and does not suspend. |
| — | **new** | *Downgrade*: effective at the end of the paid period, no automatic refund for the remainder, and how over-capacity resources are handled. |
| — | **new** | *Top-ups*: one-time purchases, carry-over to the end of the next period, and expiry. |

## Risk register

Ordered by how much damage an unnoticed instance would do.

### R-1 — A checkout can take money with no recorded consent, and nothing refuses it

`checkout_contracts_require_acceptance` computes what is missing from the documents that **exist**. With
no rows in `legal_documents`, the aggregate over an empty set is NULL, the trigger raises nothing, and the
checkout commits. The product's evidence of consent is designed to be the acceptance row — the model's own
comment says so: *"The product's evidence of consent is this row and not the later act of payment."* With
no documents published there is no row, and no gate notices.

Severity is high and the fix is not code: it is publishing the documents before taking the first payment.
Recorded in [`OWNER_DECISIONS.md`](OWNER_DECISIONS.md) as D-1, and as a candidate future task in
*Future code tasks* below.

### R-2 — Nothing in production publishes a legal document

`publishLegalDocument` is exported from the `@omnichannel/db` barrel and exercised by integration tests.
Searched across the repository, every call site outside the store's own file is a test. The deployment
producer that exists, `pnpm billing:publish-routes`, validates and publishes seller profiles and billing
routes, and does not touch legal documents.

So R-1 is not hypothetical: as the system stands there is no supported path by which a `legal_documents`
row comes into existence in a real deployment. This is reported, not fixed — Issue #121 forbids code
changes.

### R-3 — Publication needs a public URL, which needs a domain that is not acquired

`content_ref` must be an absolute `https` URL somebody can open. Both `isReadableDocumentUrl` and the
`legal_documents_content_ref_check` constraint enforce it, because the checkout renders it as the link a
person reads *before* ticking. Markdown in this repository therefore cannot be the published text.

The chain is: domain → public legal pages → `content_ref` → `required_for_checkout` → a checkout that can
record consent. The owner has settled the domain name; it is not acquired or verified. Every later link
waits on the earlier one.

### R-4 — English and Russian can drift, and the schema will not stop them

`legal_documents` is unique on `(kind, locale, version)` and `version` is monotonic per kind *and* locale.
Nothing relates the English version of a document to the Russian one. `readLegalDocumentOffers`
negotiates the reader's locale, falls back to English, and records `inViewerLanguage` on the offer — the
product is built to *survive* the drift, which is a different thing from preventing it.

The reference pack is a measured instance of that drift: Russian terms a month behind English, two
sections missing from the Russian refund policy, and no mention of a DPA in the Russian privacy policy at
all. The failure mode this product records is the one the source exhibits. Mitigated here by authoring
both languages as one aligned pair; sustaining it after the first publication is a process question, not
a schema one.

### R-5 — Stating implementation detail in a public legal document

The safety contract is unusually specific: named mandatory-review categories, a confidence value, reason
codes, and a rule that a draft answering a recording nobody could read is never sent without a person. It
is tempting to put all of it in the Terms, because it is true and it is reassuring.

It is also a hostage. A public document that enumerates reason codes becomes false the first time a code
is renamed. The drafts therefore state the *principles* — that defined high-risk categories always require
a person, that Draft mode never sends without one, that a human always outranks automation — and refer to
product documentation for the operational detail, rather than freezing the detail into a contract.

### R-6 — Describing the customer's own obligations as if they were ours

The customer decides who to message and on what basis; we carry it out. If the Terms are vague about that,
we inherit a duty we cannot perform: we do not know whether their contact list was lawfully collected. The
drafts put it in its own section rather than leaving it implicit.

### R-7 — A refund clause that mandatory consumer law overrides

The source refuses refunds for consumed digital services under Ukrainian law. An EU-established seller
faces EU consumer rules for any customer who is a consumer, and a clause excluding a right that cannot be
excluded is not merely unenforceable — it is a finding against the seller. The draft marks the whole
eligibility and exclusion area as requiring legal sign-off, and states nothing about the withdrawal right
either way. See [`OWNER_DECISIONS.md`](OWNER_DECISIONS.md), D-8.

## Where the accepted machinery and these drafts do not line up

Checked against Issue #47 and the accepted implementation. Nothing here changes any of it.

| Finding | Detail |
| --- | --- |
| Four kinds, eight documents | `LegalDocumentKind` is exactly `TERMS_OF_SERVICE`, `PUBLIC_OFFER`, `PRIVACY_POLICY`, `REFUND_POLICY`. The AUP, AI Disclosure, Cookie Notice and DPA have no kind, so they cannot be acceptance-bearing documents without a schema change. |
| Required-ness is deliberately unanswered | The migration says so in its own words: *"which documents a market requires is a product and legal decision the owner has not made yet — `required_for_checkout` is where that decision gets recorded when it is made."* The checklist asks for it per kind and per market. |
| Seller-specific documents already work | `legal_documents.seller_profile_id` is nullable, and a kind the seller has published at all is read only from that seller's own versions. A second route can have its own offer without touching code — which is exactly what Issue #47 required. |
| Acceptance records the page's language, not the document's | `legal_acceptances.locale` is the reader's interface language on purpose, so a dispute can ask whether the person was shown terms in a language they read. That question only has force if the documents exist in both languages. |
| Retention of billing and legal records is unspecified | `PRIVACY_RETENTION_DELETION.md` excludes them because *"nothing in this product writes any yet"*. Phase 6 now does: subscriptions, usage ledger entries, legal acceptances. Workspace deletion keeps "records a regulator or payment provider requires", and nothing says which or for how long. D-11. |

## Future code and documentation tasks discovered

Listed for the owner's decision, as Issue #121 allows. **None is undertaken here.**

1. A production path that publishes a legal document — a manifest-driven producer in the shape of
   `billing:publish-routes`, or an admin screen. Without one, R-1 and R-2 stand. *(Candidate issue.)*
2. A refusal when a checkout would commit with no legal document published at all, so that the empty case
   answers "nothing is configured" rather than "nothing is required". This is a product decision first:
   a deployment with no documents may be legitimate during development.
3. New `LegalDocumentKind` values, if the owner decides any adjunct must be ticked rather than linked.
   Schema change, migration, i18n strings, and the UI's required/linked split.
4. Update `PRIVACY_RETENTION_DELETION.md` where it says nothing writes billing or legal records. Phase 6
   now does, and the retention rule it defers belongs with them.
5. A publication-time check that a document kind exists in every supported locale at the same version,
   if the owner wants R-4 prevented rather than merely survived.
