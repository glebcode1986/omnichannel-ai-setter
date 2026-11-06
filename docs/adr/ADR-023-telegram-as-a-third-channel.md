# ADR-023: Telegram as a third channel

**Status:** **Proposed.** Drafted 2026-11-06 at the owner's request. Nothing in it has been built, and
the sections below are the decisions the owner has to make before anything can be — four of them are
product decisions, not engineering ones, and one is about send safety.

## The gap, stated exactly

Telegram is not in this product in any form. Measured on this tree:

| | |
|---|---|
| `CHANNEL_TYPES` in `packages/domain/src/channel.ts` | `["INSTAGRAM", "WHATSAPP"]` |
| `enum ChannelType` in the Prisma schema | the same two, carried by **two** models: `ChannelAccount` and `ChannelConnectState` |
| Production files branching on a channel literal | **37** |
| Channel adapter packages | `channel-core`, `channel-instagram`, `channel-whatsapp` |
| Occurrences of the string `"TELEGRAM"` | **three, in tests, as the unknown channel the system must reject** |

`MVP_RELEASE_SCOPE.md` names it under *Later / intentionally not MVP*: "Telegram as first-class
conversation channel — architecturally possible later; not required for MVP."

Two things follow from the table. The **database** change is small: conversations and messages take
their channel from the account, so one enum value and two tables carry it. The **product** change is
not small, because Telegram is not a Meta platform and roughly half of what this product calls "a
channel" is written around Meta's rules.

And ADR-001 claimed the core is channel-neutral with platform features capability-gated. Telegram is
the first thing that tests that claim rather than asserting it. If the claim holds, most of the 37
files need no change; if it does not, this ADR is where that is found out.

## What the decision actually is

Not "add Telegram". Four questions, each of which has a cheap answer and an expensive one, and the
fourth is about whether an unattended reply can go out somewhere none of our current brakes apply.

### 1. How a business connects it

Instagram is OAuth. WhatsApp is Embedded Signup (ADR-015). Both are *delegated*: the business
authorizes our app against assets the platform holds, and the business can revoke that from the
platform's own settings.

Telegram has no equivalent. A business creates a bot with `@BotFather` and receives a **token** — a
long-lived credential that *is* full control of that bot — and pastes it into us.

| Option | What it costs |
|---|---|
| **(a) Paste the bot token** | Simplest, and the only path that works today. We hold a credential the customer typed, encrypted with the same cipher as the others. Revocation is theirs: regenerate in BotFather. It must never be displayed again after it is stored, and never logged. |
| **(b) Telegram Login Widget** | Identifies a *person*, not a bot. It does not grant the right to receive a business's messages, so it does not answer this question. |

There is no third option. The question for the owner is whether holding a pasted bot token is
acceptable, given the product has so far only ever held delegated credentials.

### 2. There is no service window

This is the largest asymmetry. A Telegram bot may message a user at any time until the user blocks it.
There is no 24-hour window, no re-engagement rule, and nothing to be outside of.

Everything in the product that answers "what may we send now" was written for the Meta rule:
`InstagramAfterWindowPolicy`, `WhatsAppAfterWindowPolicy`, and the reason codes `WINDOW_CLOSED`,
`TEMPLATE_REQUIRED` and `NO_ELIGIBLE_TEMPLATE`.

| Option | What it costs |
|---|---|
| **(a) Telegram has no after-window policy** | Honest. The Settings group for it is absent on a Telegram account rather than showing a control with nothing behind it — which is what capability-gating in ADR-001 is for. Those reason codes can never be produced for Telegram, and the Analytics panel that lists them stays truthful without changes. |
| **(b) Invent our own window** | A quiet-hours or staleness rule of our own. Defensible as politeness, but it is **our** policy wearing the name of a platform rule, and the first person to read "window closed" on a Telegram conversation will believe Telegram said so. If this is wanted, it needs a different name. |

### 3. What a template is

A WhatsApp template is approved by Meta, and the product's whole template catalogue is built on that:
it is why an approved template may be sent where free text may not.

Telegram has no approver.

| Option | What it costs |
|---|---|
| **(a) No templates on Telegram** | Follows from question 2: with no window there is nothing a template exists to get past. |
| **(b) Saved snippets of our own** | Useful, and it must **not** reuse the template catalogue. The catalogue's records mean "a platform approved this wording"; putting our own snippets in it would make the audit unable to say who approved what, which is the one thing that record is for. |

### 4. Unattended sending — the safety question

Several of the deterministic gates that stand between a draft and a customer are not ours. They are
Meta's: the service window, the template requirement, account health. On Telegram **none of them
exist**, so a Telegram account on AUTOPILOT is less constrained than any account this product has ever
sent from.

| Option | What it costs |
|---|---|
| **(a) Telegram is DRAFT-only to begin with** | A person approves every reply. Nothing is lost that the pilot needs — the pilot is DRAFT-first anyway (#133) — and it buys time to see what the channel actually does. |
| **(b) AUTOPILOT with our own brakes** | Our rate limiting, quiet hours and confidence gates become the *only* thing between the assistant and a customer. Each exists and each is ours alone, which has never been true before. |

## Recommended default

(1a) pasted bot token, (2a) no window concept at all, (3a) no templates, (4a) DRAFT-only until a
business explicitly asks otherwise. That is the smallest Telegram that is honest: it adds a channel
without claiming any platform rule that does not exist, and it does not widen unattended sending in
the same change that adds a new way for messages to arrive.

## What it would cost to build, with that default

- **Migration**: one enum value; `ChannelAccount` and `ChannelConnectState` accept it. No column moves.
- **`packages/channel-telegram`**: webhook receipt with Telegram's `X-Telegram-Bot-Api-Secret-Token`
  (their only authenticity check — there is no request signature like Meta's), inbound mapping to the
  normalized message, and sending. Capabilities declared the way `channel-whatsapp/src/capabilities.ts`
  declares its own.
- **Connect flow**: a form that accepts a token, verifies it with `getMe`, registers the webhook, and
  stores the token encrypted. Simpler than either Meta flow — no redirect, no state cookie.
- **The 37 files**: reviewed, not rewritten. ADR-001 says most should need nothing; the ones that do
  are where the neutrality claim was not true.
- **Three tests** that use `"TELEGRAM"` as the channel the system must reject need a different unknown
  value, or they start asserting the opposite of what they were written for.
- **Copy**: four `channel.*` keys plus the connect screen, in both languages.

## Consequences if this stays Proposed

Nothing changes. The product supports two channels and says so everywhere, which is true. This file is
the record of what was asked and what it turned out to require, so the next person asking does not
start from the beginning.

## Non-goal

This does not decide Threads, which `MVP_RELEASE_SCOPE.md` holds behind a separate platform and legal
review. It does not decide whether one customer writing from Telegram and from Instagram becomes one
contact — the cross-channel identity graph is already named as not-MVP, and adding a channel does not
change that. And it does not authorize provisioning anything: no bot, no token, no webhook.
