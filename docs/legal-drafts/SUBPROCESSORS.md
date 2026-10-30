# Processors and subprocessors — candidate annex

> Part of the Issue #121 drafting task. **Nothing here is published or approved.**
>
> This is a candidate annex for the Data Processing Agreement, not an executed one. No statement here
> asserts that any agreement has been signed, that any account has been created, or that any processing
> region has been configured. Where that is unknown, the cell says so.

## How this list was built

From the application's own environment contract and the endpoints the code calls, not from a vendor list.
Every entry below is either a declared environment variable in `apps/web/src/env.ts` or
`apps/worker/src/env.ts`, or an origin that appears in the source of a package that makes outbound
requests. A vendor nobody has wired in does not appear here, and a vendor the code calls cannot be
left out.

## The list

| Processor | What it processes | Required? | Endpoint | Status |
| --- | --- | --- | --- | --- |
| **Meta** (Instagram, WhatsApp Business) | The whole of the conversation: inbound messages, media and voice notes, outbound replies, delivery and read state, the customer's own channel identity | Yes — it is the channel | `graph.facebook.com`, `graph.instagram.com`, `api.instagram.com`, `lookaside.fbsbx.com` | In use. The customer authorizes it directly; see the note below |
| **Anthropic** | Message text and the drafting context: conversation history, retrieved knowledge, style examples, transcripts | **Yes** — `ANTHROPIC_API_KEY` is the one AI key the worker cannot start without | `api.anthropic.com` | In use. Default model `claude-opus-5` |
| **OpenAI** | Audio of customer voice notes, for transcription | No — optional. Without the key, recordings are stored and shown but not transcribed | `api.openai.com` | In use where configured. Default model `gpt-transcribe` |
| **Voyage AI** | Short text for embedding: knowledge passages, style examples, inbound text | No — optional. Without the key, retrieval falls back to lexical-only | `api.voyageai.com` | In use where configured. Default model `voyage-3.5` |
| **Stripe** | Billing identifiers, amounts, currency, subscription and payment state. No conversation content | For paid plans | `api.stripe.com`, `checkout.stripe.com`, `billing.stripe.com` | Implemented first adapter, no vendor SDK (ADR-020) |
| **Google** | The e-mail address and account identifier of a person signing in with Google. No customer data | No — optional sign-in method | Auth.js Google provider | Implemented. Client credentials not configured |
| **Resend** | Recipient e-mail address of the person signing in, and the sign-in link itself | No — optional sign-in method | SMTP | **Prospective. See below** |
| Hosting, database, Redis | Everything at rest and in transit | Yes | `DATABASE_URL`, `REDIS_URL` | Provider is an unmade decision. D-10 |

Two things about Meta are worth stating rather than leaving to inference. It is not a subprocessor we
chose on the customer's behalf in the ordinary sense: the customer holds the Instagram or WhatsApp
account, authorizes our access to it, and can revoke that authorization, at which point we stop. And the
provider's copy of a voice note is the thing that makes deletion ordered rather than parallel — a media
identifier is the only handle on a recording held at Meta, so a deletion asks the provider first and
records a partial failure if it cannot, because *"a `COMPLETED` deletion that left a voice note on somebody
else's servers would be a lie."*

## Resend

Issue #121 asks that Resend be accounted for explicitly as a prospective transactional e-mail
subprocessor. Stated carefully, because several adjacent things are true and only some of them are facts
about this deployment.

**What the owner has decided.** Resend is the approved transactional e-mail vendor, with the sender address
`no-reply@{{PRODUCT_DOMAIN}}`. The owner's own words record the limit of that decision: it is *"the
approved configuration choice, not a claim DNS/account/email delivery is live."*

**What it would process.** Exactly two things, and only when e-mail sign-in is enabled: the e-mail address
of the person signing in, and the sign-in link addressed to them. No customer conversation content, no
billing data, no workspace content. Transactional only — there is no marketing mail in this product.

**Why no code changes for it.** The application takes an SMTP connection string, `AUTH_EMAIL_SERVER`, and
nothing else. There is no vendor SDK, no API-key field and no provider enum, which was a deliberate choice
recorded in the environment contract: *"A URL rather than a vendor's API key, because the accepted
decision names 'email one-time magic link' and not a particular sender: any SMTP service a deployment
already trusts satisfies it, and the product is coupled to none."* Resend is reached over SMTP like any
other sender. ADR-022 names the method, not the vendor.

**What the sign-in link is.** A credential for one click. The mailer's own note is that nothing in it logs
the URL, and that is the reason: in transit it is in the hands of whoever carries the mail.

**What is not known and must not be asserted.** Whether a data processing agreement is in place for this
account. Which region processes or stores the mail. What retention the vendor applies to message metadata
or logs. Whether the sending domain is verified — the owner states it is not. Resend publishes a standard
DPA and documents US data storage at `https://resend.com/security`, and that is a statement about their
published terms, not about this deployment's contract. Each is a diligence item: D-5.

**One operational fact with a legal shadow.** The sign-in link is on the critical path of getting into the
product, and every retry sends another message. A plan with a daily send cap can therefore deny access to
a paying customer on a bad day, which is a service-availability question before it is a billing one. Out
of scope for the drafts; worth the owner knowing. D-6.

## What has to be true before this becomes an annex

For each entry: the executed agreement, the transfer instrument, the processing location, the retention
the processor applies, and the notice given when the list changes.

**On transfers specifically.** The first launch route is an EU-established seller. Anthropic, OpenAI,
Voyage AI, Stripe and Resend are US companies; Meta and Google serve EU customers through EU entities.
Each transfer out of the EEA needs an Article 46 instrument, and this document does **not** state which
instrument applies to which processor, because that is a per-contract fact nobody has checked. A privacy
notice that names a mechanism it has not verified is worse than one that says the assessment is pending.

**On a provider list in a public document.** Naming providers is a choice, not an obligation: the GDPR's
Articles 13 and 14 require categories of recipient, while Article 28 requires the *customer* be able to
know and object to subprocessors. The drafts therefore name the categories in the Privacy Policy and keep
the named list here, as the DPA annex, where changing it is a notice obligation rather than a silent edit
to a public page. If the owner would rather publish the list, that is D-9.

## A provider is replaceable by design

ADR-010 keeps the AI contract provider-neutral: the application owns ports and the providers implement
them, so a model or a vendor can be swapped without the domain knowing. The architecture boundary checker
enforces it — a provider SDK in `domain` or `application` fails the build.

This matters to the drafts twice over. A public document must not promise a particular vendor, because
replacing one is a normal operation. And a document that lists subprocessors has to be versioned and
noticed, because the list is expected to change.
