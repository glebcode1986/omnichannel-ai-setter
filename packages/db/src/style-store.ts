/**
 * Style Training: the voice, and the library of examples that shape it (KNOWLEDGE_STYLE_UX.md, ADR-011,
 * Issue #32).
 *
 * The rule that shapes every function here: **style can never authorize a factual claim.** That is not a
 * matter of care in this file, it is structural — nothing here reads or writes `knowledge_documents`, and
 * the retriever that serves style returns `StyleSegment`, a different type from `KnowledgeSegment`, so a
 * style hit cannot satisfy a factual requirement even by accident.
 *
 * The second rule: **only a verified human example is used.** A suggestion the system noticed is inert
 * until a person activates it, because the style query filters `status = 'ACTIVE'` and the database
 * refuses an ACTIVE example with no approver. So "deliberate activation" is a CHECK rather than a habit.
 */
import type { EmojiUsage, ReplyLength } from "@omnichannel/domain";

import type { DbClient, DbExecutor } from "./client";
import { profileScopeOf, type BusinessProfileContext } from "./tenancy";

const DEFAULT_PAGE = 25;
const MAX_PAGE = 100;

export type StyleScope = "WORKSPACE" | "BUSINESS_PROFILE";

/** One layer of the voice, as the editor reads and writes it. `null` means "no opinion at this layer". */
export interface StyleProfileDraft {
  readonly persona: string | null;
  readonly tone: string | null;
  readonly replyLength: ReplyLength | null;
  readonly emoji: EmojiUsage | null;
  readonly greeting: string | null;
  readonly signOff: string | null;
  readonly preferredPhrases: readonly string[];
  readonly avoidedPhrases: readonly string[];
  readonly language: string | null;
}

export interface StyleProfileLayerView extends StyleProfileDraft {
  readonly scope: StyleScope;
  readonly exists: boolean;
  readonly updatedAt: Date | null;
}

const EMPTY: StyleProfileDraft = {
  persona: null,
  tone: null,
  replyLength: null,
  emoji: null,
  greeting: null,
  signOff: null,
  preferredPhrases: [],
  avoidedPhrases: [],
  language: null,
};

/**
 * Both layers, always, whether or not a row exists.
 *
 * A layer that is missing is still a layer an operator can edit, and returning nothing for it would make
 * the editor guess whether the base voice is empty or simply unwritten. `exists` says which.
 */
export async function readStyleProfiles(db: DbExecutor, context: BusinessProfileContext): Promise<readonly StyleProfileLayerView[]> {
  const scope = profileScopeOf(context);
  const rows = await db.styleProfile.findMany({
    where: { workspaceId: scope.workspaceId, OR: [{ businessProfileId: null }, { businessProfileId: scope.businessProfileId }] },
    select: {
      businessProfileId: true,
      persona: true,
      tone: true,
      replyLength: true,
      emoji: true,
      greeting: true,
      signOff: true,
      preferredPhrases: true,
      avoidedPhrases: true,
      language: true,
      updatedAt: true,
    },
  });

  return (["WORKSPACE", "BUSINESS_PROFILE"] as const).map((layer) => {
    const row = rows.find((candidate) => (layer === "WORKSPACE" ? candidate.businessProfileId === null : candidate.businessProfileId !== null));
    if (row === undefined) {
      return { ...EMPTY, scope: layer, exists: false, updatedAt: null };
    }
    return {
      scope: layer,
      exists: true,
      persona: row.persona,
      tone: row.tone,
      replyLength: row.replyLength,
      emoji: row.emoji,
      greeting: row.greeting,
      signOff: row.signOff,
      preferredPhrases: row.preferredPhrases,
      avoidedPhrases: row.avoidedPhrases,
      language: row.language,
      updatedAt: row.updatedAt,
    };
  });
}

export type StyleWriteOutcome =
  | { readonly status: "SAVED" }
  | { readonly status: "ACTIVATED" }
  | { readonly status: "REJECTED_EXAMPLE" }
  | { readonly status: "ARCHIVED" }
  | { readonly status: "RESTORED" }
  | { readonly status: "GONE" }
  | { readonly status: "REFUSED"; readonly reason: string };

/**
 * Writes one layer of the voice.
 *
 * Upsert rather than update, because a layer nobody has written yet is the ordinary case: a Workspace
 * starts with no base voice at all, and asking an operator to "create" it before editing it would be
 * asking them to understand the table.
 */
export async function saveStyleProfile(
  db: DbExecutor,
  context: BusinessProfileContext,
  scopeLevel: StyleScope,
  draft: StyleProfileDraft,
): Promise<StyleWriteOutcome> {
  const scope = profileScopeOf(context);
  const businessProfileId = scopeLevel === "WORKSPACE" ? null : scope.businessProfileId;
  const data = {
    persona: blankToNull(draft.persona),
    tone: blankToNull(draft.tone),
    replyLength: draft.replyLength,
    emoji: draft.emoji,
    greeting: blankToNull(draft.greeting),
    signOff: blankToNull(draft.signOff),
    preferredPhrases: [...draft.preferredPhrases],
    avoidedPhrases: [...draft.avoidedPhrases],
    language: blankToNull(draft.language),
  };

  const existing = await db.styleProfile.findFirst({
    where: { workspaceId: scope.workspaceId, businessProfileId },
    select: { id: true },
  });
  if (existing === null) {
    await db.styleProfile.create({ data: { workspaceId: scope.workspaceId, businessProfileId, ...data } });
  } else {
    await db.styleProfile.update({ where: { id: existing.id }, data });
  }
  return { status: "SAVED" };
}

