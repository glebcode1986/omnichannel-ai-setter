import { describe, expect, it } from "vitest";

import { toUserId } from "@omnichannel/domain";

import { resolveReview, type ReviewClaim, type ReviewCommand, type ReviewDependencies } from "./resolve-review";

const NOW = new Date("2026-09-19T12:00:00.000Z");
const USER = { kind: "USER", userId: toUserId("01a0b40c-0000-7000-8000-000000000007") } as const;

const command = (overrides: Partial<ReviewCommand> = {}): ReviewCommand => ({
  scope: { workspaceId: "ws_1", businessProfileId: "bp_1", conversationId: "conv_1" },
  draftId: "draft_1",
  actor: USER,
  action: { kind: "APPROVE" },
  reviewMode: "NORMAL",
  ...overrides,
});

function harness(options: { claim?: ReviewClaim; styleFails?: boolean; inboundContext?: string | undefined } = {}) {
  const calls: string[] = [];
  const styled: { outboundText: string; sourceDraftId: string; approvedByUserId?: string }[] = [];
  const takeovers: { keepOwnership: boolean }[] = [];
  const logs: string[] = [];
  let claims = 0;

  const dependencies: ReviewDependencies = {
    reviews: {
      claimReview: () => {
        claims += 1;
        return Promise.resolve(options.claim ?? (claims === 1 ? { kind: "CLAIMED" } : { kind: "ALREADY_RESOLVED", byActor: USER }));
      },
      recordHumanEdit: (_draftId, text) => {
        calls.push(`edit:${text}`);
        return Promise.resolve();
      },
      scheduleDelivery: () => {
        calls.push("schedule");
        return Promise.resolve({ operationId: "op_1" });
      },
      dismiss: () => {
        calls.push("dismiss");
        return Promise.resolve();
      },
      setTakeover: (_conversationId, _actor, _at, keepOwnership) => {
        takeovers.push({ keepOwnership });
        return Promise.resolve();
      },
    },
    style: {
      recordEditedDraft: (input) => {
        if (options.styleFails === true) {
          return Promise.reject(new Error("style store is down"));
        }
        styled.push({ outboundText: input.outboundText, sourceDraftId: input.sourceDraftId, ...(input.approvedByUserId === undefined ? {} : { approvedByUserId: input.approvedByUserId }) });
        return Promise.resolve();
      },
    },
    log: { info: (event) => logs.push(event), warn: (event) => logs.push(event) },
    now: () => NOW,
    inboundContextFor: () => Promise.resolve("inboundContext" in options ? options.inboundContext : "Are you open Saturday?"),
  };
  return { dependencies, calls, styled, takeovers, logs };
}

describe("nothing here sends anything", () => {
  it("hands an approved draft to the delivery coordinator", async () => {
    const { dependencies, calls } = harness();

    const outcome = await resolveReview(dependencies, command());

    // The same route automation uses, with the same final revalidation. There is no second send path.
    expect(outcome).toEqual({ status: "SCHEDULED", operationId: "op_1", edited: false });
    expect(calls).toEqual(["schedule"]);
  });

  it("persists the human's wording before scheduling it", async () => {
    const { dependencies, calls } = harness();

    const outcome = await resolveReview(dependencies, command({ action: { kind: "EDIT", text: "We're open 10-6!", saveAsStyleExample: false } }));

    expect(outcome).toMatchObject({ status: "SCHEDULED", edited: true });
    expect(calls).toEqual(["edit:We're open 10-6!", "schedule"]);
  });
});

describe("two colleagues, one review item", () => {
  it("lets only the first decision count", async () => {
    const { dependencies, calls } = harness();

    const [first, second] = await Promise.all([resolveReview(dependencies, command()), resolveReview(dependencies, command())]);

    expect([first.status, second.status].sort()).toEqual(["ALREADY_RESOLVED", "SCHEDULED"]);
    // Only one delivery was scheduled: the loser's click changed nothing at all.
    expect(calls).toEqual(["schedule"]);
  });

  it("does nothing when the item was already resolved", async () => {
    const { dependencies, calls } = harness({ claim: { kind: "ALREADY_RESOLVED", byActor: USER } });

    expect(await resolveReview(dependencies, command())).toEqual({ status: "ALREADY_RESOLVED" });
    expect(calls).toEqual([]);
  });

  it("reports a vanished item rather than inventing one", async () => {
    const { dependencies, calls } = harness({ claim: { kind: "GONE" } });

    expect(await resolveReview(dependencies, command())).toEqual({ status: "GONE" });
    expect(calls).toEqual([]);
  });
});

