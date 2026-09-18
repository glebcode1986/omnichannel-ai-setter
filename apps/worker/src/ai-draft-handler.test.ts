import {
  RetrievalUnavailableError,
  ReplyModelUnavailableError,
  type DraftGenerationDependencies,
  type DraftRetrievalDependencies,
  type ReplyGenerationRequest,
} from "@omnichannel/application";
import type { DraftContext, DraftContextStore } from "@omnichannel/db";
import { resolveStyleProfile } from "@omnichannel/domain";
import { createLogger } from "@omnichannel/observability";
import { NonRetryableJobError } from "@omnichannel/queue";
import { describe, expect, it, vi } from "vitest";

import { createAiDraftHandler, draftJobFromDebounce, type AiDraftJob } from "./ai-draft-handler";

const job: AiDraftJob = {
  workspaceId: "ws_1",
  businessProfileId: "bp_1",
  conversationId: "conv_1",
  anchorMessageId: "msg_1",
  trigger: { kind: "AUTOMATIC", reason: "DEBOUNCE_ELAPSED" },
  correlationId: "corr_1",
};

const context: DraftContext = {
  snapshot: { conversationId: "conv_1", status: "OPEN", aiEnabled: true, takeoverState: "NONE", mode: "DRAFT", stateVersion: 3, anchorSuperseded: false },
  channelAccountId: "ca_1",
  inbound: [{ kind: "INBOUND", provenance: "msg_1", text: "Are you open Saturday?", occurredAt: new Date() }],
  history: [],
};

const retrievalDependencies = (overrides: Partial<DraftRetrievalDependencies> = {}): DraftRetrievalDependencies => ({
  knowledge: {
    search: () =>
      Promise.resolve({
        hits: [
          {
            chunkId: "chunk_1",
            documentId: "doc_1",
            documentTitle: "Hours",
            documentVersion: 1,
            sourceType: "MANUAL",
            scopeLevel: "WORKSPACE",
            text: "Saturday hours are 10:00-18:00.",
            score: 0.03,
            lexicalRank: 1,
          },
        ],
        diagnostics: { lexicalCandidates: 1, semanticCandidates: 0 },
      }),
  },
  style: {
    search: () =>
      Promise.resolve({
        hits: [
          {
            exampleId: "style_1",
            scopeLevel: "WORKSPACE",
            inboundContext: "open saturday?",
            outboundText: "Hey! 10 till 6",
            provenance: "HUMAN_TYPED",
            score: 0.016,
          },
        ],
        diagnostics: { lexicalCandidates: 1, semanticCandidates: 0 },
      }),
  },
  log: { info: () => undefined, warn: () => undefined },
  ...overrides,
});

function harness(
  overrides: {
    context?: DraftContext | undefined;
    generate?: DraftGenerationDependencies["model"]["generate"];
    retrieval?: DraftRetrievalDependencies;
  } = {},
) {
  const saved: unknown[] = [];
  const requests: ReplyGenerationRequest[] = [];
  const logs: string[] = [];
  const store: DraftContextStore = { load: () => Promise.resolve("context" in overrides ? overrides.context : context) };
  const engine: DraftGenerationDependencies = {
    model: {
      generate:
        overrides.generate ??
        ((request) => {
          requests.push(request);
          return Promise.resolve({
            output: {
              reply: "We open at 10.",
              confidence: 0.8,
              should_send: true,
              needs_review: false,
              reason_codes: [],
              intent: "HOURS",
              lead_stage: "ENGAGED",
              suggested_action: null,
              factual_source_ids: [],
            },
            provider: "anthropic",
            model: "claude-opus-5",
            latencyMs: 12,
          });
        }),
    },
    drafts: {
      saveDraft: (input) => {
        saved.push(input);
        return Promise.resolve({ aiDraftId: "draft_1" });
      },
    },
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    now: () => new Date("2026-09-18T10:00:00.000Z"),
    newNonce: () => "nonce-1",
    promptVersion: "reply.v1",
    schemaVersion: "ai-draft.v1",
  };
  const handler = createAiDraftHandler({
    engine,
    context: store,
    retrieval: overrides.retrieval ?? retrievalDependencies(),
    styleProfiles: { load: () => Promise.resolve([{ persona: "Friendly studio assistant." }]) },
    platformStyleFallback: resolveStyleProfile([{ persona: "Platform default assistant." }]),
    logger: createLogger({ level: "debug", sink: (line) => logs.push(line) }),
  });
  return { handler, saved, logs, requests };
}

