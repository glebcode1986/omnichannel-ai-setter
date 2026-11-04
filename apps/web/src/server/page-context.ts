/**
 * The page-render flavour of the request resolvers: the same authorization, a different ending.
 *
 * An unauthenticated request used to reach `UnauthenticatedError` and stop there. For an API route that is
 * exactly right — `instagram-routes.ts` maps it to `401` — but a *page* has no one to tell: this app has
 * no middleware by design (`a11y/route-authorization.test.ts` states that and builds its gate on it), and
 * no `error.tsx` sits above the product shell, so the throw reached Next and became an HTTP 500. The
 * sign-in page existed the whole time and nobody was ever sent to it. An invited tester's first click into
 * the product returned a server error.
 *
 * So the fix belongs here rather than in `request-context.ts`: the throw is load-bearing for the callers
 * that answer with a status code, and a redirect would be swallowed by the `catch` blocks that map it.
 * `redirect()` works by throwing too, which is the trap — one broad `catch` around a resolver turns a
 * redirect into a 500. The wrapper below therefore calls `redirect()` *inside the catch*, never inside the
 * try, and rethrows anything that is not an `UnauthenticatedError` untouched.
 *
 * **This authorizes nothing new.** Each export delegates to the resolver of the same name in
 * `request-context.ts` and adds no capability; `route-authorization.test.ts` asserts that delegation by
 * AST, so a page wrapper cannot become a way to serve a page that authorizes no tenant.
 *
 * Authorization failures are deliberately *not* redirected. Somebody signed in who may not read this
 * Workspace is not helped by a sign-in page — they are already signed in — and bouncing them there would
 * turn a clear "not yours" into a loop.
 */
import { redirect } from "next/navigation";
import type { BusinessProfileContext, PlatformContext, WorkspaceContext } from "@omnichannel/db";

import {
  requireBusinessProfileContext,
  requirePlatformContext,
  requireSessionUserId,
  requireWorkspaceContext,
} from "./request-context";
import { UnauthenticatedError } from "./workspace-context";

/**
 * Where an unauthenticated page request goes.
 *
 * No `callbackUrl`, deliberately. The sign-in page accepts one, but a React Server Component has no
 * reliable way to learn the path it is rendering for without middleware, and this app has none. A guessed
 * or reconstructed path would be a plausible-looking lie in a URL that decides where somebody lands after
 * authenticating, so the honest version is to send them to sign-in and let them navigate.
 */
const SIGN_IN_PATH = "/sign-in";

async function orSignIn<T>(resolve: () => Promise<T>): Promise<T> {
  try {
    return await resolve();
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      // Inside the catch, never inside the try: `redirect` signals by throwing, and a redirect thrown
      // within the guarded block would be caught by this very handler.
      redirect(SIGN_IN_PATH);
    }
    throw error;
  }
}

/** The authenticated user id for a page render; an unauthenticated visitor is sent to sign in. */
export function pageSessionUserId(): Promise<string> {
  return orSignIn(() => requireSessionUserId());
}

/** Workspace context for a page render; an unauthenticated visitor is sent to sign in. */
export function pageWorkspaceContext(workspaceId: string | undefined): Promise<WorkspaceContext> {
  return orSignIn(() => requireWorkspaceContext(workspaceId));
}

/** Business Profile context for a page render; an unauthenticated visitor is sent to sign in. */
export function pageBusinessProfileContext(
  workspaceId: string | undefined,
  businessProfileId: string | undefined,
): Promise<BusinessProfileContext> {
  return orSignIn(() => requireBusinessProfileContext(workspaceId, businessProfileId));
}

/** Platform context for a page render in the internal console; an unauthenticated visitor is sent to sign in. */
export function pagePlatformContext(): Promise<PlatformContext> {
  return orSignIn(() => requirePlatformContext());
}
