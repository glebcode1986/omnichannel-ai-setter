# Adjunct documents — assessment

> Part of the Issue #121 drafting task. **Nothing here is published or approved.**

Issue #121 asks that the cookie notice, Acceptable Use Policy, AI Disclaimer, AI Providers & Production
Modes Notice, DPA and jurisdiction-specific privacy notices be *assessed separately* rather than inherited
from the reference pack. The reference pack refers to five of them 35 times and contains none of them.

Each is assessed on three questions: does this product need it, can the accepted machinery hold it, and is
it drafted here.

## Summary

| Document | Needed? | Can be ticked at checkout? | Drafted here |
| --- | --- | --- | --- |
| Cookie Notice | Yes, as a short notice | No kind — link only | [en](en/cookie-notice.md) / [ru](ru/cookie-notice.md) |
| Acceptable Use Policy | **Yes, and it is load-bearing** | No kind — link only | [en](en/acceptable-use.md) / [ru](ru/acceptable-use.md) |
| AI Disclosure | **Yes** | No kind — link only | [en](en/ai-disclosure.md) / [ru](ru/ai-disclosure.md) |
| AI Providers & Production Modes Notice | Yes, merged into AI Disclosure | — | merged, see below |
| Data Processing Agreement | **Yes, and it is the most consequential** | No kind — see below | scaffold: [en](en/dpa.md) / [ru](ru/dpa.md) |
| Separate GDPR notice | **No** — would duplicate the Privacy Policy | — | not drafted, by decision |
| Other-jurisdiction notices | Unresolved — depends on target markets | — | not drafted, D-13 |

"No kind" means `LegalDocumentKind` has exactly four values — `TERMS_OF_SERVICE`, `PUBLIC_OFFER`,
`PRIVACY_POLICY`, `REFUND_POLICY` — so none of these adjuncts can be an acceptance-bearing document
without a schema change. They can be published pages that the Terms and Offer refer to, which is the
normal arrangement anyway: a document is linked, not ticked, when consent to it is given through the
agreement that incorporates it.

## Cookie Notice

**Needed: yes, as a short notice. A consent banner is probably not required today — and that is exactly
what makes it fragile.**

What the application actually sets, read from the code rather than assumed:

| Cookie | Set by | Why |
| --- | --- | --- |
| Auth.js session, CSRF, callback-URL and OAuth state/PKCE cookies, under Auth.js default names | `next-auth` | Signing in, and not being signed in as somebody else. Sessions are database-backed (ADR-009), so the cookie is an opaque reference and carries no profile data. |
| `signin_locale` | the public sign-in page's own language control | Remembers which language a not-yet-signed-in visitor chose, so the page and the sign-in link they receive are in the same language. Replaced by the stored user preference the moment they sign in. |

Searched for the usual third-party tags — Google Analytics, `gtag`, Plausible, PostHog, Mixpanel,
Segment, Hotjar, a Meta pixel. **None is present in the web application.** There is no advertising or
analytics cookie to consent to.

So, as the product stands: every cookie is either strictly necessary for a service the user asked for, or
a preference that user set themselves by operating a control. Under the ePrivacy consent rule that is the
exempt category, and a blocking banner would be asking permission for something that does not need it.

Two cautions, both deliberate:

1. **This is not a legal conclusion.** Whether `signin_locale` is "strictly necessary" or merely
   "functional" is the kind of question a supervisory authority answers differently in different member
   states. The draft notice describes each cookie and its purpose accurately and does not assert an
   exemption.
2. **It expires the moment anything is added.** The first analytics script, embedded video, support widget
   or marketing tag changes the answer, and the notice becomes wrong without anybody editing it. This is
   recorded as D-12 so it is a decision somebody owns rather than a fact that silently rots.

## Acceptable Use Policy

**Needed: yes, and more than the reference product needs one.**

The reference product generates content for the person who asked for it. This product sends messages to
*other people* — the customer's customers, on Instagram and WhatsApp, under Meta's platform terms, over
accounts the customer authorized. Three things follow that an AUP is the natural place for:

