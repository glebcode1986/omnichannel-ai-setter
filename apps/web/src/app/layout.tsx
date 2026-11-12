import "./globals.css";

import type { Metadata } from "next";
import { Geist } from "next/font/google";
import { cookies } from "next/headers";
import type { ReactNode } from "react";

import { signedInLocale } from "@/i18n/request-locale";
import { publicLocaleOf, PUBLIC_LOCALE_COOKIE } from "@/server/public-locale";
import { publicThemeOf, PUBLIC_THEME_COOKIE } from "@/server/public-theme";

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
 *
 * The branch this layout's locale and colour-scheme handling came from also replaces this typeface and
 * renames the token to `--font-ui`. That is deliberately left behind: every selector in `globals.css`
 * reads `--font-geist`, so the rename is a product-wide typography change, and this slice is the
 * onboarding journeys.
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
 *
 * Two sources, in order, because there are two kinds of reader. A signed-in one has a stored preference
 * and it wins. Anyone else may have chosen a language on the public surface, and that choice is what the
 * public pages render in — so it has to be what `lang` says. This used to be `requestLocale()` alone,
 * which falls back to English for anybody with no session: the landing page rendered Russian prose and
 * announced it as English. The *cookie* is read here rather than the page's resolved locale because a
 * layout cannot see what its children resolved, and both read the same cookie through the same function.
 *
 * The colour scheme is resolved here for one reason: it has to be in the first byte. `data-theme` is
 * absent when the reader has not chosen, and the stylesheet's `prefers-color-scheme` query decides —
 * which is why the attribute is left off rather than filled in with a guess. `color-scheme` follows it so
 * that form controls, scrollbars and the canvas behind the page agree with the palette; `light dark`
 * means "whatever the system says", which is exactly the no-choice case.
 */
export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const store = await cookies();
  const locale = (await signedInLocale()) ?? publicLocaleOf(store.get(PUBLIC_LOCALE_COOKIE)?.value);
  const theme = publicThemeOf(store.get(PUBLIC_THEME_COOKIE)?.value);

  return (
    <html
      lang={locale}
      className={geist.variable}
      {...(theme === undefined ? {} : { "data-theme": theme })}
      style={{ colorScheme: theme ?? "light dark" }}
    >
      <body>{children}</body>
    </html>
  );
}
