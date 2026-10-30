# Data Processing Agreement — SCAFFOLD ONLY

> **SCAFFOLD. NOT A DRAFT, NOT PUBLISHED, NOT APPROVED, NOT IN FORCE.**
> Prepared under Issue #121 on 30 October 2026. This is not legal advice and binds nobody.
>
> **Why this is a scaffold and not a draft.** Its substance is three things nobody has decided: which of
> us is processor for what, the subprocessor annex, and how a change of subprocessor is notified and
> whether it may be objected to. Confident prose over those gaps would produce a document that looks
> finished and commits the seller to things nobody has agreed. Each clause below states what it is for
> and what it is waiting for. Reasoning in [`../ADJUNCT_ASSESSMENT.md`](../ADJUNCT_ASSESSMENT.md).

**Locale** `en` · **Version** `—` (unversioned; not publishable in this state)

---

## 1. Parties and roles

**Purpose.** Identify the controller (the Customer) and the processor (the Provider), and state the
division of roles.

**What is already settled, as the honest reading of the implementation.** The Provider is **controller**
for account and sign-in data, workspace and member records, subscription and billing records, records of
consent to legal documents, and security and audit records. The Provider is **processor** for the content
of conversations between the Customer and the people who message it, the media and recordings in them,
transcripts, and everything derived from them — summaries, recorded facts about a person, style examples
and search representations.

**Open.** That division is a legal characterisation, and the Customer's own counsel may read it
differently — particularly for derived data, which the Provider generates but which is about the
Customer's data subjects. **D-18 in this document's terms: requires legal confirmation on both sides.**

## 2. Subject matter, duration, nature and purpose

**Purpose.** Article 28(3) requires each to be stated.

**Draftable now.** Subject matter: processing conversation content in order to provide an assisted
messaging service. Duration: the term of the main agreement, plus the retention period that follows it.
Nature and purpose: receiving messages; assembling context; preparing replies; applying safety rules;
transcribing audio where enabled; computing and comparing search representations; queuing and delivering
outbound messages; and keeping the record of decisions.

**Open.** The retention period that follows termination. **D-11.**

## 3. Categories of personal data and of data subject

**Purpose.** Article 28(3) and the Annex.

**Draftable now, from the Privacy Policy clause 3.** Categories of data subject: the people who message
the Customer, and the Customer's own members. Categories of data: identifiers given by the messaging
platform; message content; media and voice recordings; transcripts; derived summaries, recorded facts and
preferences; style examples; search representations; and lead stage.

**Open.** Whether to state that special categories are not intentionally processed while acknowledging
that a person may disclose anything in a message. The Privacy Policy takes that position; the DPA should
match it rather than restate it differently.

## 4. The controller's instructions

**Purpose.** The processor acts only on documented instructions.

**Draftable now.** The Customer's instructions are: the main agreement; the configuration the Customer
sets in the Service, including its automation mode, knowledge, style material and retention settings; and
the actions its authorised members take. The Provider processes for no other purpose.

**Open.** What the Provider does if an instruction appears to infringe data protection law — the
obligation to inform exists; the operational route for it does not.

## 5. Confidentiality

**Purpose.** Persons authorised to process are bound to confidentiality.

**Draftable now.** Access is limited to what a role requires, is checked on every request against the
member's current role and the profiles they may see, and is not cached — so a revoked role takes effect at
once. Provider personnel access a Workspace's content for support, security or legal obligation, and the
access is recorded.

**Open.** Whether to commit to a notification to the Customer when Provider personnel access their
content, which is a commitment with an operational cost.

## 6. Security measures

**Purpose.** Article 32, and the Annex describing the measures.

**Draftable now, and specific.** Channel credentials are envelope-encrypted at rest with the workspace,
the credential's identity and its purpose bound into the encrypted context, so a record cannot be
decrypted in the wrong one; plaintext exists only in memory between a read and the transport that uses it.
Error reporting passes through an allow-list of fields and avoids the place HTTP clients expose request
configuration, so a token is not logged. Taking a person's whole history out of the Service, erasing it,
or erasing what the Service has learned about them are separate capabilities reserved to a Workspace's
owner or administrators. Authorization is workspace, role, profile scope and action — scope alone is not
permission.

**Open.** Encryption in transit and at rest at the infrastructure layer, backup and restore, and
penetration-testing commitments, all of which depend on the hosting decision. **D-10.**

## 7. Subprocessors

