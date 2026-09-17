/**
 * Instagram Login (business login) OAuth and token lifecycle.
 *
 * This module speaks Meta's protocol and nothing else: it holds no state, reads no environment, touches no
 * database and never logs. Callers inject the HTTP port, so tests never reach the network.
 *
 * Verified against Meta's documentation on 2026-09-17; see docs/research/META_INSTAGRAM_PHASE2_VERIFICATION.md.
 * Three hosts are involved (authorize / token exchange / graph), the exchange response is wrapped in a
 * `data` array, and the token endpoint reports errors in a different envelope from every other endpoint.
 */
import {
  DEFAULT_GRAPH_HOST,
  DEFAULT_GRAPH_VERSION,
  DEFAULT_OAUTH_AUTHORIZE_HOST,
  DEFAULT_OAUTH_TOKEN_HOST,
} from "./config";
import { formatErrorCode, parseTokenEndpointError } from "./errors";
import type { InstagramHttpPort, InstagramHttpResult } from "./http";

/** Least privilege: read the account and handle messages. Publishing and comments are not requested. */
export const INSTAGRAM_MESSAGING_SCOPES = ["instagram_business_basic", "instagram_business_manage_messages"] as const;

/** A long-lived token may be refreshed only while it is at least this old… */
export const MIN_REFRESH_AGE_MS = 24 * 60 * 60 * 1000;
/** …and not yet expired. Past expiry the only recovery is a fresh login. */
export const LONG_LIVED_TOKEN_TTL_MS = 60 * 24 * 60 * 60 * 1000;

const OAUTH_TIMEOUT_MS = 10_000;

export interface InstagramOAuthConfig {
  readonly appId: string;
  readonly appSecret: string;
  /** Exactly the URI registered with Meta. Never derived from an incoming request. */
  readonly redirectUri: string;
  readonly http: InstagramHttpPort;
  readonly scopes?: readonly string[];
  readonly authorizeHost?: string;
  readonly tokenHost?: string;
  readonly graphHost?: string;
  readonly graphVersion?: string;
}

/**
 * Why a step failed, in fixed vocabulary. Provider prose never travels with it: Meta's messages can quote
 * the request and end up in a log or a browser.
 */
export type OAuthFailureReason =
  | "provider_rejected"
  | "invalid_response"
  | "unavailable"
  | "missing_scope"
  | "not_professional_account";

export type OAuthResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: OAuthFailureReason; readonly code?: string };

export interface ExchangedCode {
  readonly accessToken: string;
  /** Instagram professional account ID (the `<IG_ID>` used by the messaging API). */
  readonly userId: string;
  /** Scopes the person actually granted; they may deselect some and still return a valid code. */
  readonly grantedScopes: readonly string[];
}

export interface LongLivedToken {
  readonly accessToken: string;
  readonly expiresInSeconds: number;
}

export interface InstagramIdentity {
  /** App-scoped ID. Not the messaging ID; storing this instead of `userId` breaks every send. */
  readonly appScopedId: string;
  readonly userId: string;
  readonly username?: string;
  readonly name?: string;
  /** Raw provider value, kept for audit; the login path itself admits only professional accounts. */
  readonly accountType?: string;
}