describe("an edited reply teaches style, never facts", () => {
  it("records the final wording as a style example when asked", async () => {
    const { dependencies, styled } = harness();

    await resolveReview(dependencies, command({ action: { kind: "EDIT", text: "Saturdays we're open 10 till 6 😊", saveAsStyleExample: true } }));

    expect(styled).toEqual([
      { outboundText: "Saturdays we're open 10 till 6 😊", sourceDraftId: "draft_1", approvedByUserId: USER.userId },
    ]);
    // The port it is written through has no way to reach the factual corpus; the separation is structural.
    expect(Object.keys(dependencies.style)).toEqual(["recordEditedDraft"]);
  });

  it("does not record one unless the person asked", async () => {
    const { dependencies, styled } = harness();

    await resolveReview(dependencies, command({ action: { kind: "EDIT", text: "Sure thing.", saveAsStyleExample: false } }));

    expect(styled).toEqual([]);
  });

  it("still sends the reply when learning from it fails", async () => {
    const { dependencies, calls, logs } = harness({ styleFails: true });

    const outcome = await resolveReview(dependencies, command({ action: { kind: "EDIT", text: "Sure thing.", saveAsStyleExample: true } }));

    // Failing to learn must never cost the person the reply they actually asked for.
    expect(outcome.status).toBe("SCHEDULED");
    expect(calls).toContain("schedule");
    expect(logs).toContain("review.style_not_recorded");
  });

  it("skips learning when the original question is no longer available", async () => {
    const { dependencies, styled, logs } = harness({ inboundContext: undefined });

    await resolveReview(dependencies, command({ action: { kind: "EDIT", text: "Sure thing.", saveAsStyleExample: true } }));

    // A style example without the message it answers teaches the wrong lesson.
    expect(styled).toEqual([]);
    expect(logs).toContain("review.style_context_missing");
  });

  it("refuses an empty edit instead of silently approving the original", async () => {
    const { dependencies, calls } = harness();

    const outcome = await resolveReview(dependencies, command({ action: { kind: "EDIT", text: "   ", saveAsStyleExample: false } }));

    expect(outcome).toMatchObject({ status: "REJECTED" });
    expect(calls).toEqual([]);
  });
});

describe("ownership after the decision", () => {
  it("leaves the person holding the conversation when something goes out", async () => {
    const { dependencies, takeovers } = harness();

    await resolveReview(dependencies, command());

    expect(takeovers).toEqual([{ keepOwnership: true }]);
  });

  it("hands the conversation back when the draft is dismissed", async () => {
    const { dependencies, calls, takeovers } = harness();

    const outcome = await resolveReview(dependencies, command({ action: { kind: "DISMISS", note: "not relevant" } }));

    expect(outcome).toEqual({ status: "DISMISSED" });
    expect(calls).toEqual(["dismiss"]);
    expect(takeovers).toEqual([{ keepOwnership: false }]);
  });

  it("takes the conversation without sending anything when claimed", async () => {
    const { dependencies, calls, takeovers } = harness();

    expect(await resolveReview(dependencies, command({ action: { kind: "CLAIM" } }))).toEqual({ status: "CLAIMED" });
    expect(calls).toEqual([]);
    expect(takeovers).toEqual([{ keepOwnership: true }]);
  });
});

describe("the human-support exception", () => {
  it("still goes through the coordinator, which re-checks eligibility before dispatch", async () => {
    const { dependencies, calls, logs } = harness();

    const outcome = await resolveReview(dependencies, command({ reviewMode: "HUMAN_AGENT" }));

    // A deliberate human action is what makes the path available; it is not what makes it permitted.
    expect(outcome.status).toBe("SCHEDULED");
    expect(calls).toEqual(["schedule"]);
    expect(logs).toContain("review.scheduled");
  });
});
