/**
 * Reading fields out of a submitted form, for every screen that submits one.
 *
 * A server action is a public HTTP endpoint: the form a screen renders is one caller, and a constructed
 * request carrying whichever fields its author felt like sending is another. These helpers are the part
 * both callers go through, and they live in one module so that the rules they encode have one
 * implementation — the expected-version rule in particular, which decides whether a submission may be
 * completed against whatever happens to be current. Knowledge, Style and AI settings all ask that
 * question, and a rule with three implementations does not fail when they disagree; it fails on the one
 * nobody checked.
 */
export function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/** One entry per line, the visible convention every multi-value field on these screens uses. */
export function lines(formData: FormData, name: string): readonly string[] {
  return field(formData, name)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * The version the form was rendered against, or `undefined` when the submission did not carry a usable
 * one.
 *
 * Deliberately strict. `Number.parseInt` is happy to read "2" out of "2; DROP", and a guard that accepts
 * that is a guard whose refusals depend on the shape of the attacker's string, so the whole field has to
 * be the number. Zero, a negative, a fraction and an absent field are all the same answer: this
 * submission does not say which version it was composed against, and nothing here is allowed to guess.
 */
export function expectedVersionOf(formData: FormData, name = "expectedVersion"): number | undefined {
  const raw = field(formData, name).trim();
  if (!/^[1-9][0-9]*$/u.test(raw)) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
