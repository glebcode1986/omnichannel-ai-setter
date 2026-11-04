# Published legal pages — what they read, and what is still missing

The Privacy Policy and the Terms of Service are served at `/privacy` and `/terms`, in English and
Russian, linked from the landing page's footer. This file says where their text comes from and which
values the deployment has to supply before the pages stop showing gaps.

## Where the text lives

| Thing | Where |
| --- | --- |
| Drafting record | `docs/legal-drafts/{en,ru}/{privacy-policy,terms-of-service}.md` |
| Published text | `apps/web/src/legal/{en,ru}/{privacy-policy,terms-of-service}.md` |
| Derivation | `apps/web/src/legal/derive.ts` — removes the `— DRAFT` suffix, the draft banner and the metadata line, and changes nothing else |
| Parser | `apps/web/src/server/legal-markdown.ts` — a deliberate subset that **throws** on anything it does not carry |
| Placeholder sources | `apps/web/src/server/legal-content.ts` |

`apps/web/src/legal/legal-documents.test.ts` asserts the published file still equals `derive(draft)`, so
editing one without the other fails the build rather than leaving two copies that disagree.

## The values the deployment supplies

None of these has a default. **An unset value renders on the page as a dashed "to be confirmed" marker**
rather than as text, because a plausible default in a published legal document is a term a reader is
entitled to rely on.

### The owner can answer these

| Variable | Fills | Note |
| --- | --- | --- |
| `LEGAL_SELLER_NAME` | the seller's registered legal name | stated in `OWNER_DECISIONS.md`, kept out of source on the owner's own direction |
| `LEGAL_SELLER_DISPLAY_NAME` | the trading name shown to customers | |
| `LEGAL_SELLER_REGISTRATION` | registry identifiers as they should appear publicly | |
| `LEGAL_SELLER_ADDRESS` | registered office, as public legal copy should show it | D-3, unresolved |
| `LEGAL_SELLER_JURISDICTION` | country of establishment | |
| `LEGAL_SELLER_VAT` | VAT identifier, if one is shown | D-4 |
| `LEGAL_SUPPORT_EMAIL` | support mailbox | D-3 |
| `LEGAL_PRIVACY_EMAIL` | mailbox for data-subject requests | D-3 |
| `LEGAL_CONTACT_EMAIL` | mailbox for notices and disputes | D-3 |
| `LEGAL_MINIMUM_AGE` | minimum age for an account | D-16 |
| `LEGAL_RETENTION_ACCOUNT` | retention for account and workspace data after closure | D-11 |
| `LEGAL_RETENTION_BILLING` | retention for invoices and billing records | D-11, likely fixed by Romanian accounting law |
| `LEGAL_RETENTION_RECORDS` | retention for acceptance evidence | D-11 |
| `LEGAL_RETENTION_CONVERSATION` | default retention for conversation content, if any | D-11 |
| `LEGAL_HOSTING_REGION` | where the database and application run | D-10 |
| `LEGAL_DPO` | whether a data protection officer or representative is appointed, and who | D-17 |
| `LEGAL_EFFECTIVE_DATE` | ISO `YYYY-MM-DD`, the date this revision takes effect | set at publication |
| `LEGAL_VERSION` | the integer in `legal_documents.version` | set at publication |

### These need a lawyer

`OWNER_DECISIONS.md` marks each of these "legal advice required", and nothing in this repository is in a
position to answer them.

| Variable | Fills |
| --- | --- |
| `LEGAL_GOVERNING_LAW` | governing law |
| `LEGAL_FORUM` | courts or arbitration, and the seat |
| `LEGAL_SUPERVISORY_AUTHORITY` | the authority a data subject may complain to |
| `LEGAL_LIABILITY_CAP` | the liability cap and its basis |
| `LEGAL_WITHDRAWAL` | whether and how a consumer withdrawal right is addressed |

`PRODUCT_NAME` is a constant in `legal-content.ts`, since the brand is decided and carries nothing
private. There is no domain placeholder: the only one the drafts had appeared inside the Terms' preamble
table, which `derive.ts` removes — it was a note to the owner listing the values settled so far, and the
first published build put it on the live page carrying the retired brand and the seller's registry
identifiers. A test now refuses any published file that contains either.

## What the pages say about themselves

Each page carries a notice above the document: that this is the current revision, that values still being
settled are marked where they appear rather than filled in, and that the text has not been reviewed by a
lawyer. That notice is accurate today and should be revisited when it stops being.
