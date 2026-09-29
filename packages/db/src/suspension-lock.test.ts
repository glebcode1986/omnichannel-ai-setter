/**
 * The key format itself, with no database in the way (Issue #56).
 *
 * The parity of this spelling against the trigger's needs PostgreSQL and lives in the integration suite.
 * What is here is the part that is true regardless: which targets share a key, which cannot, and which
 * direction an ambiguity fails in. It runs in every `pnpm verify` because a key format that quietly
 * changed shape would otherwise only be noticed where infrastructure happens to be available.
 */
import { describe, expect, it } from "vitest";

import { suspensionLockKeyOf, suspensionLockKeysFor } from "./suspension-lock";

const WORKSPACE = "ws_1";
const PROFILE = "bp_1";
const ACCOUNT = "ca_1";

describe("the kill-switch advisory key", () => {
  it("gives a claim one key per scope that could cover it", () => {
    const keys = suspensionLockKeysFor({ workspaceId: WORKSPACE, businessProfileId: PROFILE, channelAccountId: ACCOUNT });

    expect(keys).toEqual(["GLOBAL", `WORKSPACE:${WORKSPACE}`, `BUSINESS_PROFILE:${WORKSPACE}:${PROFILE}`, `CHANNEL_ACCOUNT:${WORKSPACE}:${ACCOUNT}`]);
  });

  it("derives, for every covering switch, a key the target's claim already holds", () => {
    const target = { workspaceId: WORKSPACE, businessProfileId: PROFILE, channelAccountId: ACCOUNT };
    const held = suspensionLockKeysFor(target);

    // This is the property the ordering rests on. A covering switch is one whose scope and identifiers
    // are the target's own, so the two sides build the identical string rather than a similar one — and
    // an identical string is what makes the writer and the claim contend for the same key.
    for (const covering of [
      { scope: "GLOBAL" } as const,
      { scope: "WORKSPACE", workspaceId: WORKSPACE } as const,
      { scope: "BUSINESS_PROFILE", workspaceId: WORKSPACE, businessProfileId: PROFILE } as const,
      { scope: "CHANNEL_ACCOUNT", workspaceId: WORKSPACE, channelAccountId: ACCOUNT } as const,
    ]) {
      expect(held, `${covering.scope} covers this target but derives a key the claim does not take`).toContain(suspensionLockKeyOf(covering));
    }
  });

  it("keeps a switch on one target off another target's key", () => {
    const keys = suspensionLockKeysFor({ workspaceId: WORKSPACE, businessProfileId: PROFILE, channelAccountId: ACCOUNT });

    expect(keys).not.toContain(suspensionLockKeyOf({ scope: "WORKSPACE", workspaceId: "ws_2" }));
    expect(keys).not.toContain(suspensionLockKeyOf({ scope: "BUSINESS_PROFILE", workspaceId: WORKSPACE, businessProfileId: "bp_2" }));
    expect(keys).not.toContain(suspensionLockKeyOf({ scope: "CHANNEL_ACCOUNT", workspaceId: WORKSPACE, channelAccountId: "ca_2" }));
  });

  it("errs toward extra waiting when identifiers make two targets ambiguous", () => {
    // Identifiers may legally contain a colon — `isValidIdentifier` forbids only whitespace and control
    // characters — so these two different targets share a key. That is over-blocking: a claim waits for a
    // switch that does not cover it and then proceeds, because coverage is decided by the suspension
    // predicate and never by the key. Under-blocking would require a *covering* switch to derive a
    // different key, which the property above rules out.
    expect(suspensionLockKeyOf({ scope: "BUSINESS_PROFILE", workspaceId: "a:b", businessProfileId: "c" })).toBe(
      suspensionLockKeyOf({ scope: "BUSINESS_PROFILE", workspaceId: "a", businessProfileId: "b:c" }),
    );
    // Scopes still cannot bleed into one another, which is the collision that would actually matter.
    expect(suspensionLockKeyOf({ scope: "WORKSPACE", workspaceId: "a:b" })).not.toBe(
      suspensionLockKeyOf({ scope: "BUSINESS_PROFILE", workspaceId: "a", businessProfileId: "b" }),
    );
  });
});
