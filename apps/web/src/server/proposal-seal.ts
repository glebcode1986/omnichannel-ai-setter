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
 * The bytes signed: the encoded proposal and the impacts, in a fixed order.
 *
 * **Two fields, not three.** The version was signed separately as well until a mutation run showed that
 * removing it broke no test — because `encodeProposal` already serialises `expectedVersion`, so the
 * version was in the signed bytes twice and the explicit copy could not be the thing that caught a change.
 * One statement of one fact; `settings-view.test.ts` pins that the encoded proposal distinguishes two
 * versions, which is what makes "the seal covers the version" true by construction rather than by a second
 * concatenation nothing exercises.
 *
 * The impacts are sorted, because they are a set to the comparison that uses them and a seal keyed to the
 * server's enumeration order would stop verifying the day that order changed. The separator cannot be
 * shifted between fields: base64url contains no `|`, and the impact codes are a closed vocabulary of
 * `[A-Z_]`, so there is exactly one way to split these bytes.
 */
function sealedBytes(proposal: PolicyProposal, impacts: readonly PolicyImpact[]): string {
  return [encodeProposal(proposal), [...impacts].sort().join(",")].join("|");
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
 *
 * The length check is the only guard needed before that comparison, and it does the work of the two that
 * used to precede it. An empty string decodes to zero bytes and a malformed one to some other length, so
 * both are refused here; `Buffer.from(string, "base64url")` does not throw on bad input, it ignores what
 * it cannot decode. A mutation run is what established that: deleting the empty-string check broke no
 * test, because nothing could reach it that this check does not already answer.
 */
export function proposalSealed(secret: string, proposal: PolicyProposal, impacts: readonly PolicyImpact[], seal: string): boolean {
  const provided = Buffer.from(seal, "base64url");
  if (provided.length !== SEAL_BYTES) {
    return false;
  }
  const expected = createHmac("sha256", secret).update(sealedBytes(proposal, impacts), "utf8").digest();
  return timingSafeEqual(provided, expected);
}
