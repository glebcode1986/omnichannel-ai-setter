import "./globals.css";

import type { Metadata } from "next";
import { Geist } from "next/font/google";
import type { ReactNode } from "react";

import { requestLocale } from "@/i18n/request-locale";

/**
 * One typeface for the whole product.
 *
 * Self-hosted by `next/font`, which downloads the files at build time and serves them from our own
 * origin: no request to a font CDN at runtime, so no third party learns who reads the page. `display:
 * swap` renders in the fallback immediately rather than holding the first paint, and the variable axis
 * means every weight the page uses costs one file.
 *
 * Exposed as a custom property rather than a class on `<body>`, because `globals.css` sets type on many
 * selectors and a wrapper class would lose to them; a token is read wherever the stylesheet asks.
 */
const geist = Geist({
  subsets: ["latin", "cyrillic"],
  display: "swap",
  variable: "--font-geist",
});

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
    <html lang={locale} className={geist.variable}>
      <body>{children}</body>
    </html>
  );
}
