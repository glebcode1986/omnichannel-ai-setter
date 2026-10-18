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
  unreadableAudio: false,
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
    styleProfiles?: { load: () => Promise<readonly { readonly persona?: string; readonly language?: string }[]> };
    dispose?: (input: { readonly draftId: string }) => Promise<unknown>;
    recordFollowUpSent?: (input: { readonly followUpId: string; readonly operationId: string }) => Promise<unknown>;
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
    styleProfiles: overrides.styleProfiles ?? { load: () => Promise.resolve([{ persona: "Friendly studio assistant." }]) },
    platformStyleFallback: resolveStyleProfile([{ persona: "Platform default assistant." }]),
    logger: createLogger({ level: "debug", sink: (line) => logs.push(line) }),
    ...(overrides.dispose === undefined ? {} : { dispose: overrides.dispose }),
    ...(overrides.recordFollowUpSent === undefined ? {} : { recordFollowUpSent: overrides.recordFollowUpSent }),
  });
  return { handler, saved, logs, requests };
}

describe("the language the reply is written in", () => {
  // The production path this guards: the resolved StyleProfile's language has to reach style retrieval.
  // Before this fix the handler resolved the profile *after* retrieval and passed none, so every real
  // request searched the whole multilingual style corpus and could imitate the wrong language.
  const capturing = () => {
    const styleQueries: { language?: string }[] = [];
    const knowledgeQueries: { language?: string }[] = [];
    const base = retrievalDependencies();
    const retrieval: DraftRetrievalDependencies = {
      ...base,
      knowledge: {
        search: (query) => {
          knowledgeQueries.push(query);
          return base.knowledge.search(query);
        },
      },
      style: {
        search: (query) => {
          styleQueries.push(query);
          return base.style.search(query);
        },
      },
    };
    return { retrieval, styleQueries, knowledgeQueries };
  };

  it("forwards the business's language to style retrieval", async () => {
    const { retrieval, styleQueries } = capturing();
    const { handler } = harness({
      retrieval,
      styleProfiles: { load: () => Promise.resolve([{ persona: "Studio assistant." }, { language: "fr" }]) },
    });

    await handler(job);

    expect(styleQueries).toHaveLength(1);
    expect(styleQueries[0]?.language).toBe("fr");
  });

  it("forwards it in canonical form, whatever spelling the profile was stored in", async () => {
    const { retrieval, styleQueries } = capturing();
    const { handler } = harness({
      retrieval,
      // BCP-47 is case-insensitive; the example rows are canonical, so the request has to be too, or a
      // correct configuration would miss its own examples.
      styleProfiles: { load: () => Promise.resolve([{ persona: "Studio assistant.", language: "en-us" }]) },
    });

    await handler(job);

    expect(styleQueries[0]?.language).toBe("en-US");
  });

  it("asks for no language when the business has none, keeping the whole corpus", async () => {
    const { retrieval, styleQueries } = capturing();
    const { handler } = harness({ retrieval });

    await handler(job);

    // Absent, not empty: filtering on a preference nobody expressed would silently shrink the corpus.
    expect(styleQueries[0]).not.toHaveProperty("language");
  });

  it("never gives the language to knowledge retrieval", async () => {
    const { retrieval, knowledgeQueries } = capturing();
    const { handler } = harness({
      retrieval,
      styleProfiles: { load: () => Promise.resolve([{ persona: "Studio assistant.", language: "fr" }]) },
    });

    await handler(job);

    // A fact is a fact whatever language it was written in. Filtering facts by language would hide a
    // correct English price from a French reply and produce MISSING_FACT for no reason.
    expect(knowledgeQueries[0]).not.toHaveProperty("language");
  });
});

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

  it("carries an unread recording from the context into the generation command", async () => {
    const { handler: unread, saved: heldBack } = harness({ context: { ...context, unreadableAudio: true } });
    await unread(job);

    const { handler: heard, saved } = harness();
    await heard(job);

    // The flag is a fact about the burst that only the context store can establish, and only this command
    // carries it to the layer that decides. Losing it here would send a reply to a voice note nobody
    // heard, which is exactly the invented content Issue #21 exists to prevent.
    expect(heldBack[0]).toMatchObject({ needsReview: true });
    expect((heldBack[0] as { reasonCodes: string[] }).reasonCodes).toContain("AUDIO_NOT_TRANSCRIBED");
    expect((saved[0] as { reasonCodes: string[] }).reasonCodes).not.toContain("AUDIO_NOT_TRANSCRIBED");
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

/**
 * What a follow-up attempt leaves behind (#55, Astra's first P1 on PR #82).
 *
 * The handler is the only place that knows both that this generation was a follow-up attempt and what the
 * shared disposition did with the draft, so it is where the attempt stops being claimable. The asymmetry
 * is deliberate and is what these cases hold in place: it records a send, and records nothing at all
 * otherwise, because what an *unsent* attempt means is the claim's decision and only the claim's.
 */
describe("recording what a follow-up attempt produced", () => {
  const followUpJob: AiDraftJob = { ...job, trigger: { kind: "FOLLOW_UP", followUpId: "fu_1", attempt: 2 } };

  const recording = (disposition: unknown) => {
    const recorded: { followUpId: string; operationId: string }[] = [];
    const { handler, saved } = harness({
      dispose: () => Promise.resolve(disposition),
      recordFollowUpSent: (input) => {
        recorded.push({ ...input });
        return Promise.resolve(undefined);
      },
    });
    return { handler, recorded, saved };
  };

  it("records the operation the one send path issued, under the disposition's own identity", async () => {
    const { handler, recorded } = recording({ status: "SCHEDULED", operationId: "op_77", draftId: "draft_1" });

    await handler(followUpJob);

    // The operation id is the disposition's. The handler inventing one would be a second send identity
    // for one send, and nothing downstream could reconcile the two.
    expect(recorded).toEqual([{ followUpId: "fu_1", operationId: "op_77" }]);
  });

  it("records nothing when the draft was held for a person, so the next claim decides", async () => {
    const { handler, recorded, saved } = recording({ status: "REVIEW_REQUIRED", draftId: "draft_1" });

    await handler(followUpJob);

    // The draft exists and is waiting for somebody. Marking the follow-up SENT here would claim an
    // outbound that has not happened; leaving it PENDING lets the claim settle it as REVIEW_PENDING.
    expect(saved).toHaveLength(1);
    expect(recorded).toEqual([]);
  });

  it("records nothing when the policy skipped the send, or named no operation", async () => {
    for (const disposition of [
      { status: "SKIPPED", reason: "MODE_OFF" },
      { status: "DEADLINE_MISSED" },
      // A "scheduled" disposition with no operation is not a send: it is a bug upstream, and reading it
      // as one would mark the follow-up sent against an identity nothing can look up.
      { status: "SCHEDULED" },
      { status: "SCHEDULED", operationId: "" },
      { status: "SCHEDULED", operationId: 77 },
      undefined,
      null,
    ]) {
      const { handler, recorded } = recording(disposition);
      await handler(followUpJob);
      expect(recorded).toEqual([]);
    }
  });

  it("records nothing for a draft nobody planned as a follow-up", async () => {
    const { handler, recorded } = recording({ status: "SCHEDULED", operationId: "op_77" });

    await handler(job);
    await handler({ ...job, trigger: { kind: "HUMAN_REQUEST", requestedByUserId: "user_7", requestedAt: new Date(), requestId: "req_1" } });

    // Two sends happened and no follow-up row may move, because neither of them was chasing a silence.
    expect(recorded).toEqual([]);
  });
});
