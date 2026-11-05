/**
 * The authenticated workspace shell (PRODUCT_UX.md, Issue #27).
 *
 * The Workspace and the Business Profile are named by the route and authorized on every request. There is
 * no remembered "current" workspace and no default profile: ADR-009 is explicit that the session proves
 * who you are and nothing about what you may see, and a shell that carried a profile in a cookie would be
 * the first place that stopped being true.
 *
 * The locale is resolved once here and the navigation receives finished strings, because a translator
 * carries functions and functions do not cross into a client component.
 */
import { cookies } from "next/headers";
import Link from "next/link";
import type { ReactNode } from "react";

import { NAV_SECTIONS, type NavSection } from "@/ui/sections";
import { NavigationBar } from "@/ui/navigation-bar";
import { LocaleSwitch } from "@/ui/locale-switch";
import { requestLocale } from "@/i18n/request-locale";
import { createTranslator } from "@/i18n/translate";
import { loadWebEnv } from "@/env";
import { chooseThemeInPlaceAction } from "@/server/public-surface-actions";
import { PUBLIC_PREFERENCE_MAX_AGE, PUBLIC_THEME_COOKIE, publicThemeOf } from "@/server/public-theme";
import { MoonIcon, SunIcon } from "@/ui/public/icons";
import { ThemeSwitch, type ThemeOption } from "@/ui/public/theme-switch";
import { setUiLocaleAction } from "@/server/locale-actions";
import { pageBusinessProfileContext } from "@/server/page-context";
import { getDb } from "@/server/db";

export default async function ProfileShellLayout({
  children,
  params,
}: {
  readonly children: ReactNode;
  readonly params: Promise<{ readonly workspaceId: string; readonly businessProfileId: string }>;
}) {
  const { workspaceId, businessProfileId } = await params;
  // Throws when the viewer is not a member, or the profile is not theirs to see. The shell renders
  // nothing at all in that case, rather than a frame around an authorization error.
  await pageBusinessProfileContext(workspaceId, businessProfileId);

  const locale = await requestLocale();
  const t = createTranslator(locale);
  const cookieStore = await cookies();
  const theme = publicThemeOf(cookieStore.get(PUBLIC_THEME_COOKIE)?.value);
  const themeOptions: readonly ThemeOption[] = [
    { value: "light", label: t.t("publicSurface.themeLight"), icon: <SunIcon />, action: chooseThemeInPlaceAction.bind(null, "light") },
    { value: "dark", label: t.t("publicSurface.themeDark"), icon: <MoonIcon />, action: chooseThemeInPlaceAction.bind(null, "dark") },
  ];
  const [workspace, profile] = await Promise.all([
    getDb().workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { name: true } }),
    getDb().businessProfile.findUniqueOrThrow({
      where: { workspaceId_id: { workspaceId, id: businessProfileId } },
      select: { name: true, status: true },
    }),
  ]);
  const basePath = `/workspaces/${workspaceId}/profiles/${businessProfileId}`;
  const navLabels = Object.fromEntries(NAV_SECTIONS.map((section) => [section, t.t(`nav.${section}`)])) as Record<NavSection, string>;

  return (
    <div className="shell">
      {/* A real in-page anchor, not a router link: it moves focus within this document. */}
      <a className="skip-link" href="#shell-content">
        {t.t("shell.skipToContent")}
      </a>
      <nav className="shell-nav" aria-label={t.t("shell.navigationLabel")}>
        <div className="workspace-switch">
          <span className="muted">{t.t("shell.workspaceLabel")}</span>
          <strong>{workspace.name}</strong>
          <span className="muted">{profile.name}</span>
          <Link href="/workspaces">{t.t("shell.switchWorkspace")}</Link>
        </div>
        <NavigationBar
          basePath={basePath}
          labels={navLabels}
          toggleLabel={t.t("shell.openNavigation")}
          navigationLabel={t.t("shell.navigationLabel")}
          docsUrl={loadWebEnv().WEB_DOCS_URL}
          docsLabel={t.t("nav.documentation")}
          externalHint={t.t("shell.externalLink")}
          controls={
            <>
              <ThemeSwitch
                groupLabel={t.t("publicSurface.theme")}
                stored={theme}
                options={themeOptions}
                cookieName={PUBLIC_THEME_COOKIE}
                cookieMaxAge={PUBLIC_PREFERENCE_MAX_AGE}
              />
              <LocaleSwitch t={t} current={locale} action={setUiLocaleAction} />
            </>
          }
        />
        {profile.status === "SETUP" ? <Link href={`${basePath}/setup`}>{t.t("shell.setupLink")}</Link> : undefined}
      </nav>
      <main className="shell-main" id="shell-content">
        {children}
      </main>
    </div>
  );
}
