/**
 * Reading and writing automation settings (AI_CONFIGURATION_UX.md, ADR-014, ADR-016, Issue #30).
 *
 * Three things this file is arranged to guarantee.
 *
 * **A preset is a name, not a number.** A caller sends `BALANCED`; the values come from
 * `confidenceSettingsFor` in the domain. A caller that could send a threshold could send any threshold,
 * and the preset would stop meaning anything the next time somebody edited a form. Custom values exist,
 * and they are an explicit choice rather than the default shape of a request.
 *
 * **The audit is written in the same transaction as the change.** Separately, a crash between them leaves
 * a policy nobody appears to have changed — which is the one question an audit trail exists to answer.
 *
 * **Mandatory-review topics have a floor.** `createAutomationPolicy` re-adds every
 * `MANDATORY_REVIEW_REASON_CODES` entry whatever the caller asked for, so this store cannot write a
 * policy that lets a payment dispute answer itself, and neither can anything built on top of it.
 *
 * **Only an owner or an admin may change them.** `ONBOARDING_UX.md` says workspace roles constrain policy
 * changes, and a Business Profile context proves membership and profile visibility — not permission to
 * edit. The check belongs here rather than in the screen that calls it, because every other caller would
 * otherwise inherit the screen's omission.
 *
 * **A save names the version it was composed against.** Two tabs read the same settings, and the second
 * save posts every field from a snapshot that predates the first; without the version it would succeed and
 * revert changes its author never saw. `expectedVersion` is required rather than optional for the usual
 * reason: an optional guard is a guard the next caller forgets.
 */
import {
  confidencePresetOf,
  confidenceSettingsFor,
  createAutomationPolicy,
  defaultAutomationSettings,
  policyImpactsOf,
  timingPresetOf,
  timingSettingsFor,
  type AiMode,
  type ConfidencePreset,
  type InstagramAfterWindowPolicy,
  type PolicyImpact,
  type TimingPreset,
  type WhatsAppAfterWindowPolicy,
} from "@omnichannel/domain";

import type { DbClient, DbExecutor } from "./client";
import { recordAuditEvent } from "./audit-store";
import { profileScopeOf, requireRole, WORKSPACE_ADMIN_ROLES, type BusinessProfileContext } from "./tenancy";

/**
 * The Business Profile default, as the nested write that creates it alongside the profile.
 *
 * Written explicitly rather than left to the column defaults. The schema's defaults say the same thing
 * today, and a row written by this statement would look identical either way — but then "what a profile
 * starts with" would be stated twice, once in the domain and once in a migration, and only one of them is
 * read when somebody changes their mind. Here the columns are set from the domain's answer, and the
 * schema's defaults are what protects the rows this statement does not write.
 */
export function profileDefaultPolicyWrite(): {
  readonly mode: AiMode;
  readonly confidenceThreshold: number;
  readonly mandatoryReviewReasons: string[];
  readonly debounceMinMs: number;
  readonly debounceMaxMs: number;
  readonly deliveryDelayMinMs: number;
  readonly deliveryDelayMaxMs: number;
  readonly takeoverPauseMs: number;
  readonly instagramAfterWindowPolicy: InstagramAfterWindowPolicy;
  readonly whatsappAfterWindowPolicy: WhatsAppAfterWindowPolicy;
  readonly whatsappTemplateAutomationAllowlist: string[];
} {
  const settings = defaultAutomationSettings();
  return {
    mode: settings.mode,
    confidenceThreshold: settings.confidenceThreshold,
    mandatoryReviewReasons: [...settings.mandatoryReviewReasons],
    debounceMinMs: settings.debounceWindowMs.minMs,
    debounceMaxMs: settings.debounceWindowMs.maxMs,
    deliveryDelayMinMs: settings.deliveryDelayMs.minMs,
    deliveryDelayMaxMs: settings.deliveryDelayMs.maxMs,
    takeoverPauseMs: settings.takeoverPauseMs,
    instagramAfterWindowPolicy: settings.instagramAfterWindowPolicy,
    whatsappAfterWindowPolicy: settings.whatsappAfterWindowPolicy,
    whatsappTemplateAutomationAllowlist: [...settings.whatsappTemplateAutomationAllowlist],
  };
}

