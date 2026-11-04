import "./globals.css";

import type { Metadata } from "next";
import type { ReactNode } from "react";

import { requestLocale } from "@/i18n/request-locale";

/**
 * The product's public name, confirmed by the owner on 2026-11-04 as a brand decision separate from the
 * hostname. It lives here and in `landing.title`; the repository's own documents still carry the working
 * name, which is a rename of its own and not this file's business.
 */
export const metadata: Metadata = {
  title: "KeepSayBot",
  description: "Answer Instagram and WhatsApp customers with drafts in your own words, approved by you or sent on autopilot.",
};

/**
 * The document's language is the reader's, not a constant.
 *
 * `lang` is what a screen reader chooses a voice from and what hyphenation and quotation rules follow, so
 * a Russian interface inside `lang="en"` is announced in an English voice. It is also the only place a
 * client component can read the locale from: an error boundary is rendered by React with props we do not
 * control, so it cannot be handed a translator.
 */
export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const locale = await requestLocale();

  return (
    <html lang={locale}>
      <body>{children}</body>
    </html>
  );
}
