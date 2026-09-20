import { describe, expect, it, vi } from "vitest";

import { reconcileOperation } from "./reconcile-operation";
import type { OperationEvidence, ReconciliationRecord, ReconciliationStore, ReconciliationSubject } from "./ports";

const NOW = new Date("2026-09-20T12:00:00.000Z");
const DETECTED = new Date("2026-09-20T11:00:00.000Z");
const GRACE_MS = 10 * 60_000;

const command = {
  workspaceId: "ws_1",
  businessProfileId: "bp_1",
  operationId: "op_1",
  deliveryJobId: "job_1",
  conversationId: "conv_1",
  reason: "AMBIGUOUS_SEND_RESULT" as const,
  detectedAt: DETECTED,
};

const subject = (overrides: Partial<ReconciliationSubject> = {}): ReconciliationSubject => ({
  operationId: "op_1",
  deliveryJobId: "job_1",
  conversationId: "conv_1",
  status: "HELD_AMBIGUOUS",
  claimedAt: new Date(DETECTED.getTime() - 5_000),
  attemptCount: 1,
  detectedAt: DETECTED,
  reason: "AMBIGUOUS_SEND_RESULT",
  ...overrides,
});

function harness(options: { subject?: ReconciliationSubject | undefined; evidence?: OperationEvidence } = {}) {
  const records: ReconciliationRecord[] = [];
  const store = {
    open: vi.fn(() => Promise.resolve()),
    load: vi.fn(() => Promise.resolve("subject" in options ? options.subject : subject())),
    markSent: vi.fn(() => Promise.resolve()),
    resume: vi.fn(() => Promise.resolve()),
    escalate: vi.fn(() => Promise.resolve()),
    record: vi.fn((input: ReconciliationRecord) => {
      records.push(input);
      return Promise.resolve();
    }),
  } satisfies ReconciliationStore;
  const unresolved: OperationEvidence = { kind: "UNKNOWN", detail: "no lookup" };
  const evidence = { lookup: vi.fn(() => Promise.resolve(options.evidence ?? unresolved)) };
  const log = { info: vi.fn(), warn: vi.fn() };
  return {
    store,
    evidence,
    records,
    run: (now = NOW) => reconcileOperation({ store, evidence, log, now: () => now, graceMs: GRACE_MS }, command),
  };
}

describe("reconciling a send whose outcome is unknown", () => {
  it("never sends: there is no port here that could", () => {
    const { store } = harness();

    // The guarantee is structural rather than behavioural, so it is asserted structurally. A `send` on
    // this store would be a second path to a customer, and ADR-012 allows exactly one.
    expect(Object.keys(store)).toEqual(["open", "load", "markSent", "resume", "escalate", "record"]);
  });

  it("opens the durable record before looking at anything", async () => {
    const { store, run } = harness();
    const order: string[] = [];
    store.open.mockImplementation(() => {
      order.push("open");
      return Promise.resolve();
    });
    store.load.mockImplementation(() => {
      order.push("load");
      return Promise.resolve(subject());
    });

    await run();

    // A queue flush between the two would otherwise lose the operation entirely.
    expect(order).toEqual(["open", "load"]);
  });

  it("resumes an operation that was never claimed, because no send was attempted", async () => {
    const { store, evidence, run } = harness({ subject: subject({ status: "SCHEDULED", claimedAt: undefined }) });

    const outcome = await run();

    expect(outcome.state).toBe("RESOLVED_RESUMED");
    expect(store.resume).toHaveBeenCalledOnce();
    // Our own state answered it. Asking the provider would be a slower way to learn the same thing, and
    // a chance to act on a stale answer.
    expect(evidence.lookup).not.toHaveBeenCalled();
  });

  it("leaves a live claim alone rather than racing the worker holding it", async () => {
    const { store, run } = harness({ subject: subject({ status: "SENDING" }) });

    const outcome = await run();

    expect(outcome).toMatchObject({ state: "PENDING", retryLater: true });
    expect(store.resume).not.toHaveBeenCalled();
    expect(store.escalate).not.toHaveBeenCalled();
  });

  it("does nothing to an operation something else already settled", async () => {
    for (const status of ["SENT", "CANCELLED_SUPERSEDED", "CANCELLED_HUMAN_TAKEOVER", "CANCELLED_POLICY", "HELD_REVIEW"] as const) {
      const { store, run } = harness({ subject: subject({ status }) });

      const outcome = await run();

      expect(outcome.state).toBe("ALREADY_SETTLED");
      expect(store.resume).not.toHaveBeenCalled();
      expect(store.markSent).not.toHaveBeenCalled();
    }
  });

  it("records the send when the platform can prove it happened", async () => {
    const observedAt = new Date(DETECTED.getTime() + 1_000);
    const { store, run } = harness({ evidence: { kind: "SENT", platformMessageId: "mid_9", observedAt } });

    const outcome = await run();

    expect(outcome.state).toBe("RESOLVED_SENT");
    expect(store.markSent).toHaveBeenCalledWith("op_1", "mid_9", observedAt);
  });

  it("resumes through the coordinator when the platform proves nothing was sent", async () => {
    const { store, run } = harness({ evidence: { kind: "NOT_SENT", detail: "the platform has no such message" } });

    const outcome = await run();

    // Resume, not resend: the store returns it to the claimable state and the coordinator re-judges it.
    expect(outcome.state).toBe("RESOLVED_RESUMED");
    expect(store.resume).toHaveBeenCalledOnce();
  });

  it("waits out the grace period before troubling anyone", async () => {
    const { store, run } = harness();

    const outcome = await run(new Date(DETECTED.getTime() + GRACE_MS - 1));

    // A late echo usually settles this within a minute or two, and a review item raised before that is
    // one a person opens to find nothing to do.
    expect(outcome).toMatchObject({ state: "PENDING", retryLater: true });
    expect(store.escalate).not.toHaveBeenCalled();
  });

  it("hands the question to a person once nobody can answer it", async () => {
    const { store, run } = harness();

    const outcome = await run(new Date(DETECTED.getTime() + GRACE_MS));

    expect(outcome.state).toBe("NEEDS_HUMAN");
    expect(store.escalate).toHaveBeenCalledOnce();
    expect(store.resume).not.toHaveBeenCalled();
  });

  it("escalates an exhausted delivery instead of asking the provider about it", async () => {
    const { store, evidence, run } = harness({ subject: subject({ status: "FAILED_RETRYABLE_EXHAUSTED" }) });

    const outcome = await run();

    // Repeated refusals are not ambiguity: the customer received nothing, and whether the reply is still
    // worth sending by hand is a person's decision.
    expect(outcome.state).toBe("NEEDS_HUMAN");
    expect(evidence.lookup).not.toHaveBeenCalled();
    expect(store.escalate).toHaveBeenCalledOnce();
  });

  it("writes a record for every conclusion, including the inconclusive ones", async () => {
    const { records, run } = harness();

    await run(new Date(DETECTED.getTime() + 1_000));

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ operationId: "op_1", state: "PENDING", reason: "AMBIGUOUS_SEND_RESULT" });
    // "We asked and could not tell" is itself an audit fact; a silent pass would look like no pass at all.
    expect(records[0]?.evidence).not.toBe("");
  });

  it("says so plainly when the operation has vanished", async () => {
    const { store, run } = harness({ subject: undefined });

    const outcome = await run();

    expect(outcome.state).toBe("ALREADY_SETTLED");
    expect(store.record).not.toHaveBeenCalled();
  });
});
