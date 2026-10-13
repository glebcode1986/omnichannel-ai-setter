"use server";

/**
 * Server actions for billing (#42).
 *
 * Two of them, and the pair is deliberate: cancelling and withdrawing a cancellation are the only
 * commercial changes that need no payment, so they are the only ones this deployment can honestly offer
 * before a provider adapter exists (#41). An upgrade needs authoritative confirmation that money moved,
 * and a browser click is not that.
 *
 * **Cancelling now also tells the provider to stop renewing, best-effort** (#41, the product owner's
 * decision). Until it did, a cancellation lived only in our own tables: the provider renewed, the
 * customer was charged, and the renewal webhook used to write the subscription back to `ACTIVE` — so a
 * customer who cancelled paid again and saw an active plan. That second half is now refused by the store;
 * this is the first half, which is telling the provider at all.
 *
 * **Best-effort means the order matters and the failure is recorded, not raised.** The cancellation is
 * committed first and its outcome is what the customer is told, because a decision they made must not
 * depend on a third party being reachable — a provider timeout that lost somebody's cancellation would be
 * the worse failure of the two. The request to stop renewing then happens, and whatever it says, including
 * that it could not be made, is written to the audit trail: that record is the difference between a
 * cancellation that takes effect by itself and one somebody still has to act on before the next charge.
 *
 * What is *not* here: a sweep that notices the audit row and retries. `reconcileProviderState` exists and
 * has no caller yet, so for now the record is for a person. That gap is reported rather than papered over
 * with a retry loop nothing would supervise.
 *
 * Authorization is re-resolved from the database on every call and the store refuses anyone but an OWNER,
 * so a hand-made POST from an admin's session is refused by the store rather than by this file hiding a
 * button. The screen's `canManage` decides what is *offered*; the server decides what is permitted.
 */
import { requestCancellation, resumeSubscription, WorkspacePermissionError } from "@omnichannel/db";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { ensureBillingAdapters } from "./billing-adapters";
import { stopRenewingBestEffort } from "./billing-renewal";
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
    if (outcome.status === "CANCELING") {
      // After the commit, and before the redirect: the customer's decision is durable either way, and
      // this is the last moment at which the request can still ride on their click.
      await stopRenewingBestEffort({
        db: getDb(),
        context,
        workspaceId: target.workspaceId,
        ensureAdapters: ensureBillingAdapters,
      });
    }
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
