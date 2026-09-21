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

/**
 * Why the model was asked, and on whose authority.
 *
 * A human asking explicitly is a different act from automation deciding to, and the difference decides
 * whether a draft may be produced at all in mode OFF. So it is carried as a discriminated union with the
 * acting user *inside* the human variant, rather than as a string an inbound-triggered job could also set:
 * a background worker has no user to put there, so it cannot express a human request even by mistake.
 */
export type DraftTrigger =
  | { readonly kind: "AUTOMATIC"; readonly reason: "DEBOUNCE_ELAPSED" }
  | {
      readonly kind: "HUMAN_REQUEST";
      /** The workspace member who asked. Recorded on the draft as human-requested AI assistance. */
      readonly requestedByUserId: string;
      readonly requestedAt: Date;
      /** Distinguishes repeated requests; a retried queue job reuses the same value. */
      readonly requestId: string;
    };

/** True only for a request an authorized person made deliberately. */
export function isHumanRequested(trigger: DraftTrigger): boolean {
  return trigger.kind === "HUMAN_REQUEST";
}

export interface DraftGenerationCommand {
  readonly scope: ReplyGenerationRequest["scope"];
  readonly anchorMessageId: string;
  readonly anchorStateVersion: number;
  readonly trigger: DraftTrigger;
  readonly snapshot: DraftConversationSnapshot;
  readonly styleProfile: ReplyGenerationRequest["styleProfile"];
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
 * What stops a generation before it starts.
 *
 * Two of these depend on who is asking (product-owner decision on PR #65). Mode OFF means no background
 * generation and no automatic scheduling, but an authorized person may still click "ask AI" and get a
 * draft they must then review, edit and send themselves. Likewise a human takeover blocks *automation*
 * from racing the person handling the conversation — it cannot sensibly block that person from asking for
 * help.
 *
 * The rest hold for everyone. AI disabled is a per-conversation kill switch, a closed conversation has
 * nothing to answer, and an anchor the customer has already overtaken would answer the wrong question
 * however it was requested.
 */
export function draftGenerationBlockers(snapshot: DraftConversationSnapshot, trigger: DraftTrigger): readonly ReasonCode[] {
  const blockers: ReasonCode[] = [];
  const humanRequested = isHumanRequested(trigger);
  if (snapshot.mode === "OFF" && !humanRequested) {
    blockers.push("MODE_NOT_AUTOPILOT");
  }
  if (!snapshot.aiEnabled) {
    blockers.push("AI_DISABLED");
  }
  if (snapshot.takeoverState === "HUMAN_ACTIVE" && !humanRequested) {
    blockers.push("HUMAN_TAKEOVER");
  }
  if (snapshot.takeoverState === "REVIEW_REQUIRED" && !humanRequested) {
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
    trigger: command.trigger.kind,
  };

  const blockers = draftGenerationBlockers(command.snapshot, command.trigger);
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
    if (repaired.kind === "UNAVAILABLE") {
      // The provider went away *during* the repair. Nothing was written and nothing was sent, so this is
      // the same transient outage as a first-attempt failure and the queue may retry.
      //
      // Filing the first malformed output as a held draft instead would be permanent: the generation key
      // makes the row idempotent, so a retry could never replace it with the draft the model would have
      // produced once the provider came back. A momentary outage would have become a finished, unusable
      // generation and a review item for a person, for no reason anyone could later reconstruct.
      dependencies.log.warn("ai.model_unavailable", { ...fields, attempt: 2 });
      return { status: "UNAVAILABLE" };
    }
    if (repaired.parsed.ok) {
      return persistDraft(dependencies, command, repaired.result, repaired.parsed.value, fields);
    }
    if (repaired.result.rejection === undefined) {
      dependencies.log.warn("ai.output_invalid", { ...fields, issues: repaired.parsed.issues, attempt: 2 });
    }
    // A provider that refused on the second attempt refused; filing that as malformed output would put the
    // wrong reason in the audit trail.
    return holdUnusable(
      dependencies,
      command,
      repaired.result,
      repaired.result.rejection === "REFUSAL" ? "UNSUPPORTED_CONTENT" : "INVALID_MODEL_OUTPUT",
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

/**
 * What the one repair attempt produced.
 *
 * `UNAVAILABLE` is its own variant rather than an absent result, because the two mean opposite things to
 * the caller: a repair that ran and failed is a finished generation to file, and a repair that could not
 * run at all is a transient outage to retry. Collapsing them is how a provider timeout gets written down
 * as the model's fault.
 */
type RepairOutcome =
  | { readonly kind: "ATTEMPTED"; readonly result: ReplyGenerationResult; readonly parsed: ReturnType<typeof parseModelOutput> }
  | { readonly kind: "UNAVAILABLE" };

async function repair(
  dependencies: DraftGenerationDependencies,
  request: ReplyGenerationRequest,
  previous: ReplyGenerationResult,
  issues: readonly ModelOutputIssue[],
): Promise<RepairOutcome> {
  // The model has already seen the fence marker, and this block is its own output: it is the most likely
  // text in the whole request to contain that marker. So the repair attempt gets a fresh nonce, checked
  // against the previous output as well as every other segment.
  const previousOutput = sanitizeUntrustedText(JSON.stringify(previous.output ?? null));
  const nonce = freshNonce(dependencies, [previousOutput, ...allSegmentTexts(request)], request.scope.conversationId);
  try {
    const result = await dependencies.model.generate({ ...request, nonce, repair: { issues, previousOutput } });
    return {
      kind: "ATTEMPTED",
      result,
      parsed: result.rejection === undefined ? parseModelOutput(result.output) : { ok: false, issues: [] },
    };
  } catch (error) {
    if (error instanceof ReplyModelUnavailableError) {
      return { kind: "UNAVAILABLE" };
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
    styleProfile: command.styleProfile,
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

  // Manual assistance, by definition: the person asked for help writing, and they send it themselves.
  // This is what keeps an "ask AI" click in mode OFF from ever becoming an automatic send.
  const humanRequested = isHumanRequested(command.trigger);
  const reasonCodes = [...new Set<ReasonCode>(output.reason_codes)];
  const needsReview =
    output.needs_review ||
    fabricatedSources ||
    humanRequested ||
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
    | "trigger"
    | "requestedByUserId"
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
    trigger: command.trigger.kind,
    // Who asked, recorded as human-requested AI assistance; absent for anything automation started.
    ...(command.trigger.kind === "HUMAN_REQUEST" ? { requestedByUserId: command.trigger.requestedByUserId } : {}),
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
 *
 * A human request carries its own `requestId`, so asking twice for the same anchor produces two drafts —
 * which is what a person clicking the button again expects, and the opposite of what a retried queue job
 * should do.
 */
export function generationKey(command: DraftGenerationCommand): string {
  const request = command.trigger.kind === "HUMAN_REQUEST" ? command.trigger.requestId : "";
  return [command.scope.conversationId, command.anchorMessageId, command.trigger.kind, request].join("|");
}