describe("ai draft handler", () => {
  it("loads the conversation, generates and persists one draft", async () => {
    const { handler, saved, logs } = harness();

    await handler(job);

    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ status: "PENDING", promptVersion: "reply.v1", provider: "anthropic" });
    expect(logs.join("\n")).toContain("worker.ai_draft");
  });

  it("does not retry a job whose conversation or anchor is gone", async () => {
    const { handler } = harness({ context: undefined });

    await expect(handler(job)).rejects.toBeInstanceOf(NonRetryableJobError);
  });

  it("retries when the provider is unavailable, because nothing was written", async () => {
    const generate = vi.fn(() => Promise.reject(new ReplyModelUnavailableError("timeout")));
    const { handler, saved } = harness({ generate: generate as unknown as DraftGenerationDependencies["model"]["generate"] });

    // The handler turns the port's unavailability into a retryable job failure with its own message.
    await expect(handler(job)).rejects.toThrow(/reply model unavailable/);
    expect(saved).toHaveLength(0);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("writes nothing and does not call the model when the anchor was already overtaken", async () => {
    const generate = vi.fn();
    const { handler, saved } = harness({
      context: { ...context, snapshot: { ...context.snapshot, anchorSuperseded: true } },
      generate: generate as unknown as DraftGenerationDependencies["model"]["generate"],
    });

    await handler(job);

    expect(generate).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
  });

  it("retrieves facts and tone before asking the model, and records what it supplied", async () => {
    const { handler, saved, requests } = harness();

    await handler(job);

    // The model is given the facts; it is never given a way to go and look for them.
    expect(requests[0]?.knowledge).toEqual([{ chunkId: "chunk_1", text: "Saturday hours are 10:00-18:00." }]);
    expect(requests[0]?.style).toEqual([{ exampleId: "style_1", text: "Hey! 10 till 6" }]);
    expect(saved[0]).toMatchObject({ retrieval: { status: "OK", knowledge: [{ chunkId: "chunk_1", documentId: "doc_1" }] } });
  });

  it("marks the draft for review when the factual corpus cannot be reached", async () => {
    const { handler, saved } = harness({
      retrieval: retrievalDependencies({ knowledge: { search: () => Promise.reject(new RetrievalUnavailableError("down")) } }),
    });

    await handler(job);

    expect(saved[0]).toMatchObject({ needsReview: true, retrieval: { status: "UNAVAILABLE" } });
    expect((saved[0] as { reasonCodes: string[] }).reasonCodes).toContain("RETRIEVAL_UNAVAILABLE");
  });

  it("carries the debounce job's identifiers into a draft job", () => {
    expect(
      draftJobFromDebounce({
        schemaVersion: 1,
        workspaceId: "ws_1",
        businessProfileId: "bp_1",
        correlationId: "corr_9",
        channelAccountId: "ca_1",
        conversationId: "conv_1",
        anchorMessageId: "msg_7",
        anchorInboundAt: new Date().toISOString(),
      }),
    ).toEqual({
      workspaceId: "ws_1",
      businessProfileId: "bp_1",
      conversationId: "conv_1",
      anchorMessageId: "msg_7",
      trigger: { kind: "AUTOMATIC", reason: "DEBOUNCE_ELAPSED" },
      correlationId: "corr_9",
    });
  });
});
