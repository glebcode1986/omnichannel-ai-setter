# Cookie Notice — DRAFT

> **DRAFT. NOT PUBLISHED, NOT APPROVED, NOT IN FORCE.**
> Prepared under Issue #121 on 30 October 2026 as material for owner and legal review. This is not legal
> advice, it has not been reviewed by a lawyer, and it binds nobody. `{{PLACEHOLDER}}` marks a value that
> has not been decided — see [`../OWNER_DECISIONS.md`](../OWNER_DECISIONS.md).
>
> **This notice is short because there is very little to describe, and it will stop being accurate the
> moment anything is added.** See [`../ADJUNCT_ASSESSMENT.md`](../ADJUNCT_ASSESSMENT.md) and D-12.

**Locale** `en` · **Version** `{{DOCUMENT_VERSION}}` · **Effective from** `{{EFFECTIVE_DATE}}`

---

## 1. The short version

{{PRODUCT_NAME}} sets what it needs to sign you in and keep you signed in safely, plus one cookie that
remembers which language you chose on the sign-in page.

**There is no advertising cookie and no analytics cookie in the Service.** Nothing here follows you to
another website, and no third party is given a way to build a profile of you through us.

## 2. What is set, and why

| What | Purpose | Kind |
| --- | --- | --- |
| Session cookie | Keeps you signed in. It holds **no** information about you — it is an opaque reference, and the session itself is stored in our own database | Strictly necessary |
| Security token cookie | Stops a third-party site submitting a form as if it were you | Strictly necessary |
| Sign-in flow cookies | Carry the single step of signing in — where to return you afterwards, and the values that prove the sign-in that completes is the one you started. Short-lived | Strictly necessary |
| `signin_locale` | Remembers the language you chose on the public sign-in page, so the page and the sign-in link we send you are in the same language | Set by your own choice |

2.1. The session, security and sign-in cookies are set by the authentication component the Service uses and
carry its standard names.

2.2. `signin_locale` is set only when you operate the language control on the sign-in page. It is replaced
by your stored preference as soon as you sign in. Its only possible effect is which of two language
catalogues a page is drawn from.

## 3. Consent

3.1. Everything in clause 2 is either strictly necessary for a service you asked for, or a preference you
set yourself by operating a control. The Service therefore does not present a consent banner, because
there is nothing to ask permission for.

3.2. **This notice does not assert a legal exemption.** It describes each cookie and its purpose so that
the position can be assessed. Whether `signin_locale` is "strictly necessary" or merely "functional" is a
question answered differently in different places, and it is one of the items flagged for legal review.

3.3. If a cookie of any other kind is ever added — analytics, an embedded video, a support widget, a
marketing tag — this notice changes and a consent mechanism is designed with it. That is recorded as a
decision so it cannot happen quietly.

## 4. Managing cookies

4.1. Your browser can block or delete cookies. Blocking the strictly necessary ones **will prevent you
signing in**, because they are how signing in works.

4.2. Deleting `signin_locale` only means the sign-in page forgets your language choice.

## 5. Other storage

5.1. The Service does not use browser local storage or similar technologies to track you across sites.

5.2. Your messaging platform may set its own cookies when you are redirected to it to authorize a
connection. Those are the platform's and are governed by its own notice.

## 6. Changes

6.1. A change is published as a new version with its own effective date. A version already in force is not
edited.

## 7. Contact

{{SELLER_LEGAL_NAME}} · Privacy: {{PRIVACY_EMAIL}}
