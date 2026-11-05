/**
 * The frame a published legal document is read in (#121).
 *
 * The public surface's frame rather than the product shell's, like the sign-in page: somebody reaches
 * this from a footer link having never signed in, and `.shell-main` is the content column of a layout
 * that is not above them.
 *
 * It states the document's status *before* the document. A reader who is told halfway down clause 15
 * that a value is still being settled has already read fourteen clauses believing the page was finished.
 */
import Link from "next/link";
import type { ReactNode } from "react";

import type { Translator } from "@/i18n/translate";
import type { ResolvedDocument } from "@/server/legal-content";
import { LegalDocument } from "@/ui/legal/legal-document";
import { Mark } from "@/ui/landing/mark";

export function LegalPage({
  document,
  t,
  controls,
}: {
  readonly document: ResolvedDocument;
  readonly t: Translator;
  /** The public surface's language and appearance controls — the same ones the landing page carries. */
  readonly controls: ReactNode;
}) {
  return (
    <main className="legal">
      <div className="legal-column">
        {/* The brand and the controls on one line. The brand link is sized to its own content: as a
            block it spanned the whole column, so a click on empty space to the right of the word left
            the document. */}
        <div className="legal-topbar">
          <Link className="auth-brand" href="/">
            <Mark title={t.t("landing.title")} className="auth-mark" />
            <span>{t.t("landing.title")}</span>
          </Link>
          {controls}
        </div>

        <p className="legal-dateline">
          <span>
            {t.t("legal.version")}
            {": "}
            {document.version === undefined ? "—" : String(document.version)}
          </span>
          <span>
            {t.t("legal.effective")}
            {": "}
            {document.effectiveDate ?? t.t("legal.undated")}
          </span>
        </p>

        <aside className="notice legal-notice" data-tone="warn" data-legal-unresolved={document.unresolved.length}>
          <strong>{t.t("legal.noticeTitle")}</strong>
          <p>{t.t("legal.noticeBody")}</p>
          {document.unresolved.length > 0 ? <p>{t.t("legal.noticeUnresolved")}</p> : undefined}
        </aside>

        <LegalDocument blocks={document.blocks} t={t} />

        <p className="legal-back">
          <Link href="/">{t.t("legal.backHome")}</Link>
        </p>
      </div>
    </main>
  );
}
