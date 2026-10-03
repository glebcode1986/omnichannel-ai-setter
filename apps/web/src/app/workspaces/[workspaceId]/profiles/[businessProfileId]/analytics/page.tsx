import { requestTranslator } from "@/i18n/request-locale";
import { requireBusinessProfileContext } from "@/server/request-context";

/**
 * Analytics placeholder.
 *
 * The contract for P5-01 allows only the placeholders navigation needs, and forbids implementing the
 * feature surfaces later tasks own. It still authorizes the request — a page that rendered without
 * checking would be a workspace-scoped URL anyone could open — and it is localized, so the section that
 * replaces it inherits a page with no English left in it.
 */
export default async function AnalyticsPage({
  params,
}: {
  readonly params: Promise<{ readonly workspaceId: string; readonly businessProfileId: string }>;
}) {
  const { workspaceId, businessProfileId } = await params;
  await requireBusinessProfileContext(workspaceId, businessProfileId);
  const t = await requestTranslator();
  const section = t.t("nav.analytics");

  return (
    <>
      <div className="page-header">
        <h1>{section}</h1>
      </div>
      <p>{t.t("placeholder.comingSoon", { section })}</p>
      <p className="muted">{t.t("placeholder.navigationOnly")}</p>
    </>
  );
}
