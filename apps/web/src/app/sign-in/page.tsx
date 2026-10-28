/**
 * The public sign-in and registration page (#117, ADR-022).
 *
 * Deliberately unauthenticated — it is what somebody who has no account reaches — and therefore listed in
 * `route-authorization.test.ts`'s allowlist with that reason. It authorizes nothing and reads no tenant
 * data: the only thing it knows is which sign-in methods this deployment can complete.
 *
 * Its own `<main className="shell-main">`, because there is no layout above a public page: the product
 * shell, its navigation and its skip link all live under the profile layout, and `.shell-main` works
 * standalone — which is what the landing page already relies on.
 */
import { cookies } from "next/headers";

import { createTranslator } from "@/i18n/translate";
import { loadWebEnv } from "@/env";
import { one } from "@/server/knowledge-view";
import type { RawSearchParams } from "@/server/inbox-view";
import { publicLocaleOf, PUBLIC_LOCALE_COOKIE } from "@/server/public-locale";
import { chooseSignInLanguageAction, requestSignInLinkAction, signInWithGoogleAction } from "@/server/sign-in-actions";
import { availableSignInMethods } from "@/server/sign-in-methods";
import { SignInPanel } from "@/ui/sign-in/sign-in-panel";

export default async function SignInPage({ searchParams }: { readonly searchParams: Promise<RawSearchParams> }) {
  const query = await searchParams;
  const store = await cookies();
  // The public surface's own language choice. `requestLocale()` reads a signed-in user's stored
  // preference and is right to fall back to English — but nobody reading this page has one yet.
  const locale = publicLocaleOf(store.get(PUBLIC_LOCALE_COOKIE)?.value);
  const t = createTranslator(locale);
  const methods = availableSignInMethods(loadWebEnv());
  const callbackUrl = one(query["callbackUrl"]);

  return (
    <main className="shell-main">
      <SignInPanel
        t={t}
        locale={locale}
        available={methods.available}
        error={one(query["error"])}
        googleAction={signInWithGoogleAction.bind(null, callbackUrl)}
        emailAction={requestSignInLinkAction.bind(null, callbackUrl)}
        languageAction={chooseSignInLanguageAction}
      />
    </main>
  );
}
