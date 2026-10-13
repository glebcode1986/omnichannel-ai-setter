/**
 * The loop that makes a planned follow-up happen (#55, Astra's first P1 on PR #82).
 *
 * What is under test is mostly the one thing this loop is allowed to decide: **nothing**. It finds due
 * work, hands each `READY` claim to the AI-draft job an inbound message would have enqueued, and reports
 * what happened. Every gate lives inside the claim, under a lock, and a second copy of any of them here
 * would be the copy nobody checks.
 *
 * So the cases are about what it enqueues, what it does not, and what it leaves alone — including the case
 * the blocker was about: a claim that answers `ALREADY_SENT` must produce no job at all, because the send
 * it is recovering already went out.
 */
import type { DueFollowUp, FollowUpClaim } from "@omnichannel/db";
import { createLogger } from "@omnichannel/observability";
import type { AiDraftGenerationJob, QueueProducer } from "@omnichannel/queue";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startFollowUpSweeper } from "./followup-sweeper";

const NOW = new Date("2026-10-13T09:00:00.000Z");
const INTERVAL_MS = 100;

const due = (id: string, overrides: Partial<DueFollowUp> = {}): DueFollowUp => ({
  id,
  workspaceId: "ws_1",
  businessProfileId: "bp_1",
  conversationId: "conv_1",
  goalId: "goal_1",
  status: "PENDING",
  dueAt: NOW,
  attemptCount: 0,
  maxAttempts: 3,
  stopReason: null,
  anchorMessageId: "msg_1",
  anchorStateVersion: 4,
  daypartTimeZone: "Europe/Kyiv",
  lastAttemptAt: null,
  settledAt: null,
  ...overrides,
});

const ready = (id: string, attempt = 1): FollowUpClaim => ({
  status: "READY",
  followUpId: id,
  conversationId: "conv_1",
  goalKind: "BOOK_APPOINTMENT",
  anchorMessageId: "msg_1",
  anchorStateVersion: 4,
  attempt,
  maxAttempts: 3,
});

interface Line {
  readonly event: string;
  readonly [field: string]: unknown;
}

/**
 * One pass, driven by the loop's own timer under fake time — the house pattern for a sweeper, so the
 * assertions never depend on a sleep being long enough. The loop's scheduling, overlap and
 * one-warning-per-outage behaviour belong to `recovery-loop` and are tested there.
 */
