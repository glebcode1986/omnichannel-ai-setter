/**
 * What just happened, told once (Issue #29).
 *
 * Every review decision and conversation operation redirects back with its outcome in the URL, and this
 * renders it. In the URL rather than in client state so it survives a reload, which is exactly when
 * someone re-reads a refusal they did not expect.
 *
 * The tone is part of the message. "Too late to stop it" and "Sent" are both true statements about a
 * send that happened, and only one of them is what the person was trying to do.
 */
import type { MessageKey } from "@/i18n/catalogue";
import type { Translator } from "@/i18n/translate";

const OUTCOMES = [
  "SENT",
  "DISMISSED",
  "CLAIMED",
  "TAKEN_OVER",
  "HANDED_BACK",
  "SEND_CANCELLED",
  "ALREADY_CANCELLED",
  "ALREADY_RESOLVED",
  "TOO_LATE",
  "STALE",
  "GONE",
  "REJECTED",
  // The human composer's own outcomes (#29).
  "COMPOSED",
  "COMPOSE_REPLAYED",
  "ALREADY_PENDING",
  "NOT_OPEN",
  // Knowledge and Style report their own outcomes through the same notice, for the same reason: a refusal
  // that survives a reload is one somebody actually reads. The Knowledge family was missing once, and
  // every save, publish and archive redirected with an outcome this component then ignored — the
  // operator pressed Save and was told nothing, which is indistinguishable from nothing happening.
  "SAVED",
  "CREATED",
  "VERSIONED",
  "UNCHANGED",
  "PUBLISHED",
  "ARCHIVED",
  "ACTIVATED",
  "REJECTED_EXAMPLE",
  "RESTORED",
  "CONFLICT",
  "REFUSED",
  "MOVED",
  "STALE_STAGE",
  "UNCHANGED_STAGE",
  // Settings answer two refusals of their own: a role that may not change them, and a field too long to
  // travel back in a refused proposal. Both are refusals, and both have to survive a reload — a person
  // who was silently not allowed to save reads the screen as a screen that does nothing.
  "FORBIDDEN",
  "TOO_LONG",
  // Custom timing, refused three ways rather than one. "Incomplete", "out of range" and "the wrong way
  // round" send a person to different fields, and an invalid Custom submission used to be reported as a
  // success with the previous ranges silently kept.
  "TIMING_INCOMPLETE",
  "TIMING_OUT_OF_RANGE",
  "TIMING_REVERSED",
  // The takeover pause is the fifth number on the same form and gets the same treatment, because a
  // cleared box used to be read as "leave it alone" and report a success about something else.
  "TAKEOVER_INCOMPLETE",
  "TAKEOVER_OUT_OF_RANGE",
] as const;

/** Outcomes that mean the person did not get what they asked for. */
const REFUSALS = new Set<string>([
  "TOO_LATE",
  "STALE",
  "GONE",
  "REJECTED",
  "ALREADY_RESOLVED",
  "ALREADY_PENDING",
  "NOT_OPEN",
  "REFUSED",
  "STALE_STAGE",
  // A conflict is a refusal, and the one most worth marking: it is the word that stops somebody believing
  // their edit or their publish landed.
  "CONFLICT",
  "FORBIDDEN",
  "TOO_LONG",
  "TIMING_INCOMPLETE",
  "TIMING_OUT_OF_RANGE",
  "TIMING_REVERSED",
  "TAKEOVER_INCOMPLETE",
  "TAKEOVER_OUT_OF_RANGE",
]);

export function OutcomeNotice({ t, outcome }: { readonly t: Translator; readonly outcome: string | undefined }) {
  // An outcome nobody defined is not rendered at all. It can only come from a hand-edited URL, and
  // inventing a sentence for it would be the page agreeing with something that never happened.
  if (outcome === undefined || !(OUTCOMES as readonly string[]).includes(outcome)) {
    return undefined;
  }

  return (
    <p className="notice" role="status" data-outcome={outcome} data-tone={REFUSALS.has(outcome) ? "stop" : undefined}>
      {t.t(`outcome.${outcome}` as MessageKey)}
    </p>
  );
}
