/**
 * The decisions behind the front door's two forms, kept out of the actions themselves (#115).
 *
 * A server action is a public HTTP endpoint. The form a screen renders is one caller; a constructed
 * request carrying whichever fields its author felt like is another, and both reach the same code. These
 * functions are that code, in a module with no `"use server"` and no database, so the rules can be run
 * against submissions no browser ever built — which is the only way to test the second caller at all.
 *
 * The name limit is **imported** rather than restated. A number written here would be free to disagree
 * with the one the store enforces, and the disagreement shows up as the worst kind of error: a field that
 * accepts 240 characters and then hands the person a `DbInputError` raised two layers below the screen
 * they were looking at.
 */
import { DbInputError, NAME_MAX_LENGTH, PlanLimitError, WorkspacePermissionError } from "@omnichannel/db";

import { field } from "./form-fields";

/**
 * What a front-door submission produced, as the page says it back.
 *
 * Replay is its own outcome and not an error: nothing was denied, the thing exists, and the person is
 * taken to it. Saying "created" there would claim a creation that did not happen, and saying "refused"
 * would send somebody looking for a problem that is not there.
 */
export type OnboardingOutcome =
  | "WORKSPACE_CREATED"
  | "WORKSPACE_REPLAYED"
  | "PROFILE_CREATED"
  | "PROFILE_REPLAYED"
  | "NAME_REQUIRED"
  | "NAME_TOO_LONG"
  | "PROFILE_LIMIT_REACHED"
  | "FORBIDDEN";

/** A validated name, or the reason this submission does not carry one. */
export type NameSubmission = { readonly kind: "NAMED"; readonly name: string } | { readonly kind: "REFUSED"; readonly outcome: OnboardingOutcome };

/**
 * The name a form submitted, trimmed exactly as the store trims it.
 *
 * Trimmed first and then measured, because the store stores the trimmed value: a name of 200 characters
 * padded with spaces is accepted there and would be refused here if this measured the raw field, and a
 * screen that refuses what the store accepts is a screen nobody can get past.
 *
 * Whitespace alone is `NAME_REQUIRED` rather than `NAME_TOO_LONG` or a silent empty workspace. A missing
 * field, a `File` posted in its place and a field of tabs are the same answer: this submission does not
 * name anything.
 */
export function nameOf(formData: FormData, fieldName = "name"): NameSubmission {
  const name = field(formData, fieldName).trim();
  if (name.length === 0) {
    return { kind: "REFUSED", outcome: "NAME_REQUIRED" };
  }
  if (name.length > NAME_MAX_LENGTH) {
    return { kind: "REFUSED", outcome: "NAME_TOO_LONG" };
  }
  return { kind: "NAMED", name };
}

/**
 * The outcome for a refusal the store raised.
 *
 * Only the refusals this product has a sentence for. Anything else is rethrown rather than flattened
 * into a generic failure: an unexpected error that reached a user as "something went wrong" is an error
 * nobody ever sees in a log, and the error boundary is where an unknown fault belongs.
 *
 * `DbInputError` is mapped although the forms validate first, and that is deliberate defence in depth —
 * this is a public endpoint, and the store's own rule is the one that decides. It maps by *length* rather
 * than by the error's message, because a message is prose and this is a branch.
 */
export function refusalOutcome(error: unknown, submitted: string | undefined): OnboardingOutcome | undefined {
  if (error instanceof PlanLimitError) {
    return "PROFILE_LIMIT_REACHED";
  }
  if (error instanceof WorkspacePermissionError) {
    return "FORBIDDEN";
  }
  if (error instanceof DbInputError && error.field === "name") {
    return submitted !== undefined && submitted.trim().length > NAME_MAX_LENGTH ? "NAME_TOO_LONG" : "NAME_REQUIRED";
  }
  return undefined;
}
