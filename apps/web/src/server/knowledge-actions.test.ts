/**
 * The Knowledge Library's server actions, as HTTP reaches them (Issue #31).
 *
 * Astra's second and third findings were both about this file, and both were invisible from either side
 * of it: the store refuses a stale edit *when it is told which version the edit came from*, and the
 * action decided whether to tell it. A submission without a usable version was completed against
 * whatever was current, with `VERSIONED` on the screen — so the whole mechanism could be stepped around
 * by sending one fewer field, and a publish could not be bound to the version an operator had read
 * because the action took no form at all.
 *
 * These are the only mocked-module tests in the app, and the reason is specific: a server action's
 * request-bound dependencies — the session, the client, the redirect — are exactly what cannot be
 * supplied without a request, and the behaviour under test is which of them the action reaches *before*
 * it refuses. The store's own suite proves the refusals against a real database; this proves the action
 * does not hand it a submission it should have stopped.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = {
  createKnowledge: vi.fn(),
  editKnowledge: vi.fn(),
  publishKnowledge: vi.fn(),
  archiveKnowledge: vi.fn(),
  restoreKnowledge: vi.fn(),
};

/** The sentinel `redirect` throws, so a test can read where an action sent the operator. */
class Redirected extends Error {
  constructor(readonly path: string) {
    super(`redirected to ${path}`);
  }
}

const revalidated: string[] = [];

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
  requireBusinessProfileContext: (workspaceId: string, businessProfileId: string) =>
    Promise.resolve({ userId: "usr_1", workspaceId, businessProfileId, role: "OWNER" }),
}));

const { archiveKnowledgeAction, editKnowledgeAction, publishKnowledgeAction, restoreKnowledgeAction } = await import("./knowledge-actions");

const TARGET = { workspaceId: "ws_1", businessProfileId: "bp_1" };
const LIBRARY = "/workspaces/ws_1/profiles/bp_1/knowledge";
const DOCUMENT = "kd_1";

const form = (entries: Readonly<Record<string, string>>): FormData => {
  const data = new FormData();
  for (const [name, value] of Object.entries(entries)) {
    data.set(name, value);
  }
  return data;
};

/** Runs an action and returns where it sent the operator; every action ends in a redirect. */
const outcomeOf = async (run: () => Promise<void>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof Redirected) {
      return error.path;
    }
    throw error;
  }
  throw new Error("the action returned without redirecting");
};

beforeEach(() => {
  for (const spy of Object.values(store)) {
    spy.mockReset();
  }
  revalidated.length = 0;
});

describe("an edit", () => {
  it("is refused without ever reaching the store when it carries no version", async () => {
    const path = await outcomeOf(() => editKnowledgeAction(TARGET, DOCUMENT, form({ title: "Hours", facts: "We open at 10." })));

    expect(path).toBe(`${LIBRARY}/${DOCUMENT}?outcome=REJECTED`);
    // The finding: this used to call the store with no expected version, which edits whatever is
    // current. Not reaching the store at all is the only answer that cannot be got wrong downstream.
    expect(store.editKnowledge).not.toHaveBeenCalled();
  });

  it("is refused when the version is not entirely a number", async () => {
    const path = await outcomeOf(() =>
      editKnowledgeAction(TARGET, DOCUMENT, form({ title: "Hours", facts: "We open at 10.", expectedVersion: "2; DROP TABLE knowledge_documents" })),
    );

    expect(path).toBe(`${LIBRARY}/${DOCUMENT}?outcome=REJECTED`);
    expect(store.editKnowledge).not.toHaveBeenCalled();
  });

  it("passes the version it was composed against when it has one", async () => {
    store.editKnowledge.mockResolvedValue({ status: "VERSIONED", documentId: DOCUMENT, version: 3 });

    const path = await outcomeOf(() =>
      editKnowledgeAction(TARGET, DOCUMENT, form({ title: "Hours", facts: "We open at 10.\nWe close at 18.", expectedVersion: "2" })),
    );

    expect(path).toBe(`${LIBRARY}/${DOCUMENT}?outcome=VERSIONED`);
    expect(store.editKnowledge).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ workspaceId: "ws_1", businessProfileId: "bp_1" }), DOCUMENT, {
      title: "Hours",
      chunks: ["We open at 10.", "We close at 18."],
      expectedVersion: 2,
    });
  });

  it("tells the operator a colleague got there first, rather than reporting a save", async () => {
    store.editKnowledge.mockResolvedValue({ status: "CONFLICT", expectedVersion: 2, currentVersion: 3 });

    expect(await outcomeOf(() => editKnowledgeAction(TARGET, DOCUMENT, form({ title: "Hours", facts: "A fact.", expectedVersion: "2" })))).toBe(
      `${LIBRARY}/${DOCUMENT}?outcome=CONFLICT`,
    );
  });

  it("sends an operator back to the library for a document that is not theirs", async () => {
    store.editKnowledge.mockResolvedValue({ status: "GONE" });

    // No document id in the redirect: linking to a page that will 404 is a worse answer than the list.
    expect(await outcomeOf(() => editKnowledgeAction(TARGET, DOCUMENT, form({ title: "Hours", facts: "A fact.", expectedVersion: "2" })))).toBe(
      `${LIBRARY}?outcome=GONE`,
    );
  });
});

