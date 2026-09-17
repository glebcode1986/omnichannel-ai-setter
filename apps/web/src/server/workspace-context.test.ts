import { BusinessProfileAccessDeniedError, WorkspaceAccessDeniedError, type DbExecutor } from "@omnichannel/db";
import { describe, expect, it, vi } from "vitest";

import { resolveBusinessProfileContext, resolveWorkspaceContext, UnauthenticatedError } from "./workspace-context";

function dependencies(
  userId: string | undefined,
  membership: { role: "OWNER" | "ADMIN" | "AGENT"; scope: "ALL" | "SELECTED"; grants?: string[] } | null,
) {
  const findMember = vi.fn(() =>
    Promise.resolve(
      membership === null
        ? null
        : {
            id: "member_1",
            role: membership.role,
            businessProfileScope: membership.scope,
            businessProfileAccess: (membership.grants ?? []).map((businessProfileId) => ({ businessProfileId })),
          },
    ),
  );
  const findProfile = vi.fn((args: { where: { workspaceId_id: { id: string } } }) =>
    Promise.resolve(["bp_1", "bp_2"].includes(args.where.workspaceId_id.id) ? { id: args.where.workspaceId_id.id } : null),
  );
  return {
    findMember,
    deps: {
      getSessionUserId: () => Promise.resolve(userId),
      db: { workspaceMember: { findUnique: findMember }, businessProfile: { findUnique: findProfile } } as unknown as DbExecutor,
    },
  };
}

describe("resolveWorkspaceContext", () => {
  it("requires an authenticated session", async () => {
    const { deps, findMember } = dependencies(undefined, { role: "OWNER", scope: "ALL" });
    await expect(resolveWorkspaceContext(deps, "ws_1")).rejects.toBeInstanceOf(UnauthenticatedError);
    expect(findMember).not.toHaveBeenCalled();
  });

  it("requires an explicitly selected workspace instead of guessing one", async () => {
    const { deps, findMember } = dependencies("user_1", { role: "OWNER", scope: "ALL" });
    await expect(resolveWorkspaceContext(deps, undefined)).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
    await expect(resolveWorkspaceContext(deps, "")).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
    expect(findMember).not.toHaveBeenCalled();
  });

  it("authorizes by membership of the selected workspace", async () => {
    await expect(resolveWorkspaceContext(dependencies("user_1", { role: "AGENT", scope: "SELECTED", grants: ["bp_1"] }).deps, "ws_1")).resolves.toMatchObject({
      workspaceId: "ws_1",
      userId: "user_1",
      role: "AGENT",
      businessProfileScope: { kind: "SELECTED", businessProfileIds: ["bp_1"] },
    });
    await expect(resolveWorkspaceContext(dependencies("user_1", null).deps, "ws_2")).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
  });
});

describe("resolveBusinessProfileContext", () => {
  it("requires an explicitly selected Business Profile instead of defaulting to one", async () => {
    const { deps, findMember } = dependencies("user_1", { role: "OWNER", scope: "ALL" });
    await expect(resolveBusinessProfileContext(deps, "ws_1", undefined)).rejects.toBeInstanceOf(BusinessProfileAccessDeniedError);
    await expect(resolveBusinessProfileContext(deps, "ws_1", "")).rejects.toBeInstanceOf(BusinessProfileAccessDeniedError);
    await expect(resolveBusinessProfileContext(deps, undefined, "bp_1")).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
    expect(findMember).not.toHaveBeenCalled();
  });

  it("authorizes only profiles inside the member's scope", async () => {
    const scoped = dependencies("user_1", { role: "AGENT", scope: "SELECTED", grants: ["bp_1"] });
    await expect(resolveBusinessProfileContext(scoped.deps, "ws_1", "bp_1")).resolves.toMatchObject({ businessProfileId: "bp_1" });
    await expect(resolveBusinessProfileContext(scoped.deps, "ws_1", "bp_2")).rejects.toBeInstanceOf(BusinessProfileAccessDeniedError);
    await expect(resolveBusinessProfileContext(dependencies(undefined, null).deps, "ws_1", "bp_1")).rejects.toBeInstanceOf(UnauthenticatedError);
  });
});
