/**
 * Draft generation (AI_ORCHESTRATION.md, ADR-010).
 *
 * The model drafts; this code decides nothing about sending. What it does own:
 *
 * - **Eligibility.** A conversation that is closed, has AI disabled, is under human control or has already
 *   moved on gets no generation at all — the cheapest and safest outcome.
 * - **Validation.** Output is accepted only if it parses against the boundary schema. Malformed output buys
 *   exactly one regeneration, then the generation is held for review with its audit row intact.
 * - **Attribution.** A model may only claim sources it was actually given; anything else is dropped and the
 *   draft is marked for review.
 * - **Honesty.** Contradictory output (`should_send` with `needs_review`) is stored as it came; the model's
 *   own hesitation is never tidied away.
 */
import { MANDATORY_REVIEW_REASON_CODES, type ReasonCode } from "@omnichannel/domain";

import { parseModelOutput, type AiDraftOutput, type ModelOutputIssue } from "./model-output";
import type {
  AiDraftStore,
  DraftConversationSnapshot,
  KnowledgeSegment,
  PersistedDraft,
  ReplyGenerationRequest,
  ReplyGenerationResult,
  ReplyModel,
  SaveDraftInput,
} from "./ports";
import { ReplyModelUnavailableError } from "./ports";
import { containsNonce, sanitizeUntrustedText } from "./sanitize";

