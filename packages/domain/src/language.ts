/**
 * Language tags, normalized once (P2-04 follow-up on PR #66).
 *
 * BCP-47 tags are case-insensitive and have one canonical spelling: `en-us`, `EN-US` and `en-US` are the
 * same tag, and `iw` is `he`. Style retrieval compares a requested language against the language an
 * example was written in with a plain equality, so both sides have to be in the same form before they
 * meet — otherwise a correct configuration misses its own examples for a reason nobody could see.
 *
 * The canonical form comes from `Intl.getCanonicalLocales`, which implements the standard rather than a
 * lowercase-and-hope approximation of it. Nothing here guesses: a tag is canonicalized or refused, and no
 * language is ever inferred from text.
 */

/**
 * The canonical form of a BCP-47 tag, `undefined` for a blank one, and `null` for something that is not a
 * tag at all. The caller decides what an invalid tag means at its own boundary.
 */
export function canonicalLanguageTag(tag: string | undefined): string | null | undefined {
  const trimmed = tag?.trim();
  if (trimmed === undefined || trimmed === "") {
    return undefined;
  }
  try {
    return Intl.getCanonicalLocales(trimmed)[0] ?? null;
  } catch {
    return null;
  }
}
