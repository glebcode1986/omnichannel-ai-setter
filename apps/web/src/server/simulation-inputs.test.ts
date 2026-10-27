/**
 * What the playground's hypothetical facts turn into (Issue #30, R5 finding 6).
 *
 * The finding was that none of this existed: every run was Instagram, on a connected account, inside an
 * open free-form window, so the WhatsApp settings could not affect the answer and neither Instagram
 * after-window choice was ever exercised — while the screen claimed to show the expected send/review path
 * for the saved configuration.
 *
 * These four mappings are where a chosen fact becomes an input to the deterministic evaluator, so each is
 * pinned here. The run itself needs a model and a corpus; the mapping does not, and the mapping is the
 * part that was wrong.
 */
import { describe, expect, it } from "vitest";

import { evaluatePolicy } from "@omnichannel/application";
import { NO_STAGED_ROLLOUT } from "@omnichannel/domain";

import { afterWindowFor, capabilitiesFor, capabilityHintsFor, humanAgentFor, templateRouteFor, windowFor } from "./simulation";
import type { SimulationInputs } from "./simulation";
import type { PolicyView } from "@omnichannel/db";

const POLICY = {
  instagramAfterWindowPolicy: "HUMAN_ASSISTED_EXTENDED",
  whatsappAfterWindowPolicy: "TEMPLATE_AUTOPILOT",
} as unknown as PolicyView;

const NOW = new Date("2026-09-01T10:00:00.000Z");

const INPUTS: SimulationInputs = {
  channel: "INSTAGRAM",
  window: "OPEN",
  account: "CONNECTED",
  humanSupport: "UNAVAILABLE",
  replyKind: "ORDINARY",
  templateName: "",
};

describe("the after-window policy a run is judged against", () => {
  it("is the chosen channel's own", () => {
    // The union is per channel precisely so a WhatsApp conversation cannot be judged against an
    // Instagram policy; reading the Instagram field whatever the channel was that mistake by hand.
    expect(afterWindowFor("WHATSAPP", POLICY)).toEqual({ channel: "WHATSAPP", policy: "TEMPLATE_AUTOPILOT" });
    expect(afterWindowFor("INSTAGRAM", POLICY)).toEqual({ channel: "INSTAGRAM", policy: "HUMAN_ASSISTED_EXTENDED" });
  });
});

describe("the capabilities a run assumes", () => {
  it("gives WhatsApp templates and Instagram none", () => {
    // Without this, `TEMPLATE_REVIEW` and `TEMPLATE_AUTOPILOT` are unreachable from the playground: the
    // capability gate refuses a template on an account that cannot send one, whatever the policy says.
    expect(capabilitiesFor("WHATSAPP").templates).toBe(true);
    expect(capabilitiesFor("INSTAGRAM").templates).toBe(false);
  });

  it("lets both channels send text, since a reply is text", () => {
    expect(capabilitiesFor("WHATSAPP").text).toBe(true);
    expect(capabilitiesFor("INSTAGRAM").text).toBe(true);
  });

  it("names the same facts in the hints the prompt gets", () => {
    // Two statements of the same thing would drift; this at least fails when they do.
    for (const channel of ["INSTAGRAM", "WHATSAPP"] as const) {
      const capabilities = capabilitiesFor(channel);
      for (const hint of capabilityHintsFor(channel)) {
        expect(capabilities[hint as keyof typeof capabilities], `${channel} hints ${hint} it cannot do`).toBe(true);
      }
    }
  });
});

describe("the messaging window a run assumes", () => {
  it("is open and unexpired inside the standard window", () => {
    const decision = windowFor(INPUTS, NOW);

    expect(decision.state).toBe("OPEN_FREEFORM");
    expect(decision.state === "OPEN_FREEFORM" ? (decision.expiresAt?.getTime() ?? 0) : 0).toBeGreaterThan(NOW.getTime());
  });

  it("is template-only once WhatsApp's service window closes", () => {
    const decision = windowFor({ ...INPUTS, channel: "WHATSAPP", window: "AFTER" }, NOW);

    // The state the template gate keys on. Modelling it as an expired free-form window — which the first
    // version of this repair did — made every WhatsApp after-window answer identical and the three modes
    // indistinguishable, because the gate never ran.
    expect(decision.state).toBe("TEMPLATE_ONLY");
  });

  it("is an expired window after Instagram's closes, not an ineligible one", () => {
    const decision = windowFor({ ...INPUTS, channel: "INSTAGRAM", window: "AFTER" }, NOW);

    // A closed standard window is a window that *was* open, and the after-window policies exist to say
    // what may still happen then. `NOT_ELIGIBLE` would short-circuit the very gates this run exercises.
    expect(decision.state).toBe("OPEN_FREEFORM");
    expect(decision.state === "OPEN_FREEFORM" ? (decision.expiresAt?.getTime() ?? 0) : 0).toBeLessThan(NOW.getTime());
  });
});