**Purpose.** General or specific authorisation, the list, the flow-down of obligations, and notice of
changes.

**Open, and this is the clause that most needs a decision.** The candidate list is in
[`../SUBPROCESSORS.md`](../SUBPROCESSORS.md), built from the application's own environment contract rather
than from a vendor list. Turning it into an annex requires, for each entry: the executed agreement, the
transfer instrument, and the processing location. **None of that diligence has been done.** Three
decisions follow it:

   (a) general authorisation with notice, or specific authorisation per subprocessor;
   (b) the notice period for adding one — which binds how quickly a provider can be changed;
   (c) whether the Customer may object, and what happens if it does.

**D-9 and D-5.**

## 8. Assistance with data subject requests

**Purpose.** The processor assists the controller in responding.

**Draftable now, and already implemented.** One person's data can be exported at a time, by a Workspace
owner or administrator, size-limited, and recorded as part of the same operation that reads it, with the
record holding counts rather than content. Deletion runs in one of four scopes, chosen when requested and
never widened, and finishes as completed or as a partial failure that is not silently retried. The
platform's copy of a recording is deleted before the record naming it, and a deletion that cannot reach
the platform is a partial failure rather than a completion.

**Open.** Response times the Provider commits to, which have to fit inside the Customer's own statutory
deadline.

## 9. Assistance with the controller's own obligations

**Purpose.** Assistance with Articles 32 to 36 — security, breach, impact assessment, prior consultation.

**Open.** What the Provider commits to supply, and in what form. A data protection impact assessment is
realistically needed for a product that drafts and sends messages to third parties, and whether the
Provider supplies material for the Customer's assessment is a commitment nobody has made.

## 10. Breach notification

**Purpose.** Notify the controller without undue delay.

**Open.** The notification period, the route, and the minimum content. The product has audit records that
make a breach reconstructable; it has no breach-notification process, because a process is people and not
code.

## 11. Audit and information

**Purpose.** Make available the information needed to demonstrate compliance, and allow audits.

**Open.** Whether audits are on-site, by questionnaire, or by third-party report; who pays; how often. A
pre-launch product has no certification to offer in place of an audit, which makes this clause more
consequential than it is in a mature vendor's DPA.

## 12. International transfers

**Purpose.** The basis for any transfer outside the EEA.

**Open, and blocking.** The first launch route is an EU-established seller, and several providers are
established in the United States. Each transfer needs an Article 46 instrument, and **this scaffold states
none**, because which instrument applies to which provider is a per-contract fact nobody has checked. See
[`../SUBPROCESSORS.md`](../SUBPROCESSORS.md). **D-5.**

## 13. Deletion or return at the end

**Purpose.** What happens to the data when the agreement ends.

**Draftable in part.** The deletion machinery exists and its scopes are described in clause 8. Export is
one person at a time, which is adequate for a data subject request and **not** adequate as a return of a
Workspace's data at the end of a contract — a Workspace with thousands of conversations cannot be returned
one person at a time.

**Open.** Whether the Provider commits to a bulk return, in what format, and in what period. If it does,
that is a product capability that does not exist today, and it belongs on the future-tasks list rather
than in a contract. **Noted in [`../CROSSWALK.md`](../CROSSWALK.md).**

## 14. Order of precedence and liability

**Purpose.** How this agreement sits against the main agreement.

**Draftable now.** This agreement prevails over the main agreement on the processing of personal data on
the Customer's behalf, and the main agreement governs everything else.

**Open.** Whether liability under this agreement is inside or outside the main agreement's cap. **D-8.**

## 15. Annexes

| Annex | Content | Status |
| --- | --- | --- |
| A | Details of processing — subject matter, duration, nature, purpose, categories | Draftable from clauses 2 and 3 |
| B | Technical and organisational measures | Partly draftable from clause 6; infrastructure part open |
| C | Subprocessors | **Candidate list only**, see [`../SUBPROCESSORS.md`](../SUBPROCESSORS.md) |
| D | Transfer instrument, per subprocessor | **Empty.** Diligence not done |

## What has to happen before this becomes a draft

1. Legal confirmation of the controller/processor division in clause 1, including for derived data.
2. The subprocessor diligence: agreement, transfer instrument and processing location for each entry.
3. The three subprocessor-notice decisions in clause 7.
4. The hosting decision, which clause 6 and clause 12 both wait on.
5. A decision on bulk export, which clause 13 cannot honestly promise without it.
