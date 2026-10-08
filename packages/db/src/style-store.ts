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

/** The stored vocabulary, named here so the lifecycle helpers below are not typed on string literals. */
type StyleExampleStatusValue = "ACTIVE" | "SUGGESTED" | "REJECTED" | "ARCHIVED";
type StyleExampleProvenanceValue = "HUMAN_TYPED" | "HUMAN_EDITED_DRAFT";
export type StyleDecisionValue = "APPROVED" | "REJECTED" | "ARCHIVED" | "RESTORED";

const DEFAULT_PAGE = 25;
const MAX_PAGE = 100;

/**
 * How much of one example's lifecycle a page carries. Twenty decisions is a long argument.
 *
 * The number is unchanged; which twenty it means is not. It used to be the twenty **oldest**, so after the
 * twenty-first decision every later event — including the one that produced the example's current state —
 * disappeared from the history with nothing on screen to say so. It is now the twenty **most recent**,
 * still rendered oldest-first, with the count of earlier events and a cursor that reaches them.
 *
 * Anchoring the window at the newest end is what makes the bound safe rather than merely small: whatever
 * is cut is cut from the end a reader can ask for explicitly, and the part that answers "what is the
 * state of this example and who put it there" is always present.
 */
const MAX_DECISIONS = 20;

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
  /**
   * Somebody else wrote this layer since the screen was rendered.
   *
   * A typed answer rather than a lost update or a raw constraint error: two tabs open on one business's
   * voice is ordinary, and the one that saves second must be told so instead of quietly replacing a
   * colleague's complete profile with a stale copy of it.
   */
  | { readonly status: "CONFLICT" }
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
  /**
   * What the screen believed it was editing, as the layer's own `updatedAt`.
   *
   * Absent means "there was no layer when this form was rendered", which is a claim like any other and
   * is checked the same way. Omitting the parameter entirely is the system-caller path, which has no
   * screen behind it and nothing stale to carry.
   */
  expected?: { readonly updatedAt?: Date },
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
    select: { id: true, updatedAt: true },
  });

  if (existing === null) {
    if (expected?.updatedAt !== undefined) {
      // The form was rendered against a layer that has since been deleted. Nothing to overwrite, and
      // writing a fresh one would silently discard whatever the other operator did.
      return { status: "CONFLICT" };
    }
    try {
      await db.styleProfile.create({ data: { workspaceId: scope.workspaceId, businessProfileId, ...data } });
    } catch (error) {
      // Two first saves can both see no row. The partial unique index decides which one wins, and the
      // loser is told it conflicted rather than handed a raw constraint error.
      if (isUniqueViolation(error)) {
        return { status: "CONFLICT" };
      }
      throw error;
    }
    return { status: "SAVED" };
  }

  if (expected !== undefined && expected.updatedAt?.getTime() !== existing.updatedAt.getTime()) {
    // A stale tab. Overwriting here is the lost update this check exists to prevent: the screen is
    // carrying a complete profile, so every field a colleague just changed would be replaced by an old
    // copy of itself.
    return { status: "CONFLICT" };
  }
  // Conditional on the same instant the decision was made from, so a save committed between the read
  // above and this write loses rather than being overwritten.
  const changed = await db.styleProfile.updateMany({
    where: { id: existing.id, ...(expected === undefined ? {} : { updatedAt: existing.updatedAt }) },
    data,
  });
  return changed.count === 0 ? { status: "CONFLICT" } : { status: "SAVED" };
}