/**
 * An empty field means "no opinion", not an empty instruction.
 *
 * A stored empty string would blank out the layer beneath it, so clearing a field in the override would
 * silently delete the base voice's greeting rather than deferring to it — which is the opposite of what
 * clearing a field looks like it does.
 */
function blankToNull(value: string | null): string | null {
  return value === null || value.trim() === "" ? null : value.trim();
}

export interface StyleExampleView {
  readonly id: string;
  readonly inboundContext: string;
  readonly outboundText: string;
  readonly provenance: string;
  readonly status: string;
  readonly scope: StyleScope;
  readonly language: string | null;
  readonly approvedByName: string | null;
  readonly sourceDraftId: string | null;
  readonly sourceMessageId: string | null;
  readonly createdAt: Date;
}

export interface StyleExampleFilter {
  readonly status?: "ACTIVE" | "SUGGESTED" | "REJECTED" | "ARCHIVED";
  readonly provenance?: "HUMAN_TYPED" | "HUMAN_EDITED_DRAFT";
  readonly scope?: StyleScope;
}

export interface StyleExampleCursor {
  readonly createdAt: Date;
  readonly id: string;
}

export interface StyleExamplePage {
  readonly examples: readonly StyleExampleView[];
  readonly nextCursor?: StyleExampleCursor;
}

