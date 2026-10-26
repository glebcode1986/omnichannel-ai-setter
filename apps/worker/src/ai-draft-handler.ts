/**
 * Worker composition of AI draft generation: load the conversation, generate, persist.
 *
 * Everything decided here is plumbing. Whether a draft may be generated at all, what to do with malformed
 * output and what gets stored are the application's decisions; whether anything is ever sent is the policy
 * engine's and the delivery coordinator's, neither of which this path can reach.
 */
import {
  draftGenerationBlockers,
  generateDraft,
  retrieveDraftContext,
  type DraftGenerationDependencies,
  type DraftRetrievalDependencies,
  type DraftTrigger,
} from "@omnichannel/application";
import type { DraftContextStore, StyleProfileStore } from "@omnichannel/db";
import { resolveStyleProfile, type StyleProfile } from "@omnichannel/domain";
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
  readonly styleProfiles: StyleProfileStore;
  /**
   * What happens to the draft once it exists. Separate from generation because a model call and a policy
   * decision have different failure modes and different retry stories.
   */
  readonly dispose?: (input: { readonly workspaceId: string; readonly businessProfileId: string; readonly conversationId: string; readonly draftId: string; readonly correlationId: string }) => Promise<unknown>;
  /**
   * Writes down that a follow-up attempt produced an outbound operation (#55).
   *
   * Called only once the shared disposition has actually scheduled one, and only for a follow-up job —
   * which is what keeps `follow_ups` a record of what happened rather than of what was attempted. There
   * is deliberately **no** counterpart for a disposition that did not schedule: a follow-up whose draft
   * was held or skipped is left `PENDING`, and the next claim settles it from the draft it finds. One
   * place decides what an unsent attempt means, and it is the claim.
   */
  readonly recordFollowUpSent?: (input: { readonly followUpId: string; readonly operationId: string }) => Promise<unknown>;
  /**
   * The platform's voice of last resort, used only where a business has configured nothing. It is a safe
   * default, never the authoritative persona for a tenant (product-owner decision on PR #65).
   */
  readonly platformStyleFallback: StyleProfile;
  readonly logger: Logger;
}

/** Matches the queue's AI draft job shape without importing its schema into the engine. */
export interface AiDraftJob {
  readonly workspaceId: string;
  readonly businessProfileId: string;
  readonly conversationId: string;
  readonly anchorMessageId: string;
  readonly trigger: DraftTrigger;
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

    // Asked here, before retrieval and before the model call, because this is the only place a refusal
    // saves anything: `retrieveDraftContext` below spends a paid embedding call, and the generation after
    // it spends a provider call. The engine asks the same question again when it runs — a gate that
    // trusts an upstream layer to have already checked is not a gate — but by then the money is gone.
    //
    // Every blocker, not only the commercial ones: a conversation in OFF mode or already taken over was
    // going to be declined anyway, and paying for its embeddings first was never anything but waste.
    const blockers = draftGenerationBlockers(context.snapshot, job.trigger);
    if (blockers.length > 0) {
      dependencies.logger.info("worker.draft_declined", {
        workspaceId: job.workspaceId,
        businessProfileId: job.businessProfileId,
        conversationId: job.conversationId,
        correlationId: job.correlationId,
        reasonCodes: blockers,
      });
      return;
    }

    // Workspace base, then this Business Profile's override, then the platform default underneath.
    // Resolved before retrieval rather than after it, because its language decides which style examples
    // are eligible at all — and a profile resolved only for the prompt left every production request
    // searching the whole multilingual corpus.
    const styleProfile = resolveStyleProfile(
      await dependencies.styleProfiles.load({ workspaceId: job.workspaceId, businessProfileId: job.businessProfileId }),
      dependencies.platformStyleFallback,
    );

    // Retrieval runs before generation (AI_ORCHESTRATION.md): the model is given the facts, never a way
    // to go and look for them.
    const retrieved = await retrieveDraftContext(dependencies.retrieval, {
      scope: { workspaceId: job.workspaceId, businessProfileId: job.businessProfileId },
      inbound: context.inbound,
      ...(styleProfile.language === undefined ? {} : { language: styleProfile.language }),
    });

    const outcome = await generateDraft(dependencies.engine, {
      scope: { workspaceId: job.workspaceId, businessProfileId: job.businessProfileId, conversationId: job.conversationId },
      anchorMessageId: job.anchorMessageId,
      // The state the draft is generated for, persisted with it; whether the anchor has been overtaken is a
      // separate fact the context store establishes, because both versions are read at the same instant.
      anchorStateVersion: context.snapshot.stateVersion,
      trigger: job.trigger,
      snapshot: context.snapshot,
      styleProfile,
      channel: "INSTAGRAM",
      capabilityHints: ["text"],
      inbound: context.inbound,
      history: context.history,
      // A recording in this burst that nobody could read. The draft is still written — the reply may well
      // be fine — and it is held for a person rather than sent on the strength of a guess (Issue #21).
      unreadableAudio: context.unreadableAudio,
      retrieval: retrieved,
    });

    if (outcome.status === "UNAVAILABLE") {
      // Nothing was written and nothing was sent, so the queue may retry this job.
      throw new Error("reply model unavailable");
    }
    if (outcome.status === "GENERATED" && dependencies.dispose !== undefined) {
      // The draft exists; the shared policy engine decides what becomes of it. There is no branch here
      // that could schedule a send on its own.
      const disposition = await dependencies.dispose({
        workspaceId: job.workspaceId,
        businessProfileId: job.businessProfileId,
        conversationId: job.conversationId,
        draftId: outcome.draft.aiDraftId,
        correlationId: job.correlationId,
      });
      // A follow-up attempt that reached a scheduled operation is recorded against the follow-up, so the
      // row stops being claimable and names the send it produced. The identity is the disposition's, not
      // this handler's: there is one send path and it issues the operation.
      const operationId = scheduledOperation(disposition);
      if (job.trigger.kind === "FOLLOW_UP" && operationId !== undefined && dependencies.recordFollowUpSent !== undefined) {
        await dependencies.recordFollowUpSent({ followUpId: job.trigger.followUpId, operationId });
      }
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

/**
 * The operation a disposition scheduled, if it scheduled one.
 *
 * Read structurally rather than by importing the disposition's type, for the same reason `AiDraftJob`
 * restates the queue's shape: this handler is given its collaborators and does not depend on their
 * modules. Anything that is not a scheduled send — a review, a skip, a missed deadline — answers
 * `undefined`, and a follow-up then stays claimable until the claim settles it.
 */
function scheduledOperation(disposition: unknown): string | undefined {
  if (typeof disposition !== "object" || disposition === null) {
    return undefined;
  }
  const row = disposition as { readonly status?: unknown; readonly operationId?: unknown };
  return row.status === "SCHEDULED" && typeof row.operationId === "string" && row.operationId !== "" ? row.operationId : undefined;
}

/**
 * The queue's debounce job names the conversation and anchor; the draft trigger follows from it — and it
 * is always `AUTOMATIC`. An inbound message cannot produce a human request, because there is no person to
 * name, which is the whole point of the union.
 */
export function draftJobFromDebounce(job: InboundDebounceJob): AiDraftJob {
  return {
    workspaceId: job.workspaceId,
    businessProfileId: job.businessProfileId,
    conversationId: job.conversationId,
    anchorMessageId: job.anchorMessageId,
    trigger: { kind: "AUTOMATIC", reason: "DEBOUNCE_ELAPSED" },
    correlationId: job.correlationId,
  };
}
