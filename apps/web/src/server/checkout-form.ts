/**
 * Reading an acceptance out of a form (#47).
 *
 * Its own module so it can be tested without the authenticated request path behind it, and because the
 * one thing it does that matters is *refusing* input.
 *
 * A checkbox posts nothing at all when it is unticked, so "which documents did this person accept?" has
 * to be read from what arrived rather than from what the page offered — and the ids that arrive are
 * attacker-controlled. They are passed straight to `openCheckoutContract`, which refuses any id it did
 * not itself offer for this seller, this locale and this instant; nothing here tries to decide which ids
 * are legitimate, because a second opinion on that question is a second place for the two to disagree.
 *
 * What this does enforce is shape: an id that is not a string, is blank, or repeats is dropped, so the
 * store receives a clean set and a refusal it reports names something real.
 */

/** One value, or the empty string for anything that is not a string. Never `null`. */
export function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/**
 * The document versions this submission claims to accept.
 *
 * One checkbox per document, all named `accept`, so an unticked box contributes nothing — which is the
 * whole point: the set of accepted documents is what arrived, and the server compares it against what it
 * would have offered rather than against what the page said it offered.
 */
export function acceptedDocumentIdsFrom(formData: FormData): readonly string[] {
  return idsNamed(formData, "accept");
}

/**
 * The document versions the page rendered a tick for.
 *
 * Hidden fields, one per required document, so the server can tell "you left a box unticked" from "a
 * requirement appeared between the page and the submission". It is only ever used to *soften* a refusal
 * into a more accurate one: the enforcement itself is computed from what the store would offer now, so a
 * hand-edited form that claimed to have rendered everything would still be refused for whatever it did
 * not tick.
 */
export function offeredDocumentIdsFrom(formData: FormData): readonly string[] {
  return idsNamed(formData, "offered");
}

/**
 * The opaque identity of the offer the page displayed (#47).
 *
 * Attacker-controlled like every other field, and safe for the same reason the document ids are: it is
 * only ever *compared* against what the store resolves inside the opening transaction. A forged value
 * cannot name a seller, a provider or a route — the most it can do is match the terms that are current
 * anyway, which is the case the comparison exists to allow.
 *
 * Returns the empty string when the field is absent or blank, and deliberately not `undefined`: the store
 * requires this value, and an absent one has to be a value that cannot match rather than a value that
 * skips the comparison. A submission that names no offer is refused, which is the safe direction — the
 * alternative is letting the client the check distrusts disable it by leaving the field out.
 */
export function offeredDigestFrom(formData: FormData): string {
  return field(formData, "offer").trim();
}

function idsNamed(formData: FormData, name: string): readonly string[] {
  const seen = new Set<string>();
  for (const value of formData.getAll(name)) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed !== "") {
      seen.add(trimmed);
    }
  }
  return [...seen];
}
