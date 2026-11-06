/**
 * Who may sign in while this deployment runs a private pilot, and how a refusal is answered (#133).
 *
 * The owner's decision of 2026-11-05: the pilot is **invitation-only**. Known businesses are let in by
 * name; nobody else may create an account, however the sign-in page is reached. The accepted public
 * self-serve behaviour of #117 is not deleted — it is what `open` still means, and a deployment that
 * says nothing keeps it.
 *
 * Deliberately pure — no `next-auth`, no database, no environment access of its own — so the gate can be
 * exercised against every combination a misconfigured deployment would actually produce, including the
 * empty one. `auth.ts` makes the live decision from `signInGateVerdict` and `sign-in-methods.ts` asks
 * `signInAccess` which methods a pilot may offer at all.
 *
 * **Two properties this module exists to hold.**
 *
 * 1. *A refusal is not an answer.* A stranger who types an invited colleague's address must not be able
 *    to tell that the address was invited, and an invited person must not be able to enumerate the rest
 *    of the pilot. So a link request for an address that is not invited is answered with the **same
 *    redirect a sent link produces** — `signInGateVerdict` returns that URL as a string, which
 *    `@auth/core` turns into exactly the response it would have sent anyway, before it writes a token
 *    and before the transport is called. No token row, no mail, nothing to compare.
 * 2. *Every way of being unsure closes the gate.* An unreadable mode is `invite`; an empty allowlist
 *    invites nobody; a malformed entry matches no address. Each of those is the direction that keeps
 *    somebody out rather than the direction that lets everybody in.
 */

/** Whether this deployment registers anybody who asks, or only the addresses it was given. */
export type SignInAccess = "open" | "invite";

/**
 * The slice of the environment this decision needs.
 *
 * A slice rather than `WebEnv`, for the reason `SignInConfig` is one: the rules can then be exercised
 * without constructing a whole valid environment, and an unrelated variable cannot change what this
 * means.
 */
export interface InvitationConfig {
  readonly AUTH_SIGN_IN_ACCESS?: string | undefined;
  readonly AUTH_INVITE_ALLOWLIST?: string | undefined;
}

/**
 * The provider id the email method is registered under, repeated here rather than imported.
 *
 * `sign-in-guard.ts` owns the same constant and reaches Redis to do its job; this module is imported by
 * `sign-in-methods.ts`, which is pure and tested as pure. `sign-in-invitations.test.ts` asserts the two
 * spellings are the same string, so the duplication cannot drift silently.
 */
const EMAIL_PROVIDER = "nodemailer";

/** Where Auth.js is mounted. The route is `app/api/auth/[...nextauth]/route.ts`. */
const AUTH_BASE_PATH = "/api/auth";

/**
 * The answer a request for a sign-in link gets, whether or not a link was sent.
 *
 * This string has to be **what `@auth/core` would have returned by itself**: `send-token.ts` ends with
 * `redirect: ${basePath}/verify-request?provider=<id>&type=email`, and our `redirect` callback resolves
 * a same-origin value back to its path, so returning this from the `signIn` callback produces a response
 * that is equal to a success byte for byte. `sign-in-invitations.integration.test.ts` runs the real
 * handler twice — an invited address and one that is not — and compares the two responses rather than
 * trusting this comment.
 */
export const LINK_REQUEST_ANSWER = `${AUTH_BASE_PATH}/verify-request?provider=${EMAIL_PROVIDER}&type=email`;

/**
 * One address, in the single spelling everything here compares.
 *
 * `NFKC` first and then lower case, because that is what `@auth/core`'s own normalizer does to the
 * address before it ever reaches this gate: a full-width `＠` is folded to an ASCII `@` there, so an
 * allowlist that skipped the fold would hold entries no incoming address could ever equal. Applied to
 * both sides, so the comparison is between two values that were made the same way.
 */
export function normalizeAddress(value: string): string {
  return value.normalize("NFKC").toLowerCase().trim();
}

/**
 * Which mode this deployment is in.
 *
 * `env.ts` already refuses to boot on a value that is neither word, so an unrecognised one should be
 * unreachable. It is still read as `invite` rather than `open`, because this is a gate: the two ways of
 * being wrong are not worth the same, and the only tolerable way to misread this variable is the one
 * that lets fewer people in. Absent — the ordinary state of a deployment that never heard of the pilot —
 * is `open`, which is the accepted behaviour of #117 unchanged.
 */
export function signInAccess(config: InvitationConfig): SignInAccess {
  const raw = (config.AUTH_SIGN_IN_ACCESS ?? "").trim().toLowerCase();
  if (raw === "") {
    return "open";
  }
  return raw === "open" ? "open" : "invite";
}

/**
 * The invited addresses, normalized.
 *
 * Separated by commas, semicolons or any whitespace, so a list pasted out of a message works and a list
 * written one address per line works. An entry that is not an address is **not** rejected and does not
 * fail the boot: it simply equals no incoming address, which is the fail-closed direction — a typo costs
 * one tester an invitation, and the operator finds out when that tester says the link never came, which
 * is far better than a typo quietly admitting everybody.
 */
export function invitedAddresses(config: InvitationConfig): ReadonlySet<string> {
  const raw = config.AUTH_INVITE_ALLOWLIST ?? "";
  const entries = raw
    .split(/[\s,;]+/u)
    .map((entry) => normalizeAddress(entry))
    .filter((entry) => entry !== "");
  return new Set(entries);
}

/**
 * Whether this address may sign in at all.
 *
 * In `open` mode everybody may, which is what makes this safe to call unconditionally. In `invite` mode
 * **an empty allowlist invites nobody** — the trap worth naming, because a requirement read from a list
 * that happens to be empty is a requirement that enforces nothing, and a gate that silently stops being
 * a gate when its list is cleared is worse than no gate at all.
 */
export function isInvited(config: InvitationConfig, address: string | null | undefined): boolean {
  if (signInAccess(config) === "open") {
    return true;
  }
  const normalized = normalizeAddress(address ?? "");
  if (normalized === "") {
    return false;
  }
  return invitedAddresses(config).has(normalized);
}

export interface SignInGateRequest {
  readonly config: InvitationConfig;
  /** The address the attempt is for, as `@auth/core` normalized it. */
  readonly address: string | null | undefined;
  /** True while a link is being *requested*; false when one is being *spent*, and for every provider. */
  readonly verificationRequest: boolean;
}

/**
 * The verdict, in the three values `@auth/core` understands — `true`, `false`, or a URL to answer with.
 *
 * Shaped like the library's own return type on purpose: `auth.ts` hands this straight back, so there is
 * no second place where an answer could be translated into a different one.
 *
 * - **Admitted** — `true`, and the flow continues exactly as it did before the pilot.
 * - **Not invited, asking for a link** — the URL a sent link is answered with. The library takes a
 *   string as "redirect there instead", and it does so *before* generating the token and *before*
 *   calling the transport, so nothing is written and nothing is sent. The caller cannot tell the two
 *   apart.
 * - **Not invited, spending a link** (or signing in with any other provider) — `false`, which the
 *   library turns into `AccessDenied`. There is nothing to hide at this point: whoever holds the link
 *   already knows the address, and the refusal is what makes **revocation** work — taking an address out
 *   of the allowlist stops a link that was already sent.
 */
export function signInGateVerdict(request: SignInGateRequest): true | false | string {
  if (isInvited(request.config, request.address)) {
    return true;
  }
  return request.verificationRequest ? LINK_REQUEST_ANSWER : false;
}
