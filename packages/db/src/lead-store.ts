/**
 * The lead pipeline (LEADS_ANALYTICS_UX.md, Issue #33).
 *
 * The rule the whole file turns on: **a stage change carries the stage the operator was looking at.** A
 * kanban card is a picture of the past — it was rendered before they dragged it — and a transition that
 * only said "move this to QUALIFIED" would silently overwrite a stage the AI or a colleague set in the
 * meantime. So the expected stage is part of the command, the update is conditional on it, and a request
 * that lost the race is told so rather than applied.
 *
 * The second rule: **who said so is recorded for every value.** `AI_SUGGESTED` and `HUMAN_CONFIRMED` are
 * different claims about the same stage, and the schema pairs the source with the actor by CHECK — an AI
 * suggestion has no actor and a human change cannot be anonymous.
 *
 * Display labels are a Workspace's own; the internal `LeadStage` is a contract with the draft engine,
 * which returns one in its structured output. Nothing here lets a rename change what a stage means.
 */
import { LEAD_STAGES, type LeadStage } from "@omnichannel/domain";

import type { DbClient, DbExecutor } from "./client";
import { profileScopeOf, type BusinessProfileContext } from "./tenancy";

export type LeadValueSource = "AI_SUGGESTED" | "HUMAN_CONFIRMED" | "HUMAN_SET";

export interface StageDisplay {
  readonly stage: LeadStage;
  readonly label: string;
  readonly position: number;
  readonly hidden: boolean;
  /** True when this is the product default rather than something the Workspace chose. */
  readonly isDefault: boolean;
}

/** The product's own labels, used wherever a Workspace has not said otherwise. */
const DEFAULT_LABELS: Readonly<Record<LeadStage, string>> = {
  NEW: "New",
  ENGAGED: "Engaged",
  QUALIFYING: "Qualifying",
  QUALIFIED: "Qualified",
  BOOKED: "Booked",
  WON: "Won",
  LOST: "Lost",
};

/**
 * Every stage, in board order, whether or not the Workspace has configured it.
 *
 * Every stage: a board that only showed configured ones would hide leads the moment somebody saved a
 * partial configuration, and `LEAD_STAGES` is the full internal vocabulary regardless of what a Workspace
 * has renamed.
 */
export async function readStageDisplays(db: DbExecutor, context: BusinessProfileContext): Promise<readonly StageDisplay[]> {
  const rows = await db.leadStageDisplay.findMany({
    where: { workspaceId: context.workspaceId },
    select: { stage: true, label: true, position: true, hidden: true },
  });
  const configured = new Map(rows.map((row) => [row.stage, row]));

  return LEAD_STAGES.map((stage, index) => {
    const row = configured.get(stage);
    return row === undefined
      ? { stage, label: DEFAULT_LABELS[stage], position: index, hidden: false, isDefault: true }
      : { stage, label: row.label, position: row.position, hidden: row.hidden, isDefault: false };
  }).sort((left, right) => left.position - right.position || LEAD_STAGES.indexOf(left.stage) - LEAD_STAGES.indexOf(right.stage));
}

export type StageConfigOutcome = { readonly status: "SAVED" } | { readonly status: "REFUSED"; readonly reason: string };

/**
 * Renames, reorders and hides stages. It cannot add or remove one.
 *
 * `LeadStage` is the draft engine's own output vocabulary, so a new stage is a change to what the model
 * may return — a different and larger decision than a display preference. What a Workspace controls is
 * every stage's label, position and visibility, which is what "display stages over stable internal IDs"
 * asks for.
 */
