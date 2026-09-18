/**
 * Worker composition of AI draft generation: load the conversation, generate, persist.
 *
 * Everything decided here is plumbing. Whether a draft may be generated at all, what to do with malformed
 * output and what gets stored are the application's decisions; whether anything is ever sent is the policy
 * engine's and the delivery coordinator's, neither of which this path can reach.
 */
import {
  generateDraft,
  retrieveDraftContext,
  type DraftGenerationDependencies,
  type DraftRetrievalDependencies,
  type DraftTrigger,
} from "@omnichannel/application";
import type { DraftContextStore } from "@omnichannel/db";
import type { Logger } from "@omnichannel/observability";
import { NonRetryableJobError, type InboundDebounceJob } from "@omnichannel/queue";

export interface AiDraftHandlerDependencies {
  readonly engine: DraftGenerationDependencies;
  readonly context: DraftContextStore;
  /**
   * Required. An optional dependency here would need a default retrieval record, and every possible
   * default is a lie: "OK" claims the business was consulted, "UNAVAILABLE" claims an outage that did not
   * happen. A caller that genuinely does not retrieve has to say which it means.
   */
  readonly retrieval: DraftRetrievalDependencies;
  readonly persona: string;
  readonly logger: Logger;
}

/** Matches the queue's AI draft job shape without importing its schema into the engine. */
export interface AiDraftJob {
  readonly workspaceId: string;
  readonly businessProfileId: string;
  readonly conversationId: string;
  readonly anchorMessageId: string;
  readonly trigger: DraftTrigger;
  readonly requestId?: string;
  readonly correlationId: string;
}

export function createAiDraftHandler(dependencies: AiDraftHandlerDependencies) {
  return async function generate(job: AiDraftJob): Promise<void> {
    const context = await dependencies.context.load({
      workspaceId: job.workspaceId,
      businessProfileId: job.businessProfileId,
      conversationId: job.conversationId,
      anchorMessageId: job.anchorMessageId,
    });
    if (context === undefined) {
      // The conversation or anchor is gone or belongs elsewhere: retrying cannot fix that.
      throw new NonRetryableJobError("conversation or anchor message not found for draft generation");
    }

    // Retrieval runs before generation (AI_ORCHESTRATION.md): the model is given the facts, never a way
    // to go and look for them.
    const retrieved = await retrieveDraftContext(dependencies.retrieval, {
      scope: { workspaceId: job.workspaceId, businessProfileId: job.businessProfileId },
      inbound: context.inbound,
    });

    const outcome = await generateDraft(dependencies.engine, {
      scope: { workspaceId: job.workspaceId, businessProfileId: job.businessProfileId, conversationId: job.conversationId },
      anchorMessageId: job.anchorMessageId,
      // The state the draft is generated for, persisted with it; whether the anchor has been overtaken is a
      // separate fact the context store establishes, because both versions are read at the same instant.
      anchorStateVersion: context.snapshot.stateVersion,
      trigger: job.trigger,
      snapshot: context.snapshot,
      persona: dependencies.persona,
      channel: "INSTAGRAM",
      capabilityHints: ["text"],
      inbound: context.inbound,
      history: context.history,
      retrieval: retrieved,
      ...(job.requestId === undefined ? {} : { requestId: job.requestId }),
    });

    if (outcome.status === "UNAVAILABLE") {
      // Nothing was written and nothing was sent, so the queue may retry this job.
      throw new Error("reply model unavailable");
    }
    dependencies.logger.info("worker.ai_draft", {
      correlationId: job.correlationId,
      workspaceId: job.workspaceId,
      businessProfileId: job.businessProfileId,
      conversationId: job.conversationId,
      outcome: outcome.status,
    });
  };
}

/** The queue's debounce job names the conversation and anchor; the draft trigger follows from it. */
export function draftJobFromDebounce(job: InboundDebounceJob): AiDraftJob {
  return {
    workspaceId: job.workspaceId,
    businessProfileId: job.businessProfileId,
    conversationId: job.conversationId,
    anchorMessageId: job.anchorMessageId,
    trigger: "DEBOUNCE_ELAPSED",
    correlationId: job.correlationId,
  };
}