/**
 * What the run would decide, assembled exactly as `runSimulation` assembles it.
 *
 * The real evaluator, not a model of it: the point of these cases is that a *chosen input* changes the
 * outcome an owner is shown, and a test that recomputed the decision itself would prove only that this
 * file is self-consistent. The draft is fixed and comfortably sendable — high confidence, no reason codes,
 * a cited source that was supplied — so every difference below comes from the inputs and nothing else.
 */
function decide(inputs: SimulationInputs, policy: PolicyView) {
  const route = templateRouteFor(inputs, policy);
  return evaluatePolicy({
    mode: "AUTOPILOT",
    aiEnabled: true,
    takeover: { state: "NONE" },
    // Fully permitted, deliberately. `commercial` is required on `PolicyInput` so the compiler names
    // every caller that has to decide, and this file's cases are about a chosen *simulation input*
    // changing the outcome. A restrictive value here would have the billing gate refuse every case, and
    // the suite would pass while proving nothing about the inputs it exists to compare.
    commercial: { paidWorkAllowed: true, aiDrafts: true, autopilot: true },
    // And the staged rollout, for exactly the same reason and arriving with the P7-02 merge: `rollout`
    // became required on `PolicyInput`, so the compiler names every caller that has to decide. A posture
    // that withheld autopilot would make the rollout gate refuse every case here and the suite would pass
    // while proving nothing about the simulation inputs it exists to compare. `NO_STAGED_ROLLOUT` is the
    // posture of a deployment with no staged release in force, which is what a test database is.
    rollout: NO_STAGED_ROLLOUT,
    draft: {
      usable: true,
      confidence: 0.95,
      reasonCodes: [],
      citedSourceIds: ["chunk-1"],
      contentType: inputs.replyKind === "TEMPLATE" ? "TEMPLATE" : "TEXT",
    },
    retrieval: { suppliedSourceIds: ["chunk-1"], corpusReachable: true },
    limits: {
      confidenceThreshold: 0.8,
      mandatoryReviewReasons: [],
      afterWindow: afterWindowFor(inputs.channel, policy),
    },
    account: inputs.account,
    capabilities: capabilitiesFor(inputs.channel),
    window: windowFor(inputs, NOW),
    humanAgent: humanAgentFor(inputs, NOW),
    ...(route === undefined ? {} : { templateRoute: route }),
    replyCycle: "OWNED",
    now: NOW,
  });
}

describe("whether a chosen input can change the answer at all", () => {
  it("sends inside the window and refuses outside it", () => {
    expect(decide(INPUTS, POLICY).action).toBe("SCHEDULE");

    const closed = decide({ ...INPUTS, window: "AFTER" }, POLICY);
    expect(closed.action).not.toBe("SCHEDULE");
    expect(closed.reasons).toContain("WINDOW_CLOSED");
  });

  it("distinguishes both Instagram after-window modes once the window has closed", () => {
    // This is the pair the finding was about. Under STANDARD_ONLY a closed window is the end of it;
    // under HUMAN_ASSISTED_EXTENDED, with the exception live, the same draft becomes a human-only review
    // path instead. With the exception hard-coded unavailable — as it was — both produced `WINDOW_CLOSED`
    // and nothing an owner selected here could change a single answer.
    const standard = decide(
      { ...INPUTS, window: "AFTER", humanSupport: "AVAILABLE" },
      { ...POLICY, instagramAfterWindowPolicy: "STANDARD_ONLY" },
    );
    const extended = decide({ ...INPUTS, window: "AFTER", humanSupport: "AVAILABLE" }, POLICY);

    expect(standard.reasons).toEqual(["WINDOW_CLOSED"]);
    expect(extended.reasons).toContain("HUMAN_AGENT_REVIEW_REQUIRED");
    expect(extended.action).toBe("HOLD_REVIEW");
  });

  it("keeps the human-support path unreachable without the exception", () => {
    // `HUMAN_ASSISTED_EXTENDED` plus no live exception is not a weaker form of approval, and the
    // playground must not suggest a path the adapter would refuse at dispatch.
    const extended = decide({ ...INPUTS, window: "AFTER", humanSupport: "UNAVAILABLE" }, POLICY);

    expect(extended.reasons).toEqual(["WINDOW_CLOSED"]);
  });

  it("keeps the human-support path unreachable on WhatsApp, exception or not", () => {
    // The exception is Instagram's. The union is what stops it being reachable on a channel whose policy
    // vocabulary does not contain it, and choosing WhatsApp here must not smuggle it in — so the refusal
    // is about the template route rather than offering a human-agent review.
    const whatsapp = decide({ ...INPUTS, channel: "WHATSAPP", window: "AFTER", humanSupport: "AVAILABLE" }, POLICY);

    expect(whatsapp.reasons).not.toContain("HUMAN_AGENT_REVIEW_REQUIRED");
    expect(whatsapp.reasons).toContain("WINDOW_CLOSED");
  });

  it("refuses on a disconnected account whatever the window says", () => {
    const decision = decide({ ...INPUTS, account: "DISCONNECTED" }, POLICY);

    expect(decision.action).not.toBe("SCHEDULE");
  });
});

