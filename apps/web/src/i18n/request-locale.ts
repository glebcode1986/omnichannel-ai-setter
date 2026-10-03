/**
 * The reader's locale, for one server request (LOCALIZATION.md, Issue #58).
 *
 * Read from the signed-in user's own preference, which is the only place it lives. Not from the workspace,
 * not from the Business Profile, and not from the conversation: those decide what language *customers* are
 * answered in, and borrowing one for the other is the defect this whole feature is arranged to prevent.
 *
 * A request with no session still gets a translator. Sign-in and error screens have to be readable, and
 * falling back is the right answer rather than a reason to fail.
 */
import { auth } from "@/auth";
import { getDb } from "@/server/db";
import { getLogger } from "@/server/logger";

import { FALLBACK_LOCALE, resolveUiLocale, type UiLocale } from "./locales";
import { createTranslator, type Translator } from "./translate";

export async function requestLocale(): Promise<UiLocale> {
  const userId = (await auth())?.user?.id;
  if (userId === undefined || userId === "") {
    return FALLBACK_LOCALE;
  }
  const user = await getDb().user.findUnique({ where: { id: userId }, select: { uiLocale: true } });
  return resolveUiLocale(user?.uiLocale);
}

/** A translator for this request, reporting missing keys through the deployment's own logger. */
export async function requestTranslator(): Promise<Translator> {
  return createTranslator(await requestLocale(), {
    onMiss: (event, fields) => {
      getLogger().warn(event, fields);
    },
  });
}
