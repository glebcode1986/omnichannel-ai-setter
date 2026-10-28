/**
 * "Check your email" — the page `pages.verifyRequest` names (#117).
 *
 * Public for the same reason the sign-in page is, and worded for one reason above all: **it must not say
 * whether the address has an account.** "If that address can be used to sign in, a link is on its way" is
 * the same sentence for a customer and for an address nobody has ever registered, and it is also what a
 * rate-limited request is answered with — so neither the page nor the response distinguishes them.
 */
import { cookies } from "next/headers";

import { createTranslator } from "@/i18n/translate";
import { publicLocaleOf, PUBLIC_LOCALE_COOKIE } from "@/server/public-locale";

export default async function SignInLinkSentPage() {
  const store = await cookies();
  const t = createTranslator(publicLocaleOf(store.get(PUBLIC_LOCALE_COOKIE)?.value));

  return (
    <main className="shell-main">
      <div className="page-header">
        <h1>{t.t("signIn.linkSentTitle")}</h1>
      </div>
      <p>{t.t("signIn.linkSentBody")}</p>
    </main>
  );
}
