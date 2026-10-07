/**
 * The Style test: a neutral prompt, a candidate reply, and what shaped it (Issue #32).
 *
 * `KNOWLEDGE_STYLE_UX.md` asks this screen for three things — a candidate output, the examples that
 * influenced it and the instructions that influenced it — and the first version shipped only the examples.
 * Showing what retrieval would pick is useful, but on its own it is a retrieval browser: a voice can only
 * be judged by hearing it, and an operator who reads a surprising candidate needs the resolved
 * instructions beside it to see which layer caused the surprise.
 *
 * That is also why the Knowledge tester deliberately stops at retrieval while this one does not, and the
 * specs say so in as many words at both places. A fact is checked by reading the source it came from; a
 * tone is not checked by reading anything.
 *
 * Deliberately **not** the draft engine. Nothing is persisted, no conversation is touched, no delivery row
 * is created and no policy gate is consulted, because none of those questions are being asked: this is a
 * rehearsal against a sentence the operator typed, not a reply to a customer. And it cannot send — there
 * is no recipient, no channel account and no operation anywhere in this file, so there is nothing a
 * mistake here could deliver.
 */
import { resolveStyleProfile, type StyleProfile, type StyleProfileLayer } from "@omnichannel/domain";
import {
  containsNonce,
  MODEL_OUTPUT_SCHEMA_VERSION,
  parseModelOutput,
  type ReplyGenerationRequest,
  type ReplyGenerationResult,
  type ReplyModel,
  type StyleSegment,
} from "@omnichannel/application";
import { createAnthropicReplyModel } from "@omnichannel/ai";
import { createStyleProfileStore, type BusinessProfileContext } from "@omnichannel/db";
import type { Logger } from "@omnichannel/observability";
import { randomUUID } from "node:crypto";

import { loadWebEnv } from "@/env";
import { getDb } from "@/server/db";
import { getLogger } from "@/server/logger";
import { runStyleTrial, type StyleTrial } from "@/server/retrieval-tester";

/** The prompt version this surface sends, carried in the request like any other generation. */
export const STYLE_TEST_PROMPT_VERSION = "style-test.v1";

/** The one timeout this surface allows itself: a rehearsal must not hold a page render open. */
const STYLE_TEST_TIMEOUT_MS = 20_000;

export type StyleCandidate =
  | { readonly status: "WRITTEN"; readonly text: string }
  /** Nothing was asked, so nothing was asked of a provider either. */
  | { readonly status: "NO_PROMPT" }
  /** This deployment has no reply model configured. Every other part of the test still works. */
  | { readonly status: "NOT_CONFIGURED" }
  /** The provider was asked and did not answer usefully. Said plainly rather than shown as an empty box. */
  | { readonly status: "UNAVAILABLE" };

export interface StyleTestResult {
  /**
   * The voice as the assistant would actually resolve it.
   *
   * The screen already shows each layer as its own editor, which is what a person edits; this is what the
   * assistant ends up with after the layers are merged, which is what it obeys. Those are different
   * things, and only one of them explains a candidate.
   */
  readonly effective: StyleProfile;
  readonly trial: StyleTrial;
  readonly candidate: StyleCandidate;
}

/**
 * Resolves the voice, retrieves the examples, and writes one candidate reply to the operator's prompt.
 *
 * The voice is resolved through `createStyleProfileStore` — the same store `ai-draft-handler` loads, in
 * the same precedence, under the same platform fallback. It is a second small read of two rows that this
 * screen has already rendered from the editor's view, and it is deliberate: the editor's view and the
 * draft engine's layers are two readings of the same rows, and a test that re-derived the voice from the
 * view would be a test of the view. What an operator needs to know is what the *engine* will do.
 *
 * The retrieved examples are then passed as the same fenced, untrusted segments the real draft path uses.
 * What this does not reuse is persistence, scheduling, or any gate — a rehearsal rehearses the generation,
 * not the sending.
 *
 * `model` exists so a test can supply a stub instead of a provider. Omitted, the deployment's configured
 * model is used, and where none is configured the candidate says so.
 */
export async function runStyleTest(context: BusinessProfileContext, text: string, model?: ReplyModel): Promise<StyleTestResult> {
  const query = text.trim();
  const env = loadWebEnv();
  const [layers, trial] = await Promise.all([
    createStyleProfileStore(getDb()).load({ workspaceId: context.workspaceId, businessProfileId: context.businessProfileId }),
    runStyleTrial(context, query),
  ]);
  const effective = effectiveVoiceOf(layers, env.AI_PERSONA);

  // Resolved even with no prompt: the effective voice is worth reading on its own, and it is the half of
  // this screen that needs no provider at all.
  if (query === "") {
    return { effective, trial, candidate: { status: "NO_PROMPT" } };
  }
  return { effective, trial, candidate: await writeCandidate(context, effective, trial, query, model) };
}

/**
 * The layers merged under the platform's voice of last resort.
 *
 * The fallback has to be the worker's, or this screen previews a persona no draft is ever written with —
 * which is the same mistake as a retrieval tester configured differently from the retriever, and the
 * reason that one reads its embedding settings instead of assuming them.
 */
export function effectiveVoiceOf(layers: readonly StyleProfileLayer[], fallbackPersona: string): StyleProfile {
  return resolveStyleProfile(layers, resolveStyleProfile([{ persona: fallbackPersona }]));
}