/** Prisma's unique-violation code, named once rather than compared inline at each call site. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
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
  /**
   * A window of what anybody decided about this example, oldest first within the window.
   *
   * Read with the example rather than on demand, because it is the answer to the question the retired
   * list exists to ask — "who withdrew this, and had anyone approved it before?" — and a history nothing
   * renders is a history nobody can consult.
   *
   * The window holds the most recent `MAX_DECISIONS`, so the decision that produced the current state is
   * always in it. When there are more, `earlierDecisions` says how many and `earlierCursor` reaches them;
   * a truncation nobody is told about is the defect this replaced.
   */
  readonly decisions: readonly StyleDecisionView[];
  /** How many decisions happened before the window. Zero means nothing older is hidden. */
  readonly earlierDecisions: number;
  /**
   * How many happened after it. Always zero here, because this window is anchored at the newest end.
   *
   * Carried anyway, so that the one type describes both ways a window can be partial. A page of the
   * lifecycle *can* hide later events, and a reader needs telling in both directions — a history headed
   * "what has happened to it" whose last entry is `RESTORED`, under a badge reading "Archived", is the
   * same defect as the one this replaced wearing a different number.
   */
  readonly laterDecisions: number;
  /** Where to continue backwards. Absent when nothing is earlier, or when no row was shown to start from. */
  readonly earlierCursor?: StyleDecisionCursor;
}

export interface StyleDecisionView {
  /**
   * The row's own id, carried so a reader can tell two identical decisions apart.
   *
   * `decidedAt` is not a key — two decisions can share a millisecond — and the history was previously
   * keyed in React by decision-and-instant, which collides for exactly that pair and makes one of them
   * disappear from the rendered list. A lifecycle that cannot be *shown* completely is not retrievable
   * completely, whatever the query returned.
   */
  readonly id: string;
  readonly decision: StyleDecisionValue;
  readonly decidedByName: string | null;
  readonly decidedAt: Date;
}

/**
 * Where a page of one example's lifecycle ends, so the next page can start before it.
 *
 * Both halves travel, for the reason `StyleExampleCursor` carries both of its own: `decidedAt` is not
 * unique — four decisions can land in one millisecond, and two certainly can — and a cursor on an instant
 * with no tiebreak silently repeats or skips rows. On a page of audit history that reads as an event
 * happening twice, or not happening at all, which is precisely what this history exists to rule out.
 */
export interface StyleDecisionCursor {
  readonly decidedAt: Date;
  readonly id: string;
}

export interface StyleExampleFilter {
  /**
   * One status, or several read as one list.
   *
   * Several, because the screen's "not in use" list is archived examples *and* declined suggestions —
   * the same thing to the person looking at it. Reading them as two pages and concatenating made the
   * merged list unpageable: one cursor cannot continue two queries, so the second source was always its
   * own first page and everything past it was unreachable. One query over both statuses is one keyset,
   * one cursor and one link, which is the only shape in which "every example is reachable" is true by
   * construction rather than by argument.
   */
  readonly status?: StyleExampleStatusValue | readonly StyleExampleStatusValue[];
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
      ...statusFilter(filter.status),
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
      // The count first, because it is the only way to know that the window below is partial. Prisma's
      // `take` gives no indication of what it left behind, and a window that cannot say it is a window is
      // the truncation this read used to perform in silence.
      //
      // Filtered by workspace like the window under it. The foreign key and `decide()` make the two agree
      // today, but a count and the rows it describes derived under different predicates is a pair that
      // only agrees by argument.
      _count: { select: { decisions: { where: { workspaceId: scope.workspaceId } } } },
      decisions: {
        // Newest first *in the query*, so the window is anchored at the end that holds the current state;
        // it is reversed below, because the list reads as a story and a lifecycle out of order is not a
        // lifecycle. Bounded, like every other read in this file.
        orderBy: [{ decidedAt: "desc" }, { id: "desc" }],
        take: MAX_DECISIONS,
        select: { id: true, decision: true, decidedAt: true, decidedBy: { select: { name: true } } },
      },
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
      ...lifecycleWindowOf(row._count.decisions, row._count.decisions, row.decisions),
    })),
    ...(rows.length > limit && last !== undefined ? { nextCursor: { createdAt: last.createdAt, id: last.id } } : {}),
  };
}

/** What one decision row looks like wherever the lifecycle is read. */
type DecisionRow = {
  readonly id: string;
  readonly decision: StyleDecisionValue;
  readonly decidedAt: Date;
  readonly decidedBy: { readonly name: string | null };
};

