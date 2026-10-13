/**
 * Ordering a delivery claim against a change of commercial state (#40).
 *
 * The claim re-resolves the entitlement immediately before taking the send, and that read has to be
 * ordered against whoever writes a subscription or an override — otherwise a plan change committing
 * between the read and the claim is invisible, and the send goes out on terms that no longer hold. It is
 * the same defect the kill switch's own lock exists to prevent, arriving through a different table.
 *
 * A row lock cannot do it: an override may not exist yet when the claim starts, and no lock can be taken
 * on a row nobody has inserted. The foreign-key trick the automation policies rely on would mean locking
 * the workspace row exclusively in every claim, which serializes claims across a whole workspace rather
 * than against the rare owner action that changes a plan.
 *
 * So a claim takes this key in *shared* mode, and the other side is a trigger on both tables rather than
 * application code — for the reason `suspension-lock.ts` gives: a lock taken in a store method binds only
 * callers who went through that method, and a plan can be changed by a support script or by hand.
 *
 * The key is therefore spelled twice, here and in the migration. `entitlement-lock.integration.test.ts`
 * closes that by asserting the two derivations hash identically.
 */
export type EntitlementLockKey = string;

/** The one key under which a workspace's commercial state changes, and claims read it. */
export function entitlementLockKeyFor(workspaceId: string): EntitlementLockKey {
  return `ENTITLEMENT:${workspaceId}`;
}
