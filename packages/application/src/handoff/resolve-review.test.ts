import { describe, expect, it } from "vitest";

import { toUserId, type SendAuthority } from "@omnichannel/domain";

import { resolveReview, type ReviewCommand, type ReviewDecision, type ReviewDependencies } from "./resolve-review";

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

function harness(options: { decision?: ReviewDecision; styleFails?: boolean; contextFails?: boolean; inboundContext?: string | undefined } = {}) {
  const calls: string[] = [];
  const styled: { outboundText: string; sourceDraftId: string; approvedByUserId?: string }[] = [];
  const scheduled: { authority: SendAuthority; editedText?: string }[] = [];
  const logs: string[] = [];
  let decisions = 0;

  /** Each of these is one committed decision, so the double is one call and one answer. */
  const answer = (kind: "SCHEDULED" | "DISMISSED" | "CLAIMED", operationId = "op_1"): ReviewDecision => {
    decisions += 1;
    if (options.decision !== undefined) {
      return options.decision;
    }
    if (decisions > 1) {
      return { kind: "ALREADY_RESOLVED", byActor: USER };
    }
    return kind === "SCHEDULED" ? { kind: "SCHEDULED", operationId } : { kind };
  };

  const dependencies: ReviewDependencies = {
    reviews: {
      resolveApproval: (input) => {
        calls.push(input.editedText === undefined ? "schedule" : `edit:${input.editedText}`);
        scheduled.push({ authority: input.authority, ...(input.editedText === undefined ? {} : { editedText: input.editedText }) });
        return Promise.resolve(answer("SCHEDULED"));
      },
      resolveDismissal: () => {
        calls.push("dismiss");
        return Promise.resolve(answer("DISMISSED"));
      },
      resolveClaim: () => {
        calls.push("claim");
        return Promise.resolve(answer("CLAIMED"));
      },
    },
    style: {
      recordEditedDraft: (input) => {
        // Recorded in the same list as the decision, so the *order* of the two is assertable: nothing is
        // learned from a reply until the reply itself is committed.
        calls.push("style");
        if (options.styleFails === true) {
          return Promise.reject(new Error("style store is down"));
        }
        styled.push({ outboundText: input.outboundText, sourceDraftId: input.sourceDraftId, ...(input.approvedByUserId === undefined ? {} : { approvedByUserId: input.approvedByUserId }) });
        return Promise.resolve();
      },
    },
    log: { info: (event) => logs.push(event), warn: (event) => logs.push(event) },
    now: () => NOW,
    inboundContextFor: () =>
      options.contextFails === true
        ? Promise.reject(new Error("the conversation store is down"))
        : Promise.resolve("inboundContext" in options ? options.inboundContext : "Are you open Saturday?"),
  };
  return { dependencies, calls, styled, scheduled, logs };
}

describe("nothing here sends anything", () => {
  it("hands an approved draft to the delivery coordinator", async () => {
    const { dependencies, calls } = harness();

    const outcome = await resolveReview(dependencies, command());

    // The same route automation uses, with the same final revalidation. There is no second send path.
    expect(outcome).toEqual({ status: "SCHEDULED", operationId: "op_1", edited: false });
    expect(calls).toEqual(["schedule"]);
  });

  it("persists the human's wording in the same write that schedules it", async () => {
    const { dependencies, calls } = harness();

    const outcome = await resolveReview(dependencies, command({ action: { kind: "EDIT", text: "We're open 10-6!", saveAsStyleExample: false } }));

    // Not two calls: the wording and the send it authorizes commit together, or a crash between them
    // leaves a reply nobody agreed to next to a claim nobody can retry.
    expect(outcome).toMatchObject({ status: "SCHEDULED", edited: true });
    expect(calls).toEqual(["edit:We're open 10-6!"]);
  });
});