export async function saveStageDisplays(
  db: DbClient,
  context: BusinessProfileContext,
  displays: readonly { readonly stage: LeadStage; readonly label: string; readonly position: number; readonly hidden: boolean }[],
): Promise<StageConfigOutcome> {
  const seen = new Set<LeadStage>();
  for (const display of displays) {
    if (!(LEAD_STAGES as readonly string[]).includes(display.stage)) {
      return { status: "REFUSED", reason: "that is not a stage this product has" };
    }
    if (seen.has(display.stage)) {
      return { status: "REFUSED", reason: "each stage appears once" };
    }
    seen.add(display.stage);
    if (display.label.trim() === "") {
      return { status: "REFUSED", reason: "a stage needs a label" };
    }
  }
  const positions = new Set(displays.map((display) => display.position));
  if (positions.size !== displays.length) {
    // A duplicated position would make board order arbitrary, and the unique index would refuse it
    // anyway — better as a sentence than as a constraint violation.
    return { status: "REFUSED", reason: "each stage needs its own position" };
  }
  if (displays.length > 0 && displays.every((display) => display.hidden)) {
    // Every stage hidden is a board with nothing on it and leads nobody can reach.
    return { status: "REFUSED", reason: "at least one stage has to stay visible" };
  }

  await db.$transaction(async (tx) => {
    // Replaced wholesale inside one transaction: positions are unique per Workspace, so updating rows
    // one at a time would collide with the order being replaced.
    await tx.leadStageDisplay.deleteMany({ where: { workspaceId: context.workspaceId } });
    for (const display of displays) {
      await tx.leadStageDisplay.create({
        data: {
          workspaceId: context.workspaceId,
          stage: display.stage,
          label: display.label.trim(),
          position: display.position,
          hidden: display.hidden,
        },
      });
    }
  });
  return { status: "SAVED" };
}

export interface LeadRow {
  readonly conversationId: string;
  readonly contactName: string | null;
  readonly handle: string;
  readonly channel: string;
  readonly stage: LeadStage;
  readonly assignedUserId: string | null;
  readonly assignedUserName: string | null;
  readonly tags: readonly string[];
  readonly note: string | null;
  readonly nextAction: string | null;
  readonly nextActionAt: Date | null;
  readonly lastMessageAt: Date;
  /** The AI's latest reading, kept apart from the stage a person confirmed. */
  readonly suggestedStage: LeadStage | null;
}

export interface LeadFilter {
  readonly stage?: LeadStage;
  readonly assignedUserId?: string;
  readonly tag?: string;
  readonly search?: string;
}

/**
 * Every lead in the profile, for the board and the table alike.
 *
 * One query for both views on purpose: a kanban and a table that disagreed about which leads exist would
 * be two answers to the same question, and the table is the accessible fallback for the board rather
 * than a different feature.
 */
export async function listLeads(db: DbExecutor, context: BusinessProfileContext, filter: LeadFilter = {}): Promise<readonly LeadRow[]> {
  const scope = profileScopeOf(context);
  const rows = await db.conversation.findMany({
    where: {
      ...scope,
      ...(filter.stage === undefined ? {} : { leadStage: filter.stage }),
      ...(filter.assignedUserId === undefined ? {} : { assignedUserId: filter.assignedUserId }),
      ...(filter.tag === undefined ? {} : { leadTags: { has: filter.tag } }),
      ...(filter.search === undefined || filter.search.trim() === ""
        ? {}
        : {
            OR: [
              { contact: { displayName: { contains: filter.search.trim(), mode: "insensitive" as const } } },
              { channelIdentity: { username: { contains: filter.search.trim(), mode: "insensitive" as const } } },
            ],
          }),
    },
    orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
    take: 500,
    select: {
      id: true,
      leadStage: true,
      assignedUserId: true,
      leadTags: true,
      leadNote: true,
      nextAction: true,
      nextActionAt: true,
      lastMessageAt: true,
      assignedUser: { select: { name: true } },
      contact: { select: { displayName: true } },
      channelIdentity: { select: { externalUserId: true, username: true, channelAccount: { select: { channel: true } } } },
      // The newest suggestion, which is advisory until somebody confirms it.
      aiDrafts: { orderBy: [{ createdAt: "desc" }], take: 1, select: { suggestedLeadStage: true } },
    },
  });

  return rows.map((row) => ({
    conversationId: row.id,
    contactName: row.contact.displayName,
    handle: row.channelIdentity.username ?? row.channelIdentity.externalUserId,
    channel: row.channelIdentity.channelAccount.channel,
    stage: row.leadStage,
    assignedUserId: row.assignedUserId,
    assignedUserName: row.assignedUser?.name ?? null,
    tags: row.leadTags,
    note: row.leadNote,
    nextAction: row.nextAction,
    nextActionAt: row.nextActionAt,
    lastMessageAt: row.lastMessageAt,
    suggestedStage: row.aiDrafts[0]?.suggestedLeadStage ?? null,
  }));
}

