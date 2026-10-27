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
| `max-width: 900px` | the Inbox shows one pane at a time; the leads board is hidden and its table becomes one card per lead; the analytics panels become a single column |

Above 900px the base rules apply unchanged.

The Inbox is the only two-pane surface. Review is a single column of cards and the Leads board is hidden
below 900px rather than folded, so neither has — or needs — a one-pane rule; an earlier version of this
table said all three were two-pane, and the test that cites this document now asserts the opposite.

Two things are deliberately **not** breakpoints, because a viewport width cannot answer for them:

- **The filter bar** wraps by itself, `repeat(auto-fit, minmax(min(9rem, 100%), 1fr))`. It was keyed to a
  viewport width three times and was wrong three times, because the shell spends 232px of the window on
  its sidebar before the content sees any of it, and because the widest bar has seven fields.
- **Every floor** — `minmax()` minimums and `min-width` — is capped at the container with `min(x, 100%)`.
  A floor wider than the box it is in is not a floor, it is an overflow.

## Tested widths

| Name | Width | Rules that apply |
| --- | --- | --- |
| phone | 375px | both narrow blocks |
| large phone | 430px | both narrow blocks |
| tablet | 768px | the 900px block only |
| small tablet | 901px | base rules; the Inbox's two-pane stage begins |
| small laptop | 1024px | base rules |
| desktop | 1440px | base rules |
| wide desktop | 1404px | base rules; the Inbox's three-pane stage begins |

These widths are declared in `breakpoints.test.ts` as `TESTED_WIDTHS`, and a test asserts this document
lists every one of them. The two cannot drift apart without the build failing.

## The Inbox has two stages, and the container decides which