export interface PolicyView {
  readonly id: string;
  /** Absent for the Business Profile default; set for a channel-account override. */
  readonly channelAccountId: string | null;
  readonly mode: string;
  readonly businessGoal: string | null;
  readonly qualificationCriteria: readonly string[];
  readonly confidenceThreshold: number;
  readonly mandatoryReviewReasons: readonly string[];
  /** Which preset these values correspond to, or absent when an owner tuned them by hand. */
  readonly confidencePreset?: ConfidencePreset;
  readonly timingPreset: TimingPreset;
  readonly debounceWindowMs: { readonly minMs: number; readonly maxMs: number };
  readonly deliveryDelayMs: { readonly minMs: number; readonly maxMs: number };
  readonly takeoverPauseMs: number;
  readonly instagramAfterWindowPolicy: string;
  readonly whatsappAfterWindowPolicy: string;
  readonly whatsappTemplateAutomationAllowlist: readonly string[];
  /** The number this policy has been written; a save must name the one it was composed against. */
  readonly version: number;
  readonly updatedAt: Date;
}

const policySelect = {
  id: true,
  channelAccountId: true,
  mode: true,
  businessGoal: true,
  qualificationCriteria: true,
  confidenceThreshold: true,
  mandatoryReviewReasons: true,
  debounceMinMs: true,
  debounceMaxMs: true,
  deliveryDelayMinMs: true,
  deliveryDelayMaxMs: true,
  takeoverPauseMs: true,
  instagramAfterWindowPolicy: true,
  whatsappAfterWindowPolicy: true,
  whatsappTemplateAutomationAllowlist: true,
  version: true,
  updatedAt: true,
} as const;

type PolicyRow = {
  id: string;
  channelAccountId: string | null;
  mode: string;
  businessGoal: string | null;
  qualificationCriteria: string[];
  confidenceThreshold: number;
  mandatoryReviewReasons: string[];
  debounceMinMs: number;
  debounceMaxMs: number;
  deliveryDelayMinMs: number;
  deliveryDelayMaxMs: number;
  takeoverPauseMs: number;
  instagramAfterWindowPolicy: string;
  whatsappAfterWindowPolicy: string;
  whatsappTemplateAutomationAllowlist: string[];
  version: number;
  updatedAt: Date;
};

function toView(row: PolicyRow): PolicyView {
  const timing = {
    debounceWindowMs: { minMs: row.debounceMinMs, maxMs: row.debounceMaxMs },
    deliveryDelayMs: { minMs: row.deliveryDelayMinMs, maxMs: row.deliveryDelayMaxMs },
  };
  // The preset names are derived, never stored. Storing one would let the label and the values drift
  // apart, and then the screen would say "Balanced" about settings that are not.
  const confidencePreset = confidencePresetOf({
    confidenceThreshold: row.confidenceThreshold,
    mandatoryReviewReasons: row.mandatoryReviewReasons as never,
  });
  return {
    id: row.id,
    channelAccountId: row.channelAccountId,
    mode: row.mode,
    businessGoal: row.businessGoal,
    qualificationCriteria: row.qualificationCriteria,
    confidenceThreshold: row.confidenceThreshold,
    mandatoryReviewReasons: row.mandatoryReviewReasons,
    ...(confidencePreset === undefined ? {} : { confidencePreset }),
    timingPreset: timingPresetOf(timing),
    debounceWindowMs: timing.debounceWindowMs,
    deliveryDelayMs: timing.deliveryDelayMs,
    takeoverPauseMs: row.takeoverPauseMs,
    instagramAfterWindowPolicy: row.instagramAfterWindowPolicy,
    whatsappAfterWindowPolicy: row.whatsappAfterWindowPolicy,
    whatsappTemplateAutomationAllowlist: row.whatsappTemplateAutomationAllowlist,
    version: row.version,
    updatedAt: row.updatedAt,
  };
}

/** The Business Profile default first, then any channel-account overrides. */
export async function readPolicies(db: DbExecutor, context: BusinessProfileContext): Promise<readonly PolicyView[]> {
  const scope = profileScopeOf(context);
  const rows = await db.automationPolicy.findMany({ where: scope, select: policySelect });
  return [...rows]
    .sort((left, right) => Number(left.channelAccountId !== null) - Number(right.channelAccountId !== null))
    .map(toView);
}

