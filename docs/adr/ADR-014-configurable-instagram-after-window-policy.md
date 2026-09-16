# ADR-014: Configurable Instagram after-window policy

**Status:** Accepted

## Decision

Support two workspace/account-selectable policies for Instagram conversations after the standard automated messaging window:

1. `STANDARD_ONLY` — once the standard automated window closes, AI delivery stops and the conversation is held/skipped until the user messages again.
2. `HUMAN_ASSISTED_EXTENDED` — if the Meta Human Agent feature is approved and the extended human-support window is still open, AI may prepare a draft but a real human must explicitly review/edit/approve and initiate the send. The actual send path may attach `HUMAN_AGENT` only to that human action.

## Non-goal

We do not implement fully automated AI sends that impersonate human-agent activity merely to bypass Meta's standard window. The Human Agent path is treated as a human-in-the-loop capability.

## Why

The product owner wants a selectable stricter mode and a more permissive human-assisted mode. Meta currently exposes a HUMAN_AGENT send capability for Instagram, but its intended use is human support after the standard automated window and it is gated by approval/verification requirements.

## Consequences

- `AutomationPolicy` gains an Instagram after-window policy field;
- policy engine may return `HOLD_REVIEW_HUMAN_AGENT` instead of a terminal not-eligible decision when the extended human-support path is available;
- unified inbox must show remaining eligibility and require a deliberate human action;
- automated delivery coordinator never adds `HUMAN_AGENT` on its own;
- implementation must re-verify the then-current standard/extended window durations, App Review requirements and permitted usages before shipping.
