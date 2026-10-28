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
 */
import type { UiLocale } from "@/i18n/locales";
import { localeNames, UI_LOCALES } from "@/i18n/locales";
import type { Translator } from "@/i18n/translate";
import type { SignInMethod } from "@/server/sign-in-methods";
import { signInNotice, signInNoticeKey } from "@/server/sign-in-view";

export interface SignInPanelProps {
  readonly t: Translator;
  readonly locale: UiLocale;
  readonly available: readonly SignInMethod[];
  /** The raw `?error=` value, mapped here rather than by the route. */
  readonly error?: string | undefined;
  readonly googleAction: () => Promise<void>;
  readonly emailAction: (formData: FormData) => Promise<void>;
  readonly languageAction: (locale: string) => Promise<void>;
}

export function SignInPanel({ t, locale, available, error, googleAction, emailAction, languageAction }: SignInPanelProps) {
  const notice = signInNotice(error);
  const nothingOnOffer = available.length === 0;

  return (
    <>
      <div className="page-header">
        <h1>{nothingOnOffer ? t.t("signIn.unavailableTitle") : t.t("signIn.title")}</h1>
      </div>

      {notice === undefined ? undefined : (
        <p className="notice" role="status" data-sign-in-notice={notice} data-tone="stop">
          {t.t(signInNoticeKey(notice))}
        </p>
      )}

      {nothingOnOffer ? (
        <p data-sign-in="unavailable">{t.t("signIn.unavailableBody")}</p>
      ) : (
        <>
          <p>{t.t("signIn.subtitle")}</p>

          {available.includes("google") ? (
            <form action={googleAction} data-sign-in="google">
              <button className="button primary" type="submit" data-action="sign-in-google">
                {t.t("signIn.google")}
              </button>
            </form>
          ) : undefined}

          {available.includes("email") ? (
            <form action={emailAction} className="knowledge-editor" data-sign-in="email">
              <label htmlFor="sign-in-email">{t.t("signIn.emailLabel")}</label>
              <input id="sign-in-email" name="email" type="email" autoComplete="email" required maxLength={320} />
              <p className="muted">{t.t("signIn.emailHint")}</p>
              <button className="button" type="submit" data-action="sign-in-email">
                {t.t("signIn.emailSubmit")}
              </button>
            </form>
          ) : undefined}
        </>
      )}

      {/* The language of a surface read by people who have no stored preference yet. Each name is written
          in its own language, because somebody looking for Russian is looking for "Русский". */}
      <section>
        <h2>{t.t("signIn.languageLabel")}</h2>
        {UI_LOCALES.filter((option) => option !== locale).map((option) => (
          <form action={languageAction.bind(null, option)} key={option} data-sign-in-language={option}>
            <button className="button" type="submit">
              {localeNames[option]}
            </button>
          </form>
        ))}
      </section>
    </>
  );
}
