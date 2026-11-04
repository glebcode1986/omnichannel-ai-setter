import { readFileSync } from "node:fs";
import path from "node:path";

import { ImageResponse } from "next/og";

import { FALLBACK_LOCALE } from "@/i18n/locales";
import { createTranslator } from "@/i18n/translate";

/**
 * The card a shared link unfurls into, in a messenger or a social post.
 *
 * Without one, a link to this product arrives as a bare line of text — which is how it would have
 * reached every person the owner sends it to. Generated here rather than drawn and committed as a PNG,
 * so the mark and the wording cannot drift from the page they describe: both are read from the same
 * source the site uses.
 *
 * Every word comes from the catalogue rather than a literal, for two reasons that happen to agree. The
 * i18n gate forbids user-facing text outside it and caught this file when the strings were inline — and
 * it was right to: a card that quotes the page has to keep quoting it after the page changes.
 *
 * Fixed to the fallback locale, deliberately. One route renders one image, so a card cannot follow a
 * reader's language; and `ImageResponse` renders through Satori, which needs every glyph covered by a
 * font it has been handed, while Next bundles one with Latin coverage and no Cyrillic. English is not a
 * compromise here — it is what an anonymous reader already sees, since the locale resolver falls back to
 * it for somebody with no stored preference.
 */
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "KeepSayBot — every customer answered, nothing sent without you";

/**
 * The mark, inlined as a data URI.
 *
 * Satori does not resolve a relative image path, and it ignores the `prefers-color-scheme` rules the
 * favicon carries, so the colours are fixed here to the dark card's palette rather than inherited.
 */
function markDataUri(): string {
  const icon = readFileSync(path.join(process.cwd(), "src/app/icon.svg"), "utf8");
  const flat = icon
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/<style>[\s\S]*?<\/style>/gu, "")
    .replace(/class="b"/gu, 'fill="#7AA2FF"')
    .replace(/class="e"/gu, 'fill="#0B0E13"');
  return `data:image/svg+xml;base64,${Buffer.from(flat).toString("base64")}`;
}

export default function OpengraphImage() {
  const t = createTranslator(FALLBACK_LOCALE);

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#0B0E13",
          padding: 72,
          // Satori has no cascade of its own worth relying on; the family is stated where it is used.
          fontFamily: "Geist, sans-serif",
          color: "#EEF1F5",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- Satori renders <img>, not next/image. */}
          <img src={markDataUri()} width={64} height={64} alt="" />
          <span style={{ fontSize: 38, fontWeight: 700, letterSpacing: -0.5 }}>{t.t("landing.title")}</span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <span style={{ fontSize: 68, fontWeight: 600, lineHeight: 1.1, letterSpacing: -1.5, maxWidth: 940 }}>
            {t.t("landing.headline")}
          </span>
          <span style={{ fontSize: 30, color: "#A6B0BD", maxWidth: 900, lineHeight: 1.4 }}>
            {t.t("landing.lead")}
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 18, fontSize: 26, color: "#A6B0BD" }}>
          <span>{t.t("channel.INSTAGRAM")}</span>
          <span style={{ color: "#3A424F" }}>·</span>
          <span>{t.t("channel.WHATSAPP")}</span>
        </div>
      </div>
    ),
    size,
  );
}
