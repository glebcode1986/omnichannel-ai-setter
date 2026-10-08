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
 *
 * The window's type is reached through `PolicyInput["window"]` rather than imported from
 * `@omnichannel/channel-core`, which defines it. That is not indirection for its own sake: the
 * no-send gate in `simulation-never-sends.test.ts` refuses *any* import of a channel package from this
 * file, and it is right to — a type import today is an import to add a value to tomorrow. The type is
 * already part of what the evaluator accepts, so the evaluator is where to ask for it.
 *
 * **What this run decides, and what it does not.** It drafts a free-form text reply and asks the
 * deterministic evaluator what would happen to it. So the channel, the window, the connection, the
 * human-support exception and Instagram's after-window choice all change the answer, and there are tests
 * showing each of them doing so. WhatsApp's three after-window modes and its template allowlist do not,
 * and cannot here: the evaluator is channel-neutral and takes no allowlist, because whether an *approved
 * template* may go out is `template-route.ts`'s decision, which arrives with the WhatsApp template
 * catalogue (Issue #20) later in this chain. A playground that answered that question itself would be a
 * second implementation of a send rule, and the two would eventually disagree about the same template.
 * The screen says so where it matters rather than letting an owner read an unchanged outcome as proof
 * that their allowlist does nothing.
 *
 * **What the run cannot take from the saved configuration, it takes as an input and then shows.** A
 * conversation has a channel, an account and a messaging window, and a hypothetical message has none of
 * those — so they are chosen, and the result reports what was chosen. They used to be constants: every run
 * was Instagram, on a connected account, inside an open free-form window. That made the WhatsApp settings
 * unreachable from this screen and both Instagram after-window choices untestable, while the screen still
 * claimed to show "the expected send/review path" for the saved configuration. A playground that silently
 * tests one path of several is more misleading than one that tests none, because its answer looks complete.
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
import { NO_CAPABILITIES, resolveStyleProfile, type ChannelCapabilities, type StyleProfileLayer } from "@omnichannel/domain";
import type { KnowledgeHit, PolicyInput, PolicyLimits, StyleHit } from "@omnichannel/application";

import { loadWebEnv } from "../env";
import { getDb } from "./db";
import { getLogger } from "./logger";
import { embedQuery, retrievalModeOf, type RetrievalMode } from "./retrieval-tester";

const PROMPT_VERSION = "reply.v1";
const SCHEMA_VERSION = "ai-draft.v1";
const MAX_HITS = 8;

/** The channels this screen can ask about. One policy layer holds both channels' after-window choices. */
export const SIMULATION_CHANNELS = ["INSTAGRAM", "WHATSAPP"] as const;
export type SimulationChannel = (typeof SIMULATION_CHANNELS)[number];

/**
 * The messaging window to assume, named in the words the owner's settings use.
 *
 * `OPEN` is inside the standard window, where a free-form automated reply is possible at all; `AFTER` is
 * once it has closed, which is the only state in which an after-window choice does anything. Both are
 * offered because a configuration that behaves identically in both is a configuration whose after-window
 * setting has never been exercised.
 */
export const SIMULATION_WINDOWS = ["OPEN", "AFTER"] as const;
export type SimulationWindow = (typeof SIMULATION_WINDOWS)[number];

/** Whether to assume a healthy connection. `DISCONNECTED` is what an expired token looks like to a send. */
export const SIMULATION_ACCOUNTS = ["CONNECTED", "DISCONNECTED"] as const;
export type SimulationAccount = (typeof SIMULATION_ACCOUNTS)[number];

/**
 * Whether a human-support exception is available for this hypothetical conversation.
 *
 * This is the input that makes Instagram's after-window choice mean anything. `HUMAN_ASSISTED_EXTENDED`
 * opens a human-only review path **only** while the exception is live, and the evaluator is right to
 * demand that: an absent approval is not a weaker form of approval. With the exception hard-coded
 * unavailable — as it was — both Instagram after-window choices produced the same refusal, so the
 * selector on this screen could not change a single answer. `AVAILABLE` is offered precisely so an owner
 * can see what the setting buys them, and the screen names which of the two it assumed.
 */
export const SIMULATION_HUMAN_SUPPORT = ["UNAVAILABLE", "AVAILABLE"] as const;
export type SimulationHumanSupport = (typeof SIMULATION_HUMAN_SUPPORT)[number];

/**
 * The facts a hypothetical message cannot carry, stated rather than assumed.
 *
 * Defaults are the most permissive case — the one in which something would actually be sent — because a
 * playground that defaults to "nothing can go out" answers every question with the same refusal. The
 * screen shows which values were used, so a permissive default is visible rather than implicit.
 */
export interface SimulationInputs {
  readonly channel: SimulationChannel;
  readonly window: SimulationWindow;
  readonly account: SimulationAccount;
  readonly humanSupport: SimulationHumanSupport;
}

export const DEFAULT_SIMULATION_INPUTS: SimulationInputs = {
  channel: "INSTAGRAM",
  window: "OPEN",
  account: "CONNECTED",
  // Not the permissive default, unlike the other three. The exception is a fact about a conversation that
  // a business has to have been approved for, and assuming it would show an owner a review path that
  // their account may not actually offer.
  humanSupport: "UNAVAILABLE",
};

export interface SimulationResult {
  readonly mode: RetrievalMode;
  /** The hypothetical facts this run used, so the screen can show what it was testing. */
  readonly inputs: SimulationInputs;
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

export async function runSimulation(
  context: BusinessProfileContext,
  message: string,
  inputs: SimulationInputs = DEFAULT_SIMULATION_INPUTS,
  now = new Date(),
): Promise<SimulationResult> {
  const text = message.trim();
  const env = loadWebEnv();
  const modelConfigured = env.ANTHROPIC_API_KEY !== undefined;
  if (text === "") {
    return { mode: retrievalModeOf(), inputs, modelConfigured, knowledge: [], style: [], reasonCodes: [], citedSourceIds: [] };
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
    inputs,
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
        channel: inputs.channel,
        capabilityHints: capabilityHintsFor(inputs.channel),
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
            // The chosen channel's own choice. The union is per channel precisely so a WhatsApp
            // conversation cannot be judged against an Instagram policy, and reading the Instagram field
            // whatever the channel was exactly that mistake made by hand.
            afterWindow: afterWindowFor(inputs.channel, policyUsed),
          },
          account: inputs.account,
          capabilities: capabilitiesFor(inputs.channel),
          // Stated, and stated by the person asking. The screen shows which window this run assumed, so
          // the answer below is attached to a case rather than to a hidden constant.
          window: windowFor(inputs, now),
          humanAgent: humanAgentFor(inputs, now),
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

/**
 * What the chosen channel can carry.
 *
 * Exported, and deliberately still in this file rather than moved somewhere more convenient to test:
 * `simulation-never-sends.test.ts` reads *this* module's source, and code that decides what a simulated
 * send may do belongs inside what that gate reads.
 *
 * Taken from the channel rather than from a connected account on purpose: this is a hypothetical run, and
 * an owner asking "what would WhatsApp do" before connecting WhatsApp should get WhatsApp's answer. The
 * account's *health* is a separate input, because that is the part an owner can be wrong about.
 */
export function capabilitiesFor(channel: SimulationChannel): ChannelCapabilities {
  return channel === "WHATSAPP"
    ? { ...NO_CAPABILITIES, text: true, templates: true, image: true, document: true }
    : { ...NO_CAPABILITIES, text: true, image: true };
}

/** The same facts as hints for the prompt, which names capabilities rather than asking for a shape. */
export function capabilityHintsFor(channel: SimulationChannel): readonly string[] {
  return channel === "WHATSAPP" ? ["text", "templates"] : ["text"];
}

/** The chosen channel's after-window choice, from the one policy layer that stores both. */
export function afterWindowFor(channel: SimulationChannel, policy: PolicyView): PolicyLimits["afterWindow"] {
  return channel === "WHATSAPP"
    ? { channel: "WHATSAPP", policy: policy.whatsappAfterWindowPolicy as "SERVICE_WINDOW_ONLY" | "TEMPLATE_REVIEW" | "TEMPLATE_AUTOPILOT" }
    : { channel: "INSTAGRAM", policy: policy.instagramAfterWindowPolicy as "STANDARD_ONLY" | "HUMAN_ASSISTED_EXTENDED" };
}

/**
 * The window to judge against.
 *
 * `AFTER` is modelled as an expiry in the past rather than as `NOT_ELIGIBLE`: a closed standard window is
 * a window that *was* open, and the after-window policies exist to say what may still happen then. Using
 * `NOT_ELIGIBLE` would short-circuit the very gates this run is meant to exercise.
 */
export function windowFor(inputs: SimulationInputs, now: Date): PolicyInput["window"] {
  const hour = 3_600_000;
  return inputs.window === "AFTER"
    ? { state: "OPEN_FREEFORM", expiresAt: new Date(now.getTime() - hour) }
    : { state: "OPEN_FREEFORM", expiresAt: new Date(now.getTime() + hour) };
}

/**
 * The human-support exception, as the evaluator takes it.
 *
 * An expiry an hour out rather than no expiry: `ELIGIBLE` is a fact about a moment, and the evaluator
 * treats a lapsed exception as absent — so a hypothetical one has to carry a moment too, or this run
 * would be asking a question the real path never asks.
 */
export function humanAgentFor(inputs: SimulationInputs, now: Date): PolicyInput["humanAgent"] {
  return inputs.humanSupport === "AVAILABLE"
    ? { state: "ELIGIBLE", expiresAt: new Date(now.getTime() + 3_600_000) }
    : { state: "UNAVAILABLE", reason: "NOT_APPROVED" };
}
