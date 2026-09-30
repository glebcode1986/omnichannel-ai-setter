/**
 * A conversation id that is not this profile's (Issue #28).
 *
 * The store returns `undefined` rather than throwing for that case, and this is the other half of that
 * decision: a bookmarked id from a profile someone has lost access to reads as "not here", which is also
 * all it should say. Confirming that the row exists elsewhere would be a small, free tenancy oracle.
 */
import Link from "next/link";

import { requestTranslator } from "@/i18n/request-locale";

export default async function ConversationNotFound() {
  const t = await requestTranslator();

  return (
    <div className="notice">
      <p>{t.t("inbox.notFound")}</p>
      <Link href="..">{t.t("inbox.backToList")}</Link>
    </div>
  );
}
