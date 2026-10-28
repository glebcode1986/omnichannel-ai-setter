/**
 * What the sign-in page says about what just happened (#117).
 *
 * Pure, so the mapping can be checked against the error codes the installed version actually emits rather
 * than against the ones a tutorial mentions. Only eight `AuthError`s reach a page as themselves in this
 * version — `clientErrors` in `@auth/core/errors.ts` — and everything else is rewritten to
 * `Configuration`, so a page built against the longer v4-era unions would be explaining failures that
 * cannot arrive while missing the one that can.
 */
import type { MessageKey } from "@/i18n/catalogue";

/** The notices this page can show, each a different thing for the reader to do next. */
export type SignInNotice = "EXPIRED" | "NOT_LINKED" | "CANCELLED" | "EMAIL_REQUIRED" | "GENERIC";

/**
 * The notice for a `?error=` value.
 *
 * `OAuthAccountNotLinked` is the one worth naming precisely: offering two methods for one address makes
 * it the most likely failure in the whole flow, it lands on *this* page rather than the error page, and a
 * form that ignored it would simply appear not to work. `Verification` is a link that was already used or
 * has expired — in this version an expired click consumes the token, so "ask for a new one" is the only
 * true advice. An unknown or absent value produces no notice at all rather than a reassuring guess.
 */
export function signInNotice(error: string | undefined): SignInNotice | undefined {
  switch (error) {
    case undefined:
    case "":
      return undefined;
    case "Verification":
      return "EXPIRED";
    case "OAuthAccountNotLinked":
    case "AccountNotLinked":
      return "NOT_LINKED";
    case "AccessDenied":
      return "CANCELLED";
    case "EmailRequired":
      return "EMAIL_REQUIRED";
    default:
      // Including `Configuration`, which is what this version reports for every fault it will not
      // describe to a browser. The reader cannot act on the difference; the server log can.
      return "GENERIC";
  }
}

/** The catalogue key for a notice, so the page interpolates nothing and invents nothing. */
export function signInNoticeKey(notice: SignInNotice): MessageKey {
  switch (notice) {
    case "EXPIRED":
      return "signIn.errorLinkExpired";
    case "NOT_LINKED":
      return "signIn.errorNotLinked";
    case "CANCELLED":
      return "signIn.errorAccessDenied";
    case "EMAIL_REQUIRED":
      return "signIn.errorEmailRequired";
    case "GENERIC":
      return "signIn.errorGeneric";
  }
}

// There is deliberately no `isRefusal` here. Every notice this page can show means nothing was signed in,
// so a predicate would have exactly one answer — and a function that always returns true is a decision
// nobody is making, dressed as one.