- Meta's own policies constrain what may be sent and when, and breaching them costs the customer their
  channel rather than costing us an argument. The customer has to be told that their authorization carries
  those terms.
- The product is deliberately not built for cold outreach. Nothing in it initiates contact with somebody
  who has not written first, and that is an architectural property worth stating as a rule, so a customer
  does not try to use it that way and treat the attempt as a missing feature.
- An opt-out is implemented as a tombstone that survives deletion: *"You cannot both forget somebody and
  remember never to message them."* The customer needs to know that honouring an opt-out is their
  obligation too, not only a feature we provide.

The source refers to an Acceptable Use Policy ten times and does not contain one, so there is nothing to
inherit. Drafted from this product's own constraints.

## AI Disclosure — merged from two source documents

**Needed: yes. Drafted as one document rather than two.**

The source refers to an "AI Disclaimer" (5 times) and an "AI Providers & Production Modes Notice" (4
times) as separate instruments. Both are merged here into a single AI Disclosure, for a reason worth
recording: a reader who wants to know whether a machine wrote the message and who else saw it is asking
one question, and two documents split the answer so that neither is complete. The merged document covers
what the product does automatically, what it never does without a person, which providers process
conversation content, and what the customer remains responsible for.

If the owner prefers the two-document shape — for example because a provider list changes more often than
a disclaimer and should be versioned separately — splitting it is a straightforward edit and is recorded
as D-15.

## Data Processing Agreement

**Needed: yes, and it is the most consequential document in this set. Scaffolded, not drafted.**

For account and billing data we are the controller. For the content of conversations — what a customer's
customers wrote, the recordings they sent, the transcripts, the facts inferred about them — the customer
decides the purpose and we act on their instruction. That makes us their processor, and a processor needs
an Article 28 agreement: subject matter and duration, the nature and purpose, the categories of data
subject, the controller's instructions, confidentiality, security, subprocessor authorization and notice,
assistance with data-subject requests, breach notification, audit, and what happens at the end.

It is scaffolded rather than drafted because its substance is three decisions nobody has made:

- **Which processor each of us is for what.** The boundary above is the honest reading of the
  implementation, but it is a legal characterisation and the customer's lawyer may read it differently.
- **The subprocessor annex.** [`SUBPROCESSORS.md`](SUBPROCESSORS.md) lists what the code calls. Turning it
  into an annex requires, for each entry, the signed terms, the transfer mechanism and the processing
  location — diligence that has not been done.
- **How notice of a new subprocessor is given, and whether the customer may object.** This is a commercial
  choice with an operational cost, and it binds future provider changes.

Writing confident prose over those three gaps would produce a document that looks finished and commits the
seller to things nobody has agreed. The scaffold states each clause that is needed and what it is waiting
for.

## A separate GDPR notice

**Not needed. Recommending against it.**

A separate "GDPR Notice" alongside a Privacy Policy is a pattern that belongs to companies outside the EU
bolting European obligations onto a US-drafted policy. This product's first launch route is an
EU-established seller, which means the GDPR's Article 13 and 14 content *is* the privacy notice, not an
appendix to it. Two documents would duplicate, and duplication is how two documents come to disagree —
after which the question in a dispute is which one the reader was shown.

The draft Privacy Policy therefore carries the Article 13/14 content inline: identity of the controller,
purposes and legal bases, recipients, transfers, retention, rights including the right to complain to a
supervisory authority, and whether providing data is obligatory.

## Other jurisdictions

**Unresolved, and left unresolved deliberately. D-13.**

Which additional regimes apply is a function of where customers are, which nobody has decided. The
interface ships in English and Russian, which says something about intended markets but is not a legal
determination of any of them. The honest position is that the drafts are written for an EU-established
seller under the GDPR, and that each additional market has to be assessed when it is chosen rather than
pre-emptively papered over with a clause naming regimes nobody has checked.
