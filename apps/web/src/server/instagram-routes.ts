/**
 * HTTP transport for Instagram onboarding. The handlers are deliberately thin: they read route parameters,
 * carry the state cookie, and translate outcomes into responses. Every decision that matters lives in
 * `instagram-onboarding.ts`.
 *
 * Two transport rules are load-bearing:
 * - connect and disconnect are POST, so neither can be triggered by a cross-site link or image;
 * - the callback redirects to a fixed application URL and never reflects provider text, so nothing Meta
 *   sends can reach the browser as markup or as an open redirect.
 */
import {
  BusinessProfileAccessDeniedError,
  TenantRecordNotFoundError,
  WorkspaceAccessDeniedError,
  WorkspacePermissionError,
  type BusinessProfileContext,
} from "@omnichannel/db";
import type { Logger } from "@omnichannel/observability";

import {
  completeInstagramConnect,
  disconnectInstagramAccount,
  startInstagramConnect,
  STATE_COOKIE_NAME,
  type ConnectFailureReason,
  type DisconnectDependencies,
  type OnboardingDependencies,
} from "./instagram-onboarding";
import { UnauthenticatedError } from "./workspace-context";

export interface InstagramRouteDependencies {
  /**
   * `undefined` where this deployment has no Instagram app configured. Connecting then refuses before a
   * state row is written, rather than sending the operator to Meta with credentials Meta has never heard
   * of — which answers with Meta's own error page, carrying nothing of ours and no way back.
   */
  readonly onboarding: () => OnboardingDependencies | undefined;
  /** Detaching needs no app, so it is composed separately and keeps working without one. */
  readonly disconnect: () => DisconnectDependencies;
  readonly authorize: (workspaceId: string | undefined, businessProfileId: string | undefined) => Promise<BusinessProfileContext>;
  readonly logger: () => Logger;
  /** Where the browser lands after a callback; the outcome travels as a query parameter, never a message. */
  readonly connectedRedirectUrl: (result: { readonly workspaceId?: string; readonly businessProfileId?: string; readonly status: string }) => string;
}

export interface RouteParams {
  readonly params: Promise<Record<string, string | undefined>>;
}

export function createInstagramConnectHandler(dependencies: InstagramRouteDependencies) {
  return async function POST(_request: Request, context: RouteParams): Promise<Response> {
    const params = await context.params;
    try {
      const onboarding = dependencies.onboarding();
      if (onboarding === undefined) {
        // A redirect carrying a fixed token, not a `503` body. This is a real form submission, so whatever
        // comes back is what the operator reads; the page they came from already knows how to say this
        // one. Reachable when a tab was open while the credentials were removed, or by a hand-made POST —
        // the screens stop offering the control, which is where the honesty belongs.
        return notConfiguredRedirect(dependencies, params);
      }
      const businessProfile = await dependencies.authorize(params["workspaceId"], params["businessProfileId"]);
      const started = await startInstagramConnect(onboarding, businessProfile);
      // 303 so the browser follows with GET, and the cookie is set on the same response.
      return new Response(null, {
        status: 303,
        headers: {
          location: started.authorizeUrl,
          "set-cookie": stateCookie(started.cookieNonce, started.cookieMaxAgeSeconds),
          "cache-control": "no-store",
        },
      });
    } catch (error) {
      return errorResponse(error, dependencies.logger());
    }
  };
}

export function createInstagramCallbackHandler(dependencies: InstagramRouteDependencies) {
  return async function GET(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      const onboarding = dependencies.onboarding();
      if (onboarding === undefined) {
        // No app, so there is no exchange to attempt. The state row the flow needs cannot exist either,
        // because connecting refused; this covers the credentials being removed mid-flow.
        return notConfiguredRedirect(dependencies, {});
      }
      const result = await completeInstagramConnect(
        onboarding,
        {
          state: url.searchParams.get("state") ?? undefined,
          code: url.searchParams.get("code") ?? undefined,
          error: url.searchParams.get("error") ?? undefined,
          cookieNonce: readCookie(request.headers.get("cookie"), STATE_COOKIE_NAME),
        },
        // Re-authorization happens against the workspace the state row names, not anything in the URL.
        (workspaceId, businessProfileId) => dependencies.authorize(workspaceId, businessProfileId),
      );
      const location = result.ok
        ? dependencies.connectedRedirectUrl({ workspaceId: result.workspaceId, businessProfileId: result.businessProfileId, status: "connected" })
        : dependencies.connectedRedirectUrl({ status: failureStatus(result.reason) });
      return new Response(null, {
        status: 303,
        // The cookie is one-shot; clear it whatever happened.
        headers: { location, "set-cookie": clearedStateCookie(), "cache-control": "no-store" },
      });
    } catch (error) {
      if (isAuthorizationError(error)) {
        // Access revoked between starting the flow and returning from Meta.
        return new Response(null, {
          status: 303,
          headers: { location: dependencies.connectedRedirectUrl({ status: "error" }), "set-cookie": clearedStateCookie(), "cache-control": "no-store" },
        });
      }
      return errorResponse(error, dependencies.logger());
    }
  };
}

