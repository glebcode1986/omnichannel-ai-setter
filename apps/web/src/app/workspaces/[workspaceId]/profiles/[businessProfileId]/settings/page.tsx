import { placeholderText } from "@/ui/labels";
import { requireBusinessProfileContext } from "@/server/request-context";

/**
 * Settings placeholder.
 *
 * The contract for this task allows only the placeholders navigation needs, and forbids implementing the
 * feature surfaces that later tasks own. It still authorizes the request: a page that rendered without
 * checking would be a workspace-scoped URL anyone could open.
 */
export default async function SettingsPage({
  params,
}: {
  readonly params: Promise<{ readonly workspaceId: string; readonly businessProfileId: string }>;
}) {
  const { workspaceId, businessProfileId } = await params;
  await requireBusinessProfileContext(workspaceId, businessProfileId);

  return (
    <>
      <div className="page-header">
        <h1>Settings</h1>
      </div>
      <p>{placeholderText.comingSoon("Settings")}</p>
      <p className="muted">{placeholderText.navigationOnly}</p>
    </>
  );
}
