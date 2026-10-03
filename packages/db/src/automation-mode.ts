/**
 * Which AI mode is actually in force (PRODUCT_UX.md, Issue #28).
 *
 * The precedence is a product rule, not a query detail: a conversation's own override wins, then a policy
 * written for that channel account, then the Business Profile's default, and `OFF` when nothing has been
 * written at all. `OFF` is the floor on purpose — a profile with no policy row has not opted into
 * automation, and defaulting the other way would be the product deciding to send on its own.
 *
 * It lives here because the Inbox needs the same answer the draft pipeline needs, and a second
 * implementation of a rule that governs whether we send to a customer is the kind of duplication that
 * eventually disagrees with itself.
 */
import type { AiMode } from "@omnichannel/domain";

import type { DbExecutor } from "./client";

/** A policy row as the precedence rule needs it: `null` account means the profile-wide default. */
export interface ModePolicyRow {
  readonly channelAccountId: string | null;
  readonly mode: AiMode;
}

export function resolveEffectiveMode(override: AiMode | null, channelAccountId: string, policies: readonly ModePolicyRow[]): AiMode {
  if (override !== null) {
    return override;
  }
  return (
    policies.find((policy) => policy.channelAccountId === channelAccountId)?.mode ??
    policies.find((policy) => policy.channelAccountId === null)?.mode ??
    "OFF"
  );
}

/**
 * The effective mode for several channel accounts in one query.
 *
 * The Inbox renders a page of conversations spanning every connected account, so the per-conversation
 * form of this would be a query per row. One read of the profile's policies covers the whole page.
 */
export async function readModePolicies(
  db: DbExecutor,
  scope: { readonly workspaceId: string; readonly businessProfileId: string },
): Promise<readonly ModePolicyRow[]> {
  return db.automationPolicy.findMany({
    where: scope,
    select: { channelAccountId: true, mode: true },
  });
}
