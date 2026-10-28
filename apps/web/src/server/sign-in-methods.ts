/**
 * Which sign-in methods this deployment can actually complete, and where a person may land afterwards
 * (#117, ADR-022 accepted 2026-10-28).
 *
 * The owner chose **both** Google OAuth/OIDC and a one-time email link, for public self-serve
 * registration. Neither is hard-wired on: each is offered only when the configuration it needs is
 * present *and* usable, and a method that is half-configured is reported as **withheld with a reason**
 * rather than rendered as a button that fails somewhere a customer cannot see.
 *
 * This module is deliberately pure — no `next-auth`, no database, no environment access of its own — so
 * the decision can be tested against every combination of configuration, including the combinations a
 * misconfigured deployment would actually produce. `auth.ts` builds providers from it, and the sign-in
 * page renders from the same answer, so the page cannot offer a method the server will not accept.
 */
import type { NodeEnv } from "@omnichannel/env";

export type SignInMethod = "google" | "email";

/** Why a method is not on offer. Each one is a different thing for an operator to go and fix. */
export type WithheldReason =
  /** Nothing is configured for it. The ordinary state of a deployment that has not set it up. */
  | "NOT_CONFIGURED"
  /** Some of it is configured. A client id without its secret, or a mail server without a sender. */
  | "PARTIALLY_CONFIGURED"
  /** No `AUTH_URL`, so there is no origin to build a callback or a link from that is not a header. */
  | "NO_BASE_URL"
  /** `AUTH_URL` is plain HTTP outside development, where a link and a cookie travel in the clear. */
  | "INSECURE_BASE_URL";

export interface WithheldMethod {
  readonly method: SignInMethod;
  readonly reason: WithheldReason;
}

export interface SignInAvailability {
  readonly available: readonly SignInMethod[];
  readonly withheld: readonly WithheldMethod[];
  /** The origin every callback and emailed link is built from, absent when none is usable. */
  readonly baseUrl?: string;
}

/**
 * The slice of the environment this decision needs.
 *
 * A slice rather than `WebEnv`, so the rules can be exercised without constructing a whole valid
 * environment — and so adding an unrelated variable to `env.ts` cannot change what this function means.
 */
export interface SignInConfig {
  readonly NODE_ENV: NodeEnv;
  readonly AUTH_URL?: string | undefined;
  readonly GOOGLE_CLIENT_ID?: string | undefined;
  readonly GOOGLE_CLIENT_SECRET?: string | undefined;
  readonly AUTH_EMAIL_SERVER?: string | undefined;
  readonly AUTH_EMAIL_FROM?: string | undefined;
}

/** Treats whitespace as absent: a variable set to a space is a variable somebody meant to set. */
function present(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}

/**
 * Whether the configured origin may be used, and why not.
 *
 * HTTPS is required outside development because both things this origin is used for are credentials in
 * transit: the OAuth callback carries an authorization code, and the emailed link carries a single-use
 * token that is, for one click, the account. Permitted on `http` in development so the flow can be run
 * locally at all.
 */
function baseUrlVerdict(config: SignInConfig): { readonly baseUrl: string } | { readonly reason: WithheldReason } {
  if (!present(config.AUTH_URL)) {
    return { reason: "NO_BASE_URL" };
  }
  const raw = (config.AUTH_URL ?? "").trim();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    // `env.ts` validates the shape, so this is only reachable through a direct caller — a test, or a
    // future caller that reads the value from somewhere else. Refused rather than assumed.
    return { reason: "NO_BASE_URL" };
  }
  if (parsed.protocol !== "https:" && config.NODE_ENV === "production") {
    return { reason: "INSECURE_BASE_URL" };
  }
  // Normalized to the origin. A configured path would otherwise be concatenated into callback URLs that
  // no provider has on its allowlist, which fails at the provider rather than here.
  return { baseUrl: parsed.origin };
}