export interface PolicyEdit {
  /**
   * The `version` of the policy this edit was composed against. Required, so that no caller can decide
   * not to care: a form rendered from version 4 may only write version 4, and anything else is a
   * conflict rather than a save.
   */
  readonly expectedVersion: number;
  readonly mode?: AiMode;
  readonly businessGoal?: string;
  readonly qualificationCriteria?: readonly string[];
  /** A name, resolved server-side. Mutually exclusive with `confidence`. */
  readonly confidencePreset?: ConfidencePreset;
  /** Hand-tuned values, for the advanced path the spec allows. */
  readonly confidence?: { readonly confidenceThreshold: number; readonly mandatoryReviewReasons: readonly string[] };
  readonly timingPreset?: TimingPreset;
  readonly timing?: {
    readonly debounceWindowMs: { readonly minMs: number; readonly maxMs: number };
    readonly deliveryDelayMs: { readonly minMs: number; readonly maxMs: number };
  };
  readonly takeoverPauseMs?: number;
  readonly instagramAfterWindowPolicy?: InstagramAfterWindowPolicy;
  readonly whatsappAfterWindowPolicy?: WhatsAppAfterWindowPolicy;
  readonly whatsappTemplateAutomationAllowlist?: readonly string[];
}

export type PolicyWriteOutcome =
  | { readonly status: "SAVED"; readonly impacts: readonly PolicyImpact[] }
  | { readonly status: "UNCHANGED" }
  | { readonly status: "GONE" }
  /** Somebody else wrote these settings first. `current` is what is stored now, for the screen to show. */
  | { readonly status: "CONFLICT"; readonly current: PolicyView }
  | { readonly status: "REFUSED"; readonly reason: string };

/**
 * Writes one policy layer and records who changed it.
 *
 * The whole edit goes through `createAutomationPolicy`, which is the domain's validator: it re-adds the
 * mandatory-review floor, refuses an unknown mode or after-window policy, and rejects a blank allowlist
 * entry. Validating here instead would be a second opinion about the same rules, and the two would
 * eventually disagree.
 */
