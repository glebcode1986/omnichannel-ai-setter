import "./globals.css";

import type { Metadata } from "next";
import type { ReactNode } from "react";

import { requestLocale } from "@/i18n/request-locale";

export const metadata: Metadata = {
  title: "Omnichannel AI Setter",
  description: "Instagram and WhatsApp AI setter workspace",
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
