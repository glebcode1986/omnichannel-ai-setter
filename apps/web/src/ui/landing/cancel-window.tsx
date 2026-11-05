"use client";

/**
 * The hero demonstration: one reply, waiting out its delay, with a cancel button that works.
 *
 * Every other product in this category sells speed. This one sells the pause — the randomized delay
 * before a send, the approval that can be withheld, the takeover that cancels a reply already scheduled.
 * That is hard to say in a sentence and trivial to *show*, so the first thing a visitor meets is the
 * thing nobody else has: a draft composing itself, a countdown, and a button that stops it.
 *
 * It demonstrates a real behaviour rather than illustrating one. `coordinateDelivery` re-reads the whole
 * conversation at the last possible moment and refuses to send a reply the customer has overtaken or a
 * person has taken over; `CANCELLED_HUMAN_TAKEOVER` is a settlement with tests behind it. The seconds
 * here are shortened for a landing page, which is the only liberty taken.
 *
 * **Three conversations rather than one.** A single shop enquiry answered one question — "what does a
 * reply look like" — and left the one a visitor actually arrives with: *would it work for my business*.
 * A dentist, a travel agency and a food order are three trades whose replies have nothing in common
 * except the shape of the thing underneath, which is the point being made. Each names the facts it drew
 * on and the channel it arrived through, so the WhatsApp one is visibly WhatsApp rather than asserted to
 * be. Nothing about the mechanism changes between them: the same draft, the same delay, the same button.
 *
 * Its words arrive as plain strings rather than a translator, because a translator carries functions and
 * functions do not cross the server/client boundary — the same reason `navigation.tsx` gives.
 *
 * Under `prefers-reduced-motion` nothing moves: the draft is there at once and the countdown is a number
 * rather than a sweeping ring. The demonstration still works, which is the test of whether reduced motion
 * was respected or merely declared.
 */
import { useCallback, useEffect, useState } from "react";

import { Keeper } from "./keeper";

export interface DemoScenario {
  /** Stable, and used in the DOM: the tab's id, the panel's label, and what a test selects on. */
  readonly id: string;
  /** The trade, as a reader would name it — this is the word they scan for. */
  readonly tab: string;
  /** Which platform this conversation arrived through. */
  readonly channel: string;
  readonly customerText: string;
  readonly draftText: string;
  /** Which facts the draft drew on, and how much of the owner's own writing shaped its tone. */
  readonly why: string;
}

export interface CancelWindowCopy {
  readonly scenariosLabel: string;
  readonly scenarios: readonly DemoScenario[];
  readonly customerLabel: string;
  readonly draftLabel: string;
  readonly typing: string;
  /**
   * One sentence per second the countdown can show, interpolated on the server and indexed by seconds
   * remaining. An array rather than a formatter because a function cannot cross into a client component —
   * the constraint `sign-in-panel.tsx` states — and pushing the catalogue into the browser to re-translate
   * what the server already knew would ship the same text twice.
   */
  readonly waiting: readonly string[];
  readonly cancel: string;
  readonly sent: string;
  readonly cancelled: string;
  readonly replay: string;
  readonly hint: string;
  readonly region: string;
}

type Phase = "drafting" | "waiting" | "sent" | "cancelled";

/** Shortened for a landing page; the product's own delay is minutes, not seconds. */
const COUNTDOWN_SECONDS = 6;
const TYPING_MS = 1400;
const PANEL_ID = "demo-panel";

const tabId = (scenario: DemoScenario): string => `demo-tab-${scenario.id}`;

/**
 * Move focus to a tab, outside React.
 *
 * A module function rather than a closure in the component body: this reaches into the document, which
 * is exactly what a render must not do, and keeping it out here says plainly that it only runs from a
 * key press.
 */
function focusTab(id: string): void {
  document.getElementById(id)?.focus();
}

