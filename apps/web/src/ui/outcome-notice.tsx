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
  // Billing (#42). A cancellation that takes effect later is not a refusal — nothing was denied — so it
  // keeps the ordinary tone and says when it bites.
  "CANCELING",
  "RESUMED",
  // Accepting the terms (#47). `ACCEPTED` is not a purchase and does not claim to be one: the acceptance
  // is recorded and the payment step is what comes next.
  "ACCEPTED",
  "TERMS_NOT_ACCEPTED",
  "TERMS_CHANGED",
  "CHECKOUT_UNAVAILABLE",
  // The internal console's own outcomes (#59). An operator reads these as closely as a customer reads
  // theirs, and more carefully: the refusals say whether a role is missing or a request was impossible.
  "PAUSED",
  "RESUMED_OUTBOUND",
  "ALREADY_LIFTED",
  "SESSION_OPENED",
  "SESSION_REVOKED",
  "ALREADY_REVOKED",
  "REEXAMINED",
  "NOT_PERMITTED",
  "ADMIN_REFUSED",
  "MOVED",
  "STALE_STAGE",
  "UNCHANGED_STAGE",
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
  // Three ways a checkout did not start (#47). Marked as refusals because in every one of them the
  // person pressed a button and did not get what it offered — and `CHECKOUT_UNAVAILABLE` especially,
  // because the tone is what stops them trying again and again.
  "TERMS_NOT_ACCEPTED",
  "TERMS_CHANGED",
  "CHECKOUT_UNAVAILABLE",
  // An operator who pressed a control and did not get it. `ALREADY_LIFTED` and `ALREADY_REVOKED` are not
  // refusals: nothing was denied, the work was simply already done.
  "NOT_PERMITTED",
  "ADMIN_REFUSED",
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
