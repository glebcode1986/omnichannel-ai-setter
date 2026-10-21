"use server";

/**
 * Server actions for billing (#42).
 *
 * Two of them, and the pair is deliberate: cancelling and withdrawing a cancellation are the only
 * commercial changes that need no payment, so they are the only ones this deployment can honestly offer
 * before a provider adapter exists (#41). An upgrade needs authoritative confirmation that money moved,
 * and a browser click is not that.
 *
 * Authorization is re-resolved from the database on every call and the store refuses anyone but an OWNER,
 * so a hand-made POST from an admin's session is refused by the store rather than by this file hiding a
 * button. The screen's `canManage` decides what is *offered*; the server decides what is permitted.
 */
import { requestCancellation, resumeSubscription, WorkspacePermissionError } from "@omnichannel/db";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { getDb } from "./db";
import { requireWorkspaceContext } from "./request-context";

export type BillingOutcome = "CANCELING" | "RESUMED" | "REFUSED";

export interface BillingTarget {
  readonly workspaceId: string;
  readonly businessProfileId: string;
}

const billingPath = (target: BillingTarget) =>
  `/workspaces/${target.workspaceId}/profiles/${target.businessProfileId}/settings/billing`;

function finish(target: BillingTarget, outcome: BillingOutcome | "DONE"): never {
  const path = billingPath(target);
  revalidatePath(path);
  redirect(`${path}?outcome=${outcome}`);
}

export async function requestCancellationAction(target: BillingTarget): Promise<void> {
  const context = await requireWorkspaceContext(target.workspaceId);
  try {
    const outcome = await requestCancellation(getDb(), context);
    finish(target, outcome.status === "CANCELING" ? "CANCELING" : "REFUSED");
  } catch (error) {
    if (error instanceof WorkspacePermissionError) {
      finish(target, "REFUSED");
    }
    throw error;
  }
}

export async function resumeSubscriptionAction(target: BillingTarget): Promise<void> {
  const context = await requireWorkspaceContext(target.workspaceId);
  try {
    const outcome = await resumeSubscription(getDb(), context);
    finish(target, outcome.status === "RESUMED" ? "RESUMED" : "REFUSED");
  } catch (error) {
    if (error instanceof WorkspacePermissionError) {
      finish(target, "REFUSED");
    }
    throw error;
  }
}
