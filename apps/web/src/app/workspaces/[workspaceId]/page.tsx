/**
 * Business Profile selection inside one workspace (DATA_MODEL.md v0.4).
 *
 * `listAuthorizedBusinessProfiles` returns only the profiles this membership covers — a SELECTED-scope
 * member sees their grants and not the workspace's whole list — so the page renders what it is given
 * rather than deciding visibility itself.
 */
import Link from "next/link";
import { listAuthorizedBusinessProfiles } from "@omnichannel/db";

import { workspacePickerText } from "@/ui/labels";
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

  return (
    <main className="shell-main">
      <div className="page-header">
        <h1>{workspacePickerText.profilesTitle}</h1>
        <Link href="/workspaces">{workspacePickerText.title}</Link>
      </div>
      {profiles.length === 0 ? <p>{workspacePickerText.profilesEmpty}</p> : undefined}
      <ul className="card-grid" style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {profiles.map((profile) => (
          <li className="card" key={profile.businessProfileId}>
            <h2 style={{ margin: "0 0 4px", fontSize: "1.1rem" }}>
              <Link href={`/workspaces/${workspaceId}/profiles/${profile.businessProfileId}`}>{profile.name}</Link>
            </h2>
            <p>
              <span className="badge" data-tone={profile.status === "ACTIVE" ? "ok" : "warn"}>
                {workspacePickerText.statusLabel(profile.status)}
              </span>
            </p>
          </li>
        ))}
      </ul>
    </main>
  );
}
