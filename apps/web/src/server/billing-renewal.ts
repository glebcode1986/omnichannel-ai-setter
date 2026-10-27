/**
 * Telling the provider to stop renewing, after the customer's cancellation is already committed
 * (#41, the product owner's best-effort decision).
 *
 * Until this existed a cancellation lived only in our own tables. The provider renewed, the customer was
 * charged, and the renewal webhook wrote the subscription back to `ACTIVE` — so somebody who cancelled
 * paid again and was shown an active plan. The second half of that is now refused by the store; this is
 * the first half, which is telling the provider at all.
 *
 * **Best-effort, and the order is the whole of what that means.** The cancellation is committed before
 * this runs and its outcome is what the customer is told. A decision they made must not depend on a third
 * party being reachable: a provider timeout that lost somebody's cancellation would be the worse of the
 * two failures by far. So nothing here can fail the cancellation, and nothing here throws.
 *
 * **What it leaves behind is a record, not a retry.** Every path ends in an audited outcome, including
 * "could not ask" and "this provider has no such request", because that record is the difference between a
 * cancellation that takes effect by itself and one somebody has to act on before the next charge. There is
 * deliberately no retry loop: `reconcileProviderState` is the repair path ADR-019 names and it has no
 * caller yet, so a retry here would be an unsupervised loop pretending to be reconciliation. The gap is
 * reported instead.
 *
 * A separate module from `billing-actions.ts` on purpose: that file is `"use server"`, where every export
 * is callable from a browser, and this is not something a client may invoke. Same reason
 * `provider-checkout.ts` sits beside the checkout action rather than inside it.
 */
import {
  readRenewalTarget,
  recordRenewalStopOutcome,
  setProviderRenewal,
  type DbClient,
  type WorkspaceContext,
} from "@omnichannel/db";

export interface StopRenewingInput {
  readonly db: DbClient;
  readonly context: WorkspaceContext;
  readonly workspaceId: string;
  readonly ensureAdapters: () => void;
}

export async function stopRenewingBestEffort(input: StopRenewingInput): Promise<void> {
  const { context, db, ensureAdapters, workspaceId } = input;
  try {
    ensureAdapters();
    const target = await readRenewalTarget(db, workspaceId);
    if (target === null) {
      // Nothing the provider could be asked about: either no active arrangement, or it never gave us a
      // reference for one. Recorded, because "we did not ask" is the fact somebody needs.
      await recordRenewalStopOutcome(db, context, { status: "NO_ARRANGEMENT" });
      return;
    }
    // No capability check before the call: `setProviderRenewal` answers `null` for an adapter that cannot
    // be asked, and the branch below already records that. Asking first was two places deciding one
    // thing — a mutation that deleted the check passed every test, which is the honest way to find out.
    const state = await setProviderRenewal(target.provider, {
      routeCode: target.routeCode,
      providerReference: target.providerReference,
      renew: false,
    });
    await recordRenewalStopOutcome(
      db,
      context,
      // `null` is an adapter that cannot be asked at all, and the honest summary is that it was not.
      state === null
        ? { status: "UNSUPPORTED", routeCode: target.routeCode }
        : { status: "STOPPED", routeCode: target.routeCode, renews: state.renews },
    );
  } catch (error) {
    // The error's name only. A provider's message can carry a reference or an account id, and #41 keeps
    // those out of anything a person reads. The second `catch` is because a failure to record must not
    // become the thing that breaks a cancellation either.
    await recordRenewalStopOutcome(db, context, {
      status: "FAILED",
      routeCode: "unknown",
      errorName: error instanceof Error ? error.name : typeof error,
    }).catch(() => undefined);
  }
}
