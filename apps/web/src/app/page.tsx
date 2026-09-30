import Link from "next/link";

import { requestTranslator } from "@/i18n/request-locale";

/**
 * The product's front door.
 *
 * It said "Phase 1 scaffold. Dashboard, auth and webhook routes are added by later issues." until the
 * dashboard existed, which it now does — so the page says what the product is and offers the way in. Its
 * text is localized like every other surface: this is the first page a person sees, and English prose
 * here would be the most visible place to leave some.
 */
export default async function HomePage() {
  const t = await requestTranslator();

  return (
    <main className="shell-main">
      <div className="page-header">
        <h1>{t.t("landing.title")}</h1>
      </div>
      <p>{t.t("landing.lead")}</p>
      <p>
        <Link className="button" data-variant="primary" href="/workspaces">
          {t.t("landing.openWorkspaces")}
        </Link>
      </p>
    </main>
  );
}
