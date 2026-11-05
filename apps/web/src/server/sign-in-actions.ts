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
  try {
    await signIn(EMAIL_PROVIDER_ID, { email, redirectTo });
  } catch (error) {
    if (error instanceof AuthError) {
      refuse(error.type);
    }
    throw error;
  }
}
