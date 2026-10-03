/**
 * Workspace selection (Issue #27).
 *
 * The list comes from membership, so it is already the set this person may see; there is nothing to filter
 * client-side and nothing to guess. A person with one workspace still gets the page rather than a silent
 * redirect: "which business am I in" is a question the product should keep answering out loud, and an
 * automatic jump makes a second workspace appear out of nowhere the day one is added.
 */
import Link from "next/link";
import { listWorkspacesForUser } from "@omnichannel/db";

import { workspacePickerText } from "@/ui/labels";
import { auth } from "@/auth";
import { getDb } from "@/server/db";
import { UnauthenticatedError } from "@/server/workspace-context";

export default async function WorkspacesPage() {
  const userId = (await auth())?.user?.id;
  if (userId === undefined || userId === "") {
    throw new UnauthenticatedError();
  }
  const workspaces = await listWorkspacesForUser(getDb(), userId);

  return (
    <main className="shell-main">
      <div className="page-header">
        <h1>{workspacePickerText.title}</h1>
      </div>
      {workspaces.length === 0 ? <p>{workspacePickerText.empty}</p> : undefined}
      <ul className="card-grid" style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {workspaces.map((workspace) => (
          <li className="card" key={workspace.workspaceId}>
            <h2 style={{ margin: "0 0 4px", fontSize: "1.1rem" }}>
              <Link href={`/workspaces/${workspace.workspaceId}`}>{workspace.name}</Link>
            </h2>
            <p className="muted">{workspacePickerText.roleLabel(workspace.role)}</p>
          </li>
        ))}
      </ul>
    </main>
  );
}
