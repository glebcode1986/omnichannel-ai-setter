/**
 * The no-send simulation playground (AI_CONFIGURATION_UX.md, Issue #30).
 *
 * "The real engine" is not a figure of speech here either, for the reason `packages/evals/src/run.ts`
 * gives: a playground that reimplemented retrieval, generation or the policy gates would pass while
 * production failed, and an owner would tune their settings against a fiction.
 *
 * So this uses the saved configuration and the real components — the real retrievers, the real
 * `generateDraft`, the real `evaluatePolicy` — and differs from production in exactly two ways, both
 * deliberate:
 *
 * - **the draft is never persisted.** The `AiDraftStore` port collects in memory and returns an id that
 *   was never written, so a simulated reply cannot reach the review queue, the reliability snapshot or
 *   the evals. A playground that wrote drafts would make every metric include imaginary conversations.
 * - **nothing can send it.** Not as a promise this file makes but as a property of the contract: the
 *   `ReplyModel` port has no transport, no recipient and no tools, and no delivery is created here at all.
 *
 * Where no model is configured, everything except generation still runs and the result says so. An empty
 * reply with no explanation would read as "the assistant had nothing to say", which is a different and
 * false answer.
 */
import { createAnthropicReplyModel } from "@omnichannel/ai";
import {
  evaluatePolicy,
  generateDraft,
  noRetrieval,
  type AiDraftStore,
  type PolicyDecision,
  type SaveDraftInput,
} from "@omnichannel/application";
import {
  createKnowledgeRetriever,
  createStyleRetriever,
  readPolicies,
  readStyleProfiles,
  type BusinessProfileContext,
  type PolicyView,
} from "@omnichannel/db";
import { NO_CAPABILITIES, resolveStyleProfile, type StyleProfileLayer } from "@omnichannel/domain";
import type { KnowledgeHit, StyleHit } from "@omnichannel/application";

import { loadWebEnv } from "../env";
import { getDb } from "./db";
import { getLogger } from "./logger";
import { embedQuery, retrievalModeOf, type RetrievalMode } from "./retrieval-tester";

const PROMPT_VERSION = "reply.v1";
const SCHEMA_VERSION = "ai-draft.v1";
const MAX_HITS = 8;

export interface SimulationResult {
  readonly mode: RetrievalMode;
  /** False when no model is configured: everything else ran, and the reply is the only thing missing. */
  readonly modelConfigured: boolean;
  readonly knowledge: readonly KnowledgeHit[];
  readonly style: readonly StyleHit[];
  readonly reply?: string;
  readonly confidence?: number;
  readonly reasonCodes: readonly string[];
  readonly citedSourceIds: readonly string[];
  readonly suggestedLeadStage?: string;
  readonly intent?: string;
  /** The deterministic outcome: what would actually happen to this reply. */
  readonly policy?: PolicyDecision;
  /** The effective settings the simulation ran against, so an owner can see what they were testing. */
  readonly policyUsed?: PolicyView;
  readonly failure?: string;
}

