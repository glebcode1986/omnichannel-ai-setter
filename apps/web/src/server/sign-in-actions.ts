"use server";

/**
 * Starting a sign-in, from the product's own form (#117).
 *
 * These are the **second** entry point to the email provider, and the reason `sign-in-guard.ts` exposes
 * its decision as a plain function: in the installed version `signIn()` runs `Auth()` in process rather
 * than making an HTTP request, so a sign-in started here never passes through
 * `app/api/auth/[...nextauth]/route.ts`. A rate limit that lived only on that route would guard every
 * caller except the form this product ships.
 *
 * `signIn()` works by throwing Next's redirect, so nothing here wraps it in a `try` that does not rethrow
 * what it does not recognise — catching `NEXT_REDIRECT` would turn a successful sign-in into a swallowed
 * error and leave the person on a page that reported nothing.
 */
import { AuthError } from "next-auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { signIn } from "../auth";
import { loadWebEnv } from "../env";
import { field } from "./form-fields";
import { EMAIL_PROVIDER_ID, LINK_SENT_PATH, signInAttemptAllowed } from "./sign-in-guard";
import { LINK_REQUEST_ANSWER } from "./sign-in-invitations";
import { availableSignInMethods, safeRedirectTarget } from "./sign-in-methods";

const SIGN_IN_PATH = "/sign-in";

/** A deliberately shallow check: the transport decides what it can deliver, and this is a form field. */
function looksLikeAnAddress(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length >= 3 && trimmed.length <= 320 && /^[^\s@]+@[^\s@.]+\.[^\s@]+$/u.test(trimmed);
}

/** Lands back on the sign-in page with a notice it knows how to render. */
function refuse(notice: string): never {
  redirect(`${SIGN_IN_PATH}?error=${notice}`);
}

export async function signInWithGoogleAction(callbackUrl: string | undefined): Promise<void> {
  const env = loadWebEnv();
  const methods = availableSignInMethods(env);
  if (!methods.available.includes("google") || methods.baseUrl === undefined) {
    // The page does not draw this control when the method is withheld; a constructed request still gets
    // an answer it can read rather than a provider error.
    refuse("Configuration");
  }
  const redirectTo = `${methods.baseUrl}${safeRedirectTarget(callbackUrl, methods.baseUrl)}`;
  try {
    await signIn("google", { redirectTo });
  } catch (error) {
    if (error instanceof AuthError) {
      refuse(error.type);
    }
    throw error;
  }
}

export async function requestSignInLinkAction(callbackUrl: string | undefined, formData: FormData): Promise<void> {
  const env = loadWebEnv();
  const methods = availableSignInMethods(env);
  if (!methods.available.includes("email") || methods.baseUrl === undefined) {
    refuse("Configuration");
  }

  const email = field(formData, "email").trim();
  if (!looksLikeAnAddress(email)) {
    refuse("EmailRequired");
  }

  // Before anything is looked up or sent. A refusal is answered exactly as a success is — the same page,
  // no distinguishing status or message — and the counter consults no table, so an address with an
  // account and one without are refused identically.
  const allowed = await signInAttemptAllowed({
    endpoint: "REQUEST_LINK",
    headers: await headers(),
    identifier: email,
    ...(env.AUTH_TRUSTED_CLIENT_IP_HEADER === undefined ? {} : { trustedClientIpHeader: env.AUTH_TRUSTED_CLIENT_IP_HEADER }),
  });
  if (!allowed) {
    redirect(LINK_SENT_PATH);
  }

  const redirectTo = `${methods.baseUrl}${safeRedirectTarget(callbackUrl, methods.baseUrl)}`;
  let answer: unknown;
  try {
    // `redirect: false`, so this action chooses where the browser lands rather than inheriting the
    // library's own `/api/auth/verify-request` URL. Two reasons, and neither is cosmetic. The refusal a
    // few lines up lands on `LINK_SENT_PATH`, so a success that landed anywhere else would be the one
    // difference a caller could measure between "sent" and "refused" — the property this file claims to
    // hold, undone by a URL. And an `/api/...` address in the bar is not where a person should be left
    // standing after asking for mail. Nothing is lost by taking the redirect into our own hands: the
    // library writes its cookies into the jar before returning either way.
    answer = await signIn(EMAIL_PROVIDER_ID, { email, redirectTo, redirect: false });
  } catch (error) {
    if (error instanceof AuthError) {
      refuse(error.type);
    }
    throw error;
  }
  if (typeof answer !== "string") {
    // The installed version hands back the URL it would have redirected to. Anything else means the
    // contract changed underneath this call, and the one answer that must not be given on a maybe is
    // "check your mail".
    refuse("Configuration");
  }
  // **Only a link that was actually answered as sent lands on the sent page.** When the transport fails,
  // this version does not throw — it hands back a URL carrying the error — and reporting "check your
  // mail" over a send that never happened is precisely the failure this deployment already had once.
  redirect(answeredAsLinkRequest(answer) ? LINK_SENT_PATH : `${methods.baseUrl}${safeRedirectTarget(answer, methods.baseUrl)}`);
}

/**
 * Whether the library answered this the way it answers a link request — sent, or refused by the
 * invitation gate, which are deliberately the same answer.
 *
 * Compared as a path with its query rather than as a whole URL, because the value comes back absolute
 * and the origin has already been decided by `AUTH_URL`.
 */
function answeredAsLinkRequest(answer: string): boolean {
  try {
    const parsed = new URL(answer);
    return `${parsed.pathname}${parsed.search}` === LINK_REQUEST_ANSWER;
  } catch {
    return false;
  }
}
