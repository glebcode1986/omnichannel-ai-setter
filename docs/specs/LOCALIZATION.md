# Localization — Phase 5

**Status:** Foundation implemented by P5-10 (Issue #58). Every later Phase 5 surface uses it.

**Related:** `PRODUCT_UX.md`, `ONBOARDING_UX.md`, ADR-009 (authorization), `AI_ORCHESTRATION.md`.

## The distinction the whole document exists to protect

There are **two** languages in this product and they are not the same thing:

1. **The dashboard locale** — what language the operator reads the software in. A per-user preference.
2. **The customer's conversation language** — what language the assistant replies to a customer in. A
   property of the business and the conversation, resolved from `StyleProfile.language` and the
   conversation's own history.

They must never be coupled. An agency operator who reads the interface in Russian may be answering a
customer in German for a business whose configured language is English, and all three are correct at once.
A product that inferred one from the other would produce replies in the operator's language — a customer-
visible defect with no obvious cause.

This is structural, not a convention: the dashboard locale lives on `users.ui_locale`, and the reply
language lives on the Business Profile's style profile. Nothing reads one to decide the other.

## Locales

MVP ships **English and Russian** as first-class production locales. English is the fallback, not the
default preference: a person who has chosen Russian and hits an untranslated string sees English, which is
a degraded experience rather than a broken one.

A locale is a BCP-47 tag, canonicalized through `canonicalLanguageTag` (`packages/domain/src/language.ts`)
so `RU`, `ru` and `ru-RU` cannot become three different preferences.

## Keys

- Keys are **stable and structural**, named for what the string is rather than what it currently says:
  `setup.activate`, not `setup.activateButtonBlue` and not the English text itself.
- A key is added to every locale catalogue at once. The catalogues are typed against one key union, so an
  incomplete locale is a type error rather than a runtime surprise.
- No user-facing string is written inline in production UI. This is enforced mechanically — see
  **Enforcement** below.

## Missing keys

The behaviour differs by environment on purpose:

- **Production**: fall back to English, render it, and log the missing key once. A person mid-task must not
  be shown a raw key or an empty space.
- **Development and test**: throw. A missing key is a bug, and the moment to find it is while the screen is
  being written rather than after it ships.

## Formatting

Dates, times, numbers, currency and plurals go through `Intl`, never through hand-written formatting:

- `Intl.DateTimeFormat`, `Intl.NumberFormat`, `Intl.PluralRules`.
- Plural forms use the locale's own categories. Russian has `one`, `few`, `many` and `other`; a catalogue
  entry that only supplied `one` and `other` would be wrong for "22 сообщения" in a way English never
  reveals.
- Times are rendered in the timezone the surface is about — a business's quiet hours belong to the
  business's timezone, not the reader's — and the timezone is shown whenever ambiguity would matter.

## Layout

- Layouts tolerate longer strings. Russian runs materially longer than English; anything sized to fit an
  English label will clip.
- Structure is RTL-ready — logical properties, no hard-coded left/right where start/end is meant — but the
  MVP **does not claim RTL support**. Being structurally ready is not the same as being tested, and saying
  otherwise would be a promise nobody has verified.

## Accessibility

Accessible names are localized too. An `aria-label` left in English is exactly as broken as a visible
label left in English, and less likely to be noticed.

## Enforcement

The acceptance criterion for Issue #58 is that new Phase 5 work *fails review* when it introduces
unlocalized production strings. A rule that only lives in a document is a rule that gets forgotten on a
busy day, so it is also a test:
`apps/web/src/i18n/no-unlocalized-strings.test.ts` scans the production UI for user-facing literals and
fails on ones that did not come from a catalogue.

The check is deliberately narrow — it looks at JSX text, at the attributes that become accessible names,
and at the attributes a stylesheet draws on screen with `content: attr(...)` — because a guard that cried
wolf would be switched off. What it does not catch is still a review responsibility.

The third group exists because a lead becomes a card below 900px and each cell draws its column name from
`data-label`. That attribute is not an accessible name, and it is still text a person reads.

## A name a person chose is not ours to translate

One field can carry either the product's words or an operator's, and the two must be treated differently.
`StageDisplay.label` is the case this product has: until a Workspace renames a board column the label is
the product's own placeholder from `DEFAULT_STAGE_LABELS` — an English word, `"New"`, `"Engaged"` — and the
row is marked `isDefault: true`; once they rename it, the label is exactly what they typed and `isDefault`
is `false`.

So the rule is **translate the one the product supplied, and leave the one a person typed alone, byte for
byte**. Translating both overwrites an operator's wording whenever it happens to match a key's value and
blanks it when it does not. Translating neither puts English in a Russian console.

It lives in one place, `apps/web/src/ui/leads/stage-name.ts`, and `stage-name.test.ts` holds that no leads
surface reads a stage's `label` for itself. That guard is the point: the rule had four implementations and
the fourth — the leads page's own stage filter — did not have it, so one page rendered a dropdown reading
"New" beside a column heading reading "Новый", from the same array. A rule with four implementations has
four chances to be the one that is wrong.

## What is not localized

- **Logs, audit records and reason codes.** They are read by operators and by software across
  deployments, and a log line whose wording depends on who was signed in is a log line that cannot be
  searched.
- **Provider-facing payloads.** Message content follows the conversation's language policy, not the
  dashboard locale.
- **Identifiers.** Enum values, channel names, key names.
