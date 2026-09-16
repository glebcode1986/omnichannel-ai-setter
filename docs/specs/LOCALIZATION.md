# Localization & Multilingual Product Specification — v0.1

## Product decision

The product is multilingual from the start.

Initial first-class UI locales:
- **English (`en`)**;
- **Russian (`ru`)**.

Both must be treated as production-grade primary languages, not as one source language plus an incomplete secondary translation.

Additional locales may be added later without changing business/domain logic.

## UI localization architecture

- Do not hard-code user-facing strings inside React components, server-rendered pages, emails, validation messages or onboarding flows when they are customer-visible.
- Use a mature Next.js-compatible i18n library selected at implementation time.
- Translation resources must use stable semantic keys rather than duplicated literal text.
- English is the technical fallback locale when a requested translation key is missing.
- Russian must have parity coverage for all launch-critical flows: signup, onboarding, Inbox, Review, Leads, Knowledge, Style, Analytics, Settings, billing, errors and transactional emails that are in launch scope.
- Locale is a per-user preference; workspace default locale may seed new members but must not force all staff to use one interface language.
- Date/time, numbers, pluralization and currency formatting must use locale-aware formatters rather than manual string assembly.
- Business logic, entitlement checks, channel policy and persistence identifiers must never branch on translated display strings.

## Customer conversation language

The language used to communicate with end customers is independent from the dashboard UI locale.

Default behavior:
- detect/follow the inbound customer language at conversation/message level;
- reply in the same language unless the workspace explicitly configures a different rule;
- preserve the owner's configured tone/style while changing language;
- do not translate factual business content into unsupported claims: Knowledge remains the factual authority in every language;
- mixed-language conversations may continue in the language most recently used by the customer unless workspace policy says otherwise.

The AI conversation layer is not limited to `en` and `ru`. The product UI launches with English/Russian first, while the model may handle additional customer languages when the configured model/provider supports them.

## Onboarding

During first-run setup:
- ask for/select the dashboard interface language (`English` or `Русский` initially);
- separately collect business/customer communication language preferences;
- explain that the bot may answer customers in their language even when the owner's dashboard is displayed in another language.

## Future locales

Adding another UI language should primarily require:
1. a new locale resource bundle;
2. translation/QA;
3. locale registration and formatting tests;
4. legal/billing copy review where applicable.

It must not require forks of application/domain logic.

Keep layout and components reasonably ready for languages with longer strings. RTL support is not a launch requirement, but implementation must avoid assumptions that make later RTL support unnecessarily expensive.

## Verification

Tests should cover:
- English and Russian launch-critical routes render without missing-key placeholders;
- locale switching persists per user;
- interpolation/pluralization behave correctly;
- no authorization/entitlement/policy decision depends on translated text;
- customer reply language follows inbound language independently of UI locale;
- missing optional locale strings fall back safely to English rather than crashing a production flow.
