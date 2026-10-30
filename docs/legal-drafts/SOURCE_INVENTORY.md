# Source inventory — the FastyAds legal pack

> Part of the Issue #121 drafting task. **Nothing here is published or approved.**

Read on 30 October 2026 from `glebcode1986/fastyads`, branch `prod`, the branch Issue #121 names as
preferred. Every count below was measured from the fetched files, not estimated.

## What exists

| Source file | Size | What it holds |
| --- | --- | --- |
| [`src/legal/en.ts`](https://github.com/glebcode1986/fastyads/blob/prod/src/legal/en.ts) | 95,579 bytes / 751 lines | English pack: Privacy Policy, Terms of Service, Refund Policy, Public Offer Agreement |
| [`src/legal/ru.ts`](https://github.com/glebcode1986/fastyads/blob/prod/src/legal/ru.ts) | 117,032 bytes / 646 lines | Russian pack, same four keys |
| [`src/legal/index.ts`](https://github.com/glebcode1986/fastyads/blob/prod/src/legal/index.ts) | 1,135 bytes | Locale registry: `en`, `ru`, `uk`, `tr`, `es`, `de`, `fr`, `it`, `pt`, `zh`, falling back to `en` |
| [`src/App.tsx`](https://github.com/glebcode1986/fastyads/blob/prod/src/App.tsx) | 12,635 bytes | Routes `/privacy`, `/terms`, `/refund`, `/offer`, plus an admin-managed `/legal/:slug` |

Document versions as the pack states them:

| Document | EN `lastUpdated` | RU `lastUpdated` |
| --- | --- | --- |
| Privacy Policy | 14 May 2026 | 12 May 2026 |
| Terms of Service | 14 May 2026 | **15 April 2026** |
| Refund Policy | 14 May 2026 | **15 April 2026** |
| Public Offer Agreement | 14 May 2026 | **15 April 2026** |

## Four defects measured in the source

These are recorded because the task is to reuse this pack, and reusing a defect is the likeliest way to
inherit one. None of them is a criticism of the source product's operation; they are facts about what the
files can and cannot be relied on for.

### 1. The English pack can no longer be regenerated from its stated source

`en.ts` opens with its own instruction:

> Auto-generated from `docs/policies/*.docx` via `scripts/gen-legal-en.py`
> English source text. Do not edit bodies by hand - update the .docx files and regenerate.

On `prod`, `scripts/gen-legal-en.py` exists. `docs/policies/` returns 404 — the whole `docs/` tree on that
branch contains a single entry, `fastyads-brain`. So the instruction in the header cannot be carried out
on this branch: the `.docx` originals are not there to update, and the rendered `en.ts` is the only
surviving authority for the English wording.

**Consequence for this task.** The rendered pack is the source of record, exactly as Issue #121 allows.
No `.docx` was invented or assumed, and no claim is made about what the originals said.

### 2. The Russian pack is a different, older generation — and says it is not

`ru.ts` opens with:

> Russian translation of `docs/policies/*.docx`. Structure mirrors `src/legal/en.ts`.

It does not mirror it. Measured section and paragraph counts:

| Document | EN sections | RU sections | EN paragraphs | RU paragraphs |
| --- | ---: | ---: | ---: | ---: |
| Privacy Policy | 19 | 19 | 97 | 94 |
| Terms of Service | 18 | 18 | 93 | **61** |
| Refund Policy | **14** | **12** | 65 | **39** |
| Public Offer | 20 | 20 | 86 | **68** |

Section titles align one-for-one in three documents. In the Refund Policy they diverge from section 5
onward: English §5 is *"Third-Party Providers and AI Processing"*, Russian §5 is *"Порядок подачи заявки
на возврат"* — which is English §6. The Russian text drops two whole sections, *"Third-Party Providers and
AI Processing"* and *"Account Suspension, Closure, and Deletion"*, and renumbers everything after them.

The paragraph counts say the abridgement is not confined to that document: the Russian Terms carry 34%
fewer paragraphs than the English, and the Russian Refund Policy 40% fewer.

One difference is worth naming on its own. The English Privacy Policy refers the reader to a Data
Processing Agreement four times, including as the instrument governing the reader's own processing where
they upload third parties' data. The Russian Privacy Policy mentions a Data Processing Agreement **zero**
times.

**Consequence for this task.** The Russian pack cannot be used as the Russian rendering of the English
pack, and neither can be translated into the other to produce an aligned pair. Both drafts here are
written from the same outline in the same pass, and `verify-alignment` in the pull request description
records how that was checked.

### 3. Thirty-five cross-references to documents the pack does not contain

The English pack refers the reader to documents outside the four it holds:

| Referred-to document | Mentions in the EN pack | In the pack? |
| --- | ---: | --- |
| Cookie Policy | 10 | no |
| Acceptable Use Policy | 10 | no |
| Data Processing Agreement | 6 (+1 as "DPA") | no |
| AI Disclaimer | 5 | no |
| AI Providers & Production Modes Notice | 4 | no |

The published routes are `/privacy`, `/terms`, `/refund` and `/offer`. There is also a generic
`/legal/:slug` route backed by admin-managed content, so these five documents **may** be published there.
Whether they are cannot be determined from the repository, and this inventory does not assume either way
— which is what Issue #121 asks for: *"Do not assume every document referenced by those texts exists as
separately published content."*

**Consequence for this task.** A cross-reference is a promise that something exists and can be read. The
drafts here refer only to documents that this directory contains, and
[`ADJUNCT_ASSESSMENT.md`](ADJUNCT_ASSESSMENT.md) decides each adjunct on its own merits instead of
inheriting the reference.

### 4. The commercial and legal frame is a different product in a different country

Measured in the English pack: 93 references to credits or Credits, against 9 to subscriptions and 1 to a
trial. Governing law and forum are Ukraine throughout. The data controller is a Ukrainian sole trader,
named in the text along with a street address and two mailboxes.

The word "voice" appears 11 times and never means what it means here: it is about voice cloning, likeness
and non-consensual deepfakes in generated media. There is nothing in the source about transcribing a
recording a customer sent, which is this product's one customer-metered resource.

**Consequence for this task.** This is why the source cannot be copied with substitutions, and
[`CROSSWALK.md`](CROSSWALK.md) works through it document by document.

## Identity in the source that must not be reused

Issue #121 is explicit, and so is the owner's direction in Issue #47. The source pack names a specific
individual as controller and seller, together with a street address and two mailboxes on the reference
product's own domain. **None of it is reproduced anywhere in this directory** — not in the drafts, not in
this inventory, and not as a placeholder default — in any language,
in any example, or in any placeholder default. This product's seller is a different entity in a different
jurisdiction, and the contact mailboxes do not exist yet.
