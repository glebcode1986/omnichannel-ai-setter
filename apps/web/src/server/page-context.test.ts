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
import { beforeEach, describe, expect, it, vi } from "vitest";

import { UnauthenticatedError } from "./workspace-context";

/** The sentinel `redirect` throws, so a test can read where a visitor was sent. */
class Redirected extends Error {
  constructor(readonly path: string) {
    super(`redirected to ${path}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Redirected(path);
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

  it.each(WRAPPERS)("leaves an authorization failure alone, from $name", async ({ resolver, call }) => {
    // Signed in but not entitled to this tenant. A sign-in page cannot help somebody who is already
    // signed in, and sending them there turns a clear refusal into a loop.
    const denied = new Error("WorkspaceAccessDenied");
    resolver.mockRejectedValue(denied);

    await expect(call()).rejects.toBe(denied);
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
