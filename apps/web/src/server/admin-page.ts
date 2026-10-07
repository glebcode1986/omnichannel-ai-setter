/**
 * Authorization and the translator around the console's own assembly (#59).
 *
 * The one place `/admin` becomes an authorized request. Every page under that tree goes through one of
 * these loaders, and `route-authorization.test.ts` walks the route tree and fails the build for an admin
 * page that does not reach `requirePlatformContext` — because this app has no middleware and a forgotten
 * call in one file would be an unauthenticated internal console page nothing else notices.
 *
 * No customer resolver appears here, and the same test asserts that: an operator holding a
 * `WorkspaceContext` would hold customer OWNER authority, which is the one thing the separate brand
 * exists to prevent.
 */
import { requestTranslator } from "@/i18n/request-locale";
import type { Translator } from "@/i18n/translate";
import {
  assembleAdminAudit,
  assembleAdminConversation,
  assembleAdminHome,
  assembleAdminWorkspace,
  type AdminAuditData,
  type AdminConversationData,
  type AdminHomeData,
  type AdminWorkspaceData,
} from "@/server/admin-screen";
import { getDb } from "@/server/db";
import type { RawSearchParams } from "@/server/inbox-view";
import { requirePlatformContext } from "@/server/request-context";

export const ADMIN_BASE_PATH = "/admin";

export async function loadAdminHome(searchParams: RawSearchParams): Promise<AdminHomeData & { readonly t: Translator }> {
  const context = await requirePlatformContext();
  const t = await requestTranslator();
  return { t, ...(await assembleAdminHome(getDb(), context, searchParams, ADMIN_BASE_PATH)) };
}

export async function loadAdminWorkspace(workspaceId: string): Promise<AdminWorkspaceData & { readonly t: Translator }> {
  const context = await requirePlatformContext();
  const t = await requestTranslator();
  return { t, ...(await assembleAdminWorkspace(getDb(), context, workspaceId, `${ADMIN_BASE_PATH}/workspaces/${workspaceId}`)) };
}

export async function loadAdminConversation(
  workspaceId: string,
  businessProfileId: string,
  conversationId: string,
): Promise<AdminConversationData & { readonly t: Translator }> {
  const context = await requirePlatformContext();
  const t = await requestTranslator();
  return {
    t,
    ...(await assembleAdminConversation(
      getDb(),
      context,
      { workspaceId, businessProfileId, conversationId },
      `${ADMIN_BASE_PATH}/workspaces/${workspaceId}`,
    )),
  };
}

export async function loadAdminAudit(searchParams: RawSearchParams): Promise<AdminAuditData & { readonly t: Translator }> {
  const context = await requirePlatformContext();
  const t = await requestTranslator();
  return { t, ...(await assembleAdminAudit(getDb(), context, searchParams, `${ADMIN_BASE_PATH}/audit`)) };
}
