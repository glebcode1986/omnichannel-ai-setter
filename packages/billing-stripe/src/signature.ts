/**
 * `Stripe-Signature`, verified by hand.
 *
 * Verified against the live documentation on 2026-10-12:
 * https://docs.stripe.com/webhooks?verify=verify-manually#verify-manually. Four steps, and every one of
 * them has a way of being written almost-right:
 *
 * 1. the header splits on `,` into elements and each element on `=` into a prefix and a value;
 * 2. the signed payload is the timestamp, then the single character `.`, then the raw body;
 * 3. the HMAC is SHA-256 keyed with the endpoint's signing secret, the `whsec_…` string as it stands;
 * 4. the comparison is constant-time, and the timestamp has to be recent.
 *
 * **Only `v1` is accepted.** The docs are explicit that this is a downgrade defence: Stripe also sends a
 * deliberately fake `v0` signature with test events, and a verifier that accepted any scheme it could
 * compute would accept that one. Schemes are matched exactly rather than by prefix.
 *
 * **Every `v1` is tried, not just the first.** Rolling an endpoint secret leaves the previous one active
 * for up to 24 hours, and during that window Stripe sends one signature per active secret — so a verifier
 * that read a single signature would reject half of the deliveries in the window it exists to survive.
 *
 * **The timestamp is checked per delivery, not per event.** Stripe generates a new timestamp and a new
 * signature for every delivery attempt, so a redelivery three days later is as fresh as a first attempt.
 *
 * Nothing here is logged and nothing here is returned: a rejection says which of the four steps failed and
 * never what was compared. A reason that quoted the header would put a signature in a log file, and a
 * reason that quoted the body would put the payload there.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const STRIPE_SIGNATURE_HEADER = "stripe-signature";

/**
 * How far out of date a delivery's timestamp may be.
 *
 * Stripe's own libraries state a default tolerance of five minutes, and the docs warn in as many words
 * against a tolerance of `0` because it disables the recency check. Five minutes is therefore what this
 * uses, expressed as minutes so that the constant says the thing the documentation says.
 */
export const SIGNATURE_TOLERANCE_MINUTES = 5;

const MS_PER_MINUTE = 60_000;
const MS_PER_SECOND = 1_000;

export type SignatureRejection =
  /** No `Stripe-Signature` header, or one with no `t=` or no `v1=` element. */
  | "MALFORMED_HEADER"
  /** The header parsed and no `v1` signature matched the secret. */
  | "NO_MATCHING_SIGNATURE"
  /** The signature matched, and the delivery is older or newer than the tolerance allows. */
  | "TIMESTAMP_OUTSIDE_TOLERANCE"
  /** This endpoint has no signing secret configured, so nothing can be authenticated. */
  | "NOT_CONFIGURED";

export type SignatureVerdict = { readonly status: "VERIFIED" } | { readonly status: "REJECTED"; readonly reason: SignatureRejection };

export interface SignatureCheck {
  /** The exact bytes Stripe signed, as the string it sent. */
  readonly body: string;
  /** The `Stripe-Signature` header value, as it arrived. */
  readonly header: string | undefined;
  /** The endpoint's `whsec_…` signing secrets. More than one only while a secret is being rolled. */
  readonly secrets: readonly string[];
  readonly now: Date;
  readonly toleranceMinutes?: number;
}

export function verifyStripeSignature(check: SignatureCheck): SignatureVerdict {
  const usable = check.secrets.filter((secret) => secret.trim() !== "");
  if (usable.length === 0) {
    // Fail closed on configuration. An endpoint with no secret that accepted deliveries would accept
    // anybody's, and the failure would look exactly like working software.
    return { status: "REJECTED", reason: "NOT_CONFIGURED" };
  }
  const parsed = parseHeader(check.header);
  if (parsed === undefined) {
    return { status: "REJECTED", reason: "MALFORMED_HEADER" };
  }

  // The timestamp is part of the signed payload, so it cannot be moved without invalidating the
  // signature — which is why authenticity is established first and recency second. Checking recency
  // first would be answering a question about a number an attacker chose.
  const signedPayload = `${parsed.timestamp}.${check.body}`;
  const matched = usable.some((secret) => {
    const expected = createHmac("sha256", secret).update(signedPayload, "utf8").digest();
    return parsed.signatures.some((signature) => equal(signature, expected));
  });
  if (!matched) {
    return { status: "REJECTED", reason: "NO_MATCHING_SIGNATURE" };
  }

  const tolerance = (check.toleranceMinutes ?? SIGNATURE_TOLERANCE_MINUTES) * MS_PER_MINUTE;
  const age = Math.abs(check.now.getTime() - Number(parsed.timestamp) * MS_PER_SECOND);
  // Absolute, so a timestamp from the future is as suspicious as one from the past: a clock that is
  // wrong in either direction is a clock, and the docs point at NTP for exactly this reason.
  return age > tolerance ? { status: "REJECTED", reason: "TIMESTAMP_OUTSIDE_TOLERANCE" } : { status: "VERIFIED" };
}

interface ParsedSignature {
  /** Unix seconds, as the string that was signed. Kept as a string so the signed payload is byte-exact. */
  readonly timestamp: string;
  readonly signatures: readonly Buffer[];
}

function parseHeader(header: string | undefined): ParsedSignature | undefined {
  if (header === undefined || header.trim() === "") {
    return undefined;
  }
  let timestamp: string | undefined;
  const signatures: Buffer[] = [];
  for (const element of header.split(",")) {
    const separator = element.indexOf("=");
    if (separator < 0) {
      continue;
    }
    const prefix = element.slice(0, separator).trim();
    const value = element.slice(separator + 1).trim();
    if (prefix === "t") {
      // A timestamp that is not a run of digits is not a timestamp. Accepting one would mean signing a
      // payload whose first component came from an attacker's imagination, and the arithmetic below
      // would then compare `NaN`, which is never greater than the tolerance.
      if (/^[0-9]+$/u.test(value)) {
        timestamp = value;
      }
      continue;
    }
    // Exactly `v1`, so the fake `v0` Stripe sends with test events and any future scheme are both
    // ignored rather than verified with the one algorithm this module knows.
    if (prefix === "v1") {
      const decoded = decodeHex(value);
      if (decoded !== undefined) {
        signatures.push(decoded);
      }
    }
  }
  return timestamp === undefined || signatures.length === 0 ? undefined : { timestamp, signatures };
}

/** Rejects anything that is not even-length lowercase-or-uppercase hex, so a truncated digest cannot match. */
function decodeHex(value: string): Buffer | undefined {
  if (value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-fA-F]+$/u.test(value)) {
    return undefined;
  }
  return Buffer.from(value, "hex");
}

function equal(provided: Buffer, expected: Buffer): boolean {
  // `timingSafeEqual` throws on a length mismatch, and the lengths are visible to the sender anyway.
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
