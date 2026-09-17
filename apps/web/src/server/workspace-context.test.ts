import { WorkspaceAccessDeniedError, type DbExecutor } from "@omnichannel/db";
import { describe, expect, it, vi } from "vitest";

import { resolveWorkspaceContext, UnauthenticatedError } from "./workspace-context";

function dependencies(userId: string | undefined, memberRole: "OWNER" | "AGENT" | null) {
  const findUnique = vi.fn(() => Promise.resolve(memberRole === null ? null : { role: memberRole }));
  return {
    findUnique,
    deps: {
      getSessionUserId: () => Promise.resolve(userId),
      db: { workspaceMember: { findUnique } } as unknown as DbExecutor,
    },
  };
}

describe("resolveWorkspaceContext", () => {
  it("requires an authenticated session", async () => {
    const { deps, findUnique } = dependencies(undefined, "OWNER");
    await expect(resolveWorkspaceContext(deps, "ws_1")).rejects.toBeInstanceOf(UnauthenticatedError);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("requires an explicitly selected workspace instead of guessing one", async () => {
    const { deps, findUnique } = dependencies("user_1", "OWNER");
    await expect(resolveWorkspaceContext(deps, undefined)).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
    await expect(resolveWorkspaceContext(deps, "")).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("authorizes by membership of the selected workspace", async () => {
    const member = dependencies("user_1", "AGENT");
    await expect(resolveWorkspaceContext(member.deps, "ws_1")).resolves.toEqual({
      workspaceId: "ws_1",
      userId: "user_1",
      role: "AGENT",
    });

    const outsider = dependencies("user_1", null);
    await expect(resolveWorkspaceContext(outsider.deps, "ws_2")).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
  });
});
