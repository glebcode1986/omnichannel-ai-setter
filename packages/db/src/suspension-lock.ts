/**
 * Ordering a delivery claim against the activation of a kill switch (Issue #56).
 *
 * `automation_suspensions` has no foreign key to the workspace, Business Profile or channel account it
 * names, so the trick the automation policies rely on — inserting a row takes a `KEY SHARE` lock on the
 * parent the claim already holds `FOR UPDATE` — has nothing to hang on. A `GLOBAL` switch names no row at
 * all, so no row lock could ever cover it. Advisory locks give the same ordering without a parent row.
 *
 * A claim takes, in *shared* mode, every key that could cover it; a writer takes its own key exclusively.
 * Shared holders do not block one another, so claims stay as concurrent as they were, while a switch
 * being turned on waits for the claims already in flight and blocks the ones that follow until it has
 * committed. Neither side can believe it went first.
 *
 * The keys live here, in one place, because the whole mechanism rests on both sides naming a switch
 * identically — and two copies of a naming convention is how that stops being true.
 *
 * Lifting a switch deliberately takes no lock. Removing coverage can only ever make a claim more
 * permissive, and a claim that ran just before a lift simply holds the delivery and is retried.
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

/** The single key a switch of this scope is written under; it must be one of the keys above. */
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