export type StageTransitionOutcome =
  | { readonly status: "MOVED"; readonly stage: LeadStage }
  /** Somebody or something moved it first. The caller must not report the move it asked for. */
  | { readonly status: "STALE"; readonly currentStage: LeadStage }
  | { readonly status: "UNCHANGED"; readonly stage: LeadStage }
  | { readonly status: "GONE" }
  | { readonly status: "REFUSED"; readonly reason: string };

/**
 * Moves a lead, but only from the stage the caller was looking at.
 *
 * `expectedStage` is what makes a dragged card safe. Without it the last write wins, and the operator who
 * dropped a card on QUALIFIED half a minute ago would silently undo the WON a colleague set since — with
 * a board that then shows the right thing and an audit trail that reads as if nobody disagreed.
 *
 * The transition and its history row commit together. Separately, a crash between them leaves a stage
 * nobody appears to have changed, which is the question the history exists to answer.
 */
export async function transitionLeadStage(
  db: DbClient,
  context: BusinessProfileContext,
  input: {
    readonly conversationId: string;
    readonly toStage: LeadStage;
    readonly expectedStage: LeadStage;
    readonly source: "HUMAN_CONFIRMED" | "HUMAN_SET";
    readonly at?: Date;
  },
): Promise<StageTransitionOutcome> {
  const scope = profileScopeOf(context);
  const at = input.at ?? new Date();
  if (!(LEAD_STAGES as readonly string[]).includes(input.toStage)) {
    return { status: "REFUSED", reason: "that is not a stage this product has" };
  }

  return db.$transaction(async (tx) => {
    const conversation = await tx.conversation.findFirst({
      where: { ...scope, id: input.conversationId },
      select: { leadStage: true },
    });
    if (conversation === null) {
      return { status: "GONE" };
    }
    if (conversation.leadStage !== input.expectedStage) {
      // The board was out of date. Refused, and the current stage is returned so the caller can say what
      // actually happened rather than just that it failed.
      return { status: "STALE", currentStage: conversation.leadStage };
    }
    if (input.toStage === input.expectedStage) {
      // Nothing moved, so there is nothing to record: a history of non-moves is a history nobody reads,
      // and the `from <> to` CHECK would refuse the row anyway.
      return { status: "UNCHANGED", stage: input.toStage };
    }

    const moved = await tx.conversation.updateMany({
      // Conditional on the stage as well as the id: the read above and this write are in one transaction,
      // but stating the condition here is what makes the guarantee the statement's own rather than the
      // isolation level's.
      where: { ...scope, id: input.conversationId, leadStage: input.expectedStage },
      data: { leadStage: input.toStage },
    });
    if (moved.count === 0) {
      const now = await tx.conversation.findFirst({ where: { ...scope, id: input.conversationId }, select: { leadStage: true } });
      return now === null ? { status: "GONE" } : { status: "STALE", currentStage: now.leadStage };
    }

    await tx.leadStageTransition.create({
      data: {
        ...scope,
        conversationId: input.conversationId,
        fromStage: input.expectedStage,
        toStage: input.toStage,
        source: input.source,
        // The authenticated member, as everywhere else. A CHECK pairs a human source with an actor.
        actorUserId: context.userId,
        changedAt: at,
      },
    });
    return { status: "MOVED", stage: input.toStage };
  });
}

export interface StageHistoryEntry {
  readonly id: string;
  readonly fromStage: LeadStage | null;
  readonly toStage: LeadStage;
  readonly source: LeadValueSource;
  readonly actorName: string | null;
  readonly changedAt: Date;
}

export async function readStageHistory(
  db: DbExecutor,
  context: BusinessProfileContext,
  conversationId: string,
): Promise<readonly StageHistoryEntry[]> {
  const scope = profileScopeOf(context);
  const rows = await db.leadStageTransition.findMany({
    where: { ...scope, conversationId },
    orderBy: [{ changedAt: "desc" }, { id: "desc" }],
    take: 100,
    select: { id: true, fromStage: true, toStage: true, source: true, changedAt: true, actor: { select: { name: true } } },
  });
  return rows.map((row) => ({
    id: row.id,
    fromStage: row.fromStage,
    toStage: row.toStage,
    source: row.source,
    actorName: row.actor?.name ?? null,
    changedAt: row.changedAt,
  }));
}

