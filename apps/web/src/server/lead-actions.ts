"use server";

/**
 * Server actions for the lead pipeline (LEADS_ANALYTICS_UX.md, Issue #33).
 *
 * Dragging a card and choosing a stage from a menu are the same action here, which is the contract's
 * point: one audited transition API, not a drag path and an edit path that could drift apart.
 *
 * Every move carries the stage the operator's board was showing. A card is a picture of the past, and a
 * move that did not say what it was moving *from* would silently overwrite whatever changed since — the
 * board would then look right and the history would read as though nobody had disagreed.
 */
import { editLead, recordQualification, saveStageDisplays, transitionLeadStage } from "@omnichannel/db";
import { isLeadStage, LEAD_STAGES, type LeadStage } from "@omnichannel/domain";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { getDb } from "./db";
import { requireBusinessProfileContext } from "./request-context";
import { field, lines } from "./style-form";

export interface LeadTarget {
  readonly workspaceId: string;
  readonly businessProfileId: string;
}

const leadsPath = (target: LeadTarget) => `/workspaces/${target.workspaceId}/profiles/${target.businessProfileId}/leads`;

function finish(target: LeadTarget, outcome: string): never {
  const path = leadsPath(target);
  revalidatePath(path);
  redirect(`${path}?outcome=${outcome}`);
}

/**
 * Moves a lead, from the stage the caller was looking at.
 *
 * `HUMAN_CONFIRMED` when the move agrees with what the assistant suggested, `HUMAN_SET` otherwise. The
 * distinction is the whole of "AI suggestions stay distinct from human-confirmed values": the history
 * then says whether a person agreed with a reading or made their own.
 */
export async function moveLeadAction(target: LeadTarget, formData: FormData): Promise<void> {
  const context = await requireBusinessProfileContext(target.workspaceId, target.businessProfileId);
  const toStage = field(formData, "toStage");
  const expectedStage = field(formData, "expectedStage");
  const suggested = field(formData, "suggestedStage");

  if (!isLeadStage(toStage) || !isLeadStage(expectedStage)) {
    finish(target, "REFUSED");
  }

  const outcome = await transitionLeadStage(getDb(), context, {
    conversationId: field(formData, "conversationId"),
    toStage,
    expectedStage,
    source: suggested === toStage ? "HUMAN_CONFIRMED" : "HUMAN_SET",
  });

  finish(
    target,
    outcome.status === "MOVED"
      ? "MOVED"
      : outcome.status === "STALE"
        ? "STALE_STAGE"
        : outcome.status === "UNCHANGED"
          ? "UNCHANGED_STAGE"
          : outcome.status === "GONE"
            ? "GONE"
            : "REFUSED",
  );
}

/** The CRM-lite fields. Never the stage: that goes through the audited transition above. */
export async function editLeadAction(target: LeadTarget, formData: FormData): Promise<void> {
  const context = await requireBusinessProfileContext(target.workspaceId, target.businessProfileId);
  const assignee = field(formData, "assignedUserId");
  const when = field(formData, "nextActionAt");
  const parsed = when === "" ? null : new Date(when);

  const outcome = await editLead(getDb(), context, field(formData, "conversationId"), {
    // An empty select means nobody owns it, which is different from leaving the owner alone.
    assignedUserId: assignee === "" ? null : assignee,
    tags: lines(formData, "tags"),
    note: field(formData, "note"),
    nextAction: field(formData, "nextAction"),
    nextActionAt: parsed !== null && Number.isNaN(parsed.getTime()) ? null : parsed,
  });
  finish(target, outcome.status === "SAVED" ? "SAVED" : outcome.status === "GONE" ? "GONE" : "REFUSED");
}

/** A person's answer to a qualification criterion, recorded beside the assistant's, never over it. */
export async function recordAnswerAction(target: LeadTarget, formData: FormData): Promise<void> {
  const context = await requireBusinessProfileContext(target.workspaceId, target.businessProfileId);
  const outcome = await recordQualification(getDb(), context, field(formData, "conversationId"), {
    criterion: field(formData, "criterion"),
    value: field(formData, "answer"),
    source: "HUMAN_SET",
  });
  finish(target, outcome.status === "SAVED" ? "SAVED" : outcome.status === "GONE" ? "GONE" : "REFUSED");
}

/**
 * Renames, reorders and hides the board's columns.
 *
 * The form posts one label, position and visibility per internal stage, so the mapping from display to
 * internal id stays explicit. It cannot add a stage: `LeadStage` is what the draft engine returns in its
 * structured output, which makes a new one a decision about the model rather than about a board.
 */
export async function saveStagesAction(target: LeadTarget, formData: FormData): Promise<void> {
  const context = await requireBusinessProfileContext(target.workspaceId, target.businessProfileId);
  const displays = LEAD_STAGES.map((stage: LeadStage, index: number) => ({
    stage,
    label: field(formData, `label_${stage}`),
    position: Number.parseInt(field(formData, `position_${stage}`), 10) || index,
    hidden: field(formData, `hidden_${stage}`) === "on",
  }));
  const outcome = await saveStageDisplays(getDb(), context, displays);
  finish(target, outcome.status === "SAVED" ? "SAVED" : "REFUSED");
}