/**
 * Turns a newest-first batch of decisions into the oldest-first window a reader sees.
 *
 * One function for both readers — the example list and the lifecycle page — because they must agree about
 * what "earlier" means. Two implementations of a windowing rule is how a cursor comes to skip the row it
 * was supposed to start before.
 *
 * `total` is the count of decisions at or before this batch's own starting point, so `earlierDecisions` is
 * what remains unreached rather than the lifecycle's whole length.
 */
function lifecycleWindowOf(
  reachable: number,
  total: number,
  newestFirst: readonly DecisionRow[],
): {
  readonly decisions: readonly StyleDecisionView[];
  readonly earlierDecisions: number;
  readonly laterDecisions: number;
  readonly earlierCursor?: StyleDecisionCursor;
} {
  const oldestShown = newestFirst.at(-1);
  // A page with no rows has no window to describe, so nothing can be "earlier than" it: everything that
  // exists is simply not shown here, which belongs on the later side because that is where the reader's
  // route back points. Without this the empty page could report a count with no link to follow — the one
  // state where the two halves of the original finding would both be true at once.
  const earlierDecisions = newestFirst.length === 0 ? 0 : Math.max(reachable - newestFirst.length, 0);
  return {
    // Reversed rather than re-queried: the window is already the rows wanted, and asking the database for
    // them again in the other order would be a second query that could disagree with the first.
    decisions: [...newestFirst].toReversed().map((decision) => ({
      id: decision.id,
      decision: decision.decision,
      decidedByName: decision.decidedBy.name,
      decidedAt: decision.decidedAt,
    })),
    earlierDecisions,
    // Everything this page does not reach backwards from its own starting point: the lifecycle's length
    // less the part at or before the cursor. On the newest-anchored window `reachable === total`, so it
    // is zero, which is what makes the common case silent.
    laterDecisions: newestFirst.length === 0 ? total : Math.max(total - reachable, 0),
    // Present when there is something earlier to reach *and* a row to start from, so a caller cannot
    // offer a link to nothing. A page with no rows has nothing to page before, whatever the count says.
    ...(earlierDecisions > 0 && oldestShown !== undefined
      ? { earlierCursor: { decidedAt: oldestShown.decidedAt, id: oldestShown.id } }
      : {}),
  };
}

export interface StyleLifecyclePage {
  readonly styleExampleId: string;
  /** This page's decisions, oldest first within the page. */
  readonly decisions: readonly StyleDecisionView[];
  /** How many decisions happened before this page. */
  readonly earlierDecisions: number;
  /** How many happened after it — the half a page into the past necessarily hides. */
  readonly laterDecisions: number;
  readonly earlierCursor?: StyleDecisionCursor;
  /** The lifecycle's whole length, so a reader is told where this page sits in it. */
  readonly totalDecisions: number;
}

/**
 * One example's lifecycle, a page at a time, paging backwards into the past (R5 re-review).
 *
 * This exists because a bounded window is not a complete history, and the reviewer was right that a
 * bound with no continuation makes events unreachable rather than merely unshown. Every decision is now
 * reachable: the example list carries the most recent window and a cursor, and each call here returns the
 * page immediately before the cursor it was given, with the cursor for the one before that.
 *
 * Scoped through the caller's own context like every other read in this file, so a cursor carries no
 * authority — the worst a forged one can do is point into this profile's own history.
 *
 * `null` for an example this context cannot see, which is a different answer from an empty lifecycle: an
 * example in another workspace and an example nobody has decided anything about must not read the same.
 */
