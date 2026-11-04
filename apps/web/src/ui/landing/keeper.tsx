/**
 * The character beside the demonstration — which is the brand mark itself, not a separate drawing.
 *
 * It began as a robot built from a rounded rectangle and two bars, and it looked like what it was. The
 * mark already says the whole idea in one shape: a reply with eyes and no mouth. So the character is the
 * mark, and the only thing that changes is what its eyes are doing.
 *
 * Phases come from the demonstration's own `data-phase`; this component owns no state and no timers, so
 * there is one clock rather than two that can disagree. Everything else — the lean, the blink, the
 * breath while it holds a reply — is a stylesheet rule, which is why `prefers-reduced-motion` silences
 * all of it in one place.
 *
 * The eye swap is the owner's: sly while it is drafting or holding something back, level and calm once
 * the run is reset and nothing is pending.
 */
import { Mark } from "./mark";

export function Keeper({ phase }: { readonly phase: string }) {
  // Sly in exactly one phase: while it is holding a reply it is not allowed to say. Everywhere else —
  // writing, released, cancelled — it has nothing withheld, so it looks plainly at you. That is also
  // what makes the change visible on every run: press "again" and the eyes go level, then narrow the
  // moment there is something being kept back.
  const eyes = phase === "waiting" ? "sly" : "plain";

  return (
    <span className="keeper" data-phase={phase} aria-hidden="true">
      <Mark eyes={eyes} className="keeper-mark" />
    </span>
  );
}
