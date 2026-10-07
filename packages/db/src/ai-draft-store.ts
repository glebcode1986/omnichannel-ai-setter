/**
 * PostgreSQL implementation of the application's `AiDraftStore` port.
 *
 * Draft generation is a system flow: it runs on a queue job, not a browser session, so the scope comes from
 * the job's Workspace + Business Profile rather than from a member context — exactly like webhook ingestion.
 *
 * The write is idempotent by `generationKey`. A queue retry after a partial failure must not leave a
 * conversation with two drafts for the same message, so a repeated key returns the draft that already
 * exists instead of creating another one.
 *
 * That same key identifies the logical generation for metering (#39). The usage row is written in the
 * transaction that writes the draft, so the two are exactly consistent: a rolled-back draft leaves no
 * generation cycle behind, and a retry is refused by the draft's unique index before it can be counted
 * twice. `AI_GENERATION_CYCLES` is an internal metric, so this records cost and can refuse nothing.
 */
import type { AiDraftStore, PersistedDraft, SaveDraftInput } from "@omnichannel/application";
import { isLeadStage } from "@omnichannel/domain";

import type { DbClient } from "./client";
import { isUniqueViolation } from "./errors";
import { recordUsageWithin } from "./usage-store";

export function createAiDraftStore(db: DbClient): AiDraftStore {
  return {
    async saveDraft(input: SaveDraftInput): Promise<PersistedDraft> {
      const scope = { workspaceId: input.scope.workspaceId, businessProfileId: input.scope.businessProfileId };
      const data = {
        ...scope,
        conversationId: input.scope.conversationId,
        generationKey: input.generationKey,
        // Whether automation or a person asked, and who: an "ask AI" click in mode OFF is a different act
        // from a background job, and the audit trail has to be able to tell them apart.
        trigger: input.trigger,
        requestedByUserId: input.requestedByUserId,
        anchorMessageId: input.anchorMessageId,
        anchorStateVersion: input.anchorStateVersion,
        text: input.text,
        structuredOutput: input.structuredOutput === null ? undefined : (input.structuredOutput as object),
        confidence: input.confidence,
        modelSuggestsSend: input.modelSuggestsSend,
        needsReview: input.needsReview,
        reasonCodes: [...input.reasonCodes],
        intent: input.intent,
        // A lead stage the model invented is dropped rather than stored as if it were a known stage.
        suggestedLeadStage: input.suggestedLeadStage !== undefined && isLeadStage(input.suggestedLeadStage) ? input.suggestedLeadStage : undefined,
        suggestedAction: input.suggestedAction,
        factualSourceIds: [...input.factualSourceIds],
        // The audit record of what retrieval supplied, and whether it could be reached at all.
        retrieval: input.retrieval as object,
        status: input.status,
        modelProvider: input.provider,
        modelName: input.model,
        promptVersion: input.promptVersion,
        schemaVersion: input.schemaVersion,
        providerRequestId: input.requestId,
        latencyMs: input.latencyMs,
        inputTokens: input.usage?.inputTokens,
        outputTokens: input.usage?.outputTokens,
        cacheReadTokens: input.usage?.cacheReadInputTokens,
        cacheWriteTokens: input.usage?.cacheCreationInputTokens,
      };

      try {
        return await db.$transaction(async (tx) => {
          const created = await tx.aiDraft.create({ data, select: { id: true } });
          // One logical generation, counted once. A provider retry, a schema repair and a requeued job all
          // produce this same `generationKey`, and both unique indexes refuse the second write.
          await recordUsageWithin(tx, {
            workspaceId: scope.workspaceId,
            metric: "AI_GENERATION_CYCLES",
            usageOperationId: input.generationKey,
            amount: 1,
            subjectType: "ai_drafts",
            subjectId: created.id,
            detail: { businessProfileId: scope.businessProfileId, trigger: input.trigger, provider: input.provider, model: input.model },
          });
          return { aiDraftId: created.id };
        });
      } catch (error) {
        if (!isUniqueViolation(error)) {
          throw error;
        }
        // A retry of the same generation: return the draft that already exists rather than a second one.
        const existing = await db.aiDraft.findUniqueOrThrow({
          where: { workspaceId_businessProfileId_generationKey: { ...scope, generationKey: input.generationKey } },
          select: { id: true },
        });
        return { aiDraftId: existing.id };
      }
    },
  };
}