describe("a publish", () => {
  it("is refused without reaching the store when the submission names no version", async () => {
    const path = await outcomeOf(() => publishKnowledgeAction(TARGET, DOCUMENT, form({})));

    expect(path).toBe(`${LIBRARY}/${DOCUMENT}?outcome=REJECTED`);
    // The third finding. A publish that does not name a version publishes whatever is current, which is
    // how a stale tab makes content nobody reviewed the answer customers get.
    expect(store.publishKnowledge).not.toHaveBeenCalled();
  });

  it("is bound to the version the operator was reading", async () => {
    store.publishKnowledge.mockResolvedValue({ status: "RESTORED", version: 2 });

    const path = await outcomeOf(() => publishKnowledgeAction(TARGET, DOCUMENT, form({ expectedVersion: "2" })));

    expect(path).toBe(`${LIBRARY}/${DOCUMENT}?outcome=PUBLISHED`);
    expect(store.publishKnowledge).toHaveBeenCalledWith(expect.anything(), expect.anything(), DOCUMENT, { expectedVersion: 2 });
  });

  it("reports a conflict as a conflict, not as a publish", async () => {
    store.publishKnowledge.mockResolvedValue({ status: "CONFLICT", expectedVersion: 1, currentVersion: 2 });

    expect(await outcomeOf(() => publishKnowledgeAction(TARGET, DOCUMENT, form({ expectedVersion: "1" })))).toBe(
      `${LIBRARY}/${DOCUMENT}?outcome=CONFLICT`,
    );
  });

  it("reports the refusal when the source failed to index", async () => {
    store.publishKnowledge.mockResolvedValue({ status: "REJECTED", reason: "this source failed to index and cannot be made active until it is fixed" });

    expect(await outcomeOf(() => publishKnowledgeAction(TARGET, DOCUMENT, form({ expectedVersion: "2" })))).toBe(
      `${LIBRARY}/${DOCUMENT}?outcome=REJECTED`,
    );
  });

  it("revalidates the library, so the list does not keep showing the old state", async () => {
    store.publishKnowledge.mockResolvedValue({ status: "RESTORED", version: 1 });

    await outcomeOf(() => publishKnowledgeAction(TARGET, DOCUMENT, form({ expectedVersion: "1" })));

    expect(revalidated).toEqual([LIBRARY]);
  });
});

describe("using an archived source again", () => {
  it("is the same write under a different word", async () => {
    store.restoreKnowledge.mockResolvedValue({ status: "RESTORED", version: 3 });

    const path = await outcomeOf(() => restoreKnowledgeAction(TARGET, DOCUMENT, form({ expectedVersion: "3" })));

    // `RESTORED` rather than `PUBLISHED`: the operator asked to use a source again, and that is the
    // sentence they should get back.
    expect(path).toBe(`${LIBRARY}/${DOCUMENT}?outcome=RESTORED`);
    expect(store.restoreKnowledge).toHaveBeenCalledWith(expect.anything(), expect.anything(), DOCUMENT, { expectedVersion: 3 });
  });

  it("is refused without a version too", async () => {
    expect(await outcomeOf(() => restoreKnowledgeAction(TARGET, DOCUMENT, form({})))).toBe(`${LIBRARY}/${DOCUMENT}?outcome=REJECTED`);
    expect(store.restoreKnowledge).not.toHaveBeenCalled();
  });
});

describe("archiving", () => {
  it("needs no version, because it is not a decision about one", async () => {
    store.archiveKnowledge.mockResolvedValue({ status: "ARCHIVED" });

    const path = await outcomeOf(() => archiveKnowledgeAction(TARGET, DOCUMENT));

    // Stopping a source is the one control that must not be refusable on staleness: it takes the source
    // out of retrieval whatever its current wording is.
    expect(path).toBe(`${LIBRARY}/${DOCUMENT}?outcome=ARCHIVED`);
    expect(store.archiveKnowledge).toHaveBeenCalledWith(expect.anything(), expect.anything(), DOCUMENT);
  });
});