describe("the WhatsApp template route", () => {
  /** Outside the service window, sending an approved template named `booking_reminder`. */
  const sendingTemplate = {
    ...INPUTS,
    channel: "WHATSAPP",
    window: "AFTER",
    replyKind: "TEMPLATE",
    templateName: "booking_reminder",
  } as const satisfies SimulationInputs;

  const withAllowlist = (allowlist: readonly string[], mode = "TEMPLATE_AUTOPILOT") =>
    ({ ...POLICY, whatsappAfterWindowPolicy: mode, whatsappTemplateAutomationAllowlist: allowlist }) as unknown as PolicyView;

  it("is only offered to the channel that has one", () => {
    // Absent on Instagram, and absent is not a weaker form of "available": the gate treats it as no route.
    expect(templateRouteFor({ ...sendingTemplate, channel: "INSTAGRAM" }, POLICY)).toBeUndefined();
    expect(templateRouteFor(sendingTemplate, withAllowlist(["booking_reminder"]))).toEqual({
      approvedTemplateAvailable: true,
      automatable: true,
    });
  });

  it("reads the owner's saved allowlist and nothing else", () => {
    expect(templateRouteFor(sendingTemplate, withAllowlist([]))?.automatable).toBe(false);
    expect(templateRouteFor(sendingTemplate, withAllowlist(["something_else"]))?.automatable).toBe(false);
    expect(templateRouteFor(sendingTemplate, withAllowlist(["booking_reminder"]))?.automatable).toBe(true);
  });

  it("makes an empty allowlist and a non-empty one decide differently", () => {
    // The finding. With the allowlist unread, these two produced the same answer, so nothing an owner
    // typed into the allowlist could change what this screen told them.
    const empty = decide(sendingTemplate, withAllowlist([]));
    const listed = decide(sendingTemplate, withAllowlist(["booking_reminder"]));

    expect(empty.action).toBe("HOLD_REVIEW");
    expect(empty.reasons).toContain("TEMPLATE_REQUIRED");
    expect(listed.action).toBe("SCHEDULE");
    expect(listed.reasons).toEqual([]);
  });

  it("distinguishes the three WhatsApp modes with the same allowlist", () => {
    const allowlist = ["booking_reminder"];

    // SERVICE_WINDOW_ONLY has no template route at all: the window simply closed.
    const serviceOnly = decide(sendingTemplate, withAllowlist(allowlist, "SERVICE_WINDOW_ONLY"));
    expect(serviceOnly.reasons).toEqual(["WINDOW_CLOSED"]);

    // TEMPLATE_REVIEW allows the template only once a person has approved it, so unattended it holds.
    const review = decide(sendingTemplate, withAllowlist(allowlist, "TEMPLATE_REVIEW"));
    expect(review.action).toBe("HOLD_REVIEW");
    expect(review.reasons).toContain("TEMPLATE_REQUIRED");

    // TEMPLATE_AUTOPILOT with the template allowlisted is the one case that may go out unattended.
    expect(decide(sendingTemplate, withAllowlist(allowlist, "TEMPLATE_AUTOPILOT")).action).toBe("SCHEDULE");
  });

  it("ends the matter when no template is named at all", () => {
    // A dead end rather than a review item: with nothing sendable, there is nothing for a person to do
    // either, and a review item nobody can resolve is worse than an empty queue.
    const nothing = decide({ ...sendingTemplate, templateName: "   " }, withAllowlist(["booking_reminder"]));

    expect(nothing.reasons).toContain("NO_ELIGIBLE_TEMPLATE");
  });

  it("asks for a template when an ordinary reply is proposed outside the service window", () => {
    const ordinary = decide({ ...sendingTemplate, replyKind: "ORDINARY" }, withAllowlist(["booking_reminder"]));

    // An ordinary reply is not a route once the service window has closed, whatever the allowlist says.
    expect(ordinary.reasons).toContain("TEMPLATE_REQUIRED");
    expect(ordinary.action).toBe("HOLD_REVIEW");
  });

  it("still refuses inside an open window on a disconnected account", () => {
    // The template route is reached only once the window has closed; it must not become a way around the
    // other gates.
    const disconnected = decide({ ...sendingTemplate, account: "DISCONNECTED" }, withAllowlist(["booking_reminder"]));

    expect(disconnected.action).not.toBe("SCHEDULE");
  });
});
