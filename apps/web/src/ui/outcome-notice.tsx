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
  "COMPOSED",
  "COMPOSE_REPLAYED",
  "ALREADY_PENDING",
  "NOT_OPEN",
] as const;

/** Outcomes that mean the person did not get what they asked for. */
const REFUSALS = new Set<string>(["TOO_LATE", "STALE", "GONE", "REJECTED", "ALREADY_RESOLVED", "ALREADY_PENDING", "NOT_OPEN"]);

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
