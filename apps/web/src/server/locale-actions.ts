"use server";

/**
 * Changing the interface language (Issue #58).
 *
 * The preference belongs to the signed-in user and to nobody else: there is no workspace parameter here,
 * and there could not be one. An operator's reading language is not a property of a business, and a
 * surface that let it be set per workspace would be inviting exactly the coupling LOCALIZATION.md exists
 * to prevent.
 *
 * The value is resolved through `resolveUiLocale`, so a tampered form cannot store a locale the product
 * does not have.
 */
import { revalidatePath } from "next/cache";

import { auth } from "@/auth";
import { getDb } from "@/server/db";
import { resolveUiLocale } from "@/i18n/locales";

export async function setUiLocaleAction(formData: FormData): Promise<void> {
  const userId = (await auth())?.user?.id;
  if (userId === undefined || userId === "") {
    // Nothing to store a preference against. Silently doing nothing is right: this is a preference, and a
    // signed-out request has no business writing one.
    return;
  }
  const requested = formData.get("locale");
  const locale = resolveUiLocale(typeof requested === "string" ? requested : undefined);
  await getDb().user.update({ where: { id: userId }, data: { uiLocale: locale } });
  // The whole shell re-renders in the new language, including the parts this page does not own.
  revalidatePath("/", "layout");
}
