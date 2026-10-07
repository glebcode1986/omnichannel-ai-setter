import { describe, expect, it } from "vitest";

import type { ReviewMode } from "@omnichannel/domain";

import { resolveReview, type ReviewCommand, type ReviewDecision, type ReviewDependencies, type StyleLearningInput } from "./resolve-review";

const NOW = new Date("2026-09-19T12:00:00.000Z");

const command = (overrides: Partial<ReviewCommand> = {}): ReviewCommand => ({
  scope: { workspaceId: "ws_1", businessProfileId: "bp_1", conversationId: "conv_1" },
  draftId: "draft_1",
  action: { kind: "APPROVE" },
  reviewMode: "NORMAL",
  ...overrides,
});

function harness(
  options: { decision?: ReviewDecision; replayed?: boolean; styleFails?: boolean; contextFails?: boolean; inboundContext?: string | undefined } = {},
) {
  const calls: string[] = [];
  const styled: { outboundText: string; sourceDraftId: string; kind: "verified" | "suggested" }[] = [];
  const scheduled: { reviewMode: ReviewMode; saveAsStyleExample: boolean; editedText?: string }[] = [];
  const logs: string[] = [];
  let decisions = 0;

  /** Each of these is one committed decision, so the double is one call and one answer. */
  const answer = (kind: "SCHEDULED" | "DISMISSED" | "CLAIMED", operationId = "op_1"): ReviewDecision => {
    decisions += 1;
    if (options.decision !== undefined) {
      return options.decision;
    }
    if (decisions > 1) {
      return { kind: "ALREADY_RESOLVED" };
    }
    return kind === "SCHEDULED" ? { kind: "SCHEDULED", operationId, replayed: options.replayed ?? false } : { kind };
  };

  const learn = (kind: "verified" | "suggested", input: StyleLearningInput) => {
    calls.push(`style:${kind}`);
    if (options.styleFails === true) {
      return Promise.reject(new Error("style store is down"));
    }
    styled.push({ outboundText: input.outboundText, sourceDraftId: input.sourceDraftId, kind });
    return Promise.resolve();
  };

  const dependencies: ReviewDependencies = {
    reviews: {
      resolveApproval: (input) => {
        calls.push(input.decision.editedText === undefined ? "schedule" : `edit:${input.decision.editedText}`);
        scheduled.push(input.decision);
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
      // Recorded in the same list as the decision, so the *order* of the two is assertable: nothing is
      // learned from a reply until the reply itself is committed. The two writes are told apart, because
      // which one an edit reaches is the difference between a voice in use and one awaiting judgement.
      recordEditedDraft: (input) => learn("verified", input),
      suggestEditedDraft: (input) => learn("suggested", input),
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
    // The suggestion that follows is a separate write, after the commit, and it is why there are two
    // entries rather than one: the correction is kept, and it is kept as something nobody has approved.
    expect(calls).toEqual(["edit:We're open 10-6!", "style:suggested"]);
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
    const { dependencies, calls } = harness({ decision: { kind: "ALREADY_RESOLVED" } });

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
      { outboundText: "Saturdays we're open 10 till 6 😊", sourceDraftId: "draft_1", kind: "verified" },
    ]);
    // The port it is written through has no way to reach the factual corpus; the separation is structural.
    // Both of its calls write style examples and neither can write anything else.
    expect(Object.keys(dependencies.style)).toEqual(["recordEditedDraft", "suggestEditedDraft"]);
  });

  it("keeps a correction nobody vouched for as a suggestion, not as a verified example", async () => {
    const { dependencies, styled } = harness();

    await resolveReview(dependencies, command({ action: { kind: "EDIT", text: "Sure thing.", saveAsStyleExample: false } }));

    // Both halves matter. Discarding it — which is what used to happen — threw away the only evidence the
    // assistant gets from having been corrected, and left the suggestion list with no producer at all.
    // Recording it as verified would let one operator's rewording shape every later reply with nobody
    // having agreed to it.
    expect(styled).toEqual([{ outboundText: "Sure thing.", sourceDraftId: "draft_1", kind: "suggested" }]);
  });

  it("learns from the wording only after the send it belongs to is committed", async () => {
    const { dependencies, calls } = harness();

    await resolveReview(dependencies, command({ action: { kind: "EDIT", text: "We're open 10-6!", saveAsStyleExample: true } }));

    // The decision first, the learning after. Attempted first, a slow or failing style store would stand
    // between a person's click and the reply they asked for.
    expect(calls).toEqual(["edit:We're open 10-6!", "style:verified"]);
  });

  it("does not learn the same wording twice when a decision is replayed", async () => {
    const { dependencies, styled } = harness({ replayed: true });

    await resolveReview(dependencies, command({ action: { kind: "EDIT", text: "Sure thing.", saveAsStyleExample: true } }));

    // The store found this decision already committed, so nothing new was sent — and one sentence counted
    // twice would weight it twice in every later answer.
    expect(styled).toEqual([]);
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
    expect(calls).toEqual(["edit:Sure thing.", "style:verified"]);
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

    expect(calls).toEqual(["edit:We're open 10-6!", "style:suggested"]);
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

describe("who is acting is not the caller's to say", () => {
  it("has nowhere in a command to name a person", () => {
    // A compile-time property, asserted here so it is not quietly given back. A command that could name
    // someone is a claim about identity made by whoever built it, and a caller that can name anybody can
    // approve a reply as a colleague who never signed in.
    const named = { ...command(), actor: { kind: "USER", userId: "someone-else" } };
    expect(Object.keys(command())).not.toContain("actor");
    expect(Object.keys(named)).toContain("actor");
  });

  it("asks the store for the send without telling it whose it is", async () => {
    const { dependencies, scheduled } = harness();

    await resolveReview(dependencies, command({ reviewMode: "HUMAN_AGENT" }));

    // Only *which* send is authorized travels from here. The *who* is the store's own authenticated
    // identity, taken from the authorization the request was issued under.
    expect(scheduled).toEqual([{ reviewMode: "HUMAN_AGENT", saveAsStyleExample: false }]);
  });
});

describe("the authority a decision grants", () => {
  it("carries the human-support intent, which is not the same authority as an ordinary reply", async () => {
    const { dependencies, scheduled, logs } = harness();

    const outcome = await resolveReview(dependencies, command({ reviewMode: "HUMAN_AGENT" }));

    // A deliberate human action is what makes the path available; it is not what makes it permitted. The
    // coordinator still re-checks eligibility immediately before dispatch. Which send was authorized is
    // part of the authority the store records, because approving an ordinary reply is not agreeing to a
    // tagged one.
    expect(outcome.status).toBe("SCHEDULED");
    expect(scheduled).toEqual([{ reviewMode: "HUMAN_AGENT", saveAsStyleExample: false }]);
    expect(logs).toContain("review.scheduled");
  });
});
