/**
 * The AI-settings server action, as HTTP reaches it (Issue #30).
 *
 * Astra's R5 findings 1, 3 and 4 all live on this side of the boundary, and none of them is visible from
 * either side alone: the store refuses an agent and refuses a stale version *when the action passes one*,
 * and the action decided what to pass. So these cases are run on a `FormData` nobody's browser built —
 * the form the screen renders is one caller of a public endpoint, and a constructed request is another.
 *
 * Mocked modules for the same reason `knowledge-actions.test.ts` uses them: a server action's
 * request-bound dependencies — the session, the client, the redirect — are exactly what cannot be
 * supplied without a request, and what is under test is which of them the action reaches *before* it
 * refuses. The store's own suite proves the refusals against a real database.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

class WorkspacePermissionError extends Error {
  constructor(readonly operation: string) {
    super(`not permitted: ${operation}`);
  }
}

const store = {
  readPolicies: vi.fn(),
  savePolicy: vi.fn(),
  WorkspacePermissionError,
};

/** The sentinel `redirect` throws, so a test can read where an action sent the owner. */
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

const { saveSettingsAction } = await import("./settings-actions");
const { decodeProposal, MAX_PROPOSAL_FIELD_CHARS } = await import("./settings-view");

const TARGET = { workspaceId: "ws_1", businessProfileId: "bp_1" };
const SETTINGS = "/workspaces/ws_1/profiles/bp_1/settings";

/** What is stored: DRAFT, cautious, nothing unattended. Widening any of it is a high-impact change. */
const STORED = {
  id: "ap_1",
  channelAccountId: null,
  mode: "DRAFT",
  businessGoal: "Answer questions",
  qualificationCriteria: ["has a budget"],
  confidenceThreshold: 0.8,
  mandatoryReviewReasons: ["LOW_CONFIDENCE", "PAYMENT_DISPUTE"],
  timingPreset: "NATURAL" as const,
  debounceWindowMs: { minMs: 7_000, maxMs: 12_000 },
  deliveryDelayMs: { minMs: 30_000, maxMs: 120_000 },
  takeoverPauseMs: 21_600_000,
  instagramAfterWindowPolicy: "STANDARD_ONLY",
  whatsappAfterWindowPolicy: "SERVICE_WINDOW_ONLY",
  whatsappTemplateAutomationAllowlist: [],
  version: 4,
  updatedAt: new Date("2026-09-01T10:00:00.000Z"),
};

const form = (entries: Readonly<Record<string, string>>): FormData => {
  const data = new FormData();
  for (const [name, value] of Object.entries(entries)) {
    data.set(name, value);
  }
  return data;
};

/** A complete form, as the screen renders it for the stored policy above. */
const wholeForm = (overrides: Readonly<Record<string, string>> = {}): FormData =>
  form({
    expectedVersion: "4",
    mode: "DRAFT",
    businessGoal: "Answer questions",
    criteria: "has a budget",
    timingPreset: "NATURAL",
    debounceMinSeconds: "7",
    debounceMaxSeconds: "12",
    deliveryDelayMinSeconds: "30",
    deliveryDelayMaxSeconds: "120",
    takeoverPauseHours: "6",
    instagramAfterWindowPolicy: "STANDARD_ONLY",
    whatsappAfterWindowPolicy: "SERVICE_WINDOW_ONLY",
    allowlist: "",
    ...overrides,
  });

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

const queryOf = (path: string) => new URLSearchParams(path.slice(path.indexOf("?") + 1));

beforeEach(() => {
  store.readPolicies.mockReset();
  store.savePolicy.mockReset();
  store.readPolicies.mockResolvedValue([STORED]);
  store.savePolicy.mockResolvedValue({ status: "SAVED", impacts: [], version: 5 });
  revalidated.length = 0;
});

