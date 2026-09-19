import { describe, expect, it, vi } from "vitest";

import type { DbExecutor } from "./client";
import { BusinessProfileAccessDeniedError, WorkspaceAccessDeniedError, WorkspacePermissionError } from "./errors";
import {
  authorizeBusinessProfileAccess,
  authorizedBusinessProfileFilter,
  authorizeWorkspaceAccess,
  profileScopeOf,
  requireRole,
  scopeOf,
  type BusinessProfileContext,
  type WorkspaceContext,
} from "./tenancy";

interface FakeMembership {
  readonly role: "OWNER" | "ADMIN" | "AGENT";
  readonly businessProfileScope: "ALL" | "SELECTED";
  readonly grants?: readonly string[];
}

function fakeDb(membership: FakeMembership | null, existingProfiles: readonly string[] = ["bp_1", "bp_2"]) {
  const findMember = vi.fn(() =>
    Promise.resolve(
      membership === null
        ? null
        : {
            id: "member_1",
            role: membership.role,
            businessProfileScope: membership.businessProfileScope,
            businessProfileAccess: (membership.grants ?? []).map((businessProfileId) => ({ businessProfileId })),
          },
    ),
  );
  const findProfile = vi.fn((args: { where: { workspaceId_id: { id: string } } }) =>
    Promise.resolve(existingProfiles.includes(args.where.workspaceId_id.id) ? { id: args.where.workspaceId_id.id } : null),
  );
  const db = { workspaceMember: { findUnique: findMember }, businessProfile: { findUnique: findProfile } } as unknown as DbExecutor;
  return { db, findMember, findProfile };
}

describe("authorizeWorkspaceAccess", () => {
  it("issues a frozen context with role and Business Profile scope read from the membership", async () => {
    const { db } = fakeDb({ role: "ADMIN", businessProfileScope: "SELECTED", grants: ["bp_1"] });
    const context = await authorizeWorkspaceAccess(db, { userId: "user_1", workspaceId: "ws_1" });

    expect(context).toEqual({
      workspaceId: "ws_1",
      userId: "user_1",
      workspaceMemberId: "member_1",
      role: "ADMIN",
      businessProfileScope: { kind: "SELECTED", businessProfileIds: ["bp_1"] },
    });
    expect(Object.isFrozen(context)).toBe(true);
    expect(scopeOf(context)).toBe("ws_1");
    expect(authorizedBusinessProfileFilter(context)).toEqual({ businessProfileId: { in: ["bp_1"] } });
  });

  it("gives OWNER and ALL-scoped members every Business Profile", async () => {
    const owner = await authorizeWorkspaceAccess(fakeDb({ role: "OWNER", businessProfileScope: "SELECTED" }).db, { userId: "u", workspaceId: "ws_1" });
    const allAgent = await authorizeWorkspaceAccess(fakeDb({ role: "AGENT", businessProfileScope: "ALL" }).db, { userId: "u", workspaceId: "ws_1" });
    expect(owner.businessProfileScope).toEqual({ kind: "ALL" });
    expect(authorizedBusinessProfileFilter(allAgent)).toEqual({});
  });

  it("denies non-members and malformed identifiers without querying or revealing which part failed", async () => {
    const { db, findMember } = fakeDb(null);
    await expect(authorizeWorkspaceAccess(db, { userId: "user_1", workspaceId: "ws_2" })).rejects.toThrow(new WorkspaceAccessDeniedError());

    findMember.mockClear();
    for (const request of [
      { userId: "", workspaceId: "ws_1" },
      { userId: "user_1", workspaceId: "ws 1" },
    ]) {
      await expect(authorizeWorkspaceAccess(db, request)).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
    }
    expect(findMember).not.toHaveBeenCalled();
  });
});

describe("authorizeBusinessProfileAccess", () => {
  const request = (businessProfileId: string) => ({ userId: "user_1", workspaceId: "ws_1", businessProfileId });

  it("issues a context only for a granted profile that exists in the Workspace", async () => {
    const { db } = fakeDb({ role: "AGENT", businessProfileScope: "SELECTED", grants: ["bp_1"] });
    const context = await authorizeBusinessProfileAccess(db, request("bp_1"));
    expect(profileScopeOf(context)).toEqual({ workspaceId: "ws_1", businessProfileId: "bp_1" });
  });

  it("fails identically for an ungranted profile, a nonexistent profile and a malformed identifier", async () => {
    const { db, findProfile } = fakeDb({ role: "AGENT", businessProfileScope: "SELECTED", grants: ["bp_1", "bp_gone"] });
    for (const businessProfileId of ["bp_2", "bp_gone", "bp 1"]) {
      await expect(authorizeBusinessProfileAccess(db, request(businessProfileId))).rejects.toThrow(new BusinessProfileAccessDeniedError());
    }
    // An ungranted profile is rejected before any profile lookup.
    expect(findProfile.mock.calls.map(([args]) => args.where.workspaceId_id.id)).toEqual(["bp_gone"]);
  });

  it("denies everything to a SELECTED member without grants and to non-members", async () => {
    await expect(
      authorizeBusinessProfileAccess(fakeDb({ role: "ADMIN", businessProfileScope: "SELECTED" }).db, request("bp_1")),
    ).rejects.toBeInstanceOf(BusinessProfileAccessDeniedError);
    await expect(authorizeBusinessProfileAccess(fakeDb(null).db, request("bp_1"))).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
  });
});

describe("context validation", () => {
  it("rejects contexts that were not issued by authorization, including copies of real ones", async () => {
    const { db } = fakeDb({ role: "OWNER", businessProfileScope: "ALL" });
    const workspace = await authorizeWorkspaceAccess(db, { userId: "user_1", workspaceId: "ws_1" });
    const profile = await authorizeBusinessProfileAccess(db, { userId: "user_1", workspaceId: "ws_1", businessProfileId: "bp_1" });

    for (const forged of [{ ...workspace }, { workspaceId: "ws_1", role: "OWNER" }, null, "ws_1"] as unknown as WorkspaceContext[]) {
      expect(() => scopeOf(forged)).toThrow(WorkspaceAccessDeniedError);
      expect(() => requireRole(forged, ["OWNER"], "test")).toThrow(WorkspaceAccessDeniedError);
    }
    for (const forged of [{ ...profile }, { workspaceId: "ws_1", businessProfileId: "bp_2" }, undefined] as unknown as BusinessProfileContext[]) {
      expect(() => profileScopeOf(forged)).toThrow(BusinessProfileAccessDeniedError);
    }
    // A Workspace context is not a Business Profile context and vice versa.
    expect(() => profileScopeOf(workspace as unknown as BusinessProfileContext)).toThrow(BusinessProfileAccessDeniedError);
    expect(() => scopeOf(profile as unknown as WorkspaceContext)).toThrow(WorkspaceAccessDeniedError);
  });

  it("requires one of the allowed roles", async () => {
    const { db } = fakeDb({ role: "AGENT", businessProfileScope: "ALL" });
    const agent = await authorizeBusinessProfileAccess(db, { userId: "user_1", workspaceId: "ws_1", businessProfileId: "bp_1" });
    expect(() => requireRole(agent, ["OWNER", "ADMIN"], "connecting channel accounts")).toThrow(WorkspacePermissionError);
    expect(() => requireRole(agent, ["OWNER", "ADMIN", "AGENT"], "reading")).not.toThrow();
  });
});
