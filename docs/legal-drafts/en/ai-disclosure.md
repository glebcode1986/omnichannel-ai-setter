# AI Disclosure — DRAFT

> **DRAFT. NOT PUBLISHED, NOT APPROVED, NOT IN FORCE.**
> Prepared under Issue #121 on 30 October 2026 as material for owner and legal review. This is not legal
> advice, it has not been reviewed by a lawyer, and it binds nobody. `{{PLACEHOLDER}}` marks a value that
> has not been decided — see [`../OWNER_DECISIONS.md`](../OWNER_DECISIONS.md).
>
> **Merged document.** The reference pack kept an "AI Disclaimer" and an "AI Providers & Production Modes
> Notice" apart. They are one document here, because a reader who wants to know whether a machine wrote
> the message and who else saw it is asking one question. The reasoning, and the option of splitting them
> again, is in [`../ADJUNCT_ASSESSMENT.md`](../ADJUNCT_ASSESSMENT.md) and D-15.

**Locale** `en` · **Version** `{{DOCUMENT_VERSION}}` · **Effective from** `{{EFFECTIVE_DATE}}`

---

## 1. What this notice is, and who it is for

1.1. This notice explains how {{PRODUCT_NAME}} (the "**Service**") uses automated assistance to help a
business answer messages, what it will not do without a person, and which third parties are involved.

1.2. It is written for two readers. **If you are a business using the Service**, this is the description
you are entitled to rely on, and you may refer your own customers to it or reuse its substance in your own
notice. **If you messaged a business and arrived here**, clause 12 is for you.

## 2. A machine helps write these replies

2.1. When somebody messages a business using the Service, the Service assembles what is needed to answer —
part of the conversation, the knowledge the business has configured, examples of how it writes — and asks
a language model to prepare a reply.

2.2. Depending on the business's settings, that reply is either shown to a person first, or sent
automatically.

2.3. **The business decides which.** The Service does not make that choice for them.

2.4. **A business may also schedule a follow-up** inside a conversation you have already started — a later
attempt to write to you again. It is prepared at the time it comes due, in the same way and under the same
rules as any other reply. **Nothing in the Service can write to somebody who has not written first.**

## 3. The three modes

| Mode | What happens |
| --- | --- |
| **Off** | Nothing is prepared. The business answers as it would without the Service. |
| **Draft** | A reply is prepared and **not sent** until an authorised person reviews, edits or approves it. |
| **Autopilot** | A reply may be sent **without a person reading it first**, subject to clause 4. |

3.1. A mode can be set for an account and changed at any time.

3.2. **A person always outranks the automation.** When somebody at the business takes a conversation over —
by writing in it, claiming it, or pausing it — automated sending in that conversation stops until it is
explicitly resumed. If a message is sent from the connected account outside the Service and the Service
cannot match it to something it sent itself, it treats that as a person having taken over.

## 4. What is never sent without a person

4.1. Whatever the mode, the Service applies determinate rules before anything is sent, and holds a reply
for a person instead of sending it where those rules are not satisfied.

4.2. The categories that always require a person include:

   (a) payment disputes and refunds beyond a documented policy;
   (b) interpretation of a legal or contractual question;
   (c) medical advice and other high-risk advice;
   (d) credential and security matters;
   (e) serious or reputational complaints;
   (f) unusual or high-value commitments;
   (g) any case where a material fact is missing and getting it wrong could cause real harm.

4.3. A reply that would answer a voice note whose words could not be read is **never** sent without a
person. The Service can tell "we could not hear the customer" from "we could not send what we wrote", and
treats them differently.

4.4. **This reduces risk. It does not eliminate it.** Clause 11 says what can still go wrong.

4.5. The operational detail of these rules — the exact categories, the thresholds, the codes in the record
— is product documentation and changes as the Service improves. **The principle in 4.1 does not.** It is
stated here as a principle on purpose: a public document that enumerated internal codes would become
untrue the first time one was renamed.

## 5. What the assistant is built not to do

5.1. It answers from the knowledge the business has given it and from the conversation in front of it.

5.2. It is built **not to invent** prices, policies, availability, discounts, outcomes or commitments.
Where a material fact is missing, it asks a question or hands the conversation to a person rather than
guessing.

5.3. It does not fabricate testimonials or claims about results.

5.4. It matches the language the customer wrote in, and it is shaped by examples of how the business
writes. **Style affects phrasing only.** How a business sounds and what is true about it are separate, and
the Service keeps them separate: when a person edits a prepared reply, their final wording is kept as an
example of style and **not** as a business fact.

## 6. Voice notes and transcripts

6.1. Where a customer sends a voice note and the business has transcription enabled, the recording is sent
to a transcription provider and the words come back as text.

