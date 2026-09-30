"use server";

/**
 * Server actions for the setup surface (Issue #27).
 *
 * The authorization lives here, not in the component that rendered the button. A disabled control is a
 * courtesy to the person using the page; the boundary is this file, and it re-resolves the role from the
 * database on every call rather than trusting anything the form carried.
 *
 * Each action revalidates the setup path afterwards, so the page a person lands back on is built from the
 * state their action produced rather than the one it replaced.
 */
import { activateBusinessProfile, skipOnboardingStep, unskipOnboardingStep } from "@omnichannel/db";
import { revalidatePath } from "next/cache";

import { getDb } from "./db";
import { getLogger } from "./logger";
import { requireBusinessProfileContext } from "./request-context";

export interface SetupTarget {
  readonly workspaceId: string;
  readonly businessProfileId: string;
}

const setupPath = (target: SetupTarget) => `/workspaces/${target.workspaceId}/profiles/${target.businessProfileId}/setup`;

/**
 * The step a form is talking about.
 *
 * A `FormData` entry can be a `File`, and stringifying one produces `[object Object]` — a value the store
 * would then reject for the wrong reason. Anything that is not a string is simply not a step.
 */
function stepField(formData: FormData): string {
  const value = formData.get("step");
  return typeof value === "string" ? value : "";
}

export async function skipStepAction(target: SetupTarget, formData: FormData): Promise<void> {
  const context = await requireBusinessProfileContext(target.workspaceId, target.businessProfileId);
  await skipOnboardingStep(getDb(), context, stepField(formData));
  revalidatePath(setupPath(target));
}

export async function restoreStepAction(target: SetupTarget, formData: FormData): Promise<void> {
  const context = await requireBusinessProfileContext(target.workspaceId, target.businessProfileId);
  await unskipOnboardingStep(getDb(), context, stepField(formData));
  revalidatePath(setupPath(target));
}

/**
 * Takes the profile live.
 *
 * The outcome is logged rather than thrown away, because "the button did nothing" is the failure mode a
 * person cannot diagnose. A refusal here means the checklist stopped being clear after the page rendered
 * it, and the revalidated page is what shows them why.
 */
export async function activateAction(target: SetupTarget): Promise<void> {
  const context = await requireBusinessProfileContext(target.workspaceId, target.businessProfileId);
  const outcome = await activateBusinessProfile(getDb(), context);
  if (outcome.kind !== "ACTIVATED") {
    getLogger().info("web.activation_refused", {
      workspaceId: target.workspaceId,
      businessProfileId: target.businessProfileId,
      outcome: outcome.kind,
      ...(outcome.kind === "NOT_READY" ? { blockers: outcome.blockers } : {}),
    });
  }
  revalidatePath(setupPath(target));
}
