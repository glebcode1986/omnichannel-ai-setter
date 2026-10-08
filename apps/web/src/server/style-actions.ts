"use server";

/**
 * Server actions for Style Training (KNOWLEDGE_STYLE_UX.md, ADR-011, Issue #32).
 *
 * Authorization is re-resolved from the database on every call, and the store scopes every write to the
 * resolved Business Profile. The approval gate is the store's and the schema's, not this file's: an
 * activation names its approver in the same statement, and an ACTIVE example with nobody's name on it is
 * refused by a CHECK. So there is nothing here a caller could skip to get an unverified example into use.
 *
 * Nothing here writes a fact. Style cannot authorize a factual claim, and the way that holds is that this
 * module cannot reach `knowledge_documents` at all.
 */
import {
  approveStyleExample,
  archiveStyleExample,
  createStyleExample,
  rejectStyleExample,
  restoreStyleExample,
  saveStyleProfile,
} from "@omnichannel/db";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { getDb } from "./db";
import { requireBusinessProfileContext } from "./request-context";
import { expectedVoiceVersion, field, scopeFrom, voiceDraftFrom } from "./style-form";

export interface StyleTarget {
  readonly workspaceId: string;
  readonly businessProfileId: string;
}

export type StyleOutcome = "SAVED" | "ACTIVATED" | "REJECTED_EXAMPLE" | "ARCHIVED" | "RESTORED" | "GONE" | "REFUSED" | "CONFLICT";

const stylePath = (target: StyleTarget) => `/workspaces/${target.workspaceId}/profiles/${target.businessProfileId}/style`;



function finish(target: StyleTarget, outcome: StyleOutcome): never {
  const path = stylePath(target);
  revalidatePath(path);
  redirect(`${path}?outcome=${outcome}`);
}

export async function saveVoiceAction(target: StyleTarget, formData: FormData): Promise<void> {
  const context = await requireBusinessProfileContext(target.workspaceId, target.businessProfileId);
  // Parsed and validated in `style-form.ts`, tested there: an enum member nobody defined must not be able
  // to reach the column through a hand-edited form.
  // What the screen believed it was editing travels with the save, so a second tab holding an older copy
  // of the whole profile is told it conflicted rather than silently replacing a colleague's work. Without
  // this the store's conflict check had nothing to check against and every save looked like the first one.
  const outcome = await saveStyleProfile(getDb(), context, scopeFrom(formData), voiceDraftFrom(formData), expectedVoiceVersion(formData));
  finish(target, outcome.status === "SAVED" ? "SAVED" : outcome.status === "CONFLICT" ? "CONFLICT" : "REFUSED");
}

export async function addStyleExampleAction(target: StyleTarget, formData: FormData): Promise<void> {
  const context = await requireBusinessProfileContext(target.workspaceId, target.businessProfileId);
  const language = field(formData, "language");
  const outcome = await createStyleExample(getDb(), context, {
    inboundContext: field(formData, "inbound"),
    outboundText: field(formData, "outbound"),
    ...(language === "" ? {} : { language }),
    scope: scopeFrom(formData),
  });
  finish(target, outcome.status === "SAVED" ? "SAVED" : outcome.status === "REFUSED" ? "REFUSED" : "GONE");
}

export async function approveStyleExampleAction(target: StyleTarget, exampleId: string): Promise<void> {
  const context = await requireBusinessProfileContext(target.workspaceId, target.businessProfileId);
  const outcome = await approveStyleExample(getDb(), context, exampleId);
  finish(target, outcome.status === "ACTIVATED" ? "ACTIVATED" : "GONE");
}

export async function rejectStyleExampleAction(target: StyleTarget, exampleId: string): Promise<void> {
  const context = await requireBusinessProfileContext(target.workspaceId, target.businessProfileId);
  const outcome = await rejectStyleExample(getDb(), context, exampleId);
  finish(target, outcome.status === "REJECTED_EXAMPLE" ? "REJECTED_EXAMPLE" : "GONE");
}

export async function archiveStyleExampleAction(target: StyleTarget, exampleId: string): Promise<void> {
  const context = await requireBusinessProfileContext(target.workspaceId, target.businessProfileId);
  const outcome = await archiveStyleExample(getDb(), context, exampleId);
  finish(target, outcome.status === "ARCHIVED" ? "ARCHIVED" : "GONE");
}

export async function restoreStyleExampleAction(target: StyleTarget, exampleId: string): Promise<void> {
  const context = await requireBusinessProfileContext(target.workspaceId, target.businessProfileId);
  const outcome = await restoreStyleExample(getDb(), context, exampleId);
  finish(target, outcome.status === "RESTORED" ? "RESTORED" : "GONE");
}
