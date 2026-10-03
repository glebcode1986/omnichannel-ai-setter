# UX verification: journeys, accessibility and responsive behaviour

**Status:** Implemented by P5-09 (Issue #35).

**Related:** `PRODUCT_UX.md`, `ONBOARDING_UX.md`, `AI_CONFIGURATION_UX.md`, `KNOWLEDGE_STYLE_UX.md`,
`LEADS_ANALYTICS_UX.md`, `LOCALIZATION.md`, `ANALYTICS_DEFINITIONS.md`.

The P5-09 contract asks for the tested viewport ranges and the remaining limitations to be written down.
This is that document. It is deliberately explicit about what the suite does **not** prove, because a
coverage claim nobody has bounded is the kind that gets cited in a review and turns out to be hollow.

## What is verified, and how

| Layer | Where | What it actually exercises |
| --- | --- | --- |
| Operator journeys | `apps/web/src/journeys/*.integration.test.ts` | the real stores and server-facing functions against a **migrated PostgreSQL database**, including authorization and stale state |
| Colour contrast | `apps/web/src/a11y/contrast.test.ts` | WCAG 2.1 ratios **computed** from the stylesheet's own tokens, in both themes |
| Semantics and keyboard | `apps/web/src/a11y/semantics.test.ts` | every production component's source, for the failures that make a control unreachable |
| Responsive rules | `apps/web/src/responsive/breakpoints.test.ts` | that the narrow-screen rules exist and still name what the components render |
| Component behaviour | `apps/web/src/ui/**/*.test.tsx` | rendered output in jsdom, per surface |

There are **no production Meta credentials** anywhere in the suite, per the contract's hard invariant. The
channel adapters are exercised through their own fixtures and test doubles; the journeys never reach a
provider.

## Breakpoints

| Breakpoint | What changes |
| --- | --- |
| `max-width: 720px` | the shell's navigation stops being a sidebar column |
| `max-width: 900px` | two-pane surfaces (Inbox, Review, Leads) show one pane at a time; the analytics panels become a single column |

Above 900px the base rules apply unchanged.

## Tested widths

| Name | Width | Rules that apply |
| --- | --- | --- |
| phone | 375px | both narrow blocks |
| large phone | 430px | both narrow blocks |
| tablet | 768px | the 900px block only |
| small laptop | 1024px | base rules |
| desktop | 1440px | base rules |

These widths are declared in `breakpoints.test.ts` as `TESTED_WIDTHS`, and a test asserts this document
lists every one of them. The two cannot drift apart without the build failing.

## Limitations, stated plainly

**jsdom evaluates no media queries and lays nothing out.** No test in this repository asserts that a page
*looks* right at 375px. What the responsive tests prove is that the rules which make each surface usable
narrow still exist, still name the classes and `data-pane` attributes the components render, and cover
every two-pane surface. That is the way this breaks in practice — a renamed class leaves a phone showing
two panes on top of each other, and nothing type-checks the join between a stylesheet, a component and a
route. Actual visual behaviour at each width is a manual check.

**Contrast is computed from tokens, not sampled from pixels.** Every colour in this product comes from a
custom property, so the ratios are exact for the pairs the stylesheet renders. It cannot judge a colour a
component invents inline — a separate test forbids those — and there are no images or gradients behind
text to complicate it. A browser-based auditor run in jsdom would report *nothing* here, because it needs
paint; this is strictly more than such a tool would give.

**Focus visibility is a rule, not a measurement.** `:focus-visible` draws a 3px outline in `--accent`, and
the contrast test holds that colour to 3:1 against the page. Whether the ring is *visible* over every
possible background is a manual check.

**Screen-reader output is not captured.** The semantic checks prove a control has an accessible name and
is reachable by keyboard. They do not prove the announcement reads well, which no automated tool decides.

**The journeys drive server functions, not a browser.** They exercise the authorization, the stale-state
refusals and the durable writes — which is what the contract asks for, and what a DOM-level test would
miss. They do not prove a button is wired to the action it names; the component tests cover that side.

## Keyboard operability

The product is server-rendered forms and links throughout. That is the substance of its keyboard
operability rather than a coincidence: a real `<button>` inside a real `<form>` responds to Enter and
Space, appears in the tab order, and announces its role without anybody maintaining a handler.

`semantics.test.ts` holds that property structurally. It fails the build on a clickable `div`, a
`role="button"` on something that is not one, an `<a>` with no `href`, a positive or negative `tabIndex`,
an `aria-hidden` control, a control with no label, an icon-only button with no name, and a skipped heading
level. Each has a counter-test proving the matcher would catch the failure it claims to.

## Journeys covered

Every scenario Issue #35 names, each with an authorization probe and a stale-state probe rather than a
happy path alone:

1. workspace → onboarding resume → channel connection state → knowledge and style setup → simulation →
   activation;
2. Inbox search and filter → conversation → manual reply, takeover, resume;
3. DRAFT review: approve, edit, reject;
4. AUTOPILOT: pending delay, cancel, state change;
5. missing fact → review → confirmed knowledge → retry and simulation;
6. lead stage updated from the Inbox and from the pipeline;
7. policy change recorded in the audit log;
8. loading, empty, error, stale and network-recovery states.
