/**
 * The one thing in this package that decides whether money is real.
 *
 * Every case here is a way a nearly-correct verifier passes: a scheme matched by prefix instead of
 * exactly, the first signature read instead of all of them, recency checked before authenticity, a
 * timestamp accepted because it parsed as `NaN`, a truncated digest compared against a longer one. The
 * signatures are computed in the test with the same primitive the module uses, because a fixture digest
 * copied from somewhere would only prove that the copy was faithful.
 *
 * Secrets here are invented. `whsec_` is the documented prefix; nothing below is a real endpoint secret.
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { SIGNATURE_TOLERANCE_MINUTES, verifyStripeSignature } from "./signature";

const SECRET = "whsec_a_fake_endpoint_secret_for_tests";
const ROLLED = "whsec_the_previous_secret_during_a_roll";
const BODY = '{"id":"evt_1","object":"event","type":"checkout.session.completed"}';
const NOW = new Date("2026-10-12T12:00:00.000Z");

const MS_PER_SECOND = 1_000;
const MS_PER_MINUTE = 60_000;

/** Stripe's own construction: the timestamp, the character `.`, then the raw body. */
const sign = (secret: string, timestamp: number, body = BODY): string =>
  createHmac("sha256", secret).update(`${String(timestamp)}.${body}`, "utf8").digest("hex");

const secondsAt = (instant: Date): number => Math.floor(instant.getTime() / MS_PER_SECOND);

const header = (parts: readonly string[]): string => parts.join(",");

const check = (headerValue: string | undefined, overrides: { readonly body?: string; readonly secrets?: readonly string[]; readonly now?: Date } = {}) =>
  verifyStripeSignature({
    body: overrides.body ?? BODY,
    header: headerValue,
    secrets: overrides.secrets ?? [SECRET],
    now: overrides.now ?? NOW,
  });

