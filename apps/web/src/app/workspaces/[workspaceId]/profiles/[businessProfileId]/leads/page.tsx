import { placeholderText } from "@/ui/labels";
import { requireBusinessProfileContext } from "@/server/request-context";

/**
 * Leads placeholder.
 *
 * The contract for this task allows only the placeholders navigation needs, and forbids implementing the
 * feature surfaces that later tasks own. It still authorizes the request: a page that rendered without
 * checking would be a workspace-scoped URL anyone could open.
 */
export default async function LeadsPage({
  params,
}: {
  readonly params: Promise<{ readonly workspaceId: string; readonly businessProfileId: string }>;
}) {
  const { workspaceId, businessProfileId } = await params;
  await requireBusinessProfileContext(workspaceId, businessProfileId);

  return (
    <>
      <div className="page-header">
        <h1>Leads</h1>
      </div>
      <p>{placeholderText.comingSoon("Leads")}</p>
      <p className="muted">{placeholderText.navigationOnly}</p>
    </>
  );
}