export async function savePolicy(
  db: DbClient,
  context: BusinessProfileContext,
  channelAccountId: string | null,
  edit: PolicyEdit,
): Promise<PolicyWriteOutcome> {
  const scope = profileScopeOf(context);
  // Membership is not permission. `ONBOARDING_UX.md` constrains policy changes by role exactly as it
  // constrains connecting a channel, and an AGENT who may read a conversation may not switch the
  // workspace to AUTOPILOT.
  requireRole(context, WORKSPACE_ADMIN_ROLES, "changing automation settings");

  if (edit.confidencePreset !== undefined && edit.confidence !== undefined) {
    // Both would mean two answers to one question, and whichever won would be an accident of ordering.
    return { status: "REFUSED", reason: "choose a preset or exact values, not both" };
  }
  if (edit.timingPreset !== undefined && edit.timingPreset !== "CUSTOM" && edit.timing !== undefined) {
    return { status: "REFUSED", reason: "choose a timing preset or exact values, not both" };
  }

  return db.$transaction(async (tx) => {
    // Locked before it is read, and held until commit, so the version compared below is the version this
    // transaction will overwrite. Without the lock two savers both read version 4 at READ COMMITTED, both
    // find their expectation satisfied, and the second write still lands on the first one's result — the
    // version would then be a check that passes exactly when it is needed least.
    await tx.$queryRaw`
      SELECT "id" FROM "automation_policies"
      WHERE "workspace_id" = ${scope.workspaceId}
        AND "business_profile_id" = ${scope.businessProfileId}
        AND "channel_account_id" IS NOT DISTINCT FROM ${channelAccountId}
      FOR UPDATE`;
    const existing = await tx.automationPolicy.findFirst({ where: { ...scope, channelAccountId }, select: policySelect });
    if (existing === null) {
      // Covers a channel account that is not this profile's as well, and not by luck: the policy's own
      // foreign key is the composite `(workspace, profile, channel account)`, so a row found inside this
      // scope necessarily names an account inside it. A second existence check here looked prudent and
      // was unreachable — mutation testing found it by deleting it and breaking nothing.
      return { status: "GONE" };
    }
    if (existing.version !== edit.expectedVersion) {
      // Refused, and the caller is handed what is stored instead, because "your change was not applied"
      // without the current values is an instruction to guess.
      return { status: "CONFLICT", current: toView(existing) };
    }

    const before = toView(existing);
    const confidence =
      edit.confidencePreset !== undefined
        ? confidenceSettingsFor(edit.confidencePreset)
        : (edit.confidence ?? { confidenceThreshold: before.confidenceThreshold, mandatoryReviewReasons: before.mandatoryReviewReasons });
    const timing =
      edit.timingPreset !== undefined && edit.timingPreset !== "CUSTOM"
        ? (timingSettingsFor(edit.timingPreset) ?? { debounceWindowMs: before.debounceWindowMs, deliveryDelayMs: before.deliveryDelayMs })
        : (edit.timing ?? { debounceWindowMs: before.debounceWindowMs, deliveryDelayMs: before.deliveryDelayMs });

    let validated;
    try {
      // The domain decides what is legal, including re-adding the mandatory-review floor.
      validated = createAutomationPolicy({
        id: existing.id as never,
        workspaceId: scope.workspaceId,
        businessProfileId: scope.businessProfileId,
        ...(channelAccountId === null ? {} : { channelAccountId: channelAccountId as never }),
        mode: edit.mode ?? (before.mode as AiMode),
        confidenceThreshold: confidence.confidenceThreshold,
        mandatoryReviewReasons: confidence.mandatoryReviewReasons as never,
        debounceWindowMs: timing.debounceWindowMs,
        deliveryDelayMs: timing.deliveryDelayMs,
        takeoverPauseMs: edit.takeoverPauseMs ?? before.takeoverPauseMs,
        instagramAfterWindowPolicy: edit.instagramAfterWindowPolicy ?? (before.instagramAfterWindowPolicy as InstagramAfterWindowPolicy),
        whatsappAfterWindowPolicy: edit.whatsappAfterWindowPolicy ?? (before.whatsappAfterWindowPolicy as WhatsAppAfterWindowPolicy),
        whatsappTemplateAutomationAllowlist: edit.whatsappTemplateAutomationAllowlist ?? before.whatsappTemplateAutomationAllowlist,
      });
    } catch (error) {
      // The domain's own message, which names the field. Rewriting it here would lose that.
      return { status: "REFUSED", reason: error instanceof Error ? error.message : "the settings were refused" };
    }

    const goal = edit.businessGoal === undefined ? before.businessGoal : blankToNull(edit.businessGoal);
    const criteria =
      edit.qualificationCriteria === undefined
        ? before.qualificationCriteria
        : edit.qualificationCriteria.map((entry) => entry.trim()).filter((entry) => entry !== "");

    const after = {
      mode: validated.mode,
      businessGoal: goal,
      // Mutable copies: Prisma's update input will not take a readonly array, and these are the values
      // being written rather than values anyone else holds.
      qualificationCriteria: [...criteria],
      confidenceThreshold: validated.confidenceThreshold as number,
      mandatoryReviewReasons: [...validated.mandatoryReviewReasons] as string[],
      debounceMinMs: validated.debounceWindowMs.minMs,
      debounceMaxMs: validated.debounceWindowMs.maxMs,
      deliveryDelayMinMs: validated.deliveryDelayMs.minMs,
      deliveryDelayMaxMs: validated.deliveryDelayMs.maxMs,
      takeoverPauseMs: validated.takeoverPauseMs,
      instagramAfterWindowPolicy: validated.instagramAfterWindowPolicy,
      whatsappAfterWindowPolicy: validated.whatsappAfterWindowPolicy,
      whatsappTemplateAutomationAllowlist: [...validated.whatsappTemplateAutomationAllowlist],
    };

    if (!changed(existing, after)) {
      // No audit row for a save that altered nothing: a history where every click is an entry is a
      // history nobody reads, and "did anyone touch this?" stops having a useful answer.
      return { status: "UNCHANGED" };
    }

    const impacts = policyImpactsOf(
      {
        mode: before.mode,
        confidenceThreshold: before.confidenceThreshold,
        mandatoryReviewReasons: before.mandatoryReviewReasons,
        instagramAfterWindowPolicy: before.instagramAfterWindowPolicy,
        whatsappAfterWindowPolicy: before.whatsappAfterWindowPolicy,
        whatsappTemplateAutomationAllowlist: before.whatsappTemplateAutomationAllowlist,
      },
      {
        mode: after.mode,
        confidenceThreshold: after.confidenceThreshold,
        mandatoryReviewReasons: after.mandatoryReviewReasons,
        instagramAfterWindowPolicy: after.instagramAfterWindowPolicy,
        whatsappAfterWindowPolicy: after.whatsappAfterWindowPolicy,
        whatsappTemplateAutomationAllowlist: after.whatsappTemplateAutomationAllowlist,
      },
    );

    await tx.automationPolicy.update({ where: { id: existing.id }, data: { ...after, version: { increment: 1 } } });
    // Same transaction. Separately, a crash between the two leaves a policy nobody appears to have
    // changed — the one question this table exists to answer.
    const audit = await tx.policyChangeAudit.create({
      select: { id: true },
      data: {
        workspaceId: scope.workspaceId,
        businessProfileId: scope.businessProfileId,
        channelAccountId,
        actorUserId: context.userId,
        impacts: [...impacts],
        before: auditable(existing),
        after: after as never,
      },
    });
    // The searchable log gets an event pointing at the audit row above rather than a copy of it. One
    // truth, one pointer, and no chance of the two disagreeing later.
    //
    // A template-autopilot change is its own kind because the spec lists it separately, and it deserves
    // to be: widening what goes out unattended is a different decision from tuning a threshold.
    const templateChange =
      impacts.includes("TEMPLATE_AUTOPILOT_ENABLED") ||
      impacts.includes("TEMPLATE_AUTOPILOT_WITHOUT_ALLOWLIST") ||
      existing.whatsappTemplateAutomationAllowlist.join("\u0000") !== after.whatsappTemplateAutomationAllowlist.join("\u0000");
    // Two events when the mode changed, not one with a more important-sounding name. They are different
    // facts: "what did somebody change" and "when did this profile start replying unattended". Somebody
    // searching for the second should not have to know it was buried in a settings save.
    if (existing.mode !== after.mode) {
      await recordAuditEvent(tx, context, {
        kind: "MODE_CHANGED",
        summary: `Changed the mode from ${existing.mode} to ${after.mode}`,
        subjectType: "automation_policies",
        subjectId: existing.id,
        actorUserId: context.userId,
        ...(channelAccountId === null ? {} : { channelAccountId }),
        detail: { from: existing.mode, to: after.mode },
      });
    }
    await recordAuditEvent(tx, context, {
      kind: templateChange ? "TEMPLATE_POLICY_CHANGED" : "POLICY_CHANGED",
      summary:
        impacts.length === 0
          ? "Changed automation settings"
          : `Changed automation settings: ${impacts.join(", ").toLowerCase().replaceAll("_", " ")}`,
      subjectType: "policy_change_audits",
      subjectId: audit.id,
      actorUserId: context.userId,
      ...(channelAccountId === null ? {} : { channelAccountId }),
      detail: { impacts: [...impacts], scope: channelAccountId === null ? "PROFILE_DEFAULT" : "CHANNEL_ACCOUNT" },
    });
    // No version in the outcome. It was returned "so a screen can keep editing" and nothing read it: the
    // only caller redirects, and the next render re-reads the policy. A value nothing reads is a value
    // that will be wrong one day without anybody noticing.
    return { status: "SAVED", impacts };
  });
}