describe("verifying a Stripe-Signature header", () => {
  const t = secondsAt(NOW);

  it("accepts a delivery signed with the endpoint's secret", () => {
    expect(check(header([`t=${String(t)}`, `v1=${sign(SECRET, t)}`]))).toEqual({ status: "VERIFIED" });
  });

  it("accepts the header as Stripe actually sends it, with the fake v0 alongside", () => {
    // Stripe adds a deliberately invalid `v0` to test events. A verifier that stopped at the first
    // element, or that matched schemes by prefix, would fail or accept the wrong one.
    const value = header([`t=${String(t)}`, `v1=${sign(SECRET, t)}`, "v0=6ffbb59b2300aae63f272406069a9788598b792a944a07aba816edb039989a39"]);

    expect(check(value)).toEqual({ status: "VERIFIED" });
  });

  it("refuses a correct digest presented under any scheme but v1", () => {
    // The downgrade the docs warn about, stated as a test: the signature below is the *right* one,
    // computed with the real secret, and it is offered as `v0`. Accepting it would mean a verifier that
    // believes a value because it can recompute it, rather than because Stripe said which scheme counts.
    const correct = sign(SECRET, t);

    expect(check(header([`t=${String(t)}`, `v0=${correct}`]))).toEqual({ status: "REJECTED", reason: "MALFORMED_HEADER" });
    expect(check(header([`t=${String(t)}`, `v2=${correct}`]))).toEqual({ status: "REJECTED", reason: "MALFORMED_HEADER" });
    // Not by prefix either: `v10` starts with `v1`.
    expect(check(header([`t=${String(t)}`, `v10=${correct}`]))).toEqual({ status: "REJECTED", reason: "MALFORMED_HEADER" });
  });

  it("tries every v1 signature, because a rolled secret sends one per active secret", () => {
    // The 24-hour window after rolling an endpoint secret. A verifier that read only the first signature
    // would reject the deliveries signed with the other active secret — which is half of them, and
    // exactly during the window the roll exists to make survivable.
    const value = header([`t=${String(t)}`, `v1=${sign(ROLLED, t)}`, `v1=${sign(SECRET, t)}`]);

    expect(check(value)).toEqual({ status: "VERIFIED" });
    // And from the other side: the endpoint holding both secrets accepts a delivery signed with either.
    expect(check(header([`t=${String(t)}`, `v1=${sign(ROLLED, t)}`]), { secrets: [SECRET, ROLLED] })).toEqual({ status: "VERIFIED" });
  });

  it("refuses a signature made with another secret", () => {
    expect(check(header([`t=${String(t)}`, `v1=${sign("whsec_somebody_elses_secret", t)}`]))).toEqual({
      status: "REJECTED",
      reason: "NO_MATCHING_SIGNATURE",
    });
  });

  it("refuses a body that changed by one character after it was signed", () => {
    const value = header([`t=${String(t)}`, `v1=${sign(SECRET, t)}`]);

    // The raw-body requirement, as the failure it causes. A framework that re-serializes parsed JSON
    // changes whitespace and key order, and this is what the endpoint then sees.
    expect(check(value, { body: `${BODY} ` })).toEqual({ status: "REJECTED", reason: "NO_MATCHING_SIGNATURE" });
    expect(check(value, { body: BODY.replace("evt_1", "evt_2") })).toEqual({ status: "REJECTED", reason: "NO_MATCHING_SIGNATURE" });
  });

  it("refuses a header that is missing, empty, or has no usable timestamp", () => {
    const signature = `v1=${sign(SECRET, t)}`;

    expect(check(undefined)).toEqual({ status: "REJECTED", reason: "MALFORMED_HEADER" });
    expect(check("   ")).toEqual({ status: "REJECTED", reason: "MALFORMED_HEADER" });
    expect(check(signature)).toEqual({ status: "REJECTED", reason: "MALFORMED_HEADER" });
    expect(check(header(["t=", signature]))).toEqual({ status: "REJECTED", reason: "MALFORMED_HEADER" });
    // Not a number, so not a timestamp. Accepted, it would make the recency arithmetic `NaN`, and `NaN`
    // is never greater than the tolerance — the check would pass for every delivery for ever.
    expect(check(header(["t=not-a-timestamp", signature]))).toEqual({ status: "REJECTED", reason: "MALFORMED_HEADER" });
    expect(check(header([`t=${String(t)}e3`, signature]))).toEqual({ status: "REJECTED", reason: "MALFORMED_HEADER" });
    expect(check(header([`t=-${String(t)}`, signature]))).toEqual({ status: "REJECTED", reason: "MALFORMED_HEADER" });
  });

  it("refuses a signature that is not whole hex", () => {
    const correct = sign(SECRET, t);

    // Odd length and non-hex are not signatures at all, so the header has none left to compare.
    expect(check(header([`t=${String(t)}`, `v1=${correct.slice(0, 63)}`]))).toEqual({ status: "REJECTED", reason: "MALFORMED_HEADER" });
    expect(check(header([`t=${String(t)}`, "v1=not-hex-at-all"]))).toEqual({ status: "REJECTED", reason: "MALFORMED_HEADER" });
    // Truncated to an even length it decodes, and then it is a shorter digest than the expected one —
    // which must not compare equal on its shared prefix.
    expect(check(header([`t=${String(t)}`, `v1=${correct.slice(0, 32)}`]))).toEqual({ status: "REJECTED", reason: "NO_MATCHING_SIGNATURE" });
  });

  it("refuses a delivery whose timestamp is outside the tolerance, in either direction", () => {
    const stale = secondsAt(new Date(NOW.getTime() - (SIGNATURE_TOLERANCE_MINUTES * MS_PER_MINUTE + MS_PER_SECOND)));
    const ahead = secondsAt(new Date(NOW.getTime() + (SIGNATURE_TOLERANCE_MINUTES * MS_PER_MINUTE + MS_PER_SECOND)));

    expect(check(header([`t=${String(stale)}`, `v1=${sign(SECRET, stale)}`]))).toEqual({
      status: "REJECTED",
      reason: "TIMESTAMP_OUTSIDE_TOLERANCE",
    });
    // A clock ahead of ours is as wrong as one behind, and a replay cannot be dated into the future.
    expect(check(header([`t=${String(ahead)}`, `v1=${sign(SECRET, ahead)}`]))).toEqual({
      status: "REJECTED",
      reason: "TIMESTAMP_OUTSIDE_TOLERANCE",
    });
  });

  it("accepts a delivery at the edge of the tolerance", () => {
    const edge = secondsAt(new Date(NOW.getTime() - SIGNATURE_TOLERANCE_MINUTES * MS_PER_MINUTE));

    expect(check(header([`t=${String(edge)}`, `v1=${sign(SECRET, edge)}`]))).toEqual({ status: "VERIFIED" });
  });

  it("answers an unauthenticated old delivery as unauthenticated, not as stale", () => {
    // Order matters. Recency is a property of a number the sender chose; it only means anything once the
    // signature has established that Stripe chose it. A verifier that checked the clock first would
    // report an attacker's forgery as a clock problem.
    const stale = secondsAt(new Date(NOW.getTime() - 60 * MS_PER_MINUTE));

    expect(check(header([`t=${String(stale)}`, `v1=${sign("whsec_somebody_elses_secret", stale)}`]))).toEqual({
      status: "REJECTED",
      reason: "NO_MATCHING_SIGNATURE",
    });
  });

  it("refuses everything when the endpoint has no signing secret", () => {
    const value = header([`t=${String(t)}`, `v1=${sign(SECRET, t)}`]);

    // Fail closed on configuration. An endpoint deployed without its secret that accepted deliveries
    // would accept anybody's, and would look exactly like working software while doing it.
    expect(check(value, { secrets: [] })).toEqual({ status: "REJECTED", reason: "NOT_CONFIGURED" });
    expect(check(value, { secrets: ["", "   "] })).toEqual({ status: "REJECTED", reason: "NOT_CONFIGURED" });
  });

  it("says why it refused without quoting what it compared", () => {
    // A reason is a code, never a value. A reason carrying the header would put a signature in a log
    // file, and one carrying the body would put the payload there.
    const refusals = [
      check(undefined),
      check(header([`t=${String(t)}`, "v1=deadbeef"])),
      check(header([`t=${String(t)}`, `v1=${sign("whsec_other", t)}`])),
    ];

    for (const refusal of refusals) {
      expect(Object.keys(refusal).sort()).toEqual(["reason", "status"]);
      expect(JSON.stringify(refusal)).not.toContain("whsec_");
      expect(JSON.stringify(refusal)).not.toContain("evt_");
    }
  });
});
