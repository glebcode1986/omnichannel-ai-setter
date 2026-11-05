/**
 * The two choices a reader can make before they have an account, in one cluster (#117 follow-up).
 *
 * Rendered on all four public pages — landing, sign-in, privacy, terms — from one component, because a
 * control that exists on three of them is a control a reader learns not to look for. Each page passes
 * its own path so the form returns the reader to the page they were reading rather than to a constant.
 *
 * A server component that hands a *bound* server action to the one client component underneath it. The
 * language half needs no client code at all: changing the language changes server-rendered text, so the
 * round trip is the work rather than an overhead. The theme half gets the client handler because the
 * palette is already in the browser and a reload to apply it would be a reload for nothing.
 *
 * The labels are the product's own words from the catalogue; the two-letter language badges are not
 * words and come from `localeShortNames`, with the language's own name as the accessible label so a
 * screen reader says "Русский" rather than spelling out two letters.
 */
import { localeNames, localeShortNames, UI_LOCALES, type UiLocale } from "@/i18n/locales";
import type { Translator } from "@/i18n/translate";
import type { PublicPath } from "@/server/public-paths";
import { choosePublicLocaleAction, choosePublicThemeAction } from "@/server/public-surface-actions";
import { PUBLIC_PREFERENCE_MAX_AGE, PUBLIC_THEME_COOKIE, type PublicTheme } from "@/server/public-theme";
import { ThemeSwitch } from "@/ui/public/theme-switch";

export interface SurfaceControlsProps {
  readonly t: Translator;
  /** The language the page is being rendered in, so the control can show which one is on. */
  readonly locale: UiLocale;
  /** The stored colour scheme, or `undefined` when the reader has not chosen one. */
  readonly theme: PublicTheme | undefined;
  /** The page this control is rendered on, narrowed to the public list. */
  readonly path: PublicPath;
}

export function SurfaceControls({ t, locale, theme, path }: SurfaceControlsProps) {
  const themeOptions: readonly { value: PublicTheme; label: string; action: () => Promise<void> }[] = [
    { value: "light", label: t.t("publicSurface.themeLight"), action: choosePublicThemeAction.bind(null, "light", path) },
    { value: "dark", label: t.t("publicSurface.themeDark"), action: choosePublicThemeAction.bind(null, "dark", path) },
  ];

  return (
    <div className="surface-controls">
      <ThemeSwitch
        groupLabel={t.t("publicSurface.theme")}
        stored={theme}
        options={themeOptions}
        cookieName={PUBLIC_THEME_COOKIE}
        cookieMaxAge={PUBLIC_PREFERENCE_MAX_AGE}
      />

      <div className="switch" role="group" aria-label={t.t("publicSurface.language")}>
        {UI_LOCALES.map((option) => (
          <form action={choosePublicLocaleAction.bind(null, option, path)} key={option}>
            <button
              className="switch-option"
              type="submit"
              aria-pressed={option === locale}
              aria-label={localeNames[option]}
              data-public-locale={option}
            >
              {localeShortNames[option]}
            </button>
          </form>
        ))}
      </div>
    </div>
  );
}
