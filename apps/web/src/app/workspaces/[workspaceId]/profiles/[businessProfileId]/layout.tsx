/**
 * The frame every screen inside a Business Profile is rendered in.
 *
 * It resolves the context first and renders nothing at all when the viewer may not see this profile —
 * a frame around an authorization error is worse than no frame, because it looks like the product
 * worked and the page was empty.
 *
 * The Workspace and the Business Profile are named by the route and authorized on every request. There is
 * no remembered "current" workspace and no default profile: ADR-009 is explicit that the session proves
 * who you are and nothing about what you may see, and a shell that carried a profile in a cookie would be
 * the first place that stopped being true. This paragraph is kept deliberately, because the change that
 * introduced the colour-scheme cookie below also deleted it. That cookie carries a *preference* and is
 * read for presentation only; nothing here reads tenancy from a cookie, and the sentence above is what
 * says so to whoever edits this file next.
 *
 * The shape itself lives in `ShellFrame`; everything here is the server's half of it: the words in the
 * reader's language, the workspace and profile names, and the two preference controls.
 */
import { cookies } from "next/headers";
import Link from "next/link";
import type { ReactNode } from "react";

import { getDb } from "@/server/db";
import { createTranslator } from "@/i18n/translate";
import { requestLocale } from "@/i18n/request-locale";
import { pageBusinessProfileContext } from "@/server/page-context";
import { setUiLocaleAction } from "@/server/locale-actions";
import { chooseThemeInPlaceAction } from "@/server/public-surface-actions";
import { PUBLIC_PREFERENCE_MAX_AGE, PUBLIC_THEME_COOKIE, publicThemeOf } from "@/server/public-theme";
import { LanguageSelect } from "@/ui/public/language-select";
import { Mark } from "@/ui/landing/mark";
import { MoonIcon, SunIcon } from "@/ui/public/icons";
import { ThemeSwitch, type ThemeOption } from "@/ui/public/theme-switch";
import { localeNames, UI_LOCALES } from "@/i18n/locales";
import { NAV_GROUPS, NAV_SECTIONS, type NavGroup, type NavSection } from "@/ui/sections";
import { ShellFrame } from "@/ui/shell-frame";

export default async function BusinessProfileLayout({
  children,
  params,
}: {
  readonly children: ReactNode;
  readonly params: Promise<{ readonly workspaceId: string; readonly businessProfileId: string }>;
}) {
  const { workspaceId, businessProfileId } = await params;
  await pageBusinessProfileContext(workspaceId, businessProfileId);

  const locale = await requestLocale();
  const t = createTranslator(locale);
  const cookieStore = await cookies();
  const theme = publicThemeOf(cookieStore.get(PUBLIC_THEME_COOKIE)?.value);

  const [workspace, profile] = await Promise.all([
    getDb().workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { name: true } }),
    getDb().businessProfile.findUniqueOrThrow({
      where: { workspaceId_id: { workspaceId, id: businessProfileId } },
      select: { name: true, status: true },
    }),
  ]);

  const basePath = `/workspaces/${workspaceId}/profiles/${businessProfileId}`;
  const labels = Object.fromEntries(NAV_SECTIONS.map((section) => [section, t.t(`nav.${section}`)])) as Record<NavSection, string>;
  const groupLabels = Object.fromEntries(NAV_GROUPS.map((group) => [group.id, t.t(`navGroup.${group.id}`)])) as Record<NavGroup, string>;

  const themeOptions: readonly ThemeOption[] = [
    { value: "light", label: t.t("publicSurface.themeLight"), icon: <SunIcon />, action: chooseThemeInPlaceAction.bind(null, "light") },
    { value: "dark", label: t.t("publicSurface.themeDark"), icon: <MoonIcon />, action: chooseThemeInPlaceAction.bind(null, "dark") },
  ];

  return (
    <ShellFrame
      basePath={basePath}
      labels={labels}
      groupLabels={groupLabels}
      navigationLabel={t.t("shell.navigationLabel")}
      toggleLabel={t.t("shell.openNavigation")}
      closeLabel={t.t("shell.closeNavigation")}
      skipLabel={t.t("shell.skipToContent")}
      brand={
        <Link className="shell-brand-link" href="/workspaces">
          <Mark title={t.t("landing.title")} className="shell-brand-mark" />
          <span>{t.t("landing.title")}</span>
        </Link>
      }
      crumb={
        <>
          <span className="shell-crumb-name">{profile.name}</span>
          <span className="shell-crumb-muted">{workspace.name}</span>
        </>
      }
      account={
        <>
          {profile.status === "SETUP" ? (
            <Link className="shell-account-setup" href={`${basePath}/setup`}>
              {t.t("shell.setupLink")}
            </Link>
          ) : undefined}
          <Link className="shell-account-switch" href="/workspaces">
            {t.t("shell.switchWorkspace")}
          </Link>
        </>
      }
      controls={
        <>
          <ThemeSwitch
            groupLabel={t.t("publicSurface.theme")}
            stored={theme}
            options={themeOptions}
            cookieName={PUBLIC_THEME_COOKIE}
            cookieMaxAge={PUBLIC_PREFERENCE_MAX_AGE}
          />
          {/* The same control the public pages use, rather than a second one: it applies on change,
              which is what lets it sit in a 56px bar without a submit button beside it. */}
          <LanguageSelect
            label={t.t("shell.localeLabel")}
            applyLabel={t.t("shell.localeSave")}
            locale={locale}
            options={UI_LOCALES.map((option) => ({ value: option, label: localeNames[option] }))}
            action={setUiLocaleAction}
          />
        </>
      }
    >
      {children}
    </ShellFrame>
  );
}