export function buildAuthorizeUrl(config: InstagramOAuthConfig, state: string): string {
  const url = new URL(`https://${config.authorizeHost ?? DEFAULT_OAUTH_AUTHORIZE_HOST}/oauth/authorize`);
  url.searchParams.set("client_id", config.appId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", (config.scopes ?? INSTAGRAM_MESSAGING_SCOPES).join(","));
  url.searchParams.set("state", state);
  // Without this, an operator already logged into Instagram in this browser is bound silently to whatever
  // account that session holds — which is how the wrong account ends up connected to a workspace.
  url.searchParams.set("force_reauth", "true");
  return url.toString();
}

/** Meta appends `#_` to the redirect; it is not part of the code and the exchange fails if it is sent. */
export function normalizeAuthorizationCode(code: string): string {
  return code.endsWith("#_") ? code.slice(0, -2) : code;
}

export async function exchangeCode(config: InstagramOAuthConfig, code: string): Promise<OAuthResult<ExchangedCode>> {
  const body = new URLSearchParams({
    client_id: config.appId,
    client_secret: config.appSecret,
    grant_type: "authorization_code",
    redirect_uri: config.redirectUri,
    code: normalizeAuthorizationCode(code),
  });
  const result = await config.http.send({
    url: `https://${config.tokenHost ?? DEFAULT_OAUTH_TOKEN_HOST}/oauth/access_token`,
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    timeoutMs: OAUTH_TIMEOUT_MS,
  });
  const payload = readJson(result);
  if (!payload.ok) {
    return payload.failure;
  }
  // The success body is `{"data": [{...}]}`; reading it as a flat object yields undefined everywhere.
  const entry = firstDataEntry(payload.value);
  const accessToken = stringField(entry, "access_token");
  const userId = stringField(entry, "user_id") ?? numberFieldAsString(entry, "user_id");
  if (accessToken === undefined || userId === undefined) {
    return { ok: false, reason: "invalid_response" };
  }
  const permissions = stringField(entry, "permissions") ?? "";
  return {
    ok: true,
    value: {
      accessToken,
      userId,
      grantedScopes: permissions
        .split(",")
        .map((scope) => scope.trim())
        .filter((scope) => scope.length > 0),
    },
  };
}

export async function exchangeForLongLivedToken(
  config: InstagramOAuthConfig,
  shortLivedToken: string,
): Promise<OAuthResult<LongLivedToken>> {
  const url = new URL(`https://${config.graphHost ?? DEFAULT_GRAPH_HOST}/access_token`);
  url.searchParams.set("grant_type", "ig_exchange_token");
  url.searchParams.set("client_secret", config.appSecret);
  url.searchParams.set("access_token", shortLivedToken);
  return readToken(await config.http.send({ url: url.toString(), method: "GET", headers: {}, timeoutMs: OAUTH_TIMEOUT_MS }));
}

export async function refreshLongLivedToken(config: InstagramOAuthConfig, longLivedToken: string): Promise<OAuthResult<LongLivedToken>> {
  const url = new URL(`https://${config.graphHost ?? DEFAULT_GRAPH_HOST}/refresh_access_token`);
  url.searchParams.set("grant_type", "ig_refresh_token");
  url.searchParams.set("access_token", longLivedToken);
  return readToken(await config.http.send({ url: url.toString(), method: "GET", headers: {}, timeoutMs: OAUTH_TIMEOUT_MS }));
}

export async function fetchIdentity(config: InstagramOAuthConfig, accessToken: string): Promise<OAuthResult<InstagramIdentity>> {
  const url = new URL(`https://${config.graphHost ?? DEFAULT_GRAPH_HOST}/${config.graphVersion ?? DEFAULT_GRAPH_VERSION}/me`);
  url.searchParams.set("fields", "id,user_id,username,name,account_type");
  url.searchParams.set("access_token", accessToken);
  const payload = readJson(await config.http.send({ url: url.toString(), method: "GET", headers: {}, timeoutMs: OAUTH_TIMEOUT_MS }));
  if (!payload.ok) {
    return payload.failure;
  }
  const appScopedId = stringField(payload.value, "id") ?? numberFieldAsString(payload.value, "id");
  const userId = stringField(payload.value, "user_id") ?? numberFieldAsString(payload.value, "user_id");
  if (appScopedId === undefined || userId === undefined) {
    return { ok: false, reason: "invalid_response" };
  }
  const username = stringField(payload.value, "username");
  const name = stringField(payload.value, "name");
  const accountType = stringField(payload.value, "account_type");
  return {
    ok: true,
    value: {
      appScopedId,
      userId,
      ...(username === undefined ? {} : { username }),
      ...(name === undefined ? {} : { name }),
      ...(accountType === undefined ? {} : { accountType }),
    },
  };
}

/** True while Meta would accept a refresh: the token is at least a day old and has not expired. */
export function isRefreshEligible(mintedAt: Date, expiresAt: Date, now: Date): boolean {
  return now.getTime() - mintedAt.getTime() >= MIN_REFRESH_AGE_MS && expiresAt.getTime() > now.getTime();
}

/** Scopes the product cannot work without; a person may grant fewer than we asked for. */
export function missingScopes(granted: readonly string[], required: readonly string[] = INSTAGRAM_MESSAGING_SCOPES): readonly string[] {
  return required.filter((scope) => !granted.includes(scope));
}

function readToken(result: InstagramHttpResult): OAuthResult<LongLivedToken> {
  const payload = readJson(result);
  if (!payload.ok) {
    return payload.failure;
  }
  const accessToken = stringField(payload.value, "access_token");
  const expiresIn = payload.value["expires_in"];
  if (accessToken === undefined || typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    return { ok: false, reason: "invalid_response" };
  }
  return { ok: true, value: { accessToken, expiresInSeconds: Math.trunc(expiresIn) } };
}

type JsonObject = Readonly<Record<string, unknown>>;

function readJson(result: InstagramHttpResult): { ok: true; value: JsonObject } | { ok: false; failure: OAuthResult<never> } {
  if (result.kind === "NO_RESPONSE") {
    // Nothing was created by a failed read: unlike a send, retrying a token call is safe.
    return { ok: false, failure: { ok: false, reason: "unavailable" } };
  }
  const parsed = safeJsonObject(result.body);
  if (result.status < 200 || result.status >= 300) {
    const error = parseTokenEndpointError(result.body);
    const code = error === undefined ? `HTTP_${String(result.status)}` : (formatErrorCode(error) ?? `HTTP_${String(result.status)}`);
    return { ok: false, failure: { ok: false, reason: "provider_rejected", code } };
  }
  return parsed === undefined ? { ok: false, failure: { ok: false, reason: "invalid_response" } } : { ok: true, value: parsed };
}

function firstDataEntry(payload: JsonObject): JsonObject {
  const data = payload["data"];
  if (Array.isArray(data)) {
    const entry: unknown = data[0];
    return isJsonObject(entry) ? entry : {};
  }
  // Deliberately not falling back to the flat body: a shape we do not recognize is an invalid response,
  // not something to guess at.
  return {};
}

function safeJsonObject(body: string): JsonObject | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    return isJsonObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(payload: JsonObject, field: string): string | undefined {
  const value = payload[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberFieldAsString(payload: JsonObject, field: string): string | undefined {
  const value = payload[field];
  return typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;
}