export type LeadEditOutcome = { readonly status: "SAVED" } | { readonly status: "GONE" } | { readonly status: "REFUSED"; readonly reason: string };

/** The CRM-lite fields. Never the stage: that goes through `transitionLeadStage` and its audit. */
export async function editLead(
  db: DbExecutor,
  context: BusinessProfileContext,
  conversationId: string,
  edit: {
    readonly assignedUserId?: string | null;
    readonly tags?: readonly string[];
    readonly note?: string;
    readonly nextAction?: string;
    readonly nextActionAt?: Date | null;
  },
): Promise<LeadEditOutcome> {
  const scope = profileScopeOf(context);
  const tags = edit.tags === undefined ? undefined : [...new Set(edit.tags.map((tag) => tag.trim()).filter((tag) => tag !== ""))];

  if (edit.assignedUserId !== undefined && edit.assignedUserId !== null) {
    const member = await db.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: context.workspaceId, userId: edit.assignedUserId } },
      select: { id: true },
    });
    if (member === null) {
      // Assigning a lead to somebody who is not in the Workspace would put a name on it that nobody can
      // act under, and the next reader would reasonably believe that person was working it.
      return { status: "REFUSED", reason: "a lead can only be assigned to a member of this workspace" };
    }
  }

  const changed = await db.conversation.updateMany({
    where: { ...scope, id: conversationId },
    data: {
      ...(edit.assignedUserId === undefined ? {} : { assignedUserId: edit.assignedUserId }),
      ...(tags === undefined ? {} : { leadTags: tags }),
      ...(edit.note === undefined ? {} : { leadNote: blankToNull(edit.note) }),
      ...(edit.nextAction === undefined ? {} : { nextAction: blankToNull(edit.nextAction) }),
      ...(edit.nextActionAt === undefined ? {} : { nextActionAt: edit.nextActionAt }),
    },
  });
  return changed.count === 0 ? { status: "GONE" } : { status: "SAVED" };
}

function blankToNull(value: string): string | null {
  return value.trim() === "" ? null : value.trim();
}

export interface QualificationAnswer {
  readonly criterion: string;
  readonly value: string;
  readonly source: LeadValueSource;
  readonly actorName: string | null;
  readonly updatedAt: Date;
}

/**
 * Every answer, both the AI's and the people's, side by side.
 *
 * Not merged. The invariant is that an AI suggestion stays distinct from a human-confirmed value, and a
 * reader who sees one field cannot tell whether a person ever looked at it.
 */
export async function readQualification(
  db: DbExecutor,
  context: BusinessProfileContext,
  conversationId: string,
): Promise<readonly QualificationAnswer[]> {
  const scope = profileScopeOf(context);
  const rows = await db.leadQualificationAnswer.findMany({
    where: { ...scope, conversationId },
    orderBy: [{ criterion: "asc" }, { source: "asc" }],
    select: { criterion: true, value: true, source: true, updatedAt: true, actor: { select: { name: true } } },
  });
  return rows.map((row) => ({
    criterion: row.criterion,
    value: row.value,
    source: row.source,
    actorName: row.actor?.name ?? null,
    updatedAt: row.updatedAt,
  }));
}

/** A person's answer to a qualification criterion. Recorded beside the AI's, never over it. */
export async function recordQualification(
  db: DbExecutor,
  context: BusinessProfileContext,
  conversationId: string,
  input: { readonly criterion: string; readonly value: string; readonly source: "HUMAN_CONFIRMED" | "HUMAN_SET" },
): Promise<LeadEditOutcome> {
  const scope = profileScopeOf(context);
  const criterion = input.criterion.trim();
  const value = input.value.trim();
  if (criterion === "" || value === "") {
    return { status: "REFUSED", reason: "an answer needs both the question and the answer" };
  }
  const conversation = await db.conversation.findFirst({ where: { ...scope, id: conversationId }, select: { id: true } });
  if (conversation === null) {
    return { status: "GONE" };
  }

  await db.leadQualificationAnswer.upsert({
    where: {
      workspaceId_businessProfileId_conversationId_criterion_source: { ...scope, conversationId, criterion, source: input.source },
    },
    create: { ...scope, conversationId, criterion, value, source: input.source, actorUserId: context.userId },
    update: { value, actorUserId: context.userId },
  });
  return { status: "SAVED" };
}