function blankToNull(value: string): string | null {
  return value.trim() === "" ? null : value.trim();
}

/** The stored shape, for comparison and for the audit's `before`. */
function auditable(row: PolicyRow) {
  return {
    mode: row.mode,
    businessGoal: row.businessGoal,
    qualificationCriteria: row.qualificationCriteria,
    confidenceThreshold: row.confidenceThreshold,
    mandatoryReviewReasons: row.mandatoryReviewReasons,
    debounceMinMs: row.debounceMinMs,
    debounceMaxMs: row.debounceMaxMs,
    deliveryDelayMinMs: row.deliveryDelayMinMs,
    deliveryDelayMaxMs: row.deliveryDelayMaxMs,
    takeoverPauseMs: row.takeoverPauseMs,
    instagramAfterWindowPolicy: row.instagramAfterWindowPolicy,
    whatsappAfterWindowPolicy: row.whatsappAfterWindowPolicy,
    whatsappTemplateAutomationAllowlist: row.whatsappTemplateAutomationAllowlist,
  };
}

/** Whether anything stored actually moved. Order-insensitive for the two list columns. */
function changed(row: PolicyRow, after: ReturnType<typeof auditable>): boolean {
  const before = auditable(row);
  return (
    JSON.stringify({ ...before, mandatoryReviewReasons: [...before.mandatoryReviewReasons].sort(), whatsappTemplateAutomationAllowlist: [...before.whatsappTemplateAutomationAllowlist].sort() }) !==
    JSON.stringify({ ...after, mandatoryReviewReasons: [...after.mandatoryReviewReasons].sort(), whatsappTemplateAutomationAllowlist: [...after.whatsappTemplateAutomationAllowlist].sort() })
  );
}

