/**
 * The front door as HTTP reaches it (#115).
 *
 * The form a screen renders is one caller of these endpoints; a constructed request carrying whatever its
 * author felt like is another, and the second one is what these cases are. The rule that cannot be
 * checked from either side alone is the one the issue names first: **the owner comes from the session**,
 * and a submission that carries an `ownerUserId` must not be able to create a workspace owned by somebody
 * else.
 *
 * Mocked for the reason `settings-actions.test.ts` gives: a server action's request-bound dependencies —
 * the session, the client, the redirect — are exactly what cannot be supplied without a request, and what
 * is under test here is *which of them the action reaches before it refuses*. The stores' own refusals are
 * proved against a real database in `packages/db` and in the journey suite.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

class WorkspacePermissionError extends Error {
  constructor(readonly operation: string) {
    super(`not permitted: ${operation}`);
  }
}

class PlanLimitError extends Error {
  constructor(readonly verdict: { readonly kind: string }) {
    super("at limit");
  }
}

class DbInputError extends Error {
  constructor(readonly field: string) {
    super(`${field} is invalid`);
  }
}

const store = {
  createWorkspaceOnce: vi.fn(),
  createBusinessProfile: vi.fn(),
  listAuthorizedBusinessProfiles: vi.fn(),
  NAME_MAX_LENGTH: 200,
  WorkspacePermissionError,
  PlanLimitError,
  DbInputError,
};

/** The sentinel `redirect` throws, so a test can read where an action sent the person. */
class Redirected extends Error {
  constructor(readonly path: string) {
    super(`redirected to ${path}`);
  }
}

const revalidated: string[] = [];
let sessionUserId: string | undefined = "usr_session";
const workspacesAsked: (string | undefined)[] = [];

vi.mock("@omnichannel/db", () => store);
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Redirected(path);
  },
}));
vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => {
    revalidated.push(path);
  },
}));
vi.mock("./db", () => ({ getDb: () => ({ marker: "the client the action resolved" }) }));
vi.mock("./request-context", () => ({
  requireSessionUserId: () => {
    if (sessionUserId === undefined) {
      throw new Error("UnauthenticatedError");
    }
    return Promise.resolve(sessionUserId);
  },
  requireWorkspaceContext: (workspaceId: string | undefined) => {
    workspacesAsked.push(workspaceId);
    return Promise.resolve({ userId: sessionUserId, workspaceId, role: "OWNER" });
  },
}));

const { createBusinessProfileAction, createWorkspaceAction } = await import("./onboarding-actions");

const form = (entries: Readonly<Record<string, string>>): FormData => {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    data.set(key, value);
  }
  return data;
};

/** Runs an action and returns where it redirected, since that is how these actions report. */
const sentTo = async (run: () => Promise<void>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof Redirected) {
      return error.path;
    }
    throw error;
  }
  throw new Error("the action returned without redirecting, so it reported nothing");
};

beforeEach(() => {
  vi.clearAllMocks();
  revalidated.length = 0;
  workspacesAsked.length = 0;
  sessionUserId = "usr_session";
  store.createWorkspaceOnce.mockResolvedValue({ workspace: { workspaceId: "ws_new", name: "Acme", role: "OWNER" }, replayed: false });
  store.createBusinessProfile.mockResolvedValue({ businessProfileId: "bp_new", name: "Main", status: "SETUP" });
  store.listAuthorizedBusinessProfiles.mockResolvedValue([]);
});