describe("two colleagues, one review item", () => {
  it("lets only the first decision count", async () => {
    const { dependencies, calls } = harness();

    const [first, second] = await Promise.all([resolveReview(dependencies, command()), resolveReview(dependencies, command())]);

    expect([first.status, second.status].sort()).toEqual(["ALREADY_RESOLVED", "SCHEDULED"]);
    // Both asked; the database answered once. Only one of them was told it had scheduled anything, and the
    // loser's click changed nothing at all.
    expect(calls).toEqual(["schedule", "schedule"]);
  });

  it("does nothing when the item was already resolved", async () => {
    const { dependencies, calls } = harness({ decision: { kind: "ALREADY_RESOLVED", byActor: USER } });

    expect(await resolveReview(dependencies, command())).toEqual({ status: "ALREADY_RESOLVED" });
    // The store was asked, and answered that the decision was not this caller's to make.
    expect(calls).toEqual(["schedule"]);
  });

  it("reports a vanished item rather than inventing one", async () => {
    const { dependencies, calls } = harness({ decision: { kind: "GONE" } });

    expect(await resolveReview(dependencies, command())).toEqual({ status: "GONE" });
    expect(calls).toEqual(["schedule"]);
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

  it("learns from the wording only after the send it belongs to is committed", async () => {
    const { dependencies, calls } = harness();

    await resolveReview(dependencies, command({ action: { kind: "EDIT", text: "We're open 10-6!", saveAsStyleExample: true } }));

    // The decision first, the learning after. Attempted first, a slow or failing style store would stand
    // between a person's click and the reply they asked for.
    expect(calls).toEqual(["edit:We're open 10-6!", "style"]);
  });

  it("still sends the reply when even looking up the context fails", async () => {
    const { dependencies, calls, logs } = harness({ contextFails: true });

    const outcome = await resolveReview(dependencies, command({ action: { kind: "EDIT", text: "Sure thing.", saveAsStyleExample: true } }));

    // Learning is best effort and it runs after the decision has committed, so nothing it can do reaches
    // the reply. Were it attempted first, this failure would have cost the person their click.
    expect(outcome.status).toBe("SCHEDULED");
    expect(calls).toEqual(["edit:Sure thing."]);
    expect(logs).toContain("review.style_not_recorded");
  });

  it("still sends the reply when learning from it fails", async () => {
    const { dependencies, calls, logs } = harness({ styleFails: true });

    const outcome = await resolveReview(dependencies, command({ action: { kind: "EDIT", text: "Sure thing.", saveAsStyleExample: true } }));

    // Failing to learn must never cost the person the reply they actually asked for — and by now it
    // cannot, because the send was committed before the style store was ever called.
    expect(outcome.status).toBe("SCHEDULED");
    expect(calls).toEqual(["edit:Sure thing.", "style"]);
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

describe("one decision, one write", () => {
  it("asks the store for the whole approval rather than assembling it here", async () => {
    const { dependencies, calls, scheduled } = harness();

    await resolveReview(dependencies, command());

    // One call, because the claim, the wording, the authority, the delivery and the ownership are one
    // decision. Assembled here, a crash between the parts left a draft claimed with nothing done — and the
    // retry is told somebody already resolved it.
    expect(calls).toEqual(["schedule"]);
    expect(scheduled).toHaveLength(1);
  });

  it("carries the person's own wording into that same write", async () => {
    const { dependencies, calls, scheduled } = harness();

    await resolveReview(dependencies, command({ action: { kind: "EDIT", text: "We're open 10-6!", saveAsStyleExample: false } }));

    expect(calls).toEqual(["edit:We're open 10-6!"]);
    expect(scheduled[0]?.editedText).toBe("We're open 10-6!");
  });

  it("hands the conversation back when the draft is dismissed", async () => {
    const { dependencies, calls } = harness();

    const outcome = await resolveReview(dependencies, command({ action: { kind: "DISMISS", note: "not relevant" } }));

    expect(outcome).toEqual({ status: "DISMISSED" });
    expect(calls).toEqual(["dismiss"]);
  });

  it("takes the conversation without sending anything when claimed", async () => {
    const { dependencies, calls } = harness();

    expect(await resolveReview(dependencies, command({ action: { kind: "CLAIM" } }))).toEqual({ status: "CLAIMED" });
    expect(calls).toEqual(["claim"]);
  });

  it("refuses a draft that belongs to a different conversation", async () => {
    const { dependencies } = harness({ decision: { kind: "FOREIGN_CONVERSATION" } });

    const outcome = await resolveReview(dependencies, command());

    // Approving it would take ownership of one conversation and send into another: not one action.
    expect(outcome).toMatchObject({ status: "REJECTED" });
  });
});

describe("only a person can authorize a send", () => {
  for (const actor of [{ kind: "SYSTEM" }, { kind: "NATIVE_APP" }] as const) {
    it(`refuses an approval from ${actor.kind} before anything is claimed`, async () => {
      const { dependencies, calls, logs } = harness();

      const outcome = await resolveReview(dependencies, command({ actor }));

      // Human activity for the purpose of takeover is not the authority to send: neither of these can look
      // at a draft and decide it may go out. Refused before the claim, so nothing is left half-resolved.
      expect(outcome).toMatchObject({ status: "REJECTED" });
      expect(calls).toEqual([]);
      expect(logs).toContain("review.actor_cannot_approve");
    });

    it(`refuses an edit from ${actor.kind} too`, async () => {
      const { dependencies, calls } = harness();

      const outcome = await resolveReview(dependencies, command({ actor, action: { kind: "EDIT", text: "we open at 10", saveAsStyleExample: true } }));

      expect(outcome).toMatchObject({ status: "REJECTED" });
      expect(calls).toEqual([]);
    });

    it(`still lets ${actor.kind} claim and dismiss, which is takeover rather than authority`, async () => {
      const claiming = harness();
      expect(await resolveReview(claiming.dependencies, command({ actor, action: { kind: "CLAIM" } }))).toEqual({ status: "CLAIMED" });

      const dismissing = harness();
      expect(await resolveReview(dismissing.dependencies, command({ actor, action: { kind: "DISMISS" } }))).toEqual({ status: "DISMISSED" });
    });
  }
});

describe("the authority a decision grants", () => {
  it("records who approved it, when, and which send they authorized", async () => {
    const { dependencies, scheduled } = harness();

    await resolveReview(dependencies, command());

    // Persisted with the delivery, because the send happens later and in another process. An approval
    // that lived only in this call would arrive there as automation — which is how the human-support
    // path became unreachable and how a DRAFT-mode approval held itself.
    expect(scheduled.map((entry) => entry.authority)).toEqual([
      { kind: "HUMAN_APPROVED", approvedByUserId: USER.userId, approvedAt: NOW, reviewMode: "NORMAL" },
    ]);
  });

  it("carries the human-support intent, which is not the same authority as an ordinary reply", async () => {
    const { dependencies, scheduled, logs } = harness();

    const outcome = await resolveReview(dependencies, command({ reviewMode: "HUMAN_AGENT" }));

    // A deliberate human action is what makes the path available; it is not what makes it permitted. The
    // coordinator still re-checks eligibility immediately before dispatch.
    expect(outcome.status).toBe("SCHEDULED");
    expect(scheduled.map((entry) => entry.authority)).toEqual([
      { kind: "HUMAN_APPROVED", approvedByUserId: USER.userId, approvedAt: NOW, reviewMode: "HUMAN_AGENT" },
    ]);
    expect(logs).toContain("review.scheduled");
  });
});