export interface PolicyAuditEntry {
  readonly id: string;
  readonly channelAccountId: string | null;
  readonly actorName: string | null;
  readonly changedAt: Date;
  readonly impacts: readonly string[];
  readonly before: unknown;
  readonly after: unknown;
}

/**
 * Where a page of history ends, so the next page can start after it.
 *
 * Both halves travel. `changedAt` is not unique — two saves can land in one millisecond — and a cursor on
 * an instant alone repeats or skips rows, which on a change log reads as a change happening twice or not
 * at all. The index is on the pair for the same reason.
 */
export interface PolicyAuditCursor {
  readonly changedAt: Date;
  readonly id: string;
}

export interface PolicyAuditPage {
  readonly entries: readonly PolicyAuditEntry[];
  /** Absent when this is the last page. Present means older entries exist and this is where they resume. */
  readonly nextCursor?: PolicyAuditCursor;
}

const DEFAULT_AUDIT_PAGE = 20;
const MAX_AUDIT_PAGE = 200;

/**
 * The change history, newest first, in pages.
 *
 * Paged rather than capped. `AI_CONFIGURATION_UX.md` requires the old and new values of material changes
 * to be auditable, and a read that took the newest twenty and said nothing about the rest made the
 * twenty-first change unreachable from the screen for ever — the record existed and could not be read,
 * which is indistinguishable from not keeping it.
 */
export async function listPolicyAudits(
  db: DbExecutor,
  context: BusinessProfileContext,
  page: { readonly limit?: number; readonly cursor?: PolicyAuditCursor } = {},
): Promise<PolicyAuditPage> {
  const scope = profileScopeOf(context);
  const limit = Math.min(Math.max(Math.trunc(page.limit ?? DEFAULT_AUDIT_PAGE), 1), MAX_AUDIT_PAGE);
  const rows = await db.policyChangeAudit.findMany({
    where: {
      ...scope,
      ...(page.cursor === undefined
        ? {}
        : { OR: [{ changedAt: { lt: page.cursor.changedAt } }, { changedAt: page.cursor.changedAt, id: { lt: page.cursor.id } }] }),
    },
    orderBy: [{ changedAt: "desc" }, { id: "desc" }],
    // One more than asked for, which is how this read knows there is a next page rather than guessing
    // from a full one. The cursor predicate above is a two-arm `OR` rather than a row comparison, so the
    // ordering is not always answered from the index — the migration records the measured plans and why
    // the raw-SQL seek is not worth it at this table's size.
    take: limit + 1,
    select: { id: true, channelAccountId: true, changedAt: true, impacts: true, before: true, after: true, actor: { select: { name: true } } },
  });
  const window = rows.slice(0, limit);
  const last = window.at(-1);
  return {
    entries: window.map((row) => ({
      id: row.id,
      channelAccountId: row.channelAccountId,
      actorName: row.actor.name,
      changedAt: row.changedAt,
      impacts: row.impacts,
      before: row.before,
      after: row.after,
    })),
    // `rows.length > limit` already implies a full window, so `last` cannot be absent here. It is still
    // named in the condition because the compiler cannot see that and `last` is `T | undefined`; what it
    // is not is a second *predicate* over the data, which would be a branch no input could falsify.
    ...(rows.length > limit && last ? { nextCursor: { changedAt: last.changedAt, id: last.id } } : {}),
  };
}