export interface DraftLogPort {
  info(event: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void;
  error(event: string, fields?: Readonly<Record<string, unknown>>): void;
}

export interface DraftGenerationDependencies {
  readonly model: ReplyModel;
  readonly drafts: AiDraftStore;
  readonly log: DraftLogPort;
  readonly now: () => Date;
  /** Opaque per-request value used to fence untrusted text. */
  readonly newNonce: () => string;
  readonly promptVersion: string;
  readonly schemaVersion: string;
  readonly timeoutMs?: number;
}

/** Why the model was asked. A human asking explicitly is a different act from automation deciding to. */
export type DraftTrigger = "DEBOUNCE_ELAPSED" | "MANUAL_REQUEST";

export interface DraftGenerationCommand {
  readonly scope: ReplyGenerationRequest["scope"];
  readonly anchorMessageId: string;
  readonly anchorStateVersion: number;
  readonly trigger: DraftTrigger;
  readonly snapshot: DraftConversationSnapshot;
  readonly persona: string;
  readonly channel: ReplyGenerationRequest["channel"];
  readonly capabilityHints: readonly string[];
  readonly inbound: readonly ReplyGenerationRequest["inbound"][number][];
  readonly history: readonly ReplyGenerationRequest["history"][number][];
  readonly knowledge: readonly KnowledgeSegment[];
  readonly style: readonly ReplyGenerationRequest["style"][number][];
  /** Distinguishes repeated manual requests; a retried queue job reuses the same value. */
  readonly requestId?: string;
}

export type DraftGenerationOutcome =
  | { readonly status: "GENERATED"; readonly draft: PersistedDraft; readonly needsReview: boolean }
  | { readonly status: "HELD"; readonly draft: PersistedDraft; readonly reasonCodes: readonly ReasonCode[] }
  | { readonly status: "DECLINED"; readonly reasonCodes: readonly ReasonCode[] }
  | { readonly status: "UNAVAILABLE" };

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * A conversation must be open, AI-enabled, not under human control, and still on the state the draft
 * answers. Mode OFF mirrors only, so it generates nothing — not even on an explicit request (POLICY_ENGINE.md
 * and PROJECT_CONTEXT.md; see the PR description, this one is flagged for the product owner).
 */
export function draftGenerationBlockers(snapshot: DraftConversationSnapshot): readonly ReasonCode[] {
  const blockers: ReasonCode[] = [];
  if (snapshot.mode === "OFF") {
    blockers.push("MODE_NOT_AUTOPILOT");
  }
  if (!snapshot.aiEnabled) {
    blockers.push("AI_DISABLED");
  }
  if (snapshot.takeoverState === "HUMAN_ACTIVE") {
    blockers.push("HUMAN_TAKEOVER");
  }
  if (snapshot.takeoverState === "REVIEW_REQUIRED") {
    blockers.push("REVIEW_PENDING");
  }
  if (snapshot.status !== "OPEN") {
    blockers.push("AI_DISABLED");
  }
  if (snapshot.anchorSuperseded) {
    // The customer has said something since; drafting against the old anchor answers the wrong question.
    blockers.push("SUPERSEDED_BY_NEWER_INBOUND");
  }
  return blockers;
}

export async function generateDraft(
  dependencies: DraftGenerationDependencies,
  command: DraftGenerationCommand,
): Promise<DraftGenerationOutcome> {
  const fields = {
    workspaceId: command.scope.workspaceId,
    businessProfileId: command.scope.businessProfileId,
    conversationId: command.scope.conversationId,
    anchorMessageId: command.anchorMessageId,
    trigger: command.trigger,
  };

  const blockers = draftGenerationBlockers(command.snapshot);
  if (blockers.length > 0) {
    // Nothing is persisted: a generation that never happened is not a draft.
    dependencies.log.info("ai.draft_declined", { ...fields, reasonCodes: blockers });
    return { status: "DECLINED", reasonCodes: blockers };
  }

  const request = buildRequest(dependencies, command);
  let result: ReplyGenerationResult;
  try {
    result = await dependencies.model.generate(request);
  } catch (error) {
    if (error instanceof ReplyModelUnavailableError) {
      // Transient: the queue may retry, because nothing was sent and nothing was written.
      dependencies.log.warn("ai.model_unavailable", { ...fields });
      return { status: "UNAVAILABLE" };
    }
    throw error;
  }

  const first = result.rejection === undefined ? parseModelOutput(result.output) : undefined;
  if (first?.ok === true) {
    return persistDraft(dependencies, command, result, first.value, fields);
  }

  // One bounded repair. The invalid output goes back as untrusted data with the issue paths, never as an
  // instruction, and a provider refusal is not repaired at all.
  if (result.rejection === undefined && first !== undefined) {
    dependencies.log.warn("ai.output_invalid", { ...fields, issues: first.issues, attempt: 1 });
    const repaired = await repair(dependencies, request, result, first.issues);
    if (repaired !== undefined && repaired.parsed.ok) {
      return persistDraft(dependencies, command, repaired.result, repaired.parsed.value, fields);
    }
    if (repaired?.parsed.ok === false && repaired.result.rejection === undefined) {
      dependencies.log.warn("ai.output_invalid", { ...fields, issues: repaired.parsed.issues, attempt: 2 });
    }
    // A provider that refused on the second attempt refused; filing that as malformed output would put the
    // wrong reason in the audit trail.
    return holdUnusable(
      dependencies,
      command,
      repaired?.result ?? result,
      repaired?.result.rejection === "REFUSAL" ? "UNSUPPORTED_CONTENT" : "INVALID_MODEL_OUTPUT",
      fields,
    );
  }

  dependencies.log.warn("ai.model_rejected", { ...fields, rejection: result.rejection });
  return holdUnusable(
    dependencies,
    command,
    result,
    result.rejection === "REFUSAL" ? "UNSUPPORTED_CONTENT" : "INVALID_MODEL_OUTPUT",
    fields,
  );
}

async function repair(
  dependencies: DraftGenerationDependencies,
  request: ReplyGenerationRequest,
  previous: ReplyGenerationResult,
  issues: readonly ModelOutputIssue[],
): Promise<{ result: ReplyGenerationResult; parsed: ReturnType<typeof parseModelOutput> } | undefined> {
  // The model has already seen the fence marker, and this block is its own output: it is the most likely
  // text in the whole request to contain that marker. So the repair attempt gets a fresh nonce, checked
  // against the previous output as well as every other segment.
  const previousOutput = sanitizeUntrustedText(JSON.stringify(previous.output ?? null));
  const nonce = freshNonce(dependencies, [previousOutput, ...allSegmentTexts(request)], request.scope.conversationId);
  try {
    const result = await dependencies.model.generate({ ...request, nonce, repair: { issues, previousOutput } });
    return {
      result,
      parsed: result.rejection === undefined ? parseModelOutput(result.output) : { ok: false, issues: [] },
    };
  } catch (error) {
    if (error instanceof ReplyModelUnavailableError) {
      return undefined;
    }
    throw error;
  }
}

function buildRequest(dependencies: DraftGenerationDependencies, command: DraftGenerationCommand): ReplyGenerationRequest {
  const sanitize = <T extends { readonly text: string }>(segment: T): T => ({ ...segment, text: sanitizeUntrustedText(segment.text) });
  const inbound = command.inbound.map(sanitize);
  const history = command.history.map(sanitize);
  const knowledge = command.knowledge.map(sanitize);
  const style = command.style.map(sanitize);

  const nonce = freshNonce(
    dependencies,
    [...inbound, ...history, ...knowledge, ...style].map((segment) => segment.text),
    command.scope.conversationId,
  );

  return {
    scope: command.scope,
    anchorMessageId: command.anchorMessageId,
    anchorStateVersion: command.anchorStateVersion,
    promptVersion: dependencies.promptVersion,
    schemaVersion: dependencies.schemaVersion,
    nonce,
    timeoutMs: dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    persona: command.persona,
    channel: command.channel,
    capabilityHints: command.capabilityHints,
    inbound,
    history,
    knowledge,
    style,
  };
}

/** A marker that appears inside the data would let the data close its own fence, so pick another. */
function freshNonce(dependencies: DraftGenerationDependencies, texts: readonly string[], conversationId: string): string {
  let nonce = dependencies.newNonce();
  for (let attempt = 0; attempt < 3 && texts.some((text) => containsNonce(text, nonce)); attempt += 1) {
    dependencies.log.warn("ai.nonce_collision", { conversationId });
    nonce = dependencies.newNonce();
  }
  return nonce;
}

function allSegmentTexts(request: ReplyGenerationRequest): readonly string[] {
  return [...request.inbound, ...request.history, ...request.knowledge, ...request.style].map((segment) => segment.text);
}

function persistDraft(
  dependencies: DraftGenerationDependencies,
  command: DraftGenerationCommand,
  result: ReplyGenerationResult,
  output: AiDraftOutput,
  fields: Readonly<Record<string, unknown>>,
): Promise<DraftGenerationOutcome> {
  const supplied = new Set(command.knowledge.map((chunk) => chunk.chunkId));
  const claimed = [...new Set(output.factual_source_ids)];
  const factualSourceIds = claimed.filter((id) => supplied.has(id));
  const fabricatedSources = claimed.length !== factualSourceIds.length;
  if (fabricatedSources) {
    // A model citing something it was never given is exactly the failure mode that invents facts.
    dependencies.log.warn("ai.unsupported_sources", { ...fields, claimed: claimed.length, supplied: supplied.size });
  }

  const reasonCodes = [...new Set<ReasonCode>(output.reason_codes)];
  const needsReview =
    output.needs_review ||
    fabricatedSources ||
    reasonCodes.some((code) => (MANDATORY_REVIEW_REASON_CODES as readonly ReasonCode[]).includes(code));

  return save(dependencies, command, result, {
    text: output.reply,
    structuredOutput: output,
    confidence: output.confidence,
    // Stored verbatim: advisory, and never reconciled with needs_review for tidiness.
    modelSuggestsSend: output.should_send,
    needsReview,
    reasonCodes: fabricatedSources ? [...new Set<ReasonCode>([...reasonCodes, "MISSING_FACT"])] : reasonCodes,
    ...(output.intent === null ? {} : { intent: output.intent }),
    ...(output.lead_stage === null ? {} : { suggestedLeadStage: output.lead_stage }),
    ...(output.suggested_action === null ? {} : { suggestedAction: output.suggested_action }),
    factualSourceIds,
    status: "PENDING",
  }).then((draft) => {
    dependencies.log.info("ai.draft_generated", { ...fields, aiDraftId: draft.aiDraftId, needsReview });
    return { status: "GENERATED", draft, needsReview } as const;
  });
}

/** An unusable generation still leaves an audit row: what was attempted, by which model, and why it failed. */
function holdUnusable(
  dependencies: DraftGenerationDependencies,
  command: DraftGenerationCommand,
  result: ReplyGenerationResult,
  reason: ReasonCode,
  fields: Readonly<Record<string, unknown>>,
): Promise<DraftGenerationOutcome> {
  return save(dependencies, command, result, {
    text: null,
    structuredOutput: null,
    confidence: 0,
    modelSuggestsSend: false,
    needsReview: true,
    reasonCodes: [reason],
    factualSourceIds: [],
    status: "HELD",
  }).then((draft) => {
    dependencies.log.warn("ai.draft_held", { ...fields, aiDraftId: draft.aiDraftId, reasonCodes: [reason] });
    return { status: "HELD", draft, reasonCodes: [reason] } as const;
  });
}

function save(
  dependencies: DraftGenerationDependencies,
  command: DraftGenerationCommand,
  result: ReplyGenerationResult,
  fields: Omit<
    SaveDraftInput,
    | "scope"
    | "generationKey"
    | "anchorMessageId"
    | "anchorStateVersion"
    | "provider"
    | "model"
    | "promptVersion"
    | "schemaVersion"
    | "requestId"
    | "latencyMs"
    | "usage"
  >,
): Promise<PersistedDraft> {
  return dependencies.drafts.saveDraft({
    scope: command.scope,
    generationKey: generationKey(command),
    anchorMessageId: command.anchorMessageId,
    anchorStateVersion: command.anchorStateVersion,
    provider: result.provider,
    model: result.model,
    promptVersion: dependencies.promptVersion,
    schemaVersion: dependencies.schemaVersion,
    ...(result.requestId === undefined ? {} : { requestId: result.requestId }),
    latencyMs: result.latencyMs,
    ...(result.usage === undefined ? {} : { usage: result.usage }),
    ...fields,
  });
}

/**
 * Identity of one logical generation. It is derived only from values that are fixed when the work is
 * enqueued, so every attempt at the same job produces the same key and a retry cannot create a second draft.
 * Deliberately excludes the conversation's live state version, which changes between attempts.
 */
export function generationKey(command: DraftGenerationCommand): string {
  return [command.scope.conversationId, command.anchorMessageId, command.trigger, command.requestId ?? ""].join("|");
}
