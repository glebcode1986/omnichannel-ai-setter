/**
 * What the Style test sends, and what it makes of what comes back (Issue #32).
 *
 * The screen shipped as a retrieval browser: it listed the examples retrieval would pick and never
 * produced the candidate output or the effective instructions the spec asks this surface for. These cover
 * the three pieces that were missing, and the two properties that make the addition safe — the request
 * carries no facts and no way to send.
 */
import { PLATFORM_STYLE_FALLBACK, type StyleProfileLayer } from "@omnichannel/domain";
import type { BusinessProfileContext } from "@omnichannel/db";
import { describe, expect, it } from "vitest";

import { candidateFrom, effectiveVoiceOf, styleTestRequest, STYLE_TEST_PROMPT_VERSION } from "./style-test";

const CONTEXT = {
  userId: "user-1",
  workspaceId: "ws-1",
  businessProfileId: "bp-1",
  role: "OWNER",
} as unknown as BusinessProfileContext;

const FALLBACK_PERSONA = "You are the business's own assistant.";

const OUTPUT = {
  reply: "We open at ten on Saturdays.",
  confidence: 0.8,
  should_send: true,
  needs_review: false,
  reason_codes: [],
  intent: null,
  lead_stage: null,
  suggested_action: null,
  factual_source_ids: [],
};

const result = (overrides: Record<string, unknown> = {}) => ({
  output: OUTPUT,
  provider: "anthropic",
  model: "claude-opus-5",
  latencyMs: 12,
  ...overrides,
});

describe("the voice the test previews", () => {
  it("merges the layers field by field, later layers winning", () => {
    const layers: readonly StyleProfileLayer[] = [
      { persona: "Base persona", signOff: "— the team", replyLength: "LONG" },
      { persona: "This profile's persona" },
    ];

    const voice = effectiveVoiceOf(layers, FALLBACK_PERSONA);

    expect(voice.persona).toBe("This profile's persona");
    // The override said nothing about either, so the base layer's answers survive. A profile that only
    // wants a different persona must not silently lose its sign-off.
    expect(voice.signOff).toBe("— the team");
    expect(voice.replyLength).toBe("LONG");
  });

  it("falls back to the deployment's persona, not the platform's, where no layer has an opinion", () => {
    // The worker drafts with AI_PERSONA underneath. A preview that fell through to the library's own
    // constant would show a voice no reply is ever written in — the same mistake as a retrieval tester
    // configured differently from the retriever.
    const voice = effectiveVoiceOf([], FALLBACK_PERSONA);

    expect(voice.persona).toBe(FALLBACK_PERSONA);
    expect(voice.persona).not.toBe(PLATFORM_STYLE_FALLBACK.persona);
    // Everything the fallback does not speak to still comes from the platform default, so the resolved
    // profile is complete rather than half-decided.
    expect(voice.replyLength).toBe(PLATFORM_STYLE_FALLBACK.replyLength);
    expect(voice.emoji).toBe(PLATFORM_STYLE_FALLBACK.emoji);
  });

  it("keeps an absent language absent rather than inventing one", () => {
    expect(effectiveVoiceOf([{ persona: "P" }], FALLBACK_PERSONA).language).toBeUndefined();
  });
});

describe("the request the Style test sends", () => {
  const request = (query: string, style: readonly { readonly exampleId: string; readonly text: string }[] = []) =>
    styleTestRequest({ context: CONTEXT, styleProfile: { ...PLATFORM_STYLE_FALLBACK }, style, query });

  it("carries no knowledge at all", () => {
    // The contract this screen is held to: a style test must not imply that style examples establish
    // business facts. A candidate written with no facts in front of it cannot borrow authority from one.
    expect(request("When do you open?", [{ exampleId: "ex-1", text: "We open at ten." }]).knowledge).toEqual([]);
  });

  it("passes the retrieved examples as style, with their identifiers", () => {
    const sent = request("When do you open?", [{ exampleId: "ex-1", text: "We open at ten." }]);

    expect(sent.style).toEqual([{ exampleId: "ex-1", text: "We open at ten." }]);
  });

  it("puts the operator's own sentence in as the customer's message", () => {
    const sent = request("Do you deliver?");

    expect(sent.inbound).toHaveLength(1);
    expect(sent.inbound[0]?.kind).toBe("INBOUND");
    expect(sent.inbound[0]?.text).toBe("Do you deliver?");
    // Nothing earlier is replayed: there is no conversation, so there is no history to replay.
    expect(sent.history).toEqual([]);
  });

  it("names itself as its own prompt version", () => {
    expect(request("Hello").promptVersion).toBe(STYLE_TEST_PROMPT_VERSION);
    expect(STYLE_TEST_PROMPT_VERSION).not.toBe("");
  });

  it("gives each run a fence marker the text cannot close", () => {
    const first = request("Hello");
    const second = request("Hello");

    expect(first.nonce).not.toBe(second.nonce);
    expect(first.inbound[0]?.text.includes(first.nonce)).toBe(false);
  });

  it("carries nothing a send could be built from", () => {
    // The structural half of "this test cannot send": no recipient, no channel account, no operation and
    // no delivery anywhere in the request. The type forbids it; this says so where a reader will look.
    const keys = Object.keys(request("Hello"));

    expect(keys).not.toContain("recipient");
    expect(keys).not.toContain("channelAccountId");
    expect(keys).not.toContain("operationId");
    expect(JSON.stringify(request("Hello"))).not.toContain("channelAccount");
  });

  it("scopes the generation to the caller's own workspace and profile", () => {
    const sent = request("Hello");

    expect(sent.scope.workspaceId).toBe("ws-1");
    expect(sent.scope.businessProfileId).toBe("bp-1");
  });
});

describe("reading what the provider returned", () => {
  it("shows the reply when the output parses", () => {
    expect(candidateFrom(result())).toEqual({ status: "WRITTEN", text: OUTPUT.reply });
  });

  it("reports a refusal as no candidate rather than an empty one", () => {
    expect(candidateFrom(result({ rejection: "REFUSAL" }))).toEqual({ status: "UNAVAILABLE" });
  });

  it("reports a truncation as no candidate", () => {
    // Truncated JSON is unusable, and half a reply read as a whole one would misrepresent the voice.
    expect(candidateFrom(result({ rejection: "TRUNCATED" }))).toEqual({ status: "UNAVAILABLE" });
  });

  it("refuses output in any other shape, however plausible", () => {
    // No lenient reading: a bare string that happens to look like a reply has not been through the
    // boundary schema, and this screen is not the place to decide that is good enough.
    expect(candidateFrom(result({ output: { reply: "We open at ten." } }))).toEqual({ status: "UNAVAILABLE" });
    expect(candidateFrom(result({ output: "We open at ten." }))).toEqual({ status: "UNAVAILABLE" });
    expect(candidateFrom(result({ output: { ...OUTPUT, send_now: true } }))).toEqual({ status: "UNAVAILABLE" });
  });

  it("does not need a logger to read a result", () => {
    // Deliberate: reading a provider result must not require a configured deployment, or this becomes
    // untestable without one.
    expect(() => candidateFrom(result({ rejection: "UNREADABLE" }))).not.toThrow();
  });
});
