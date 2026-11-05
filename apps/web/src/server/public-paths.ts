/**
 * Where the public surface's own controls may send a reader back to.
 *
 * The theme and language controls are forms, and a form that has just set a cookie has to return the
 * reader to the page they were reading — otherwise choosing Russian on the Privacy Policy lands them on
 * the sign-in screen, which is what the first version of the language control did because its action
 * redirected to a constant.
 *
 * The page supplies its own path, and this narrows that to a list written here. A redirect target that
 * comes from the request and is not checked against a list is an open redirect, and it does not stop
 * being one because today's only caller passes a literal: the next caller passes a search parameter.
 * Anything unrecognised becomes the landing page rather than an error, because a reader who chose a
 * language should not be shown a failure for it.
 */
export const PUBLIC_PATHS = ["/", "/sign-in", "/privacy", "/terms"] as const;
export type PublicPath = (typeof PUBLIC_PATHS)[number];

export function isPublicPath(value: unknown): value is PublicPath {
  return typeof value === "string" && (PUBLIC_PATHS as readonly string[]).includes(value);
}

/** The path to return to: the one given, when it is one of ours, and the landing page otherwise. */
export function publicPathOf(value: string | null | undefined): PublicPath {
  return isPublicPath(value) ? value : "/";
}
