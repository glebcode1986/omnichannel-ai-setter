/**
 * HTTP transport for WhatsApp onboarding (Issue #19).
 *
 * The handlers are deliberately thin: they read route parameters, carry the state cookie, and translate
 * outcomes into responses. Every decision that matters lives in `whatsapp-onboarding.ts`.
 *
 * Three transport rules are load-bearing, and the first is the one that differs from Instagram.
 *
 * **There is no provider callback.** Embedded Signup hands its result to *our own* page through the
 * Facebook JavaScript SDK, so completion is a same-origin POST carrying JSON rather than a cross-site
 * redirect. That makes the state cookie `SameSite=Strict` — nothing legitimate posts here from another
 * site — and it means nothing Meta sends ever reaches the browser as markup or as a redirect target,
 * because the browser never leaves our origin.
 *
 * **Every handler is POST**, so none can be triggered by a cross-site link or image.
 *
 * **The response is a fixed outcome token and nothing else.** No provider prose, no identifiers beyond the
 * account that was connected, and never the code, the token or the PIN.
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
  completeWhatsAppConnect,
  disconnectWhatsAppAccount,
  startWhatsAppConnect,
  STATE_COOKIE_NAME,
  type ConnectFailureReason,
  type WhatsAppOnboardingDependencies,
} from "./whatsapp-onboarding";
import { UnauthenticatedError } from "./workspace-context";

export interface WhatsAppRouteDependencies {
  /** `undefined` when this deployment has no WhatsApp app configured. */
  readonly onboarding: () => WhatsAppOnboardingDependencies | undefined;
  readonly authorize: (workspaceId: string | undefined, businessProfileId: string | undefined) => Promise<BusinessProfileContext>;
  readonly logger: () => Logger;
}

export interface RouteParams {
  readonly params: Promise<Record<string, string | undefined>>;
}

/** The body the completion endpoint accepts. Everything in it is untrusted. */
interface CompletionBody {
  readonly state?: unknown;
  readonly code?: unknown;
  readonly notice?: unknown;
  readonly pin?: unknown;
}

export function createWhatsAppConnectHandler(dependencies: WhatsAppRouteDependencies) {
  return async function POST(_request: Request, context: RouteParams): Promise<Response> {
    const params = await context.params;
    try {
      const onboarding = dependencies.onboarding();
      if (onboarding === undefined) {
        // Refused before a state row is written: walking somebody through Meta's whole flow and failing at
        // the exchange would leave real assets on their account for a connection we can never finish.
        return json(503, { status: "not_configured" });
      }
      const businessProfile = await dependencies.authorize(params["workspaceId"], params["businessProfileId"]);
      const started = await startWhatsAppConnect(onboarding, businessProfile);
      return json(
        200,
        { status: "started", state: started.stateId, launch: started.launch },
        { "set-cookie": stateCookie(started.cookieNonce, started.cookieMaxAgeSeconds) },
      );
    } catch (error) {
      return errorResponse(error, dependencies.logger(), "whatsapp.connect_route_failed");
    }
  };
}

export function createWhatsAppCompleteHandler(dependencies: WhatsAppRouteDependencies) {
  return async function POST(request: Request, context: RouteParams): Promise<Response> {
    const params = await context.params;
    try {
      const onboarding = dependencies.onboarding();
      if (onboarding === undefined) {
        return json(503, { status: "not_configured" });
      }
      // Authorized here as well as from the state row: a request with no usable state must not be able to
      // learn whether a Business Profile exists by the shape of its refusal.
      await dependencies.authorize(params["workspaceId"], params["businessProfileId"]);
      const body = await readBody(request);
      const result = await completeWhatsAppConnect(
        onboarding,
        {
          state: stringOf(body.state),
          code: stringOf(body.code),
          notice: body.notice,
          pin: stringOf(body.pin),
          cookieNonce: readCookie(request.headers.get("cookie"), STATE_COOKIE_NAME),
        },
        // Re-authorization happens against the Workspace the state row names, never anything in the body.
        (workspaceId, businessProfileId) => dependencies.authorize(workspaceId, businessProfileId),
      );
      const headers = { "set-cookie": clearedStateCookie() };
      if (!result.ok) {
        return json(400, { status: failureStatus(result.reason) }, headers);
      }
      return json(
        200,
        {
          status: "connected",
          channelAccountId: result.channelAccountId,
          mode: result.mode,
          // So the screen can say the catalogue is unknown instead of implying it is empty.
          templatesUnsynced: result.templatesUnsynced,
        },
        headers,
      );
    } catch (error) {
      return errorResponse(error, dependencies.logger(), "whatsapp.complete_route_failed", clearedStateCookie());
    }
  };
}

