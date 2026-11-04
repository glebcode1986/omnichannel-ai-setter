/**
 * The published terms-of-service, at a stable public address (#121).
 *
 * Deliberately unauthenticated: it is linked from the landing page's footer and has to be readable by
 * somebody who has no account — which is most of the people a legal document is written for. It
 * authorizes nothing and reads no tenant data.
 */
import type { Metadata } from "next";
import { cookies } from "next/headers";

import { createTranslator } from "@/i18n/translate";
import { PUBLIC_LOCALE_COOKIE, publicLocaleOf } from "@/server/public-locale";
import { loadLegalDocument } from "@/server/legal-view";
import { LegalPage } from "@/ui/legal/legal-page";

async function publicTranslator() {
  const store = await cookies();
  return createTranslator(publicLocaleOf(store.get(PUBLIC_LOCALE_COOKIE)?.value));
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await publicTranslator();
  return { title: t.t("legal.termsTitle") };
}

export default async function Page() {
  const store = await cookies();
  const locale = publicLocaleOf(store.get(PUBLIC_LOCALE_COOKIE)?.value);
  return <LegalPage document={loadLegalDocument("terms-of-service", locale)} t={createTranslator(locale)} />;
}