describe("the version the form was composed against", () => {
  it("is required, and a submission without one never reaches the store", async () => {
    const data = wholeForm();
    data.delete("expectedVersion");

    const path = await outcomeOf(() => saveSettingsAction(TARGET, data));

    expect(path).toBe(`${SETTINGS}?outcome=REJECTED`);
    // Sending one fewer field must not be a way past a conflict check.
    expect(store.savePolicy).not.toHaveBeenCalled();
  });

  it("must be the whole field, not a number found at the front of it", async () => {
    const path = await outcomeOf(() => saveSettingsAction(TARGET, wholeForm({ expectedVersion: "4; DROP TABLE automation_policies" })));

    expect(path).toBe(`${SETTINGS}?outcome=REJECTED`);
    expect(store.savePolicy).not.toHaveBeenCalled();
  });

  it("is passed through to the store when it is usable", async () => {
    await outcomeOf(() => saveSettingsAction(TARGET, wholeForm()));

    expect(store.savePolicy.mock.calls[0]?.[3]).toMatchObject({ expectedVersion: 4 });
  });

  it("keeps the proposal when the store answers CONFLICT", async () => {
    store.savePolicy.mockResolvedValue({ status: "CONFLICT", current: { ...STORED, version: 9 } });

    const path = await outcomeOf(() => saveSettingsAction(TARGET, wholeForm({ businessGoal: "Book consultations" })));

    // A refusal that also loses the owner's edit costs more than the change it prevented.
    expect(queryOf(path).get("outcome")).toBe("CONFLICT");
    expect(decodeProposal(queryOf(path).get("proposal") ?? undefined)?.businessGoal).toBe("Book consultations");
  });

  it("re-stamps a conflicted proposal to the version that is now stored", async () => {
    store.savePolicy.mockResolvedValue({ status: "CONFLICT", current: { ...STORED, version: 9 } });

    const path = await outcomeOf(() => saveSettingsAction(TARGET, wholeForm({ businessGoal: "Book consultations" })));

    // Carried at its original version the proposal would conflict for ever, and a form that can only be
    // refused is a trap rather than a safeguard. The next submit is then a deliberate act against the
    // settings as they now are — with the other change visible in the history below the form.
    expect(decodeProposal(queryOf(path).get("proposal") ?? undefined)?.expectedVersion).toBe(9);
  });
});

describe("a change that widens what goes out", () => {
  it("is refused, with the proposal, when nothing was acknowledged", async () => {
    const path = await outcomeOf(() => saveSettingsAction(TARGET, wholeForm({ mode: "AUTOPILOT" })));
    const query = queryOf(path);

    expect(query.get("outcome")).toBe("CONFIRM");
    expect(query.get("impacts")).toContain("AUTOPILOT_ENABLED");
    // The finding: the refusal carried only the impacts, so the form was rebuilt from stored values and
    // the summary described a change that was no longer on screen.
    expect(decodeProposal(query.get("proposal") ?? undefined)?.mode).toBe("AUTOPILOT");
    expect(store.savePolicy).not.toHaveBeenCalled();
  });

  it("is not saved by a bare affirmative", async () => {
    // What the screen used to post. A checkbox that is always present is ticked before any summary
    // exists, so "show the effect summary before save" was skippable by a user and by a crafted request.
    const path = await outcomeOf(() => saveSettingsAction(TARGET, wholeForm({ mode: "AUTOPILOT", confirm: "on", acknowledged: "on" })));

    expect(queryOf(path).get("outcome")).toBe("CONFIRM");
    expect(store.savePolicy).not.toHaveBeenCalled();
  });

  it("is not saved by acknowledging a different change", async () => {
    const path = await outcomeOf(() =>
      saveSettingsAction(TARGET, wholeForm({ mode: "AUTOPILOT", acknowledged: "CONFIDENCE_LOWERED" })),
    );

    expect(queryOf(path).get("outcome")).toBe("CONFIRM");
    expect(store.savePolicy).not.toHaveBeenCalled();
  });

  it("is not saved by acknowledging only one of two", async () => {
    const path = await outcomeOf(() =>
      saveSettingsAction(
        TARGET,
        wholeForm({ mode: "AUTOPILOT", confidencePreset: "AGGRESSIVE", acknowledged: "AUTOPILOT_ENABLED" }),
      ),
    );

    expect(queryOf(path).get("outcome")).toBe("CONFIRM");
    expect(store.savePolicy).not.toHaveBeenCalled();
  });

  it("is saved when the acknowledgement names exactly what the server computed", async () => {
    const refused = await outcomeOf(() => saveSettingsAction(TARGET, wholeForm({ mode: "AUTOPILOT" })));
    const shown = queryOf(refused).get("impacts") ?? "";

    const path = await outcomeOf(() => saveSettingsAction(TARGET, wholeForm({ mode: "AUTOPILOT", acknowledged: shown })));

    expect(path).toBe(`${SETTINGS}?outcome=SAVED`);
    expect(store.savePolicy.mock.calls[0]?.[3]).toMatchObject({ mode: "AUTOPILOT", expectedVersion: 4 });
  });

  it("needs no acknowledgement when it widens nothing", async () => {
    const path = await outcomeOf(() => saveSettingsAction(TARGET, wholeForm({ businessGoal: "Book consultations" })));

    expect(path).toBe(`${SETTINGS}?outcome=SAVED`);
  });
});

