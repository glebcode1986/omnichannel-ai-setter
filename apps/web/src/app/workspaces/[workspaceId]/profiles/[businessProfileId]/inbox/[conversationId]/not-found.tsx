"use client";

/**
 * A conversation id that is not this profile's (Issue #28).
 *
 * The store returns `undefined` rather than throwing for that case, and this is the other half of that
 * decision: a bookmarked id from a profile someone has lost access to reads as "not here", which is also
 * all it should say. Confirming that the row exists elsewhere would be a small, free tenancy oracle.
 *
 * A client component because Next hands `not-found.tsx` no params, and the way back to the list is the
 * current path without its last segment. Hard-coding a relative `..` in a router link does not resolve
 * against the route, and guessing the workspace and profile ids is not possible here.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";

import { resolveUiLocale } from "@/i18n/locales";
import { createTranslator } from "@/i18n/translate";

export default function ConversationNotFound() {
  const pathname = usePathname();
  const t = createTranslator(resolveUiLocale(typeof document === "undefined" ? undefined : document.documentElement.lang));
  const listPath = pathname.slice(0, pathname.lastIndexOf("/"));

  return (
    <div className="notice">
      <p>{t.t("inbox.notFound")}</p>
      <Link href={listPath === "" ? "/workspaces" : listPath}>{t.t("inbox.backToList")}</Link>
    </div>
  );
}