export function CancelWindow({ copy }: { readonly copy: CancelWindowCopy }) {
  const [active, setActive] = useState(0);
  const [phase, setPhase] = useState<Phase>("drafting");
  const [typed, setTyped] = useState(0);
  const [left, setLeft] = useState(COUNTDOWN_SECONDS);
  // Read once at mount rather than assigned from inside an effect. `useState` with an initialiser runs
  // on the client's first render, so the value is right before anything is painted; setting it in an
  // effect would render once with the wrong answer and then again with the right one.
  const [reduced, setReduced] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [run, setRun] = useState(0);

  const scenario = copy.scenarios[active] ?? copy.scenarios[0];
  const draftText = scenario?.draftText ?? "";

  // Only the *changes* need an effect; the initial value came from the initialiser above.
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  // The draft composes itself. With reduced motion it is simply there.
  useEffect(() => {
    if (phase !== "drafting" || draftText === "") {
      return;
    }
    if (reduced) {
      // Scheduled rather than called straight through. A `setState` run synchronously inside an effect
      // re-renders before the first render has settled, which is a cascade the lint rule refuses — and
      // it is right to: the same two updates one tick later are indistinguishable to a reader.
      const immediate = window.setTimeout(() => {
        setTyped(draftText.length);
        setPhase("waiting");
      }, 0);
      return () => window.clearTimeout(immediate);
    }
    const step = TYPING_MS / draftText.length;
    const id = window.setInterval(() => {
      setTyped((count) => {
        if (count >= draftText.length) {
          window.clearInterval(id);
          setPhase("waiting");
          return count;
        }
        return count + 1;
      });
    }, step);
    return () => window.clearInterval(id);
  }, [phase, reduced, draftText, run]);

  // The delay runs down. Nothing here sends anything; the point is that it *could*.
  useEffect(() => {
    if (phase !== "waiting") {
      return;
    }
    const id = window.setInterval(() => {
      setLeft((seconds) => {
        if (seconds <= 1) {
          window.clearInterval(id);
          setPhase("sent");
          return 0;
        }
        return seconds - 1;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [phase, run]);

  const restart = useCallback(() => {
    setTyped(0);
    setLeft(COUNTDOWN_SECONDS);
    setPhase("drafting");
    setRun((count) => count + 1);
  }, []);

  /**
   * Switching trade starts that conversation from the beginning.
   *
   * Leaving the phase alone would show the new draft already sent, or — worse — part-typed to the length
   * the *previous* text had reached. The demonstration's whole claim is that you watch it happen, so
   * every scenario gets watched.
   */
  const choose = useCallback(
    (index: number) => {
      setActive(index);
      restart();
    },
    [restart],
  );

  // Нет слежения за курсором, и это сознательно. Сцена кренилась вслед за мышью, и текст внутри
  // плыл вместе с ней — читать было неуютно, хотя эффект задумывался как «объём». Объём остался,
  // но статический: слои по-прежнему разнесены по translateZ внутри perspective, просто ничего
  // больше не двигается под курсором.

  const visible = draftText.slice(0, typed);
  const progress = phase === "waiting" ? left / COUNTDOWN_SECONDS : phase === "drafting" ? 1 : 0;

  if (scenario === undefined) {
    return null;
  }

  return (
    <div className="demo" role="group" aria-label={copy.region}>
      <div
        className="demo-scene"
        id={PANEL_ID}
        role="tabpanel"
        aria-labelledby={tabId(scenario)}
        // Focusable because during `drafting` the panel holds nothing focusable at all, and a tab panel a
        // keyboard cannot reach is a panel a keyboard user is told about and then cannot read.
        tabIndex={0}
        data-phase={phase}
        data-scenario={scenario.id}
      >
        {/* The character reads the same phase the demonstration is in. It owns no state of its own —
            every expression is a stylesheet rule keyed off `data-phase` — so there is one clock here,
            not two that can disagree. */}
        <Keeper phase={phase} />

        <p className="demo-channel" data-demo-channel={scenario.id}>
          {scenario.channel}
        </p>

        <div className="demo-layer" data-depth="back">
          <p className="demo-label">{copy.customerLabel}</p>
          <p className="demo-text">{scenario.customerText}</p>
        </div>

        <div className="demo-layer" data-depth="front" data-kind="draft">
          <p className="demo-label">
            {copy.draftLabel}
            {phase === "drafting" ? <span className="demo-typing"> · {copy.typing}</span> : null}
          </p>
          <p className="demo-text">
            {visible}
            {phase === "drafting" ? <span className="demo-caret" aria-hidden="true" /> : null}
          </p>
        </div>

        <div className="demo-bar" data-depth="top">
          {phase === "waiting" ? (
            <>
              <span
                className="demo-ring"
                role="timer"
                aria-label={copy.waiting[left] ?? ""}
                style={{ "--progress": progress } as React.CSSProperties}
              >
                <span className="demo-ring-value" aria-hidden="true">
                  {left}
                </span>
              </span>
              <button type="button" className="demo-cancel" onClick={() => setPhase("cancelled")}>
                {copy.cancel}
              </button>
            </>
          ) : null}

          {phase === "drafting" ? <span className="demo-state">{copy.typing}</span> : null}

          {phase === "sent" || phase === "cancelled" ? (
            <>
              <span className="demo-state" data-outcome={phase}>
                {phase === "sent" ? copy.sent : copy.cancelled}
              </span>
              <button type="button" className="demo-replay" onClick={restart}>
                {copy.replay}
              </button>
            </>
          ) : null}
        </div>

        <p className="demo-why">{scenario.why}</p>
      </div>

      {/*
        A real tablist, with arrow keys and one tab stop. Selection follows focus, which is the pattern
        for panels that cost nothing to render — arrowing along the trades shows each one rather than
        requiring a second key to confirm a choice already made.

        **After the panel, not before it.** Above the panel are two things that cannot move: the
        character, which overhangs its top edge, and the alignment with the headline. Written first,
        this row pushed the panel 46px down and broke that alignment — the stylesheet's comment said
        "under the demonstration" while the markup put it over the top, and the markup won. ARIA ties a
        panel to its tabs by `aria-controls` and `aria-labelledby` rather than by document order, so the
        relationship survives the arrangement; `cancel-window.test.tsx` holds the order itself.
      */}
      <div className="demo-tabs" role="tablist" aria-label={copy.scenariosLabel}>
        {copy.scenarios.map((option, index) => (
          <button
            className="demo-tab"
            key={option.id}
            id={tabId(option)}
            type="button"
            role="tab"
            aria-selected={index === active}
            aria-controls={PANEL_ID}
            tabIndex={index === active ? 0 : -1}
            data-demo-tab={option.id}
            onClick={() => {
              choose(index);
            }}
            onKeyDown={(event) => {
              const last = copy.scenarios.length - 1;
              const next =
                event.key === "ArrowRight"
                  ? (index === last ? 0 : index + 1)
                  : event.key === "ArrowLeft"
                    ? (index === 0 ? last : index - 1)
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? last
                        : null;
              if (next === null) {
                return;
              }
              event.preventDefault();
              choose(next);
              const target = copy.scenarios[next];
              if (target !== undefined) {
                focusTab(tabId(target));
              }
            }}
          >
            {option.tab}
          </button>
        ))}
      </div>

      {/* The outcome, announced once rather than on every tick: a countdown read aloud every second is
          unusable, and what matters to somebody not watching is how it ended. */}
      <p className="demo-live" aria-live="polite">
        {phase === "sent" ? copy.sent : phase === "cancelled" ? copy.cancelled : ""}
      </p>
      <p className="demo-hint">{copy.hint}</p>
    </div>
  );
}