6.2. **A transcript is a machine's reading of a recording and can be wrong.** It enters the conversation as
text like any other, and nothing about a machine having produced it gives it extra authority.

6.3. **If the customer also typed something on the same message, their typed words take precedence** over
the machine's reading of their voice. They chose those words themselves.

6.4. If transcription is unavailable, not enabled, or the business's allowance is exhausted, the recording
is still stored and visible and the business can listen to it. See clause 4.3 for what the Service will not
do in that case.

## 7. Why a reply is not instant

7.1. The Service may wait briefly, group several messages that arrive together, and answer them once —
because that is what a person would do.

7.2. It may deliberately delay a reply so that it does not arrive with machine-like immediacy.

7.3. Messaging platforms also restrict when and how a business may reply. The Service observes those
restrictions and will decline to send rather than breach them.

## 8. Which providers are involved

8.1. Providing the Service involves third parties in these categories:

| Category | What it receives |
| --- | --- |
| The messaging platform | The whole conversation. It is the channel |
| A provider that prepares text | The context assembled for one reply — see clause 9 |
| A provider that transcribes audio, where enabled | The audio of a voice note |
| A provider that computes search representations, where enabled | Short passages of text, to find what is relevant |
| A payment provider | Billing data only. **No conversation content** |
| An e-mail delivery provider | The address of somebody signing in, and their sign-in link. **No conversation content** |
| Hosting and infrastructure | Everything, at rest and in transit |

8.2. **A provider can be replaced.** The Service is deliberately built so that no single provider is
load-bearing in its design. The current named list is maintained with the subprocessor arrangements rather
than written into this notice, so that a change is a notified change and not a silent edit to a web page.
Businesses using the Service can obtain the current list — see clause 14.

## 9. What is sent to a provider, and what never is

9.1. For each reply the Service sends the text-preparing provider: a bounded part of the conversation, the
knowledge and style material retrieved for that reply, and a transcript where one exists.

9.2. **It is bounded deliberately.** The provider is given a structured set of labelled pieces rather than
one assembled block of text. Anything that did not come from the business's own configuration is treated
as material to read rather than instructions to follow: it is cleaned, limited in length, and marked as
untrusted. The amount of history is bounded and the retrieved material is capped.

9.3. **Nothing reaches a provider that was not read for that reply.** And a credential never reaches one at
all.

9.4. A sign-in link is a credential for one click. It is never written to a log.

## 10. Model training

10.1. **This notice does not claim that content sent to a provider is excluded from training that
provider's models.**

10.2. That depends on each provider's terms and on how the account is configured, and the claim will not be
made until it has been verified for each provider — and re-verified whenever a provider changes. See
[`../OWNER_DECISIONS.md`](../OWNER_DECISIONS.md), D-14.

## 11. Limits — what can still go wrong

Stated plainly, because a disclosure that only lists safeguards is an advertisement.

11.1. **A prepared reply can be wrong.** It can be confidently wrong, and it can be wrong in a way that
reads well.

11.2. **Safety rules can be satisfied by a reply that is still bad.** They catch defined categories; they
do not understand the conversation.

11.3. **Configured knowledge can be wrong or out of date**, and the assistant will answer from it faithfully
if so. Keeping it accurate is the business's job.

11.4. **A transcript can mishear** a name, a number, an amount or a negation.

11.5. **Autopilot sends without review**, so an error in Autopilot reaches the customer before anybody at
the business sees it.

11.6. **Delivery is not guaranteed.** A platform may delay, refuse or lose a message, and a delivery or
read receipt is the platform's statement.

11.7. A provider or platform may be unavailable. The Service holds work rather than discarding it, and
says so.

## 12. If you messaged a business and arrived here

12.1. The business you wrote to uses software that helps it answer. Depending on its settings, a reply you
received may have been prepared automatically, and may have been sent without a person reading it first.

12.2. **You can ask for a person.** Saying so in the conversation is enough: a member of staff can take the
conversation over at any time, and when they do, automation stops.

12.3. **You can ask not to be contacted again.** That is a request the business must honour, and the
Service is built to keep an objection even if everything else about you is deleted.

12.4. **If you want to know what is held about you, or want it erased, ask the business**, not us. They
decide; we act on their instructions. If you reach us instead, we will tell you so and pass your request
to them. The reason is in the Privacy Policy, clause 14.4.

12.5. If you sent a voice note, it may have been transcribed by a machine, and the transcript may be
wrong. If something you said was misunderstood, saying so in the conversation corrects it.

## 13. Changes

13.1. A change is published as a new version with its own effective date. A version already in force is not
edited.

## 14. Contact

{{SELLER_LEGAL_NAME}} · Support: {{SUPPORT_EMAIL}} · Privacy: {{PRIVACY_EMAIL}}

For the current list of providers, write to {{PRIVACY_EMAIL}}.