export function createWhatsAppDisconnectHandler(dependencies: WhatsAppRouteDependencies) {
  return async function POST(_request: Request, context: RouteParams): Promise<Response> {
    const params = await context.params;
    const channelAccountId = params["channelAccountId"];
    try {
      const onboarding = dependencies.onboarding();
      if (onboarding === undefined) {
        return json(503, { status: "not_configured" });
      }
      const businessProfile = await dependencies.authorize(params["workspaceId"], params["businessProfileId"]);
      if (channelAccountId === undefined) {
        return new Response(null, { status: 404 });
      }
      const result = await disconnectWhatsAppAccount(onboarding, businessProfile, channelAccountId);
      if (!result.ok) {
        return new Response(null, { status: 404 });
      }
      // 200 rather than 204: whether Meta's own subscription was removed is something an operator may
      // need to finish by hand, so it cannot be a body-less success.
      return json(200, { status: "disconnected", unsubscribed: result.unsubscribed });
    } catch (error) {
      return errorResponse(error, dependencies.logger(), "whatsapp.disconnect_route_failed");
    }
  };
}

function json(status: number, body: Readonly<Record<string, unknown>>, headers: Readonly<Record<string, string>> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

async function readBody(request: Request): Promise<CompletionBody> {
  try {
    const parsed: unknown = await request.json();
    // Every field is read through a guard below, so an object of unknown shape is enough here.
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    // An unreadable body is an unreadable state, which the flow refuses. Nothing is guessed at.
    return {};
  }
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * `__Host-` requires Secure and a path of `/` with no Domain, which is what makes the cookie unusable by a
 * sibling subdomain. `SameSite=Strict` is right here and wrong for Instagram: the WhatsApp flow never
 * leaves our origin, so there is no legitimate cross-site navigation that needs the cookie sent.
 */
function stateCookie(nonce: string, maxAgeSeconds: number): string {
  return `${STATE_COOKIE_NAME}=${nonce}; Path=/; Max-Age=${String(maxAgeSeconds)}; HttpOnly; Secure; SameSite=Strict`;
}

function clearedStateCookie(): string {
  return `${STATE_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
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
export function failureStatus(reason: ConnectFailureReason): string {
  switch (reason) {
    case "cancelled":
      return "cancelled";
    case "denied":
      return "denied";
    case "no_phone_number":
      return "no_phone_number";
    case "missing_scope":
      return "missing_scope";
    case "asset_mismatch":
      return "asset_mismatch";
    case "invalid_pin":
      return "invalid_pin";
    case "subscription_failed":
      return "subscription_failed";
    case "registration_failed":
      return "registration_failed";
    case "already_connected":
      return "already_connected";
    case "different_account":
      return "different_account";
    case "not_entitled":
      return "not_entitled";
    case "provider_unavailable":
      return "unavailable";
    case "invalid_state":
    case "wrong_app":
    case "provider_rejected":
      // All three are "something is wrong with this attempt, and telling you which would tell an attacker
      // too": a forged state, a token minted for another app, and a provider refusal we cannot explain.
      return "error";
  }
}

function errorResponse(error: unknown, logger: Logger, event: string, clearCookie?: string): Response {
  const headers: Record<string, string> = clearCookie === undefined ? {} : { "set-cookie": clearCookie };
  if (error instanceof UnauthenticatedError) {
    return new Response(null, { status: 401, headers });
  }
  if (error instanceof WorkspacePermissionError) {
    // Only an OWNER or an authorized ADMIN may connect or disconnect a channel; the store enforces it and
    // this is where that refusal becomes a status code.
    return new Response(null, { status: 403, headers });
  }
  if (error instanceof WorkspaceAccessDeniedError || error instanceof BusinessProfileAccessDeniedError || error instanceof TenantRecordNotFoundError) {
    // Not found rather than forbidden: whether a Workspace or account exists is itself information.
    return new Response(null, { status: 404, headers });
  }
  logger.error(event, { errorName: error instanceof Error ? error.name : typeof error });
  return new Response(null, { status: 500, headers });
}