/** What this deployment offers, and what it withholds with the reason an operator needs. */
export function availableSignInMethods(config: SignInConfig): SignInAvailability {
  const origin = baseUrlVerdict(config);
  const google = present(config.GOOGLE_CLIENT_ID) && present(config.GOOGLE_CLIENT_SECRET);
  const googlePartial = present(config.GOOGLE_CLIENT_ID) !== present(config.GOOGLE_CLIENT_SECRET);
  const email = present(config.AUTH_EMAIL_SERVER) && present(config.AUTH_EMAIL_FROM);
  const emailPartial = present(config.AUTH_EMAIL_SERVER) !== present(config.AUTH_EMAIL_FROM);

  if (!("baseUrl" in origin)) {
    // No usable origin withholds **both** methods, and that is not over-caution: without it the only
    // other source of an absolute URL is the request's own `Host` header.
    return {
      available: [],
      withheld: [
        { method: "google", reason: origin.reason },
        { method: "email", reason: origin.reason },
      ],
    };
  }

  const available: SignInMethod[] = [];
  const withheld: WithheldMethod[] = [];
  if (google) {
    available.push("google");
  } else {
    withheld.push({ method: "google", reason: googlePartial ? "PARTIALLY_CONFIGURED" : "NOT_CONFIGURED" });
  }
  if (email) {
    available.push("email");
  } else {
    withheld.push({ method: "email", reason: emailPartial ? "PARTIALLY_CONFIGURED" : "NOT_CONFIGURED" });
  }
  return { available, withheld, baseUrl: origin.baseUrl };
}

/** The destination after a successful sign-in when the request named nothing usable. */
export const DEFAULT_SIGNED_IN_PATH = "/workspaces";

/**
 * Where a sign-in may send somebody, given what the request asked for.
 *
 * An open-redirect guard, and the reason it is strict: the sign-in page takes a `callbackUrl` from the
 * query string, Auth.js passes it to the `redirect` callback, and a value that leaves this origin turns
 * the product's own sign-in into a credible way to deliver somebody to a page that looks like it.
 *
 * Allowed: a path on this origin. An absolute URL whose origin is exactly `baseUrl`, normalized back to
 * its path so one answer comes out of both forms. Everything else — another origin, a protocol-relative
 * `//evil.example`, a `javascript:` or `data:` URL, a backslash-smuggled authority, anything unparseable
 * — becomes the default. **Not** an error: a person signing in should arrive somewhere useful rather than
 * at a failure about a parameter they never saw.
 */
export function safeRedirectTarget(requested: string | undefined, baseUrl: string): string {
  if (requested === undefined || requested.trim() === "") {
    return DEFAULT_SIGNED_IN_PATH;
  }
  const candidate = requested.trim();
  // Resolved against the base rather than pattern-matched. A relative value resolves onto this origin and
  // an absolute one keeps its own, so one comparison answers both — and `new URL` is what the browser
  // and the framework will do with this string anyway, which is the behaviour a guard has to agree with.
  // A literal backslash is rejected outright: browsers have historically treated `/\evil.example` as an
  // authority, and WHATWG URL parsing of it differs from some agents'.
  if (candidate.includes("\\")) {
    return DEFAULT_SIGNED_IN_PATH;
  }
  let resolved: URL;
  let base: URL;
  try {
    base = new URL(baseUrl);
    resolved = new URL(candidate, base);
  } catch {
    return DEFAULT_SIGNED_IN_PATH;
  }
  if (resolved.origin !== base.origin) {
    return DEFAULT_SIGNED_IN_PATH;
  }
  // Only the path survives, with its query and fragment. Returning the absolute URL would be correct and
  // would also mean every redirect this product performs carries an origin somebody could edit.
  const path = `${resolved.pathname}${resolved.search}${resolved.hash}`;
  return path.startsWith("/") ? path : DEFAULT_SIGNED_IN_PATH;
}
