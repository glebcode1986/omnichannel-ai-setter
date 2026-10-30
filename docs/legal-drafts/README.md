# Legal drafts — NOT PUBLISHED, NOT APPROVED

> **Status: DRAFT. Not legal advice. Not approved by a lawyer. Not published anywhere.**
> Nothing in this directory is in force, offered to anybody, or referenced by running code. No file here
> is wired to `legal_documents.content_ref`, and nothing here may be published without explicit owner and
> legal-professional approval. Issue #121 authorizes the drafting and forbids the publication.

Prepared 30 October 2026 under Issue #121, from the owner's own FastyAds legal pack as a reference
baseline. The owner's standing direction on that baseline (Issue #47, comment 6085523397) is that it is a
**structural reference only**, that its text is known to be weak or incomplete, and that it must not be
published as authoritative wording. This directory follows that: the structure is reused, the wording is
written for this product, and the parts that cannot be settled without a decision are marked as such
rather than filled in with something plausible.

## What is here

| File | What it is |
| --- | --- |
| [`SOURCE_INVENTORY.md`](SOURCE_INVENTORY.md) | What the FastyAds pack contains, where it lives, and the four provenance defects measured in it |
| [`CROSSWALK.md`](CROSSWALK.md) | Section-by-section mapping of the source onto this product, with the risk register |
| [`ADJUNCT_ASSESSMENT.md`](ADJUNCT_ASSESSMENT.md) | Whether this product needs a cookie notice, AUP, AI disclaimer, AI-providers notice, DPA and GDPR notices — and which of them the accepted machinery can hold |
| [`SUBPROCESSORS.md`](SUBPROCESSORS.md) | The external processors the code actually calls, from the environment contract, including Resend |
| [`OWNER_DECISIONS.md`](OWNER_DECISIONS.md) | Every placeholder in the drafts, and the decision that resolves it |
| `en/`, `ru/` | The drafts themselves |

## The drafts

| Document | `LegalDocumentKind` | EN | RU | Completeness |
| --- | --- | --- | --- | --- |
| Terms of Service | `TERMS_OF_SERVICE` | [en](en/terms-of-service.md) | [ru](ru/terms-of-service.md) | full draft |
| Public Offer / Service Agreement | `PUBLIC_OFFER` | [en](en/public-offer.md) | [ru](ru/public-offer.md) | full draft |
| Privacy Policy | `PRIVACY_POLICY` | [en](en/privacy-policy.md) | [ru](ru/privacy-policy.md) | full draft |
| Refund and Cancellation Policy | `REFUND_POLICY` | [en](en/refund-and-cancellation.md) | [ru](ru/refund-and-cancellation.md) | full draft |
| Acceptable Use Policy | *(no kind — see assessment)* | [en](en/acceptable-use.md) | [ru](ru/acceptable-use.md) | full draft |
| AI Disclosure | *(no kind)* | [en](en/ai-disclosure.md) | [ru](ru/ai-disclosure.md) | full draft |
| Cookie Notice | *(no kind)* | [en](en/cookie-notice.md) | [ru](ru/cookie-notice.md) | full draft |
| Data Processing Agreement | *(no kind)* | [en](en/dpa.md) | [ru](ru/dpa.md) | **scaffold only** |

The DPA is a scaffold rather than a draft because its substance is the controller/processor split and the
subprocessor annex, and both are owner decisions that are not yet made. A scaffold that names the open
questions is more use than prose that answers them by guessing.

## How placeholders work

Every value that is not settled appears as `{{PLACEHOLDER_NAME}}`, never as a plausible-looking default.
A reader can find every one of them with a single search, and [`OWNER_DECISIONS.md`](OWNER_DECISIONS.md)
lists each with the decision that resolves it.

Seller identity is deliberately a placeholder even though the owner has named the entity. That is not
hedging — it is what this product's data model requires. `seller_profiles` holds `legal_name`,
`display_name`, `jurisdiction` and `support_email` as columns precisely so that one document body can
serve more than one selling entity, which is what the owner asked for in Issue #47: *"Keep seller-specific
fields configurable so Route A (UA FOP) and Route B (Romanian company) can use the correct applicable
seller/legal wording without changing billing domain code."* A draft with the Romanian company's name
baked into its prose would have to be rewritten rather than reconfigured if a second route is ever added.

Each draft opens with a table resolving its placeholders for the first launch route, so the text reads as
continuous prose for a human reviewer while the body stays route-neutral.

## Why the English and Russian drafts are one version and not two

The four published document kinds are keyed `(kind, locale, version)` in `legal_documents`, and `version`
is monotonic *per kind and locale*. Nothing in the schema relates the English version 3 of a document to
the Russian version 3 of it. The two can therefore drift, and the product is built to survive that drift
rather than to prevent it: `readLegalDocumentOffers` negotiates a locale, falls back to English, and
records on each acceptance whether the person was shown the document in their own language.

The reference pack is what that drift looks like once it has happened — measured in
[`SOURCE_INVENTORY.md`](SOURCE_INVENTORY.md). So the drafts here are written as a single aligned pair:
the same sections in the same order with the same numbering in both languages, so that alignment can be
checked rather than trusted, and so the first publication starts from a state the schema will not keep
for you.

## What this directory is not

- Not a legal opinion, and not a statement that the product complies with anything.
- Not a change to the accepted legal-acceptance or billing machinery. Nothing here alters
  `legal_documents`, `legal_acceptances`, `checkout_contracts` or any code path.
- Not a publication pipeline. `legal_documents.content_ref` must be an absolute `https` URL somebody can
  open, enforced by `isReadableDocumentUrl` and by the `legal_documents_content_ref_check` constraint, so
  Markdown in a repository cannot be the published text. Publishing is a later, separate decision.
