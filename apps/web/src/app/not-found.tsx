/**
 * What a refused page render looks like, and the reason it is this page rather than a "forbidden" one.
 *
 * Reached two ways. Next renders it for a URL that matches no route, and `page-context.ts` renders it on
 * purpose for a Workspace, Business Profile or platform console the reader may not see — mapping the
 * access-denied errors here rather than to a 403 because that is the answer this codebase already chose
 * and wrote down: `instagram-routes.ts` returns `404` for exactly these, noting that *whether a Workspace
 * or account exists is itself information*. Saying "forbidden" would confirm the row to somebody who may
 * not have it confirmed.
 *
 * The wording therefore has to carry that refusal honestly without undoing it. "Either it does not exist,
 * or it is not yours, and we do not say which" is the whole posture in one sentence: a reader who
 * genuinely mistyped is not misled, and a reader probing for existence learns nothing.
 *
 * A server component, unlike the Inbox's own `not-found.tsx`, which is a client one because it rebuilds a
 * path from `usePathname`. This one needs no path: the way back is the workspace chooser, which is the
 * one place every reader can reach. `requestTranslator()` works without a session by design — its header
 * says error screens have to be readable — so this renders in the reader's language whether or not they
 * are signed in.
 */
import Link from "next/link";

import { requestTranslator } from "@/i18n/request-locale";

export default async function NotFound() {
  const t = await requestTranslator();

  return (
    <main className="shell-main">
      <div className="page-header">
        <h1>{t.t("notFound.title")}</h1>
      </div>
      <p className="muted">{t.t("notFound.body")}</p>
      <p>
        <Link href="/workspaces">{t.t("notFound.back")}</Link>
      </p>
    </main>
  );
}
