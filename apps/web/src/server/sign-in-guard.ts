/**
 * The rate limit in front of Auth.js (#117).
 *
 * This app has no middleware, so a limit has to be applied at every entry point by hand — and there are
 * **two**, which is the trap this module exists to close. The HTTP endpoint
 * `app/api/auth/[...nextauth]/route.ts` is one. The other is the product's own sign-in form, which calls
 * the server action `signIn("nodemailer", …)`: in this version that runs `Auth()` **in process** rather
 * than making a request, so it never passes through the route and a limiter that lived only there would
 * guard every caller except the one the product ships.
 *
 * So the decision is a plain function over what both callers have — a method, a path, headers and maybe an
 * address — and `signin-limit-coverage.test.ts` walks the tree to fail the build if a third path to the
 * email provider ever appears without it.
 *
 * Applied **before** anything is looked up, deliberately: `ingestWebhook` resolves an account before
 * verifying a signature, and repeating that ordering here would mean every refused attempt still costs a
 * database round trip and a mail attempt, which makes a limiter decorative.
 *
 * **A refusal does not depend on whether the address has an account.** That is the property that keeps
 * this from becoming an enumeration oracle, and it is structural rather than careful: the counter is keyed
 * on the normalized address and on nothing else, so an address nobody has ever registered and an address
 * belonging to a customer are refused after exactly the same number of attempts, with exactly the same
 * response. Auth.js's email flow already mails a link to either, so there was no oracle to open — and the
 * one this could have added is closed by never asking the database anything.
 *
 * A refused request is answered the way a *successful* one is: a redirect to the "check your email" page.
 * Not a 429, and that is a decision — a distinct status or message on the sign-in form is a signal to
 * script against, and the person who has genuinely asked five times in a quarter of an hour is better
 * served by the same calm page than by an error they cannot act on. Every refusal is logged.
 */
import type { NextRequest } from "next/server";

import { getLogger } from "./logger";
import { getSignInCounter } from "./sign-in-counter";
import { checkSignInRateLimit, trustedCallerFrom, type SignInEndpoint } from "./sign-in-rate-limit";

/** The provider id the email method is registered under, which appears in both of its URLs. */
export const EMAIL_PROVIDER_ID = "nodemailer";

/** Where a person is sent after asking for a link — the page `pages.verifyRequest` names. */
export const LINK_SENT_PATH = "/sign-in/sent";

/**
 * Which limit, if any, this request is subject to.
 *
 * Matched on the path Auth.js itself routes on, and only for the email method: the Google endpoints hand
 * off to Google, which does its own abuse control, and limiting the redirect would refuse people for
 * pressing a button twice.
 */
export function signInEndpointFor(method: string, pathname: string): SignInEndpoint | undefined {
  if (method === "POST" && pathname.endsWith(`/signin/${EMAIL_PROVIDER_ID}`)) {
    return "REQUEST_LINK";
  }
  if (method === "GET" && pathname.endsWith(`/callback/${EMAIL_PROVIDER_ID}`)) {
    return "VERIFY_LINK";
  }
  return undefined;
}

/**
 * The address a sign-in request is for, read without consuming the body the handler still needs.
 *
 * `request.clone()` is the whole reason this is safe: reading a request's body marks it used, and the
 * handler behind this guard has to read the same body. A guard that broke the request it was protecting
 * would be worse than no guard.
 *
 * Returns `undefined` for anything that is not a form submission with an address, which leaves the
 * per-address rule unapplied for that request — the shape Auth.js would refuse anyway.
 */
export async function identifierFrom(request: NextRequest): Promise<string | undefined> {
  const type = request.headers.get("content-type") ?? "";
  if (!type.includes("application/x-www-form-urlencoded") && !type.includes("multipart/form-data")) {
    return undefined;
  }
  try {
    const form = await request.clone().formData();
    const email = form.get("email");
    return typeof email === "string" && email.trim() !== "" ? email : undefined;
  } catch {
    // An unparseable body is not an address. The handler will answer it however it answers it.
    return undefined;
  }
}

export interface GuardDecision {
  /** A response to send instead of calling the handler, or nothing to let the request through. */
  readonly refusal?: Response;
}

/**
 * Applies the limit to one request to the auth endpoint.
 *
 * Takes the trusted-header name and the origin as arguments rather than reading the environment, so the
 * behaviour can be exercised for a deployment that has configured a proxy header and for one that has
 * not — which are genuinely different limits, not a setting.
 */
export async function guardSignInRequest(
  request: NextRequest,
  options: { readonly trustedClientIpHeader?: string | undefined; readonly origin: string },
): Promise<GuardDecision> {
  const endpoint = signInEndpointFor(request.method, new URL(request.url).pathname);
  if (endpoint === undefined) {
    return {};
  }

  const identifier = endpoint === "REQUEST_LINK" ? await identifierFrom(request) : undefined;
  const allowed = await signInAttemptAllowed({
    endpoint,
    headers: request.headers,
    ...(identifier === undefined ? {} : { identifier }),
    ...(options.trustedClientIpHeader === undefined ? {} : { trustedClientIpHeader: options.trustedClientIpHeader }),
  });
  if (allowed) {
    return {};
  }

  // Answered exactly as a successful request is. A verification attempt has nowhere calm to go, so it
  // gets the sign-in page with the same error a spent link produces, which is also what it would have
  // received had it raced a real one.
  const location =
    endpoint === "REQUEST_LINK"
      ? `${options.origin}${LINK_SENT_PATH}?provider=${EMAIL_PROVIDER_ID}&type=email`
      : `${options.origin}/sign-in?error=Verification`;
  return { refusal: new Response(null, { status: 302, headers: { Location: location } }) };
}

export interface SignInAttempt {
  readonly endpoint: SignInEndpoint;
  readonly headers: Headers;
  /** The address asked for, where the caller knows it. */
  readonly identifier?: string;
  readonly trustedClientIpHeader?: string;
}

/**
 * The one decision both entry points make.
 *
 * Returns a boolean rather than a response, because the two callers answer a refusal differently: the
 * HTTP route sends the same redirect a success sends, and the server action lands on the same page it
 * would have landed on. Neither reveals anything about the address — the counter is keyed on the address
 * and consults no table, so a registered address and an unknown one are refused identically.
 *
 * Logged **without the address**. This is the one place that knows it, and a log of refused sign-in
 * attempts would be a list of addresses somebody is interested in.
 */
export async function signInAttemptAllowed(attempt: SignInAttempt): Promise<boolean> {
  const caller = trustedCallerFrom(attempt.headers, attempt.trustedClientIpHeader);
  const decision = await checkSignInRateLimit(getSignInCounter(), {
    endpoint: attempt.endpoint,
    ...(attempt.identifier === undefined ? {} : { identifier: attempt.identifier }),
    ...(caller === undefined ? {} : { caller }),
  });
  if (!decision.allowed) {
    getLogger().warn("signin.rate_limited", { endpoint: attempt.endpoint, refusedBy: decision.refusedBy });
  }
  return decision.allowed;
}
