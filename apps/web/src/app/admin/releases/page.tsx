/**
 * The release record (#60, LAUNCH_READINESS.md §20).
 *
 * Read-only, and that is the whole design: a release is recorded by `pnpm release:record` against an
 * exact SHA from a clean working tree, and a console button that could record one would be a release
 * decision taken without a commit in hand. What an operator needs here is to see which stage the send
 * path is actually using — the allowlist half of §18 is on the workspace screen, beside the profiles it
 * applies to.
 */
import { ReleaseHistory } from "@/ui/admin/release-history";
import { ADMIN_BASE_PATH, loadAdminReleases } from "@/server/admin-page";

export const dynamic = "force-dynamic";

export default async function AdminReleasesPage() {
  const data = await loadAdminReleases();
  const { t } = data;

  return (
    <div className="stack">
      <div className="page-header">
        <h1>{t.t("admin.releasesTitle")}</h1>
        <a className="button" href={ADMIN_BASE_PATH} data-action="back-to-admin">
          {t.t("admin.title")}
        </a>
      </div>

      <ReleaseHistory t={t} inForce={data.inForce} candidates={data.candidates} />
    </div>
  );
}
