/**
 * Ordering a delivery claim against the activation of a kill switch (Issue #56).
 *
 * `automation_suspensions` has no foreign key to the workspace, Business Profile or channel account it
 * names, so the trick the automation policies rely on — inserting a row takes a `KEY SHARE` lock on the
 * parent the claim already holds `FOR UPDATE` — has nothing to hang on. A `GLOBAL` switch names no row at
 * all, so no row lock could ever cover it. Advisory locks give the same ordering without a parent row.
 *
 * A claim takes, in *shared* mode, every key that could cover it. The other side is **not** application
 * code: a `BEFORE INSERT OR UPDATE OR DELETE` trigger on `automation_suspensions` takes the matching key
 * exclusively, so every writer participates — including the direct SQL an operator runs during an
 * incident, which `RELIABILITY_INCIDENTS.md` documents as how the switch is pulled today. A lock taken in
 * a store method would only bind callers who went through that method, which is the one guarantee this
 * mechanism cannot afford.
 *
 * Shared holders do not block one another, so claims stay as concurrent as they were, while a switch
 * being written waits for the claims already in flight and blocks the ones that follow until it has
 * committed. Neither side can believe it went first.
 *
 * So the keys are spelled twice — here and in the trigger — which is exactly the drift this file's
 * existence is meant to prevent. `suspension-lock.integration.test.ts` closes that by asserting the two
 * derivations hash identically for every scope.
 */
export type SuspensionLockKey = string;

/** Every key that could cover a send: global, its workspace, its Business Profile, its channel account. */
export function suspensionLockKeysFor(target: {
  readonly workspaceId: string;
  readonly businessProfileId: string;
  readonly channelAccountId: string;
}): SuspensionLockKey[] {
  return [
    "GLOBAL",
    `WORKSPACE:${target.workspaceId}`,
    `BUSINESS_PROFILE:${target.workspaceId}:${target.businessProfileId}`,
    `CHANNEL_ACCOUNT:${target.workspaceId}:${target.channelAccountId}`,
  ];
}

/**
 * The single key a switch of this scope is written under; it must be one of the keys above.
 *
 * Nothing in production calls this any more — the trigger derives the key itself, which is the point. It
 * is the TypeScript half of the agreement, kept so a test can hold the two spellings against each other.
 */
export function suspensionLockKeyOf(input: {
  readonly scope: "GLOBAL" | "WORKSPACE" | "BUSINESS_PROFILE" | "CHANNEL_ACCOUNT";
  readonly workspaceId?: string | null;
  readonly businessProfileId?: string | null;
  readonly channelAccountId?: string | null;
}): SuspensionLockKey {
  switch (input.scope) {
    case "GLOBAL":
      return "GLOBAL";
    case "WORKSPACE":
      return `WORKSPACE:${input.workspaceId ?? ""}`;
    case "BUSINESS_PROFILE":
      return `BUSINESS_PROFILE:${input.workspaceId ?? ""}:${input.businessProfileId ?? ""}`;
    case "CHANNEL_ACCOUNT":
      return `CHANNEL_ACCOUNT:${input.workspaceId ?? ""}:${input.channelAccountId ?? ""}`;
  }
}