async function sweep(
  rows: readonly DueFollowUp[],
  claims: Readonly<Record<string, FollowUpClaim>>,
  options: { readonly enqueueFails?: boolean } = {},
) {
  vi.useFakeTimers();
  const lines: Line[] = [];
  const logger = createLogger({ level: "debug", sink: (line) => lines.push(JSON.parse(line) as Line) });
  const enqueueAiDraftGeneration = vi.fn<(job: AiDraftGenerationJob) => Promise<{ jobId: string }>>(() =>
    options.enqueueFails === true ? Promise.reject(new Error("redis://user:hunter2@cache:6379 is unreachable")) : Promise.resolve({ jobId: "job_1" }),
  );
  const producer = { enqueueAiDraftGeneration } as unknown as QueueProducer;
  const claim = vi.fn((followUpId: string): Promise<FollowUpClaim> => Promise.resolve(claims[followUpId] ?? { status: "MISSED", followUpId }));
  const due_ = vi.fn((request: { readonly now: Date; readonly limit: number }): Promise<readonly DueFollowUp[]> => {
    void request;
    return Promise.resolve(rows);
  });

  const loop = startFollowUpSweeper({
    intervalMs: INTERVAL_MS,
    limit: 50,
    due: due_,
    claim,
    producer,
    logger,
    now: () => NOW,
    newCorrelationId: () => "corr_sweep",
  });
  await vi.advanceTimersByTimeAsync(INTERVAL_MS);
  const closing = loop.close();
  await vi.advanceTimersByTimeAsync(INTERVAL_MS);
  await closing;

  return {
    enqueueAiDraftGeneration,
    claim,
    due: due_,
    lines,
    swept: lines.find((line) => line.event === "worker.follow_ups_swept"),
    failed: lines.find((line) => line.event === "worker.follow_ups_swept_failed"),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("sweeping due follow-ups", () => {
  it("hands a READY claim to the same AI-draft job an inbound message would enqueue", async () => {
    const swept = await sweep([due("fu_1")], { fu_1: ready("fu_1") });

    expect(swept.due).toHaveBeenCalledWith({ now: NOW, limit: 50 });
    expect(swept.enqueueAiDraftGeneration).toHaveBeenCalledTimes(1);
    expect(swept.enqueueAiDraftGeneration.mock.calls[0]?.[0]).toEqual({
      schemaVersion: 1,
      workspaceId: "ws_1",
      businessProfileId: "bp_1",
      correlationId: "corr_sweep",
      conversationId: "conv_1",
      anchorMessageId: "msg_1",
      // The attempt travels with the job because it is part of the job's identity: re-enqueueing this
      // attempt is the same job, and a second allowed attempt is a different one.
      trigger: { kind: "FOLLOW_UP", followUpId: "fu_1", attempt: 1 },
    });
    expect(swept.swept).toMatchObject({ due: 1, enqueued: 1, settled: 0, recovered: 0 });
  });

  it("enqueues nothing for a claim that recovered an operation already scheduled", async () => {
    // The crash window. The send went out before the worker died; a job here would ask the model again
    // and the customer would get a second message about one silence.
    const swept = await sweep([due("fu_1", { attemptCount: 1 })], {
      fu_1: { status: "ALREADY_SENT", followUpId: "fu_1", attempt: 1, operationId: "op_1" },
    });

    expect(swept.enqueueAiDraftGeneration).not.toHaveBeenCalled();
    expect(swept.swept).toMatchObject({ due: 1, enqueued: 0, recovered: 1 });
  });

  it("enqueues nothing for a claim the gates stopped, deferred or missed", async () => {
    const swept = await sweep([due("stopped"), due("deferred"), due("missed")], {
      stopped: { status: "STOPPED", followUpId: "stopped", reason: "NEW_INBOUND" },
      deferred: { status: "DEFERRED", followUpId: "deferred", dueAt: new Date(NOW.getTime() + 3_600_000) },
      missed: { status: "MISSED", followUpId: "missed" },
    });

    // Every reason a follow-up should not go out is the claim's to find, and this loop re-asks none of
    // them: it only declines to enqueue what the claim did not clear.
    expect(swept.enqueueAiDraftGeneration).not.toHaveBeenCalled();
    expect(swept.swept).toMatchObject({ due: 3, enqueued: 0, settled: 1, recovered: 0 });
  });

  it("claims each due follow-up separately, and one refusal does not stop the pass", async () => {
    const swept = await sweep([due("fu_1"), due("fu_2"), due("fu_3")], {
      fu_1: ready("fu_1"),
      fu_2: { status: "STOPPED", followUpId: "fu_2", reason: "HUMAN_TAKEOVER" },
      fu_3: ready("fu_3", 2),
    });

    expect(swept.claim).toHaveBeenCalledTimes(3);
    expect(swept.claim.mock.calls.map((call) => call[0])).toEqual(["fu_1", "fu_2", "fu_3"]);
    expect(swept.enqueueAiDraftGeneration).toHaveBeenCalledTimes(2);
    expect(swept.enqueueAiDraftGeneration.mock.calls.map((call) => call[0].trigger)).toEqual([
      { kind: "FOLLOW_UP", followUpId: "fu_1", attempt: 1 },
      // The second allowed attempt of a follow-up is its own job, which is what keeps it from being
      // dropped as a duplicate of the first: same conversation, same anchor, different identity.
      { kind: "FOLLOW_UP", followUpId: "fu_3", attempt: 2 },
    ]);
  });

  it("says nothing when nothing is due", async () => {
    const swept = await sweep([], {});

    // A quiet pass writes no summary, because a minute-by-minute "nothing to do" is a log nobody reads.
    expect(swept.claim).not.toHaveBeenCalled();
    expect(swept.enqueueAiDraftGeneration).not.toHaveBeenCalled();
    expect(swept.swept).toBeUndefined();
  });

  it("leaves a claim claimed when the enqueue fails, and reports the failure without the connection string", async () => {
    const swept = await sweep([due("fu_1")], { fu_1: ready("fu_1") }, { enqueueFails: true });

    // The lease is what makes this safe: the follow-up becomes claimable again when it lapses, and the
    // next claim settles it from the draft it finds — one lost lease rather than a lost or doubled
    // follow-up. The failure is reported by the error's name only.
    expect(swept.failed).toMatchObject({ errorName: "Error" });
    expect(swept.swept).toBeUndefined();
    expect(JSON.stringify(swept.lines)).not.toContain("hunter2");
  });
});
