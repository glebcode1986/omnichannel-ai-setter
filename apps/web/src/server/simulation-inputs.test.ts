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

import { afterWindowFor, capabilitiesFor, capabilityHintsFor, humanAgentFor, windowFor } from "./simulation";
import type { SimulationInputs } from "./simulation";
import type { PolicyView } from "@omnichannel/db";

const POLICY = {
  instagramAfterWindowPolicy: "HUMAN_ASSISTED_EXTENDED",
  whatsappAfterWindowPolicy: "TEMPLATE_AUTOPILOT",
} as unknown as PolicyView;

const NOW = new Date("2026-09-01T10:00:00.000Z");

const INPUTS: SimulationInputs = { channel: "INSTAGRAM", window: "OPEN", account: "CONNECTED", humanSupport: "UNAVAILABLE" };

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

  it("is an expired window after it closes, not an ineligible one", () => {
    const decision = windowFor({ ...INPUTS, channel: "WHATSAPP", window: "AFTER" }, NOW);

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
  return evaluatePolicy({
    mode: "AUTOPILOT",
    aiEnabled: true,
    takeover: { state: "NONE" },
    draft: { usable: true, confidence: 0.95, reasonCodes: [], citedSourceIds: ["chunk-1"], contentType: "TEXT" },
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
    // vocabulary does not contain it, and choosing WhatsApp here must not smuggle it in.
    const whatsapp = decide({ ...INPUTS, channel: "WHATSAPP", window: "AFTER", humanSupport: "AVAILABLE" }, POLICY);

    expect(whatsapp.reasons).toEqual(["WINDOW_CLOSED"]);
  });

  it("refuses on a disconnected account whatever the window says", () => {
    const decision = decide({ ...INPUTS, account: "DISCONNECTED" }, POLICY);

    expect(decision.action).not.toBe("SCHEDULE");
  });
});
