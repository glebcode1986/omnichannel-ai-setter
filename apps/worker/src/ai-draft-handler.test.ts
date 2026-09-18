import type { DraftGenerationDependencies } from "@omnichannel/application";
import type { DraftContext, DraftContextStore } from "@omnichannel/db";
import { createLogger } from "@omnichannel/observability";
import { NonRetryableJobError } from "@omnichannel/queue";
import { describe, expect, it, vi } from "vitest";

import { createAiDraftHandler, draftJobFromDebounce, type AiDraftJob } from "./ai-draft-handler";

const job: AiDraftJob = {
  workspaceId: "ws_1",
  businessProfileId: "bp_1",
  conversationId: "conv_1",
  anchorMessageId: "msg_1",
  trigger: "DEBOUNCE_ELAPSED",
  correlationId: "corr_1",
};

const context: DraftContext = {
  snapshot: { conversationId: "conv_1", status: "OPEN", aiEnabled: true, takeoverState: "NONE", mode: "DRAFT", stateVersion: 3 },
  channelAccountId: "ca_1",
  inbound: [{ kind: "INBOUND", provenance: "msg_1", text: "Are you open Saturday?", occurredAt: new Date() }],
  history: [],
};

function harness(overrides: { context?: DraftContext | undefined; generate?: DraftGenerationDependencies["model"]["generate"] } = {}) {
  const saved: unknown[] = [];
  const logs: string[] = [];
  const store: DraftContextStore = { load: () => Promise.resolve("context" in overrides ? overrides.context : context) };
  const engine: DraftGenerationDependencies = {
    model: {
      generate:
        overrides.generate ??
        (() =>
          Promise.resolve({
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
          })),
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
    persona: "Friendly studio assistant.",
    logger: createLogger({ level: "debug", sink: (line) => logs.push(line) }),
  });
  return { handler, saved, logs };
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
    const generate = vi.fn(() => Promise.reject(new (class extends Error {})()));
    const { handler, saved } = harness({ generate: generate as unknown as DraftGenerationDependencies["model"]["generate"] });

    await expect(handler(job)).rejects.toBeTruthy();
    expect(saved).toHaveLength(0);
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
      trigger: "DEBOUNCE_ELAPSED",
      correlationId: "corr_9",
    });
  });
});
