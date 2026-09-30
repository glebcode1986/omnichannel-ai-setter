import { redirect } from "next/navigation";

import { requireBusinessProfileContext } from "@/server/request-context";
import { getDb } from "@/server/db";

/**
 * Where a profile opens.
 *
 * A profile still in setup opens on its setup page, because that is the only thing a half-configured
 * workspace can usefully do; a live one opens on the Inbox, which PRODUCT_UX.md names as where a connected
 * workspace should spend most of its time.
 */
export default async function ProfileHomePage({
  params,
}: {
  readonly params: Promise<{ readonly workspaceId: string; readonly businessProfileId: string }>;
}) {
  const { workspaceId, businessProfileId } = await params;
  await requireBusinessProfileContext(workspaceId, businessProfileId);
  const profile = await getDb().businessProfile.findUniqueOrThrow({
    where: { workspaceId_id: { workspaceId, id: businessProfileId } },
    select: { status: true },
  });
  const basePath = `/workspaces/${workspaceId}/profiles/${businessProfileId}`;
  redirect(profile.status === "SETUP" ? `${basePath}/setup` : `${basePath}/inbox`);
}
