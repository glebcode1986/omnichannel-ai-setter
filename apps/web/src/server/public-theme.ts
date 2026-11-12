/**
 * The colour scheme chosen on the public surface.
 *
 * Three states, not two, and the third is the one that is easy to lose: **no choice at all**. A reader
 * who has never touched the control should follow their operating system, and keep following it when they
 * change it at dusk. Modelling the absent cookie as `undefined` rather than defaulting it to `light` is
 * what keeps that true — a stored `light` is a decision, and the absence of one is not the same decision.
 *
 * The cookie is read on the server so the document is rendered with the right palette in its first byte.
 * A theme applied by script after hydration is a flash of the wrong colours on every single navigation,
 * which is the usual way this control is built and the reason it usually looks cheap.
 *
 * Not `httpOnly`, for the same reason the locale cookie is not: there is nothing secret in a colour
 * scheme, and the control writes it from the client so the switch is instant. Validated on the way in, so
 * the worst a hostile value can do is pick between two palettes.
 */
export const PUBLIC_THEME_COOKIE = "public_theme";

export const PUBLIC_THEMES = ["light", "dark"] as const;
export type PublicTheme = (typeof PUBLIC_THEMES)[number];

/** A year. The same life as the locale cookie: a preference, not a session. */
export const PUBLIC_PREFERENCE_MAX_AGE = 365 * 24 * 60 * 60;

export function isPublicTheme(value: unknown): value is PublicTheme {
  return typeof value === "string" && (PUBLIC_THEMES as readonly string[]).includes(value);
}

/**
 * The stored choice, or `undefined` when there is none.
 *
 * `undefined` is not a failure to read: it is the answer "follow the system", and the document renders
 * with no `data-theme` attribute so the stylesheet's `prefers-color-scheme` query decides.
 */
export function publicThemeOf(value: string | null | undefined): PublicTheme | undefined {
  return isPublicTheme(value) ? value : undefined;
}
