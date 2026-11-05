/**
 * The public sign-in surface (#117, ADR-022).
 *
 * A component rather than markup in the route, for the reason `add-example-form.tsx` states: a route
 * component is the one thing a test in this app cannot call, and controls that went missing went missing
 * there. This one has more to get wrong than most — two methods, each of which may be withheld, and five
 * notices — so it is tested directly.
 *
 * A **server** component, because a `Translator` carries functions and cannot cross into a client
 * component, and because nothing here needs the browser: each control is a form submitting to a server
 * action. No client bundle, no provider SDK, no inline colour.
 *
 * It offers exactly what the server will accept. `available` comes from `availableSignInMethods`, the
 * same answer `auth.ts` builds its providers from, so a withheld method is absent from both — and when
 * neither is on offer the panel says so rather than rendering a form that cannot work.
 *
 * It wears the public surface's own classes rather than the product shell's. It used to borrow
 * `page-header` and `knowledge-editor`, which belong to screens that sit inside a signed-in layout with a
 * sidebar and a content column — so without that layout the page had nothing holding it: a heading
 * against the left edge of a 1920px window, a rule running the full width, and the language switch
 * reading as a section of the page rather than a small choice at the bottom of it. Nobody arrives here
 * having seen the product; this is the second screen of the landing page and now looks like it.
 */
import Link from "next/link";
import type { ReactNode } from "react";

import type { Translator } from "@/i18n/translate";
import type { SignInMethod } from "@/server/sign-in-methods";
import { signInNotice, signInNoticeKey } from "@/server/sign-in-view";
import { Mark } from "@/ui/landing/mark";

export interface SignInPanelProps {
  readonly t: Translator;
  readonly available: readonly SignInMethod[];
  /** The raw `?error=` value, mapped here rather than by the route. */
  readonly error?: string | undefined;
  readonly googleAction: () => Promise<void>;
  readonly emailAction: (formData: FormData) => Promise<void>;
  /**
   * The public surface's language and appearance controls, passed in rather than built here.
   *
   * This panel used to own a language switch of its own, which offered only the language the reader was
   * *not* reading in. That is a reasonable control on its own and the wrong one to have twice: the same
   * choice now sits on all four public pages, shows both options and marks the live one, so a reader
   * meets one control and not two dialects of it.
   */
  readonly controls: ReactNode;
}

export function SignInPanel({ t, available, error, googleAction, emailAction, controls }: SignInPanelProps) {
  const notice = signInNotice(error);
  const nothingOnOffer = available.length === 0;

  return (
    <div className="auth-column">
      {/* The way back. Somebody who followed a link here and wants to read what this is first should not
          have to edit the address bar to do it. */}
      <Link className="auth-brand" href="/">
        <Mark title={t.t("landing.title")} className="auth-mark" />
        <span>{t.t("landing.title")}</span>
      </Link>

      <div className="auth-card">
        <h1>{nothingOnOffer ? t.t("signIn.unavailableTitle") : t.t("signIn.title")}</h1>

        {notice === undefined ? undefined : (
          <p className="notice" role="status" data-sign-in-notice={notice} data-tone="stop">
            {t.t(signInNoticeKey(notice))}
          </p>
        )}

        {nothingOnOffer ? (
          <p className="auth-lede" data-sign-in="unavailable">
            {t.t("signIn.unavailableBody")}
          </p>
        ) : (
          <>
            <p className="auth-lede">{t.t("signIn.subtitle")}</p>

            {available.includes("google") ? (
              <form action={googleAction} data-sign-in="google">
                <button className="button primary auth-submit" type="submit" data-action="sign-in-google">
                  {t.t("signIn.google")}
                </button>
              </form>
            ) : undefined}

            {/* Both on offer is two ways to do one thing, and the reader has to be told they are
                alternatives rather than steps. */}
            {available.length > 1 ? (
              <p className="auth-or">
                <span>{t.t("signIn.or")}</span>
              </p>
            ) : undefined}

            {available.includes("email") ? (
              <form action={emailAction} className="auth-form" data-sign-in="email">
                <label htmlFor="sign-in-email">{t.t("signIn.emailLabel")}</label>
                <input id="sign-in-email" name="email" type="email" autoComplete="email" required maxLength={320} />
                <button className="button auth-submit" type="submit" data-action="sign-in-email">
                  {t.t("signIn.emailSubmit")}
                </button>
                <p className="auth-hint">{t.t("signIn.emailHint")}</p>
              </form>
            ) : undefined}
          </>
        )}
      </div>

      {nothingOnOffer ? undefined : <p className="auth-status">{t.t("landing.status")}</p>}

      {controls}
    </div>
  );
}
