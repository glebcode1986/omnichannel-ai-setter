/**
 * Ordering a delivery claim against a change of the staged rollout (#60).
 *
 * The claim re-resolves the rollout immediately before it takes the send, and that resolution is a read
 * of the release catalogue: which candidate is approved decides which stage is in force, and the stage
 * decides whether this profile may send unattended at all. Like every other fact the claim depends on, the
 * read has to be ordered against whoever writes it — otherwise a release recorded between the read and the
 * claim is simply invisible, and a reply goes out under a stage that no longer holds. It is the same defect
 * the kill switch's own lock exists to prevent, arriving through a third set of tables.
 *
 * A row lock cannot do it, for the reason `entitlement-lock.ts` gives about an override: the candidate that
 * would change the answer *may not exist yet* when the claim starts, and no lock can be taken on a row
 * nobody has inserted. Here the point is sharper still — the answer is computed from the newest *approved*
 * candidate, so what invalidates it is almost always an insert rather than an update.
 *
 * So a claim takes this key in *shared* mode, and the other side is a trigger on the three release tables
 * rather than application code — for the reason `suspension-lock.ts` gives: a lock taken in a store method
 * binds only callers who went through that method, and a release can be recorded by a script, or a gate
 * result corrected by hand during an incident.
 *
 * **Why one key and not one per workspace.** A release is a platform-wide fact: `release_records` has no
 * workspace column, because the question "which stage is this deployment in" has one answer for everybody.
 * Deriving a key per workspace would be a key that the writer could not compute — it would have to take
 * every workspace's key, or none. The cost of a single key is paid only by the writer: shared holders do
 * not block one another, so claims stay exactly as concurrent as they were, and recording a release waits
 * for the claims already in flight and holds the ones that follow until it commits. That is a few hundred
 * milliseconds for an operator action that happens on the order of once a deployment, and it is the
 * ordering we want rather than a side effect of it.
 *
 * The key is therefore spelled twice, here and in the migration, which is exactly the drift this comment
 * would otherwise invite; `release-lock.integration.test.ts` closes that by asserting the two derivations
 * hash identically through the same `hashtextextended` both sides actually call.
 */
export type ReleaseCatalogueLockKey = string;

/**
 * The one key the release catalogue is written under, and claims read it.
 *
 * A function rather than a bare constant, so that the two sides are compared the way every other key in
 * this directory is compared — and so that a later decision to scope it (by environment, say) changes a
 * signature the compiler can find every caller of, rather than a string.
 */
export function releaseCatalogueLockKey(): ReleaseCatalogueLockKey {
  return "RELEASE_CATALOGUE";
}