The reading thread is the product's primary surface and it must not be the narrowest thing on screen. It
was: at a 901px window the thread's grid track resolved to **zero** — the 26px box a browser reported is
`box-sizing: border-box` refusing to draw narrower than its own padding and border — and at 1024px it was
100px against a 320px list. Nothing overflowed the document at any of those widths, which is why a sweep
for a sideways-scrolling page found nothing (Issue #112).

**Why it happened:** the two outer tracks are capped and the middle one is flexible, and CSS Grid sizes
them in that order — §12.6 Maximize Tracks grows the definite tracks to their maxima first, and only then
does §12.7 resolve the `fr` from what is left. The thread was not "the rest of the row"; it was the
remainder after 320 and 300 had been taken.

**The rule now, which is a rule and not a width somebody liked:**

- the conversation list never takes more than **a third** of the main column, and never more than 320px;
- all three panes appear only when the column can give the thread **half again** the widest pane beside it
  — `320 + 300 + 2 x 12 + 480 = 1124px` of main column, which is a 1404px window;
- below that the context panel keeps its full content in document order **below** the thread at the full
  width of the column, which is the treatment it already had on a phone;
- three panes scroll inside themselves; two panes scroll with the page. Neither stage nests a scroller
  inside a scroller.

**Asked of `.shell-main` through a container query, not of the window.** The window is the wrong question
inside this layout: `.shell` spends `--shell-nav-width` on navigation down to 721px and `.shell-main`
spends `--space-5` a side, so a 1024px window leaves 744px. A viewport breakpoint for anything in here is
the sidebar's width wrong by construction, and wrong again the day that token changes.

### Measured, in a browser, before and after

| Window | Main column | Thread before | Thread after | Panes in the thread's row |
| --- | --- | --- | --- | --- |
| 320–900px | 288–688px | full width | full width | 1 |
| 901px | 621px | **0px of content** | 404px | 2 |
| 960px | 680px | **36px** | 444px | 2 |
| 1024px | 744px | **100px** | 486px | 2 |
| 1180px | 900px | **256px** | 591px | 2 |
| 1244px | 964px | **320px** | 634px | 2 |
| 1245px | 965px | 321px | 635px | 2 |
| 1403px | 1123px | 479px | 791px | 2 |
| 1404px | 1124px | 480px | 480px | 3 |
| 1440px | 1160px | 516px | 516px | 3 |
| 1920px | 1312px | 668px | 668px | 3 |

Document overflow was zero at every width both before and after. The 1403px and 1404px "before" figures
are computed rather than measured — the browser run on the previous head covered the other nine widths,
and `thread-width.test.ts` agrees with every measured one to the pixel.

`responsive/thread-width.test.ts` is the deterministic half of this: it resolves the tracks the way the
specification says, from the declarations the stylesheet really carries, and asserts the width the thread
is left with at every width above. It recomputes the 1124px threshold from the track caps, so widening a
pane without moving the threshold fails rather than quietly re-collapsing the thread, and a counter-test
runs the previous head's single track list through the same arithmetic to reproduce the 0 and the 100.

**Also checked in the browser, and not by any test:** tab order runs list → thread → context in both
stages, with the phone-only "back" link appearing only where the list is a separate screen; no focusable
element is zero-sized or clipped; in the two-pane stage no pane declares a scroller of its own, and in the
three-pane stage each declares exactly one; the context panel keeps its `aria-label` in both.

**What is not covered:** that 480px *reads* well is a judgement, not a measurement. Neither the harness nor
the arithmetic opens a real route with real data — both render the shell and the stylesheet around
representative markup — so a component that sets its own width inline would escape both. Nothing does
today, and a separate test forbids inline colours; there is no equivalent guard for inline widths.

## The overflow harness, and what it measured

`apps/web/src/responsive/harness/` is a reproducible layout check for the one question no source scan can
answer: **does the document scroll sideways?** It loads the real stylesheet and the real shell around the
worst case each surface has to survive — one token with no break opportunity in it, which is what a person
creates by pasting a link into a lead's next action or by having a handle with no separators.

Run it by serving the repository over HTTP and opening
`apps/web/src/responsive/harness/index.html` (any static server will do;
`python3 -m http.server` from the repository root is enough). It needs no dev server, no database and no
network. Each tested width gets its own `<iframe>`, because a media query reads a viewport rather than a
parent element, and the results appear in the page and on `window.__results`.

**It is not run by CI and it is not a test.** There is no browser in the verify job, so these numbers are a
manual check, recorded here because they were taken rather than claimed. Two things about the harness are
worth knowing before trusting a number it prints: it passes a fresh token to the stylesheet on every run,
because without that the browser served a cached copy and the harness reported the *previous* stylesheet's
numbers for a changed one; and it measures a surface against `.shell-main`'s **content** box, since
`clientWidth` includes the 24px of padding on each side and reporting it made every surface look 48px
safer than it is. Both of those were mistakes in the first version of this file.

Measured with `documentElement.scrollWidth − clientWidth` inside each frame, before and after the repairs
of Issue #111:

| Viewport | Main column | Document overflow before | After |
| --- | --- | --- | --- |
| 320px | 288px | 136px | 0 |
| 375px | 343px | 81px | 0 |
| 430px | 398px | 26px | 0 |
| 720px | 688px | 0 | 0 |
| 768px | 488px | 0 | 0 |
| 901px | 621px | 205px | 0 |
| 1024px | 744px | 82px | 0 |
| 1440px | 1160px | 0 | 0 |
| 1920px | 1312px | 0 | 0 |

Two separate defects show up in that column. The phone widths were the **context panel**: an unbroken
handle made it ask for 440px inside a 288px column, and it had no `overflow-wrap` rule at all. The 901px
and 1024px widths were the **lead table**: its cells' wrap was declared only inside the 900px block, so
above that width the table asked for 850px against 621px and 744px of room. 1440px and 1920px show 0 both
times only because this harness's pasted link needs 850px and there is more room than that — the rule is
that a surface overflows when it needs more than the main column's content box, so a longer value reaches
wider windows. The numbers above are measurements of this content, not a bound for all content.

## Limitations, stated plainly

**jsdom evaluates no media queries and lays nothing out.** No test in this repository asserts that a page
*looks* right at 375px. It does, however, resolve the **cascade** — specificity and source order — and
`responsive/cascade.test.ts` uses that: it loads the real stylesheet, renders the markup a route renders,
and asks `getComputedStyle` which rule won. jsdom does not resolve `var()`, so the answer is the winning
declaration rather than a pixel value, which is exactly the question when a rule has been shadowed by a
twin. The tokens those declarations name are asserted separately against `:root`. What the responsive tests prove is that the rules which make each surface usable
narrow still exist, still name the classes and `data-pane` attributes the components render, and cover
every two-pane surface. That is the way this breaks in practice — a renamed class leaves a phone showing
two panes on top of each other, and nothing type-checks the join between a stylesheet, a component and a
route. Actual visual behaviour at each width is a manual check.

**Contrast is computed from tokens, not sampled from pixels.** Every colour in this product comes from a
custom property, so the ratios are exact for the pairs the stylesheet renders. It cannot judge a colour a
component invents inline — a separate test forbids those — and there are no images or gradients behind
text to complicate it. A browser-based auditor run in jsdom would report *nothing* here, because it needs
paint; this is strictly more than such a tool would give.

**Focus visibility is a rule, and the measured ring is 2px rather than 3.** Two rules declare it:
`:focus-visible` at (0,1,0) asks for 3px, and an element-qualified list — `input:focus-visible`,
`select:focus-visible`, `textarea:focus-visible`, `button:focus-visible`, `a:focus-visible`,
`summary:focus-visible` — asks for 2px at (0,1,1). The more specific one wins, so **every control a person
can actually focus draws 2px solid `--accent` at a 2px offset**, measured in a browser by pressing Tab
(`document.activeElement` matching `:focus-visible`, computed `outline` reading `2px solid`). The 3px rule
is the backstop for anything focusable that is not in that list, and `semantics.test.ts` forbids most of
what that could be. The contrast test holds `--accent` to 3:1 against the page either way. Whether the
ring reads well over every possible background is still a manual check.

This paragraph used to say 3px flatly, which was true before the element-qualified rule was added and
false afterwards. Whether the two rules should be one, and at which width, is a visual decision and is
noted for scoping rather than taken here.

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
