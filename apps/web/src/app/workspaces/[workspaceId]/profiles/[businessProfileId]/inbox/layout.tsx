/**
 * The Inbox's heading, which is the one thing both of its screens had no way to get (Issue #35).
 *
 * The list and the thread each draw three `<h2>` panes -- the conversation list, the thread and the
 * context rail -- and nothing above them. Every other screen in the console opens at `<h1>`; these two
 * were the only ones whose outline began at level two, so a reader arriving here was handed three sibling
 * sections and no name for the page holding them.
 *
 * It lives in a layout rather than in the two routes because Next renders `loading.tsx` and `error.tsx`
 * *instead of* `page.tsx`'s subtree. A heading written in the route file would be absent while the first
 * page is being read and absent again if that read failed -- the two moments a reader is most lost. A
 * layout sits outside the Suspense boundary, so the heading is there in all three states.
 *
 * Hidden rather than drawn: the bar already names the workspace and the profile, and each pane draws its
 * own title, so a second visible heading would tell a sighted reader nothing new. `visually-hidden` is
 * `position: absolute`, so it takes no part in the Inbox's grid.
 */
import type { ReactNode } from "react";

import { requestTranslator } from "@/i18n/request-locale";

export default async function InboxLayout({ children }: { readonly children: ReactNode }) {
  const t = await requestTranslator();

  return (
    <>
      <h1 className="visually-hidden">{t.t("inbox.title")}</h1>
      {children}
    </>
  );
}
