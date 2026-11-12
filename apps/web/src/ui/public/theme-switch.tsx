"use client";

/**
 * The light/dark control, as a pair of forms that work before JavaScript does.
 *
 * Each option is a real `<form>` bound to a server action, so the control works with scripting off, and
 * works in the window between first paint and hydration — the moment an impatient reader clicks. When
 * the handler *is* live it cancels the submit and does the same two things the action would: set the
 * attribute the stylesheet reads, and write the cookie the server reads next time. One preference, two
 * writers, the same cookie name and the same lifetime, taken from the server so they cannot drift.
 *
 * `stored` is deliberately `PublicTheme | undefined`, and `undefined` is not "light": it means nobody has
 * chosen, so the system decides and the control has to show which way the system went. The server cannot
 * know that — `prefers-color-scheme` never reaches a server — so the system's answer is read here, as an
 * external store rather than in an effect. The difference matters twice: `useSyncExternalStore` has a
 * server snapshot, so the first render is a render rather than a correction, and it keeps following the
 * system for as long as no explicit choice exists. A reader who has not chosen and switches their laptop
 * to dark at dusk sees this control follow them.
 */
import type { ReactNode } from "react";
import { useState, useSyncExternalStore } from "react";

import type { PublicTheme } from "@/server/public-theme";

const DARK_QUERY = "(prefers-color-scheme: dark)";

function subscribeToSystemTheme(onChange: () => void): () => void {
  const query = window.matchMedia(DARK_QUERY);
  query.addEventListener("change", onChange);
  return () => {
    query.removeEventListener("change", onChange);
  };
}

function readSystemTheme(): PublicTheme {
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

/**
 * What the server knows about the system's preference: nothing, and it says so.
 *
 * It is tempting to guess light here. The guess is wrong for every reader on a dark machine, and it is
 * wrong *visibly* — the control arrives with the wrong half marked and corrects itself once the script
 * runs, which is the flicker this component exists to avoid. Returning `undefined` marks neither, and
 * the stylesheet fills the gap: `[data-following-system]` plus a `prefers-color-scheme` query shows the
 * right half from the very first paint, with no script at all. React re-reads the real value after
 * hydration and the accessible state catches up with what was already on screen.
 */
function readSystemThemeOnServer(): undefined {
  return undefined;
}

/**
 * The two writes, outside React.
 *
 * `data-theme` is what the stylesheet reads, so setting it is what makes the switch instant; the cookie
 * is what the *server* reads, so writing it is what makes the choice survive a reload. Deliberately a
 * module function rather than a closure in the component: these mutate globals, which is exactly what a
 * render must not do, and keeping them out here is the honest way to say they only run from an event.
 */
function applyTheme(value: PublicTheme, cookieName: string, cookieMaxAge: number): void {
  document.documentElement.dataset["theme"] = value;
  // `secure` is read from the page rather than passed in: the server knows its deployment mode, but the
  // browser knows whether *this* page arrived over TLS, and a `secure` cookie set on plain http is
  // silently dropped — which would make the choice survive the click and not the reload.
  const secure = window.location.protocol === "https:" ? "; secure" : "";
  document.cookie = `${cookieName}=${value}; path=/; max-age=${String(cookieMaxAge)}; samesite=lax${secure}`;
}

export interface ThemeOption {
  readonly value: PublicTheme;
  /** The accessible name — a word from the catalogue, because the icon is not readable aloud. */
  readonly label: string;
  /** A sun or a moon. Decorative and `aria-hidden`; `label` is what is announced. */
  readonly icon: ReactNode;
  /** `choosePublicThemeAction` bound to this option and the page's own path. */
  readonly action: () => Promise<void>;
}

export interface ThemeSwitchProps {
  readonly groupLabel: string;
  readonly stored: PublicTheme | undefined;
  readonly options: readonly ThemeOption[];
  readonly cookieName: string;
  readonly cookieMaxAge: number;
}

export function ThemeSwitch({ groupLabel, stored, options, cookieName, cookieMaxAge }: ThemeSwitchProps) {
  const [chosen, setChosen] = useState<PublicTheme | undefined>(stored);
  const system = useSyncExternalStore(subscribeToSystemTheme, readSystemTheme, readSystemThemeOnServer);
  // A choice wins over the system; with no choice, the system *is* the answer — and on the server, where
  // the system cannot be read, the answer is "neither", which the stylesheet renders rather than guesses.
  const active = chosen ?? system;

  return (
    <div
      className="switch"
      role="group"
      aria-label={groupLabel}
      {...(chosen === undefined ? { "data-following-system": "true" } : {})}
    >
      {options.map((option) => (
        <form action={option.action} key={option.value}>
          <button
            className="switch-option switch-icon"
            type="submit"
            aria-pressed={active === option.value}
            aria-label={option.label}
            data-public-theme={option.value}
            onClick={(event) => {
              event.preventDefault();
              applyTheme(option.value, cookieName, cookieMaxAge);
              setChosen(option.value);
            }}
          >
            {option.icon}
          </button>
        </form>
      ))}
    </div>
  );
}
