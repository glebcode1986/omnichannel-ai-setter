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

import { afterWindowFor, capabilitiesFor, capabilityHintsFor, windowFor } from "./simulation";
import type { PolicyView } from "@omnichannel/db";

const POLICY = {
  instagramAfterWindowPolicy: "HUMAN_ASSISTED_EXTENDED",
  whatsappAfterWindowPolicy: "TEMPLATE_AUTOPILOT",
} as unknown as PolicyView;

const NOW = new Date("2026-09-01T10:00:00.000Z");

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
    const decision = windowFor({ channel: "INSTAGRAM", window: "OPEN", account: "CONNECTED" }, NOW);

    expect(decision.state).toBe("OPEN_FREEFORM");
    expect(decision.state === "OPEN_FREEFORM" ? (decision.expiresAt?.getTime() ?? 0) : 0).toBeGreaterThan(NOW.getTime());
  });

  it("is an expired window after it closes, not an ineligible one", () => {
    const decision = windowFor({ channel: "WHATSAPP", window: "AFTER", account: "CONNECTED" }, NOW);

    // A closed standard window is a window that *was* open, and the after-window policies exist to say
    // what may still happen then. `NOT_ELIGIBLE` would short-circuit the very gates this run exercises.
    expect(decision.state).toBe("OPEN_FREEFORM");
    expect(decision.state === "OPEN_FREEFORM" ? (decision.expiresAt?.getTime() ?? 0) : 0).toBeLessThan(NOW.getTime());
  });
});