export function createInstagramDisconnectHandler(dependencies: InstagramRouteDependencies) {
  return async function POST(_request: Request, context: RouteParams): Promise<Response> {
    const params = await context.params;
    const channelAccountId = params["channelAccountId"];
    try {
      const businessProfile = await dependencies.authorize(params["workspaceId"], params["businessProfileId"]);
      if (channelAccountId === undefined) {
        return new Response(null, { status: 404 });
      }
      // `disconnect`, not `onboarding`: an account connected while this deployment had an Instagram app
      // must still be detachable after the app is gone, or removing the credentials would strand it.
      await disconnectInstagramAccount(dependencies.disconnect(), businessProfile, channelAccountId);
      return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    } catch (error) {
      return errorResponse(error, dependencies.logger());
    }
  };
}

/**
 * `__Host-` requires Secure and a path of `/` with no Domain, which is what makes the cookie unusable by a
 * sibling subdomain. SameSite=Lax is required: the callback is a top-level cross-site navigation from Meta.
 */
function stateCookie(nonce: string, maxAgeSeconds: number): string {
  return `${STATE_COOKIE_NAME}=${nonce}; Path=/; Max-Age=${String(maxAgeSeconds)}; HttpOnly; Secure; SameSite=Lax`;
}

function clearedStateCookie(): string {
  return `${STATE_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function readCookie(header: string | null, name: string): string | undefined {
  if (header === null) {
    return undefined;
  }
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator > 0 && part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return undefined;
}

/**
 * "This installation has no Instagram app", said the way every other outcome of this flow is said.
 *
 * The cookie is cleared unconditionally. There can be no legitimate flow in progress — connecting is what
 * sets the cookie and connecting is what refused — so the only cookie this can clear is a stale one.
 */
function notConfiguredRedirect(dependencies: InstagramRouteDependencies, params: Readonly<Record<string, string | undefined>>): Response {
  const location = dependencies.connectedRedirectUrl({
    ...(params["workspaceId"] === undefined ? {} : { workspaceId: params["workspaceId"] }),
    ...(params["businessProfileId"] === undefined ? {} : { businessProfileId: params["businessProfileId"] }),
    status: "not_configured",
  });
  return new Response(null, {
    status: 303,
    headers: { location, "set-cookie": clearedStateCookie(), "cache-control": "no-store" },
  });
}

/** Outcome vocabulary for the browser. Fixed tokens only: provider text never reaches a URL or a page. */
function failureStatus(reason: ConnectFailureReason): string {
  switch (reason) {
    case "denied":
      return "denied";
    case "missing_scope":
      return "missing_scope";
    case "already_connected":
      return "already_connected";
    case "different_account":
      return "different_account";
    case "not_entitled":
      return "not_entitled";
    case "provider_unavailable":
      return "unavailable";
    case "invalid_state":
    case "provider_rejected":
      return "error";
  }
}

function isAuthorizationError(error: unknown): boolean {
  return (
    error instanceof UnauthenticatedError ||
    error instanceof WorkspaceAccessDeniedError ||
    error instanceof BusinessProfileAccessDeniedError ||
    error instanceof WorkspacePermissionError
  );
}

function errorResponse(error: unknown, logger: Logger): Response {
  if (error instanceof UnauthenticatedError) {
    return new Response(null, { status: 401 });
  }
  if (error instanceof WorkspacePermissionError) {
    return new Response(null, { status: 403 });
  }
  if (
    error instanceof WorkspaceAccessDeniedError ||
    error instanceof BusinessProfileAccessDeniedError ||
    error instanceof TenantRecordNotFoundError
  ) {
    // Not found rather than forbidden: whether a Workspace or account exists is itself information.
    return new Response(null, { status: 404 });
  }
  logger.error("instagram.route_failed", { errorName: error instanceof Error ? error.name : typeof error });
  return new Response(null, { status: 500 });
}
