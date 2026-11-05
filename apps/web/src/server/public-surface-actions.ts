"use server";

/**
 * The two preferences a reader can set before they have an account: language and colour scheme.
 *
 * Server actions rather than client-only state, and the reason is the same for both: these pages are
 * server-rendered, so a preference that lives only in the browser cannot change what the server sends.
 * The language *is* the rendered text, and the theme has to be in the document's first byte or the page
 * flashes the wrong palette. A cookie read on the server answers both.
 *
 * Each action takes the path the control was rendered on and returns the reader to it. The path is
 * narrowed by `publicPathOf` rather than trusted — see its comment.
 *
 * Neither preference is authenticated and neither authorizes anything. A signed-in reader's language
 * still comes from `users.uiLocale`; this cookie is what somebody has before that row exists.
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { isUiLocale } from "@/i18n/locales";

import { loadWebEnv } from "../env";
import { publicPathOf } from "./public-paths";
import { PUBLIC_LOCALE_COOKIE } from "./public-locale";
import { isPublicTheme, PUBLIC_PREFERENCE_MAX_AGE, PUBLIC_THEME_COOKIE } from "./public-theme";

/** One cookie shape for both preferences, so they cannot drift apart in scope or lifetime. */
function preferenceCookie(): {
  path: string;
  sameSite: "lax";
  httpOnly: false;
  secure: boolean;
  maxAge: number;
} {
  return {
    path: "/",
    sameSite: "lax",
    // Read by the client control so the switch does not wait for a round trip. Nothing secret here.
    httpOnly: false,
    secure: loadWebEnv().NODE_ENV === "production",
    maxAge: PUBLIC_PREFERENCE_MAX_AGE,
  };
}

/**
 * Choose the colour scheme.
 *
 * An unrecognised value clears the preference rather than refusing: that is how "follow my system" is
 * expressed, and a control that can set a preference and never unset it is a trap.
 */
export async function choosePublicThemeAction(theme: string, path: string): Promise<void> {
  const store = await cookies();
  if (isPublicTheme(theme)) {
    store.set(PUBLIC_THEME_COOKIE, theme, preferenceCookie());
  } else {
    store.delete(PUBLIC_THEME_COOKIE);
  }
  redirect(publicPathOf(path));
}

/** Choose the language this public surface is read in. An unrecognised locale changes nothing. */
export async function choosePublicLocaleAction(locale: string, path: string): Promise<void> {
  if (isUiLocale(locale)) {
    const store = await cookies();
    store.set(PUBLIC_LOCALE_COOKIE, locale, preferenceCookie());
  }
  redirect(publicPathOf(path));
}