export async function readStyleExampleLifecycle(
  db: DbExecutor,
  context: BusinessProfileContext,
  styleExampleId: string,
  page: { readonly limit?: number; readonly before?: StyleDecisionCursor } = {},
): Promise<StyleLifecyclePage | null> {
  const scope = profileScopeOf(context);
  const limit = Math.min(Math.max(Math.trunc(page.limit ?? MAX_DECISIONS), 1), MAX_PAGE);
  const example = await db.styleExample.findFirst({
    where: {
      id: styleExampleId,
      workspaceId: scope.workspaceId,
      ...exampleScopeFilter(undefined, scope.businessProfileId),
    },
    select: { id: true, _count: { select: { decisions: { where: { workspaceId: scope.workspaceId } } } } },
  });
  if (example === null) {
    return null;
  }

  const before = page.before;
  const earlierThanCursor = {
    ...(before === undefined
      ? {}
      : { OR: [{ decidedAt: { lt: before.decidedAt } }, { decidedAt: before.decidedAt, id: { lt: before.id } }] }),
  };
  const [rows, reachable] = await Promise.all([
    db.styleExampleDecision.findMany({
      where: { workspaceId: scope.workspaceId, styleExampleId: example.id, ...earlierThanCursor },
      orderBy: [{ decidedAt: "desc" }, { id: "desc" }],
      take: limit,
      select: { id: true, decision: true, decidedAt: true, decidedBy: { select: { name: true } } },
    }),
    // How many decisions are at or before this page's starting point. Counted rather than derived from
    // the total, because the page's own position is what decides whether there is anything earlier — and
    // a cursor in the middle of the lifecycle makes "total minus shown" the wrong number.
    db.styleExampleDecision.count({ where: { workspaceId: scope.workspaceId, styleExampleId: example.id, ...earlierThanCursor } }),
  ]);

  return {
    styleExampleId: example.id,
    ...lifecycleWindowOf(reachable, example._count.decisions, rows),
    totalDecisions: example._count.decisions,
  };
}

/**
 * One status, several, or no constraint at all.
 *
 * Narrowed in a function rather than inline, because `Array.isArray` on a `readonly` union does not narrow
 * well enough inside an object spread — and a cast there would be a cast in the one place the status
 * reaches the database.
 */
