/**
 * What an unauthenticated page render does now, and what it must still not do.
 *
 * The defect these cases pin down was measured on a running deployment rather than imagined: an
 * unauthenticated `GET /workspaces` returned **HTTP 500** with `UnauthenticatedError: Authentication
 * required` in the log, and `/admin` did the same, while a working sign-in page sat at `/sign-in` and
 * nobody was ever sent to it.
 *
 * Mocked for the reason `onboarding-actions.test.ts` gives: a redirect and a session are request-bound,
 * and what is under test here is *which of them this module reaches, and which errors it leaves alone*.
 * The resolvers' own authorization is proved against a real database elsewhere.
 */
import {
  BusinessProfileAccessDeniedError,
  PlatformAccessDeniedError,
  TenantRecordNotFoundError,
  WorkspaceAccessDeniedError,
  WorkspacePermissionError,
} from "@omnichannel/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { UnauthenticatedError } from "./workspace-context";

/** The sentinel `redirect` throws, so a test can read where a visitor was sent. */
class Redirected extends Error {
  constructor(readonly path: string) {
    super(`redirected to ${path}`);
  }
}

/** The same for `notFound`, which is how a refusal reaches the reader as a page. */
class NotFound extends Error {}

vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Redirected(path);
  },
  notFound: () => {
    throw new NotFound();
  },
}));

const resolvers = {
  requireSessionUserId: vi.fn(),
  requireWorkspaceContext: vi.fn(),
  requireBusinessProfileContext: vi.fn(),
  requirePlatformContext: vi.fn(),
};
vi.mock("./request-context", () => resolvers);

const { pageBusinessProfileContext, pagePlatformContext, pageSessionUserId, pageWorkspaceContext } = await import("./page-context");

/** Every wrapper, paired with a call of its own shape. One table so none can be forgotten. */
const WRAPPERS = [
  { name: "pageSessionUserId", resolver: resolvers.requireSessionUserId, call: () => pageSessionUserId() },
  { name: "pageWorkspaceContext", resolver: resolvers.requireWorkspaceContext, call: () => pageWorkspaceContext("ws_1") },
  {
    name: "pageBusinessProfileContext",
    resolver: resolvers.requireBusinessProfileContext,
    call: () => pageBusinessProfileContext("ws_1", "bp_1"),
  },
  { name: "pagePlatformContext", resolver: resolvers.requirePlatformContext, call: () => pagePlatformContext() },
] as const;

describe("a page render with no session", () => {
  beforeEach(() => {
    for (const { resolver } of WRAPPERS) {
      resolver.mockReset();
    }
  });

  it.each(WRAPPERS)("sends the visitor to sign-in rather than throwing, from $name", async ({ resolver, call }) => {
    resolver.mockRejectedValue(new UnauthenticatedError());

    await expect(call()).rejects.toBeInstanceOf(Redirected);
    await expect(call()).rejects.toMatchObject({ path: "/sign-in" });
  });

  it.each(WRAPPERS)("passes the resolved value straight through when there is a session, from $name", async ({ resolver, call }) => {
    // The success control. Without it a wrapper that redirected unconditionally would satisfy every
    // assertion above, and the whole product would be a sign-in page.
    resolver.mockResolvedValue("resolved");

    await expect(call()).resolves.toBe("resolved");
  });

  it.each(WRAPPERS)("never sends an authorization failure to sign-in, from $name", async ({ resolver, call }) => {
    // Signed in but not entitled to this tenant. A sign-in page cannot help somebody who is already
    // signed in, and sending them there turns a clear refusal into a loop.
    resolver.mockRejectedValue(new WorkspaceAccessDeniedError());

    await expect(call()).rejects.not.toBeInstanceOf(Redirected);
  });

  it.each([
    ["WorkspaceAccessDeniedError", () => new WorkspaceAccessDeniedError()],
    ["BusinessProfileAccessDeniedError", () => new BusinessProfileAccessDeniedError()],
    ["PlatformAccessDeniedError", () => new PlatformAccessDeniedError()],
    ["TenantRecordNotFoundError", () => new TenantRecordNotFoundError("conversation")],
  ] as const)("answers %s with the not-found page rather than a server error", async (_name, build) => {
    // The second half of the same defect, measured on the deployment: `/admin` returned 500 to a signed-in
    // reader with no platform membership. Not-found rather than forbidden, because whether the row exists
    // is itself information — the reason `instagram-routes.ts` already gives for its own 404.
    resolvers.requirePlatformContext.mockRejectedValue(build());

    await expect(pagePlatformContext()).rejects.toBeInstanceOf(NotFound);
  });

  it("leaves a permission failure alone, because no page render can produce one", async () => {
    // A member whose role forbids an operation. Thrown in four write paths and reached by no page, so
    // mapping it here would be handling a case that cannot occur — which is worse than not handling it,
    // because it would look tested.
    const permission = new WorkspacePermissionError("granting OWNER");
    resolvers.requireWorkspaceContext.mockRejectedValue(permission);

    await expect(pageWorkspaceContext("ws_1")).rejects.toBe(permission);
  });

  it("leaves an unrelated failure alone", async () => {
    const boom = new Error("the database fell over");
    resolvers.requireBusinessProfileContext.mockRejectedValue(boom);

    await expect(pageBusinessProfileContext("ws_1", "bp_1")).rejects.toBe(boom);
  });

  it("does not swallow a redirect thrown by the resolver itself", async () => {
    // `redirect` signals by throwing, so a guard that caught everything would turn one into a 500 — the
    // exact shape of the defect being fixed, reintroduced one layer up.
    const inner = new Redirected("/somewhere-else");
    resolvers.requireWorkspaceContext.mockRejectedValue(inner);

    await expect(pageWorkspaceContext("ws_1")).rejects.toBe(inner);
  });

  it("asks the resolver exactly once and forwards what the route named", async () => {
    resolvers.requireBusinessProfileContext.mockResolvedValue("ctx");

    await pageBusinessProfileContext("ws_7", "bp_9");

    expect(resolvers.requireBusinessProfileContext).toHaveBeenCalledTimes(1);
    expect(resolvers.requireBusinessProfileContext).toHaveBeenCalledWith("ws_7", "bp_9");
  });
});