describe("custom timing", () => {
  it("sends the four numbers an owner typed, in milliseconds", async () => {
    await outcomeOf(() =>
      saveSettingsAction(
        TARGET,
        wholeForm({
          timingPreset: "CUSTOM",
          debounceMinSeconds: "3",
          debounceMaxSeconds: "9",
          deliveryDelayMinSeconds: "20",
          deliveryDelayMaxSeconds: "45",
        }),
      ),
    );

    // The finding: the form posted only `timingPreset`, so selecting Custom saved no custom values and
    // the store fell back to the previous ranges — a preset an owner could choose and not configure.
    expect(store.savePolicy.mock.calls[0]?.[3]).toMatchObject({
      timingPreset: "CUSTOM",
      timing: { debounceWindowMs: { minMs: 3_000, maxMs: 9_000 }, deliveryDelayMs: { minMs: 20_000, maxMs: 45_000 } },
    });
  });

  it("sends no ranges alongside a named preset", async () => {
    await outcomeOf(() => saveSettingsAction(TARGET, wholeForm({ timingPreset: "FAST", debounceMinSeconds: "3", debounceMaxSeconds: "9" })));

    // A named preset means its own ranges, and sending both is a contradiction the store refuses. The
    // inputs stay on screen whichever preset is selected, so they are posted whichever is selected too.
    const edit = store.savePolicy.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(edit["timingPreset"]).toBe("FAST");
    expect(edit["timing"]).toBeUndefined();
  });

  it("sends nothing when a custom range is only half typed", async () => {
    await outcomeOf(() => saveSettingsAction(TARGET, wholeForm({ timingPreset: "CUSTOM", debounceMinSeconds: "" })));

    // Completing it from stored values would mix a typed number with a previous one and produce a window
    // the owner never chose; the store then keeps the stored ranges, which is at least explicable.
    expect((store.savePolicy.mock.calls[0]?.[3] as Record<string, unknown>)["timing"]).toBeUndefined();
  });

  it("refuses a range the domain refuses, in the domain's own words", async () => {
    store.savePolicy.mockResolvedValue({ status: "REFUSED", reason: "deliveryDelayMs: minMs must not exceed maxMs" });

    const path = await outcomeOf(() =>
      saveSettingsAction(TARGET, wholeForm({ timingPreset: "CUSTOM", deliveryDelayMinSeconds: "90", deliveryDelayMaxSeconds: "30" })),
    );

    // Reversed bounds are the domain's refusal to make. The action passes the range and reports it.
    expect(path).toBe(`${SETTINGS}?outcome=REFUSED`);
  });
});

describe("who may save", () => {
  it("reports the store's role refusal rather than crashing the page", async () => {
    store.savePolicy.mockRejectedValue(new WorkspacePermissionError("changing automation settings"));

    const path = await outcomeOf(() => saveSettingsAction(TARGET, wholeForm({ businessGoal: "Book consultations" })));

    // The screen hides the form from an agent, so reaching here means a direct post. Answered, not an
    // error page — and not a save.
    expect(path).toBe(`${SETTINGS}?outcome=FORBIDDEN`);
  });

  it("lets any other failure out, rather than reporting it as a refusal", async () => {
    store.savePolicy.mockRejectedValue(new Error("the database is on fire"));

    // A refusal and an outage are different answers. Reporting an outage as "you may not do that" would
    // send an owner to look for a permission they already have.
    await expect(saveSettingsAction(TARGET, wholeForm())).rejects.toThrow("the database is on fire");
  });
});

describe("a field too long to carry", () => {
  it("is refused before anything is encoded", async () => {
    const path = await outcomeOf(() => saveSettingsAction(TARGET, wholeForm({ businessGoal: "x".repeat(MAX_PROPOSAL_FIELD_CHARS + 1) })));

    expect(path).toBe(`${SETTINGS}?outcome=TOO_LONG`);
    expect(store.savePolicy).not.toHaveBeenCalled();
  });
});
