import { describe, expect, it, vi } from "vitest";

import type { DbExecutor } from "./client";
import { WorkspaceAccessDeniedError, WorkspacePermissionError } from "./errors";
import { authorizeWorkspaceAccess, requireWorkspaceRole, scopeOf, type WorkspaceContext } from "./tenancy";

function fakeDb(role: "OWNER" | "ADMIN" | "AGENT" | null) {
  const findUnique = vi.fn(() => Promise.resolve(role === null ? null : { role }));
  return { db: { workspaceMember: { findUnique } } as unknown as DbExecutor, findUnique };
}

describe("authorizeWorkspaceAccess", () => {
  it("issues a frozen context scoped to the requested membership", async () => {
    const { db, findUnique } = fakeDb("ADMIN");
    const context = await authorizeWorkspaceAccess(db, { userId: "user_1", workspaceId: "ws_1" });

    expect(findUnique).toHaveBeenCalledWith({
      where: { workspaceId_userId: { workspaceId: "ws_1", userId: "user_1" } },
      select: { role: true },
    });
    expect(context).toEqual({ workspaceId: "ws_1", userId: "user_1", role: "ADMIN" });
    expect(Object.isFrozen(context)).toBe(true);
    expect(scopeOf(context)).toBe("ws_1");
  });

  it("denies non-members and malformed identifiers without revealing which part failed", async () => {
    const { db, findUnique } = fakeDb(null);
    await expect(authorizeWorkspaceAccess(db, { userId: "user_1", workspaceId: "ws_2" })).rejects.toThrow(
      new WorkspaceAccessDeniedError(),
    );

    findUnique.mockClear();
    for (const request of [
      { userId: "", workspaceId: "ws_1" },
      { userId: "user_1", workspaceId: "ws 1" },
    ]) {
      await expect(authorizeWorkspaceAccess(db, request)).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
    }
    expect(findUnique).not.toHaveBeenCalled();
  });
});

describe("scopeOf / requireWorkspaceRole", () => {
  it("rejects contexts that were not issued by authorization, including copies of real ones", async () => {
    const { db } = fakeDb("OWNER");
    const issued = await authorizeWorkspaceAccess(db, { userId: "user_1", workspaceId: "ws_1" });
    const forged = [
      { ...issued },
      { workspaceId: "ws_1", userId: "user_1", role: "OWNER" },
      null,
      undefined,
      "ws_1",
    ] as unknown as WorkspaceContext[];

    for (const context of forged) {
      expect(() => scopeOf(context)).toThrow(WorkspaceAccessDeniedError);
      expect(() => requireWorkspaceRole(context, ["OWNER"], "test")).toThrow(WorkspaceAccessDeniedError);
    }
  });

  it("requires one of the allowed roles", async () => {
    const { db } = fakeDb("AGENT");
    const agent = await authorizeWorkspaceAccess(db, { userId: "user_1", workspaceId: "ws_1" });

    expect(() => requireWorkspaceRole(agent, ["OWNER", "ADMIN"], "connecting channel accounts")).toThrow(
      WorkspacePermissionError,
    );
    expect(requireWorkspaceRole(agent, ["OWNER", "ADMIN", "AGENT"], "reading")).toBe("ws_1");
  });
});
