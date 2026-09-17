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
import { BusinessProfileAccessDeniedError, WorkspaceAccessDeniedError, WorkspacePermissionError, type BusinessProfileContext } from "@omnichannel/db";
import type { Logger } from "@omnichannel/observability";

import {
  completeInstagramConnect,
  disconnectInstagramAccount,
  startInstagramConnect,
  STATE_COOKIE_NAME,
  type ConnectFailureReason,
  type OnboardingDependencies,
} from "./instagram-onboarding";
import { UnauthenticatedError } from "./workspace-context";

export interface InstagramRouteDependencies {
  readonly onboarding: () => OnboardingDependencies;
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
      const businessProfile = await dependencies.authorize(params["workspaceId"], params["businessProfileId"]);
      const started = await startInstagramConnect(dependencies.onboarding(), businessProfile);
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
      const result = await completeInstagramConnect(
        dependencies.onboarding(),
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
      await disconnectInstagramAccount(dependencies.onboarding(), businessProfile, channelAccountId);
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
  if (error instanceof WorkspaceAccessDeniedError || error instanceof BusinessProfileAccessDeniedError) {
    // Not found rather than forbidden: whether a Workspace exists is itself information.
    return new Response(null, { status: 404 });
  }
  logger.error("instagram.route_failed", { errorName: error instanceof Error ? error.name : typeof error });
  return new Response(null, { status: 500 });
}