function statusFilter(
  status: StyleExampleStatusValue | readonly StyleExampleStatusValue[] | undefined,
): { readonly status?: StyleExampleStatusValue | { readonly in: StyleExampleStatusValue[] } } {
  if (status === undefined) {
    return {};
  }
  return typeof status === "string" ? { status } : { status: { in: [...status] } };
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
export async function approveStyleExample(db: DbClient, context: BusinessProfileContext, exampleId: string, at = new Date()): Promise<StyleWriteOutcome> {
  return decide(db, context, exampleId, { from: ["SUGGESTED"], to: "ACTIVE", outcome: { status: "ACTIVATED" }, decision: "APPROVED", approve: true }, at);
}

/** Declines a suggestion. Kept rather than deleted, so the decision is auditable. */
export async function rejectStyleExample(db: DbClient, context: BusinessProfileContext, exampleId: string, at = new Date()): Promise<StyleWriteOutcome> {
  return decide(db, context, exampleId, { from: ["SUGGESTED"], to: "REJECTED", outcome: { status: "REJECTED_EXAMPLE" }, decision: "REJECTED" }, at);
}

/** Out of style retrieval immediately, because the query filters on ACTIVE. */
export async function archiveStyleExample(db: DbClient, context: BusinessProfileContext, exampleId: string, at = new Date()): Promise<StyleWriteOutcome> {
  return decide(db, context, exampleId, { from: ["ACTIVE"], to: "ARCHIVED", outcome: { status: "ARCHIVED" }, decision: "ARCHIVED" }, at);
}

/**
 * Back into style retrieval, naming whoever brought it back.
 *
 * The approver is re-stamped rather than left as it was: the person restoring an example is the one
 * standing behind it now, and the CHECK would accept the old name — which would make the audit trail say
 * a colleague approved something they never saw again.
 *
 * Re-stamping used to be the end of it, and that lost the previous approver for good. It does not now:
 * every decision writes an audit row naming the actor and the transition, so "who approved this first,
 * who archived it, who brought it back" is a question the history answers even though the row itself
 * only ever holds the current answer.
 */
export async function restoreStyleExample(db: DbClient, context: BusinessProfileContext, exampleId: string, at = new Date()): Promise<StyleWriteOutcome> {
  return decide(db, context, exampleId, { from: ["ARCHIVED", "REJECTED"], to: "ACTIVE", outcome: { status: "RESTORED" }, decision: "RESTORED", approve: true }, at);
}

/**
 * One lifecycle decision, with the record of who made it.
 *
 * The status alone cannot answer the questions somebody actually asks of this screen. "Archived" does
 * not say who withdrew it, and an example that was rejected, restored and archived again looks exactly
 * like one archived on the first day. So each transition stamps the decision, its actor and its instant
 * — and leaves the *first* approver alone, because re-stamping that on every restore is what destroyed
 * the identity of whoever originally vouched for the example.
 *
 * Read and write in one transaction, conditional on the status the decision was made from: two people
 * judging the same suggestion at once produce one decision rather than two, and the loser is told it is
 * gone rather than silently overwriting the winner.
 */
async function decide(
  db: DbClient,
  context: BusinessProfileContext,
  exampleId: string,
  transition: {
    readonly from: readonly StyleExampleStatusValue[];
    readonly to: StyleExampleStatusValue;
    readonly outcome: StyleWriteOutcome;
    readonly decision: StyleDecisionValue;
    readonly approve?: boolean;
  },
  at: Date,
): Promise<StyleWriteOutcome> {
  const scope = profileScopeOf(context);
  return db.$transaction(async (tx) => {
    const where = {
      workspaceId: scope.workspaceId,
      id: exampleId,
      status: { in: [...transition.from] },
      ...exampleScopeFilter(undefined, scope.businessProfileId),
    };
    const before = await tx.styleExample.findFirst({ where, select: { status: true, approvedByUserId: true } });
    if (before === null) {
      return { status: "GONE" } as const;
    }
    const changed = await tx.styleExample.updateMany({
      where,
      data: {
        status: transition.to,
        // Who decided, and when. Every transition writes it, including the ones that do not change the
        // approver, so "who archived this?" has an answer rather than being inferred from a status.
        decidedByUserId: context.userId,
        decidedAt: at,
        decision: transition.decision,
        // The first person to vouch for it, set once and never replaced. Re-stamping it on every
        // restore is what destroyed the identity of the original approver.
        ...(transition.approve === true && before.approvedByUserId === null ? { approvedByUserId: context.userId } : {}),
      },
    });
    if (changed.count === 0) {
      // Somebody decided it between the read and the write. Theirs stands.
      return { status: "GONE" } as const;
    }
    // The decision itself, kept rather than overwritten. The columns above answer "who withdrew this?";
    // only these rows answer "what happened to it?", and an example rejected, restored and archived again
    // is a different thing from one archived on the first day. In the same transaction as the transition
    // it records, so a history cannot claim a decision that did not take effect, or miss one that did.
    await tx.styleExampleDecision.create({
      data: {
        workspaceId: scope.workspaceId,
        styleExampleId: exampleId,
        decision: transition.decision,
        decidedByUserId: context.userId,
        decidedAt: at,
      },
    });
    return transition.outcome;
  });
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
  input: {
    readonly inboundContext: string;
    readonly outboundText: string;
    readonly sourceMessageId?: string;
    /**
     * The draft a person rewrote, when that is where this came from.
     *
     * Present exactly when `provenance` is `HUMAN_EDITED_DRAFT`: the edit is the signal, and without the
     * draft it points at there is no way to show an operator what the assistant had written instead.
     */
    readonly sourceDraftId?: string;
    /**
     * How this reply came to exist. Defaulted rather than hard-coded, because the two sources mean
     * different things to somebody judging the suggestion: a reply typed from a phone is how this
     * colleague writes, while an edited draft is a correction of how the assistant writes.
     */
    readonly provenance?: StyleExampleProvenanceValue;
    readonly language?: string;
  },
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
      provenance: input.provenance ?? "HUMAN_TYPED",
      status: "SUGGESTED",
      ...(input.sourceMessageId === undefined ? {} : { sourceMessageId: input.sourceMessageId }),
      ...(input.sourceDraftId === undefined ? {} : { sourceDraftId: input.sourceDraftId }),
      ...(input.language === undefined ? {} : { language: input.language }),
    },
  });
  return { status: "SAVED" };
}
