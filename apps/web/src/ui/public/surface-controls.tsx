/**
 * The two choices a reader can make before they have an account, in one cluster (#117 follow-up).
 *
 * Rendered on all four public pages — landing, sign-in, privacy, terms — from one component, because a
 * control that exists on three of them is a control a reader learns not to look for. Each page passes
 * its own path so the form returns the reader to the page they were reading rather than to a constant.
 *
 * Two different shapes, because the two choices are different. Appearance is a closed pair that will
 * never gain a third option, so it is a segmented control with a sun and a moon — recognised without
 * being read, and small enough to live in a corner. Language is an open list that is meant to grow, so
 * it is a select: the same size at twenty languages as at two, with the platform's own keyboard
 * handling and its own overlay on a phone.
 *
 * A server component that hands *bound* server actions to the two client components underneath it.
 * Language needs no client code to work at all — changing it changes server-rendered text, so the round
 * trip is the work rather than an overhead — and the client half only saves the reader a second click.
 * Appearance gets a client handler because the palette is already in the browser and reloading to apply
 * it would be a reload for nothing.
 */
import { localeNames, UI_LOCALES, type UiLocale } from "@/i18n/locales";
import type { Translator } from "@/i18n/translate";
import type { PublicPath } from "@/server/public-paths";
import { choosePublicLocaleAction, choosePublicThemeAction } from "@/server/public-surface-actions";
import { PUBLIC_PREFERENCE_MAX_AGE, PUBLIC_THEME_COOKIE, type PublicTheme } from "@/server/public-theme";
import { MoonIcon, SunIcon } from "@/ui/public/icons";
import { LanguageSelect } from "@/ui/public/language-select";
import { ThemeSwitch, type ThemeOption } from "@/ui/public/theme-switch";

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
  const themeOptions: readonly ThemeOption[] = [
    {
      value: "light",
      label: t.t("publicSurface.themeLight"),
      icon: <SunIcon />,
      action: choosePublicThemeAction.bind(null, "light", path),
    },
    {
      value: "dark",
      label: t.t("publicSurface.themeDark"),
      icon: <MoonIcon />,
      action: choosePublicThemeAction.bind(null, "dark", path),
    },
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

      <LanguageSelect
        label={t.t("publicSurface.language")}
        applyLabel={t.t("publicSurface.languageApply")}
        locale={locale}
        options={UI_LOCALES.map((option) => ({ value: option, label: localeNames[option] }))}
        action={choosePublicLocaleAction.bind(null, path)}
      />
    </div>
  );
}