export async function runSimulation(context: BusinessProfileContext, message: string, now = new Date()): Promise<SimulationResult> {
  const text = message.trim();
  const env = loadWebEnv();
  const modelConfigured = env.ANTHROPIC_API_KEY !== undefined;
  if (text === "") {
    return { mode: retrievalModeOf(), modelConfigured, knowledge: [], style: [], reasonCodes: [], citedSourceIds: [] };
  }

  const scope = { workspaceId: context.workspaceId, businessProfileId: context.businessProfileId };
  const embedding = await embedQuery(text);
  const [knowledge, style, layers, policies] = await Promise.all([
    createKnowledgeRetriever(getDb())
      .search({ scope, text, ...(embedding === undefined ? {} : { embedding }), limit: MAX_HITS })
      .catch(() => undefined),
    createStyleRetriever(getDb())
      .search({ scope, text, ...(embedding === undefined ? {} : { embedding }), limit: MAX_HITS })
      .catch(() => undefined),
    readStyleProfiles(getDb(), context),
    readPolicies(getDb(), context),
  ]);

  const policyUsed = policies.find((policy) => policy.channelAccountId === null);
  const mode: RetrievalMode = embedding === undefined ? "LEXICAL_ONLY" : "HYBRID";
  const base = {
    mode,
    modelConfigured,
    knowledge: knowledge?.hits ?? [],
    style: style?.hits ?? [],
    ...(policyUsed === undefined ? {} : { policyUsed }),
  };

  if (!modelConfigured || env.ANTHROPIC_API_KEY === undefined) {
    // Retrieval and the settings are real and worth showing on their own; the reply is the only part
    // that needed a provider.
    return { ...base, reasonCodes: [], citedSourceIds: [] };
  }

  const saved: SaveDraftInput[] = [];
  const drafts: AiDraftStore = {
    // Collected, never written. A simulated reply must not reach the review queue or any metric.
    saveDraft: (input) => {
      saved.push(input);
      return Promise.resolve({ aiDraftId: "simulated" });
    },
  };

  try {
    await generateDraft(
      {
        model: createAnthropicReplyModel({
          apiKey: env.ANTHROPIC_API_KEY,
          model: env.AI_REPLY_MODEL,
          maxOutputTokens: env.AI_REPLY_MAX_OUTPUT_TOKENS,
          logger: getLogger(),
        }),
        drafts,
        log: getLogger(),
        now: () => now,
        newNonce: () => `sim-${String(now.getTime())}`,
        promptVersion: PROMPT_VERSION,
        schemaVersion: SCHEMA_VERSION,
      },
      {
        scope: { ...scope, conversationId: "simulated" },
        anchorMessageId: "simulated",
        anchorStateVersion: 1,
        // A person asked for this one, which is what a playground run is. The request id is fixed to the
        // run's own clock: it identifies this simulation and nothing that could be retried.
        trigger: { kind: "HUMAN_REQUEST", requestedByUserId: context.userId, requestedAt: now, requestId: `sim-${String(now.getTime())}` },
        snapshot: {
          conversationId: "simulated",
          status: "OPEN",
          aiEnabled: true,
          takeoverState: "NONE",
          mode: (policyUsed?.mode ?? "DRAFT") as "OFF" | "DRAFT" | "AUTOPILOT",
          stateVersion: 1,
          anchorSuperseded: false,
        },
        // The saved voice, merged the way production merges it: base layer then override.
        styleProfile: resolveStyleProfile(layers.map((layer) => layerOf(layer))),
        channel: "INSTAGRAM",
        capabilityHints: ["text"],
        inbound: [{ kind: "INBOUND", provenance: "simulated", text, occurredAt: now }],
        history: [],
        retrieval: {
          knowledge: (knowledge?.hits ?? []).map((hit) => ({ chunkId: hit.chunkId, text: hit.text })),
          style: (style?.hits ?? []).map((hit) => ({ exampleId: hit.exampleId, text: hit.outboundText })),
          supplied: {
            ...noRetrieval(knowledge === undefined ? "UNAVAILABLE" : "OK"),
            knowledge: (knowledge?.hits ?? []).map((hit) => ({
              chunkId: hit.chunkId,
              documentId: hit.documentId,
              documentVersion: hit.documentVersion,
              scopeLevel: hit.scopeLevel,
              score: hit.score,
            })),
          },
        },
      },
    );
  } catch (error) {
    // A provider outage is reported as one. Rendering it as an empty reply would tell an owner their
    // settings produce nothing, which is a claim about their configuration rather than about the provider.
    getLogger().warn("simulation.generation_failed", { message: error instanceof Error ? error.message : "unknown" });
    return { ...base, reasonCodes: [], citedSourceIds: [], failure: "GENERATION_FAILED" };
  }

  const draft = saved[0];
  const policy =
    draft === undefined || policyUsed === undefined
      ? undefined
      : evaluatePolicy({
          mode: policyUsed.mode as "OFF" | "DRAFT" | "AUTOPILOT",
          aiEnabled: true,
          takeover: { state: "NONE" },
          draft: {
            usable: draft.text !== null && draft.text !== undefined,
            confidence: draft.confidence,
            reasonCodes: draft.reasonCodes,
            citedSourceIds: draft.factualSourceIds,
            contentType: "TEXT",
          },
          retrieval: {
            suppliedSourceIds: (knowledge?.hits ?? []).map((hit) => hit.chunkId),
            corpusReachable: knowledge !== undefined,
          },
          limits: {
            // The owner's own saved thresholds, so the outcome shown is the outcome they configured.
            confidenceThreshold: policyUsed.confidenceThreshold,
            mandatoryReviewReasons: policyUsed.mandatoryReviewReasons as never,
            afterWindow: { channel: "INSTAGRAM", policy: policyUsed.instagramAfterWindowPolicy as "STANDARD_ONLY" | "HUMAN_ASSISTED_EXTENDED" },
          },
          account: "CONNECTED",
          capabilities: { ...NO_CAPABILITIES, text: true },
          // A simulation is not inside any real messaging window, so the most permissive assumption is
          // stated rather than hidden: the window is open. The screen says the run is hypothetical.
          window: { state: "OPEN_FREEFORM", expiresAt: new Date(now.getTime() + 3_600_000) },
          humanAgent: { state: "UNAVAILABLE", reason: "NOT_APPROVED" },
          replyCycle: "OWNED",
          now,
        });

  return {
    ...base,
    ...(draft?.text === null || draft?.text === undefined ? {} : { reply: draft.text }),
    ...(draft === undefined ? {} : { confidence: draft.confidence }),
    reasonCodes: draft?.reasonCodes ?? [],
    citedSourceIds: draft?.factualSourceIds ?? [],
    ...(draft?.suggestedLeadStage === undefined || draft.suggestedLeadStage === null ? {} : { suggestedLeadStage: draft.suggestedLeadStage }),
    ...(draft?.intent === undefined || draft.intent === null ? {} : { intent: draft.intent }),
    ...(policy === undefined ? {} : { policy }),
  };
}

/** One stored layer, in the shape `resolveStyleProfile` merges. */
function layerOf(layer: Awaited<ReturnType<typeof readStyleProfiles>>[number]): StyleProfileLayer {
  return {
    ...(layer.persona === null ? {} : { persona: layer.persona }),
    ...(layer.tone === null ? {} : { tone: layer.tone }),
    ...(layer.replyLength === null ? {} : { replyLength: layer.replyLength }),
    ...(layer.emoji === null ? {} : { emoji: layer.emoji }),
    ...(layer.greeting === null ? {} : { greeting: layer.greeting }),
    ...(layer.signOff === null ? {} : { signOff: layer.signOff }),
    preferredPhrases: layer.preferredPhrases,
    avoidedPhrases: layer.avoidedPhrases,
    ...(layer.language === null ? {} : { language: layer.language }),
  };
}
