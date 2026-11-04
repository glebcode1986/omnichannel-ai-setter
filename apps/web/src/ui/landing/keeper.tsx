/**
 * The character: a face that wants to speak and waits to be allowed.
 *
 * The product's whole argument is restraint — it drafts, it holds, it goes out only when a person says
 * so, and a takeover cancels it mid-flight. Said in a sentence that is abstract. Given a face it is
 * immediate: this one peeks over the conversation, thinks while the draft is composed, leans in holding
 * the words while the delay runs down, opens its mouth exactly once if the send completes, and settles
 * back with its mouth shut if you cancel. It never speaks on its own, because the product does not.
 *
 * Pure inline SVG driven by `[data-phase]` on an ancestor, so every expression is a stylesheet rule and
 * the component itself has no state, no effects and no timers — the demo it reacts to already owns all
 * three. That also means one media query silences the whole performance under `prefers-reduced-motion`.
 *
 * `aria-hidden`, and deliberately so: it carries no information that the demonstration beside it and the
 * numbered steps below it do not already state in words. A reader using a screen reader loses a joke,
 * not a fact.
 */
export function Keeper({ phase }: { readonly phase: string }) {
  return (
    <svg className="keeper" data-phase={phase} viewBox="0 0 120 108" aria-hidden="true" focusable="false">
      {/* Antenna. Its light is the only part that moves while the reply is being written. */}
      <line className="keeper-stalk" x1="60" y1="10" x2="60" y2="22" />
      <circle className="keeper-lamp" cx="60" cy="7" r="5" />

      <rect className="keeper-head" x="14" y="22" width="92" height="76" rx="26" />

      {/* Eyes. Rounded bars rather than dots, so a blink is a scale rather than a disappearance. */}
      <rect className="keeper-eye" data-side="left" x="36" y="48" width="12" height="16" rx="6" />
      <rect className="keeper-eye" data-side="right" x="72" y="48" width="12" height="16" rx="6" />

      {/* The mouth. Shut is the resting state, which is the point of the whole character. */}
      <rect className="keeper-mouth" x="48" y="76" width="24" height="4" rx="2" />
    </svg>
  );
}
