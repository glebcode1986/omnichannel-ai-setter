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
import { cache } from "react";

import { auth } from "@/auth";
import { getDb } from "@/server/db";
import { getLogger } from "@/server/logger";

import { FALLBACK_LOCALE, resolveUiLocale, type UiLocale } from "./locales";
import { createTranslator, type Translator } from "./translate";

/**
 * Cached per request, not per call.
 *
 * The document element, the shell, a loading fallback and the page itself each need the locale, and
 * without this that is four session lookups and four user reads for one screen. `cache()` is request
 * scoped, so it dedupes within a render and never leaks one reader's locale into another's request.
 */
export const requestLocale = cache(async (): Promise<UiLocale> => (await signedInLocale()) ?? FALLBACK_LOCALE);

/**
 * The signed-in reader's own preference, or `undefined` when there is nobody to have one.
 *
 * Separated from `requestLocale` because the document element needs to tell those two cases apart and
 * nothing else does. `requestLocale` answers "which catalogue", and English is the right answer when
 * there is no user; `<html lang>` answers "which language is this text in", and English is the *wrong*
 * answer for a public page a reader has just switched to Russian. The two were the same function, so
 * every public page announced Russian prose as English to a screen reader — an English voice reading
 * Cyrillic. Callers who only want a catalogue keep using `requestLocale` and are unchanged.
 */
export const signedInLocale = cache(async (): Promise<UiLocale | undefined> => {
  const userId = (await auth())?.user?.id;
  if (userId === undefined || userId === "") {
    return undefined;
  }
  const user = await getDb().user.findUnique({ where: { id: userId }, select: { uiLocale: true } });
  return resolveUiLocale(user?.uiLocale);
});

/** A translator for this request, reporting missing keys through the deployment's own logger. */
export async function requestTranslator(): Promise<Translator> {
  return createTranslator(await requestLocale(), {
    onMiss: (event, fields) => {
      getLogger().warn(event, fields);
    },
  });
}
