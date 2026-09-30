/**
 * Business Profile selection inside one workspace (DATA_MODEL.md v0.4).
 *
 * `listAuthorizedBusinessProfiles` returns only the profiles this membership covers — a SELECTED-scope
 * member sees their grants and not the workspace's whole list — so the page renders what it is given
 * rather than deciding visibility itself.
 */
import Link from "next/link";
import { listAuthorizedBusinessProfiles } from "@omnichannel/db";

import { requestTranslator } from "@/i18n/request-locale";
import type { MessageKey } from "@/i18n/catalogue";
import { getDb } from "@/server/db";
import { requireWorkspaceContext } from "@/server/request-context";

export default async function WorkspacePage({
  params,
}: {
  readonly params: Promise<{ readonly workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const context = await requireWorkspaceContext(workspaceId);
  const profiles = await listAuthorizedBusinessProfiles(getDb(), context);
  const t = await requestTranslator();

  return (
    <main className="shell-main">
      <div className="page-header">
        <h1>{t.t("workspaces.profilesTitle")}</h1>
        <Link href="/workspaces">{t.t("workspaces.title")}</Link>
      </div>
      {profiles.length === 0 ? <p>{t.t("workspaces.profilesEmpty")}</p> : undefined}
      <ul className="card-grid" style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {profiles.map((profile) => (
          <li className="card" key={profile.businessProfileId}>
            <h2 style={{ margin: "0 0 4px", fontSize: "1.1rem" }}>
              <Link href={`/workspaces/${workspaceId}/profiles/${profile.businessProfileId}`}>{profile.name}</Link>
            </h2>
            <p>
              <span className="badge" data-tone={profile.status === "ACTIVE" ? "ok" : "warn"}>
                {t.t(`profileStatus.${profile.status}` as MessageKey)}
              </span>
            </p>
          </li>
        ))}
      </ul>
    </main>
  );
}
