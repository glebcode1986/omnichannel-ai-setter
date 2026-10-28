/**
 * Auth.js's own endpoint, behind the sign-in rate limit (#117).
 *
 * This used to be a bare `export const { GET, POST } = handlers`, and it is wrapped now for a structural
 * reason rather than a stylistic one: this app has no middleware, so there is no other point at which a
 * limit can be applied to the email sign-in and verification endpoints. The guard decides whether this
 * request is subject to a limit at all — the Google endpoints are not — and the handler is called
 * unchanged when it is not refused.
 *
 * The request body is read by `request.clone()` inside the guard, so the handler still receives its own.
 */
import type { NextRequest } from "next/server";

import { handlers } from "../../../../auth";
import { loadWebEnv } from "../../../../env";
import { guardSignInRequest } from "../../../../server/sign-in-guard";

async function guarded(request: NextRequest, handle: (request: NextRequest) => Promise<Response>): Promise<Response> {
  const env = loadWebEnv();
  const { refusal } = await guardSignInRequest(request, {
    trustedClientIpHeader: env.AUTH_TRUSTED_CLIENT_IP_HEADER,
    origin: env.AUTH_URL ?? new URL(request.url).origin,
  });
  return refusal ?? (await handle(request));
}

export async function GET(request: NextRequest): Promise<Response> {
  return guarded(request, handlers.GET);
}

export async function POST(request: NextRequest): Promise<Response> {
  return guarded(request, handlers.POST);
}