describe("creating a workspace", () => {
  it("owns it to the session, and ignores an ownerUserId the submission carried", async () => {
    // The whole point of the endpoint. A posted owner would let any authenticated caller create a
    // workspace owned by somebody else, and nothing below this action would notice:
    // `createWorkspaceWithOwner` takes no context and authorizes nothing.
    await sentTo(() => createWorkspaceAction(form({ name: "Acme", ownerUserId: "usr_victim" })));

    expect(store.createWorkspaceOnce).toHaveBeenCalledWith(expect.anything(), { name: "Acme", ownerUserId: "usr_session" });
  });

  it("reports a creation and lands in the new workspace", async () => {
    expect(await sentTo(() => createWorkspaceAction(form({ name: "Acme" })))).toBe("/workspaces/ws_new?outcome=WORKSPACE_CREATED");
    // The chooser's own list is what just changed, so a cached copy of it would show an empty list to
    // somebody who has just filled it.
    expect(revalidated).toContain("/workspaces");
  });

  it("reports a replay as a replay, and still lands on the workspace", async () => {
    store.createWorkspaceOnce.mockResolvedValue({ workspace: { workspaceId: "ws_existing", name: "Acme", role: "OWNER" }, replayed: true });

    expect(await sentTo(() => createWorkspaceAction(form({ name: "Acme" })))).toBe("/workspaces/ws_existing?outcome=WORKSPACE_REPLAYED");
  });

  it("refuses a nameless submission without reaching the database", async () => {
    expect(await sentTo(() => createWorkspaceAction(form({ name: "  " })))).toBe("/workspaces?outcome=NAME_REQUIRED");
    expect(store.createWorkspaceOnce).not.toHaveBeenCalled();
  });

  it("refuses an overlong name without reaching the database", async () => {
    expect(await sentTo(() => createWorkspaceAction(form({ name: "a".repeat(201) })))).toBe("/workspaces?outcome=NAME_TOO_LONG");
    expect(store.createWorkspaceOnce).not.toHaveBeenCalled();
  });

  it("creates nothing for a request with no session", async () => {
    sessionUserId = undefined;

    await expect(createWorkspaceAction(form({ name: "Acme" }))).rejects.toThrow("UnauthenticatedError");
    expect(store.createWorkspaceOnce).not.toHaveBeenCalled();
  });

  it("lets an error nobody wrote a sentence for reach the error boundary", async () => {
    store.createWorkspaceOnce.mockRejectedValue(new Error("connection terminated"));

    await expect(createWorkspaceAction(form({ name: "Acme" }))).rejects.toThrow("connection terminated");
  });
});

describe("creating a business profile", () => {
  it("authorizes the workspace the route named, not one the form carried", async () => {
    await sentTo(() => createBusinessProfileAction("ws_route", form({ name: "Main", workspaceId: "ws_other" })));

    expect(workspacesAsked).toEqual(["ws_route"]);
  });

  it("reports a creation and goes to that profile's setup", async () => {
    expect(await sentTo(() => createBusinessProfileAction("ws_1", form({ name: "Main" })))).toBe(
      "/workspaces/ws_1/profiles/bp_new/setup?outcome=PROFILE_CREATED",
    );
  });

  it("treats a second submission of the same name as the replay it is", async () => {
    // The ordinary double-click. Nothing is created, and the person lands where they meant to go.
    store.listAuthorizedBusinessProfiles.mockResolvedValue([{ businessProfileId: "bp_first", name: "Main", status: "SETUP" }]);

    expect(await sentTo(() => createBusinessProfileAction("ws_1", form({ name: "Main" })))).toBe(
      "/workspaces/ws_1/profiles/bp_first/setup?outcome=PROFILE_REPLAYED",
    );
    expect(store.createBusinessProfile).not.toHaveBeenCalled();
  });

  it("does not mistake a different profile for a replay", async () => {
    // Otherwise the guard would refuse every second profile a workspace ever adds.
    store.listAuthorizedBusinessProfiles.mockResolvedValue([{ businessProfileId: "bp_first", name: "Main", status: "SETUP" }]);

    expect(await sentTo(() => createBusinessProfileAction("ws_1", form({ name: "Second" })))).toBe(
      "/workspaces/ws_1/profiles/bp_new/setup?outcome=PROFILE_CREATED",
    );
    expect(store.createBusinessProfile).toHaveBeenCalledOnce();
  });

  it("renders the store's role refusal rather than crashing on it", async () => {
    store.createBusinessProfile.mockRejectedValue(new WorkspacePermissionError("creating Business Profiles"));

    expect(await sentTo(() => createBusinessProfileAction("ws_1", form({ name: "Main" })))).toBe("/workspaces/ws_1?outcome=FORBIDDEN");
  });

  it("says a plan's profile ceiling is reached, which a trialling workspace will hit at its second", async () => {
    // `ACCEPTED_TRIAL.businessProfiles === 1`, so this is not an edge case: it is what the second profile
    // does during the 14-day trial, and a page that treated it as a fault would be wrong about the plan.
    store.createBusinessProfile.mockRejectedValue(new PlanLimitError({ kind: "AT_LIMIT" }));

    expect(await sentTo(() => createBusinessProfileAction("ws_1", form({ name: "Second" })))).toBe(
      "/workspaces/ws_1?outcome=PROFILE_LIMIT_REACHED",
    );
  });

  it("refuses a nameless submission without reaching the database", async () => {
    expect(await sentTo(() => createBusinessProfileAction("ws_1", form({})))).toBe("/workspaces/ws_1?outcome=NAME_REQUIRED");
    expect(store.createBusinessProfile).not.toHaveBeenCalled();
    expect(store.listAuthorizedBusinessProfiles).not.toHaveBeenCalled();
  });
});