export async function listStyleExamples(
  db: DbExecutor,
  context: BusinessProfileContext,
  filter: StyleExampleFilter = {},
  page: { readonly limit?: number; readonly cursor?: StyleExampleCursor } = {},
): Promise<StyleExamplePage> {
  const scope = profileScopeOf(context);
  const limit = Math.min(Math.max(Math.trunc(page.limit ?? DEFAULT_PAGE), 1), MAX_PAGE);

  const rows = await db.styleExample.findMany({
    where: {
      workspaceId: scope.workspaceId,
      ...exampleScopeFilter(filter.scope, scope.businessProfileId),
      ...(filter.status === undefined ? {} : { status: filter.status }),
      ...(filter.provenance === undefined ? {} : { provenance: filter.provenance }),
      ...(page.cursor === undefined
        ? {}
        : { OR: [{ createdAt: { lt: page.cursor.createdAt } }, { createdAt: page.cursor.createdAt, id: { lt: page.cursor.id } }] }),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: {
      id: true,
      inboundContext: true,
      outboundText: true,
      provenance: true,
      status: true,
      businessProfileId: true,
      language: true,
      sourceDraftId: true,
      sourceMessageId: true,
      createdAt: true,
      approvedByUser: { select: { name: true } },
    },
  });

  const window = rows.slice(0, limit);
  const last = window.at(-1);
  return {
    examples: window.map((row) => ({
      id: row.id,
      inboundContext: row.inboundContext,
      outboundText: row.outboundText,
      provenance: row.provenance,
      status: row.status,
      scope: row.businessProfileId === null ? "WORKSPACE" : "BUSINESS_PROFILE",
      language: row.language,
      approvedByName: row.approvedByUser?.name ?? null,
      sourceDraftId: row.sourceDraftId,
      sourceMessageId: row.sourceMessageId,
      createdAt: row.createdAt,
    })),
    ...(rows.length > limit && last !== undefined ? { nextCursor: { createdAt: last.createdAt, id: last.id } } : {}),
  };
}

function exampleScopeFilter(wanted: StyleScope | undefined, businessProfileId: string) {
  if (wanted === "WORKSPACE") {
    return { businessProfileId: null };
  }
  if (wanted === "BUSINESS_PROFILE") {
    return { businessProfileId };
  }
  return { OR: [{ businessProfileId: null }, { businessProfileId }] };
}

export interface NewStyleExample {
  readonly inboundContext: string;
  readonly outboundText: string;
  readonly language?: string;
  readonly scope?: StyleScope;
}

/**
 * An example a person typed, active immediately.
 *
 * Immediately, and that is not a shortcut around the approval gate: the person who typed it *is* the
 * approval, and the row records them. The gate exists for examples the system proposed, which nobody has
 * yet said anything about.
 *
 * `HUMAN_TYPED` is the only provenance this can claim. `HUMAN_EDITED_DRAFT` requires a draft it came from,
 * which a CHECK enforces, so a hand-written example cannot dress itself up as a corrected model reply.
 */
export async function createStyleExample(
  db: DbExecutor,
  context: BusinessProfileContext,
  input: NewStyleExample,
): Promise<StyleWriteOutcome> {
  const scope = profileScopeOf(context);
  const inbound = input.inboundContext.trim();
  const outbound = input.outboundText.trim();
  if (inbound === "" || outbound === "") {
    // An example is a pair. Half of one teaches nothing: the reply without the question it answers cannot
    // be matched to a later question, and the question without a reply has no tone in it.
    return { status: "REFUSED", reason: "an example needs both the customer's message and your reply" };
  }

  await db.styleExample.create({
    data: {
      workspaceId: scope.workspaceId,
      businessProfileId: input.scope === "WORKSPACE" ? null : scope.businessProfileId,
      inboundContext: inbound,
      outboundText: outbound,
      provenance: "HUMAN_TYPED",
      status: "ACTIVE",
      approvedByUserId: context.userId,
      ...(input.language === undefined ? {} : { language: input.language }),
    },
  });
  return { status: "SAVED" };
}

/**
 * Activates a suggestion, naming the person who did it.
 *
 * Only from `SUGGESTED`. Activating something already active is not an approval anybody made, and
 * activating a rejected example would quietly overturn a decision without recording that it was
 * overturned — reject then re-suggest is the honest route, and it leaves a trail.
 */
export async function approveStyleExample(db: DbExecutor, context: BusinessProfileContext, exampleId: string): Promise<StyleWriteOutcome> {
  const scope = profileScopeOf(context);
  const changed = await db.styleExample.updateMany({
    where: { workspaceId: scope.workspaceId, id: exampleId, status: "SUGGESTED", ...exampleScopeFilter(undefined, scope.businessProfileId) },
    // The approver is written in the same statement that activates it, which is what the CHECK requires
    // and also what makes the audit trail impossible to forget.
    data: { status: "ACTIVE", approvedByUserId: context.userId },
  });
  return changed.count === 0 ? { status: "GONE" } : { status: "ACTIVATED" };
}

/** Declines a suggestion. Kept rather than deleted, so the decision is auditable. */
export async function rejectStyleExample(db: DbExecutor, context: BusinessProfileContext, exampleId: string): Promise<StyleWriteOutcome> {
  const scope = profileScopeOf(context);
  const changed = await db.styleExample.updateMany({
    where: { workspaceId: scope.workspaceId, id: exampleId, status: "SUGGESTED", ...exampleScopeFilter(undefined, scope.businessProfileId) },
    data: { status: "REJECTED" },
  });
  return changed.count === 0 ? { status: "GONE" } : { status: "REJECTED_EXAMPLE" };
}

/** Out of style retrieval immediately, because the query filters on ACTIVE. */
export async function archiveStyleExample(db: DbExecutor, context: BusinessProfileContext, exampleId: string): Promise<StyleWriteOutcome> {
  const scope = profileScopeOf(context);
  const changed = await db.styleExample.updateMany({
    where: { workspaceId: scope.workspaceId, id: exampleId, status: "ACTIVE", ...exampleScopeFilter(undefined, scope.businessProfileId) },
    data: { status: "ARCHIVED" },
  });
  return changed.count === 0 ? { status: "GONE" } : { status: "ARCHIVED" };
}

/**
 * Back into style retrieval, naming whoever brought it back.
 *
 * The approver is re-stamped rather than left as it was: the person restoring an example is the one
 * standing behind it now, and the CHECK would accept the old name — which would make the audit trail say
 * a colleague approved something they never saw again.
 */
export async function restoreStyleExample(db: DbExecutor, context: BusinessProfileContext, exampleId: string): Promise<StyleWriteOutcome> {
  const scope = profileScopeOf(context);
  const changed = await db.styleExample.updateMany({
    where: {
      workspaceId: scope.workspaceId,
      id: exampleId,
      status: { in: ["ARCHIVED", "REJECTED"] },
      ...exampleScopeFilter(undefined, scope.businessProfileId),
    },
    data: { status: "ACTIVE", approvedByUserId: context.userId },
  });
  return changed.count === 0 ? { status: "GONE" } : { status: "RESTORED" };
}

/**
 * A style example the system noticed, for a person to judge later.
 *
 * `SUGGESTED` and deliberately unapproved: a reply a colleague typed natively from their phone is real
 * human writing, but nobody has said "yes, sound like that", and one hurried message should not start
 * shaping every later reply's tone.
 */
export async function suggestStyleExample(
  db: DbClient,
  context: BusinessProfileContext,
  input: { readonly inboundContext: string; readonly outboundText: string; readonly sourceMessageId?: string; readonly language?: string },
): Promise<StyleWriteOutcome> {
  const scope = profileScopeOf(context);
  if (input.inboundContext.trim() === "" || input.outboundText.trim() === "") {
    return { status: "REFUSED", reason: "an example needs both the customer's message and your reply" };
  }
  await db.styleExample.create({
    data: {
      workspaceId: scope.workspaceId,
      businessProfileId: scope.businessProfileId,
      inboundContext: input.inboundContext.trim(),
      outboundText: input.outboundText.trim(),
      provenance: "HUMAN_TYPED",
      status: "SUGGESTED",
      ...(input.sourceMessageId === undefined ? {} : { sourceMessageId: input.sourceMessageId }),
      ...(input.language === undefined ? {} : { language: input.language }),
    },
  });
  return { status: "SAVED" };
}
