/**
 * Proof that the server itself refused this exact proposal and showed its effect summary (Issue #30).
 *
 * The acknowledgement cannot be a claim the caller makes. Comparing the posted impact codes against the
 * freshly computed ones is necessary and **not sufficient**: the codes are public — they are in the URL,
 * in the page and in the translation catalogue — so a first crafted POST carrying
 * `mode=AUTOPILOT&acknowledged=AUTOPILOT_ENABLED` satisfies the comparison without any summary ever
 * having been rendered. A server action is a public endpoint, and the page's conditional rendering of a
 * checkbox is a courtesy to the browser, not a check.
 *
 * So the refusal mints a seal over the three things that must not have changed since — the exact proposal,
 * the policy version it was composed against, and the impacts that were shown — and the save accepts an
 * acknowledgement only with a seal it minted itself. A caller cannot produce one without `AUTH_SECRET`;
 * a stale one does not verify against a different proposal, a newer version or a different impact list, so
 * each of those requires a fresh review rather than silently reusing the owner's last decision.
 *
 * Stateless on purpose. A persisted pending proposal would need a table, an owner, a cleanup policy and a
 * story about two tabs proposing at once; the seal needs none of that, because the thing being
 * authenticated travels with the request and the version check already settles concurrency.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import type { PolicyImpact } from "@omnichannel/domain";

import { encodeProposal, type PolicyProposal } from "./settings-view";

const SEAL_BYTES = 32;

/**
 * The bytes signed: the encoded proposal, the version, and the impacts in a fixed order.
 *
 * Sorted, because the impacts are a set to the comparison that uses them, and a seal that depended on the
 * server's enumeration order would stop verifying the day that order changed. Length-prefixed by the
 * separator so no field can be shifted into another — `a|bc` and `ab|c` must not sign the same bytes.
 */
function sealedBytes(proposal: PolicyProposal, impacts: readonly PolicyImpact[]): string {
  return [encodeProposal(proposal), String(proposal.expectedVersion), [...impacts].sort().join(",")].join("|");
}

/** The seal the refusal hands to the page, for the form to post back with the acknowledgement. */
export function sealProposal(secret: string, proposal: PolicyProposal, impacts: readonly PolicyImpact[]): string {
  return createHmac("sha256", secret).update(sealedBytes(proposal, impacts), "utf8").digest("base64url");
}

/**
 * Whether this seal is one we minted for this exact proposal, version and impact list.
 *
 * Compared in constant time, and only after the lengths match, because `timingSafeEqual` throws on a
 * length mismatch and both lengths are attacker-visible anyway.
 */
export function proposalSealed(secret: string, proposal: PolicyProposal, impacts: readonly PolicyImpact[], seal: string): boolean {
  if (seal === "") {
    return false;
  }
  let provided: Buffer;
  try {
    provided = Buffer.from(seal, "base64url");
  } catch {
    return false;
  }
  if (provided.length !== SEAL_BYTES) {
    return false;
  }
  const expected = createHmac("sha256", secret).update(sealedBytes(proposal, impacts), "utf8").digest();
  return timingSafeEqual(provided, expected);
}
