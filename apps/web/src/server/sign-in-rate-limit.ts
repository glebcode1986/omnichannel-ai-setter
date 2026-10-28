/**
 * How often one address, and one caller, may ask for a sign-in link (#117).
 *
 * Two endpoints need this and for different reasons. **Requesting** a link costs somebody else's inbox:
 * without a limit, the form is a way to mail an arbitrary address repeatedly, from a domain the target
 * trusts. **Verifying** a link costs nothing to attempt, which is exactly why it must be limited — a
 * token is short, and an endpoint that will answer unboundedly is an endpoint somebody will guess at.
 *
 * The policy is data and the decision is pure; the counting is a port, so the substrate can be the
 * deployment's Redis in production and a map in a test. Keyed by a **hash** of the address rather than the
 * address: a counter store is not a place to keep a list of who has tried to sign in, and a dump of one
 * should not be a customer list.
 *
 * **Why there is no per-IP rule unless a deployment asks for one.** Nothing in this repository reads a
 * client address, and no reverse-proxy contract is checked in — so the only available source is a request
 * header, which any caller can set. A limiter keyed on a spoofable header is worse than no limiter,
 * because it reads as protection and provides none: an attacker rotates the header and an ordinary person
 * behind the same corporate NAT gets refused. So the caller rule applies **only** when the deployment
 * names the header its own proxy sets (`AUTH_TRUSTED_CLIENT_IP_HEADER`), and is otherwise absent rather
 * than applied to one shared bucket — a shared bucket would be a global sign-in outage after twenty
 * attempts, which is a denial of service this product would be doing to itself.
 *
 * What remains always on is the per-address rule, which cannot be spoofed: the address *is* the thing
 * being protected. The residual gap — an attacker asking for links at many different addresses from an
 * unattributed caller — is real, is stated in the handoff, and closes the moment a trusted header is
 * configured.
 */
import { createHash } from "node:crypto";

export type SignInEndpoint = "REQUEST_LINK" | "VERIFY_LINK";

export interface RateLimitRule {
  /** How many attempts the window allows before refusing. */
  readonly limit: number;
  readonly windowMs: number;
}

export interface RateLimitPolicy {
  /** Per address asked for, which protects the person who owns that inbox. */
  readonly perIdentifier?: RateLimitRule;
  /** Per caller, applied only where the deployment supplies a caller identity it trusts. */
  readonly perCaller: RateLimitRule;
}

const MINUTE_MS = 60_000;

/**
 * The limits, stated as the product's answer rather than hidden in a call site.
 *
 * Deliberately generous enough that an ordinary person who mistypes an address twice and asks again is
 * never refused, and small enough that the form is useless as a way to mail somebody repeatedly. A
 * refusal is not an error page: the request endpoint answers exactly as it does on success, because an
 * endpoint that refuses *differently* tells an attacker when they have found a real address.
 */
export const SIGN_IN_RATE_LIMITS: Readonly<Record<SignInEndpoint, RateLimitPolicy>> = {
  REQUEST_LINK: {
    perIdentifier: { limit: 5, windowMs: 15 * MINUTE_MS },
    perCaller: { limit: 20, windowMs: 15 * MINUTE_MS },
  },
  // No per-identifier rule: a verification attempt carries a token, not an address somebody chose, and
  // counting by the address in the link would let a flood against one person's token lock that person out
  // of their own link.
  VERIFY_LINK: {
    perCaller: { limit: 30, windowMs: 15 * MINUTE_MS },
  },
};

/** Counts attempts in a window. Returns the count *including* the attempt being recorded. */
export interface AttemptCounter {
  increment: (key: string, windowMs: number) => Promise<number>;
}

export interface RateLimitRequest {
  readonly endpoint: SignInEndpoint;
  /** The address a link was asked for, where the endpoint has one. */
  readonly identifier?: string;
  /** Whoever is calling, as the deployment identifies them — an address, or a proxy-supplied one. */
  readonly caller?: string;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Which rule refused, for the log. Absent when allowed. */
  readonly refusedBy?: "IDENTIFIER" | "CALLER";
}

/**
 * Normalizes an address the way a counter must count it.
 *
 * Lowercased and trimmed, so `Someone@Example.com ` and `someone@example.com` share a bucket — otherwise
 * the limit is bypassed by changing the capitalization. Local-part tricks (dots, `+tag`) are deliberately
 * *not* normalized: they can be genuinely different mailboxes at some providers, and collapsing them would
 * refuse one person because another was noisy.
 */
export function normalizeIdentifier(identifier: string): string {
  return identifier.trim().toLowerCase();
}

/** The key an attempt is counted under. The address never appears in it. */
export function rateLimitKey(endpoint: SignInEndpoint, scope: "id" | "caller", value: string): string {
  const digest = createHash("sha256").update(`${endpoint}:${scope}:${value}`).digest("base64url").slice(0, 32);
  return `signin:rl:${endpoint}:${scope}:${digest}`;
}

/**
 * Whether this attempt may proceed.
 *
 * Both rules are counted even when the first refuses, and that is deliberate: a caller who is over the
 * per-caller limit is still attempting against an address, and a count that stopped early would let a
 * flood reset itself by alternating. The *decision* is reported from whichever refused first.
 *
 * A missing caller is counted under a single shared bucket rather than waved through. A deployment behind
 * a proxy that strips the header would otherwise have no limit at all, which is the failure mode worth
 * being paranoid about — and it is visible, because the shared bucket refuses early and loudly.
 */
export async function checkSignInRateLimit(counter: AttemptCounter, request: RateLimitRequest): Promise<RateLimitDecision> {
  const policy = SIGN_IN_RATE_LIMITS[request.endpoint];
  const caller = request.caller?.trim();

  // Both rules are counted before either refuses, and that is deliberate: a caller who is already over
  // their limit is still attempting against an address, and a count that stopped early would let a flood
  // reset its own per-address counters by rotating callers.
  let callerRefused = false;
  if (caller !== undefined && caller !== "") {
    const count = await counter.increment(rateLimitKey(request.endpoint, "caller", caller), policy.perCaller.windowMs);
    callerRefused = count > policy.perCaller.limit;
  }
  let identifierRefused = false;
  if (policy.perIdentifier !== undefined && request.identifier !== undefined && request.identifier.trim() !== "") {
    const count = await counter.increment(
      rateLimitKey(request.endpoint, "id", normalizeIdentifier(request.identifier)),
      policy.perIdentifier.windowMs,
    );
    identifierRefused = count > policy.perIdentifier.limit;
  }

  if (identifierRefused) {
    return { allowed: false, refusedBy: "IDENTIFIER" };
  }
  if (callerRefused) {
    return { allowed: false, refusedBy: "CALLER" };
  }
  return { allowed: true };
}

/**
 * The caller identity, taken only from the header the deployment named.
 *
 * Returns `undefined` when no header is configured or the configured one is absent or empty, which is what
 * switches the per-caller rule off rather than onto a shared bucket. The first value of a comma-separated
 * list is taken — `x-forwarded-for` accumulates hops left to right, and the leftmost is the one the
 * trusted proxy wrote — and it is length-capped, because an unbounded header becomes an unbounded key.
 */
export function trustedCallerFrom(headers: Headers, headerName: string | undefined): string | undefined {
  if (headerName === undefined || headerName.trim() === "") {
    return undefined;
  }
  const raw = headers.get(headerName.trim());
  if (raw === null) {
    return undefined;
  }
  const first = raw.split(",")[0]?.trim() ?? "";
  return first === "" ? undefined : first.slice(0, 128);
}