async function writeCandidate(
  context: BusinessProfileContext,
  styleProfile: StyleProfile,
  trial: StyleTrial,
  query: string,
  model?: ReplyModel,
): Promise<StyleCandidate> {
  const env = loadWebEnv();
  const reply = model ?? configuredModel(env);
  if (reply === undefined) {
    // A supported configuration, not a fault: the effective voice and the retrieved examples are still
    // shown, and the one part that needs a provider says so rather than rendering as a blank.
    return { status: "NOT_CONFIGURED" };
  }

  const request = styleTestRequest({
    context,
    styleProfile,
    style: trial.hits.map((hit) => ({ exampleId: hit.exampleId, text: hit.outboundText })),
    query,
  });

  try {
    return candidateFrom(await reply.generate(request), getLogger());
  } catch (error) {
    // Named, never quoted: a provider's own prose can carry the prompt it was given back out with it.
    getLogger().warn("style.test_unavailable", { errorName: error instanceof Error ? error.name : typeof error });
    return { status: "UNAVAILABLE" };
  }
}

/** The deployment's reply model, or nothing where this deployment has not configured one. */
function configuredModel(env: ReturnType<typeof loadWebEnv>): ReplyModel | undefined {
  if (env.ANTHROPIC_API_KEY === undefined) {
    return undefined;
  }
  return createAnthropicReplyModel({
    apiKey: env.ANTHROPIC_API_KEY,
    model: env.AI_REPLY_MODEL,
    maxOutputTokens: env.AI_REPLY_MAX_OUTPUT_TOKENS,
    logger: getLogger(),
  });
}

/**
 * The generation request this screen sends.
 *
 * Separated from the call so that what it contains — and more importantly what it cannot contain — is a
 * thing a test can read. There is no recipient, no channel account and no operation anywhere in it, and
 * `knowledge` is empty by contract rather than by accident.
 */
export function styleTestRequest(input: {
  readonly context: BusinessProfileContext;
  readonly styleProfile: StyleProfile;
  readonly style: readonly StyleSegment[];
  readonly query: string;
  readonly at?: Date;
}): ReplyGenerationRequest {
  return {
    scope: {
      workspaceId: input.context.workspaceId,
      businessProfileId: input.context.businessProfileId,
      conversationId: STYLE_TEST_CONVERSATION_ID,
    },
    anchorMessageId: STYLE_TEST_ANCHOR_ID,
    anchorStateVersion: 0,
    promptVersion: STYLE_TEST_PROMPT_VERSION,
    schemaVersion: MODEL_OUTPUT_SCHEMA_VERSION,
    nonce: nonceFor(input.query),
    timeoutMs: STYLE_TEST_TIMEOUT_MS,
    styleProfile: input.styleProfile,
    // One channel has to be named, and these are the capabilities every channel has, so the candidate is
    // not quietly shaped by a transport the operator did not choose.
    channel: "INSTAGRAM",
    capabilityHints: ["text"],
    // The operator's own sentence, standing in for a customer's message. Untrusted like any other, and
    // fenced by `packages/ai` exactly as a real one would be.
    inbound: [{ kind: "INBOUND", provenance: STYLE_TEST_ANCHOR_ID, text: input.query, occurredAt: input.at ?? new Date() }],
    history: [],
    // No knowledge, and that is the contract rather than an omission: this test must not imply that style
    // examples establish business facts, and a candidate written with no facts in front of it cannot
    // borrow authority from one. The screen says so next to the result.
    knowledge: [],
    style: input.style,
  };
}

/**
 * What a provider result means on this screen.
 *
 * Parsed against the same boundary schema the draft engine uses. A model that refused, was truncated, or
 * answered in some other shape did not produce a candidate, and this surface is not the place to invent a
 * lenient reading of one.
 *
 * The logger is handed in rather than fetched, so that reading a provider result does not require a
 * configured deployment. Production always passes one.
 */
export function candidateFrom(result: ReplyGenerationResult, logger?: Logger): StyleCandidate {
  if (result.rejection !== undefined) {
    // The draft path holds such a generation for review; here there is nothing to hold, so it is reported
    // as no candidate.
    logger?.info("style.test_rejected", { rejection: result.rejection });
    return { status: "UNAVAILABLE" };
  }
  const parsed = parseModelOutput(result.output);
  if (!parsed.ok) {
    logger?.info("style.test_unparsable", { issues: parsed.issues.map((issue) => `${issue.path}:${issue.code}`) });
    return { status: "UNAVAILABLE" };
  }
  return { status: "WRITTEN", text: parsed.value.reply };
}

/**
 * A fence marker that does not occur in the text it fences.
 *
 * The draft engine regenerates its nonce when the data contains it, for the obvious reason: a marker
 * appearing inside an untrusted block lets that block close its own fence. A random UUID colliding with an
 * operator's sentence is close to impossible, and checking costs nothing — and "close to impossible" is
 * not the standard this particular boundary is held to.
 */
function nonceFor(query: string): string {
  let nonce = randomUUID();
  for (let attempt = 0; attempt < 3 && containsNonce(query, nonce); attempt += 1) {
    nonce = randomUUID();
  }
  return nonce;
}

/**
 * Identifiers for a conversation that does not exist.
 *
 * The request type requires them and nothing reads them back: no row is written and no store is consulted
 * with them, so they name nothing and can collide with nothing. Fixed rather than random, so that two
 * rehearsals are two rehearsals and not two conversations.
 */
const STYLE_TEST_CONVERSATION_ID = "00000000-0000-7000-8000-00000000057e";
const STYLE_TEST_ANCHOR_ID = "00000000-0000-7000-8000-00000000057f";
