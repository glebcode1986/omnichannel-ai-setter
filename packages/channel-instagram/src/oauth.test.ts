import { describe, expect, it } from "vitest";

import {
  buildAuthorizeUrl,
  exchangeCode,
  exchangeForLongLivedToken,
  fetchIdentity,
  INSTAGRAM_MESSAGING_SCOPES,
  isRefreshEligible,
  missingScopes,
  normalizeAuthorizationCode,
  refreshLongLivedToken,
  type InstagramOAuthConfig,
} from "./oauth";
import { jsonResponse, scriptedHttp } from "./__fixtures__/payloads";

const APP_SECRET = "test-app-secret";
const SHORT_LIVED = "IGQVJshort-lived-token";
const LONG_LIVED = "IGQVJlong-lived-token";

const config = (http: InstagramOAuthConfig["http"]): InstagramOAuthConfig => ({
  appId: "1234567890",
  appSecret: APP_SECRET,
  redirectUri: "https://app.example.test/api/channels/instagram/callback",
  http,
});

describe("authorize url", () => {
  it("sends the person to instagram.com with least-privilege scopes and forced re-authentication", () => {
    const url = new URL(buildAuthorizeUrl(config(scriptedHttp([]).port), "state_1"));

    expect(url.origin).toBe("https://www.instagram.com");
    expect(url.pathname).toBe("/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "1234567890",
      redirect_uri: "https://app.example.test/api/channels/instagram/callback",
      response_type: "code",
      scope: "instagram_business_basic,instagram_business_manage_messages",
      state: "state_1",
      // Without this, a browser already logged into Instagram binds whatever account it holds.
      force_reauth: "true",
    });
    // The app secret has no business in a URL the person's browser follows.
    expect(url.toString()).not.toContain(APP_SECRET);
  });
});

describe("code exchange", () => {
  const success = jsonResponse(200, { data: [{ access_token: SHORT_LIVED, user_id: "17841400000000001", permissions: "instagram_business_basic,instagram_business_manage_messages" }] });

  it("posts form-encoded credentials and unwraps the data envelope", async () => {
    const http = scriptedHttp([success]);
    const result = await exchangeCode(config(http.port), "AQD-code");

    expect(result).toEqual({
      ok: true,
      value: { accessToken: SHORT_LIVED, userId: "17841400000000001", grantedScopes: ["instagram_business_basic", "instagram_business_manage_messages"] },
    });
    const request = http.requests[0];
    expect(request?.url).toBe("https://api.instagram.com/oauth/access_token");
    expect(request?.method).toBe("POST");
    expect(Object.fromEntries(new URLSearchParams(request?.body ?? ""))).toEqual({
      client_id: "1234567890",
      client_secret: APP_SECRET,
      grant_type: "authorization_code",
      redirect_uri: "https://app.example.test/api/channels/instagram/callback",
      code: "AQD-code",
    });
    // The secret goes in the body, never in the URL, where proxies and logs would capture it.
    expect(request?.url).not.toContain(APP_SECRET);
  });

  it("strips the `#_` fragment Meta appends to the redirect", async () => {
    const http = scriptedHttp([success]);
    await exchangeCode(config(http.port), "AQD-code#_");

    expect(new URLSearchParams(http.requests[0]?.body ?? "").get("code")).toBe("AQD-code");
    expect(normalizeAuthorizationCode("AQD-code")).toBe("AQD-code");
  });

  it("refuses a flat body instead of silently reading undefined fields", async () => {
    const flat = await exchangeCode(config(scriptedHttp([jsonResponse(200, { access_token: SHORT_LIVED, user_id: "1" })]).port), "c");
    const empty = await exchangeCode(config(scriptedHttp([jsonResponse(200, { data: [] })]).port), "c");

    expect(flat).toEqual({ ok: false, reason: "invalid_response" });
    expect(empty).toEqual({ ok: false, reason: "invalid_response" });
  });

  it("classifies the token endpoint's flat error envelope without leaking its message", async () => {
    const rejected = await exchangeCode(
      config(scriptedHttp([jsonResponse(400, { error_type: "OAuthException", code: 400, error_message: "Matching code was not found or was already used" })]).port),
      "used-code",
    );

    expect(rejected).toEqual({ ok: false, reason: "provider_rejected", code: "400" });
    expect(JSON.stringify(rejected)).not.toContain("Matching code");
  });

  it("separates a provider that refused us from one that is merely failing", async () => {
    const refused = await exchangeCode(config(scriptedHttp([jsonResponse(400, { error_type: "OAuthException", code: 400, error_message: "bad code" })]).port), "c");
    const throttled = await exchangeCode(config(scriptedHttp([jsonResponse(429, { error: { code: 4, message: "rate limited" } })]).port), "c");
    const broken = await exchangeCode(config(scriptedHttp([jsonResponse(500, { error: { code: 2, is_transient: true } })]).port), "c");

    expect(refused).toMatchObject({ ok: false, reason: "provider_rejected" });
    // 5xx and throttling say nothing about the credential, so they must not read as a rejection.
    expect(throttled).toMatchObject({ ok: false, reason: "unavailable" });
    expect(broken).toMatchObject({ ok: false, reason: "unavailable" });
  });

  it("refuses a numeric account id that cannot survive JSON, instead of persisting a wrong one", async () => {
    // Real Instagram IDs are 17 digits; unquoted, they lose precision before we ever see them.
    const unsafe = await exchangeCode(
      config(scriptedHttp([{ kind: "RESPONSE", status: 200, body: '{"data":[{"access_token":"t","user_id":17841400000000001,"permissions":"instagram_business_basic"}]}' }]).port),
      "c",
    );

    expect(unsafe).toEqual({ ok: false, reason: "invalid_response" });
  });

  it("reports a transport failure as unavailable rather than a rejection", async () => {
    const result = await exchangeCode(config(scriptedHttp([{ kind: "NO_RESPONSE", reason: "TIMEOUT", message: "timed out" }]).port), "c");

    // Nothing was created, so unlike a send this may simply be tried again.
    expect(result).toEqual({ ok: false, reason: "unavailable" });
  });
});

describe("long-lived tokens", () => {
  it("exchanges and refreshes on the graph host with the documented grant types", async () => {
    const exchangeHttp = scriptedHttp([jsonResponse(200, { access_token: LONG_LIVED, token_type: "bearer", expires_in: 5_184_000 })]);
    const refreshHttp = scriptedHttp([jsonResponse(200, { access_token: "refreshed", token_type: "bearer", expires_in: 5_184_000 })]);

    expect(await exchangeForLongLivedToken(config(exchangeHttp.port), SHORT_LIVED)).toEqual({
      ok: true,
      value: { accessToken: LONG_LIVED, expiresInSeconds: 5_184_000 },
    });
    expect(await refreshLongLivedToken(config(refreshHttp.port), LONG_LIVED)).toEqual({
      ok: true,
      value: { accessToken: "refreshed", expiresInSeconds: 5_184_000 },
    });

    const exchangeUrl = new URL(exchangeHttp.requests[0]?.url ?? "");
    expect(exchangeUrl.origin + exchangeUrl.pathname).toBe("https://graph.instagram.com/access_token");
    expect(exchangeUrl.searchParams.get("grant_type")).toBe("ig_exchange_token");
    const refreshUrl = new URL(refreshHttp.requests[0]?.url ?? "");
    expect(refreshUrl.origin + refreshUrl.pathname).toBe("https://graph.instagram.com/refresh_access_token");
    expect(refreshUrl.searchParams.get("grant_type")).toBe("ig_refresh_token");
    // Meta's refresh call takes no app secret; sending one would widen its exposure for nothing.
    expect(refreshUrl.toString()).not.toContain(APP_SECRET);
  });

  it("rejects a token response without a usable lifetime", async () => {
    const noExpiry = await exchangeForLongLivedToken(config(scriptedHttp([jsonResponse(200, { access_token: LONG_LIVED })]).port), SHORT_LIVED);
    const zero = await exchangeForLongLivedToken(config(scriptedHttp([jsonResponse(200, { access_token: LONG_LIVED, expires_in: 0 })]).port), SHORT_LIVED);

    expect(noExpiry).toEqual({ ok: false, reason: "invalid_response" });
    expect(zero).toEqual({ ok: false, reason: "invalid_response" });
  });

  it("knows when Meta would accept a refresh", () => {
    const now = new Date("2026-09-17T12:00:00.000Z");
    const day = 24 * 60 * 60 * 1000;
    const expires = new Date(now.getTime() + 30 * day);

    expect(isRefreshEligible(new Date(now.getTime() - 2 * day), expires, now)).toBe(true);
    // Just minted: Meta requires the token to be at least 24 hours old, so a reconnect must not refresh.
    expect(isRefreshEligible(new Date(now.getTime() - 60_000), expires, now)).toBe(false);
    // Past the 60-day cliff there is no refresh, only a new login.
    expect(isRefreshEligible(new Date(now.getTime() - 90 * day), new Date(now.getTime() - day), now)).toBe(false);
  });
});

describe("identity and scopes", () => {
  it("reads the messaging account ID, not the app-scoped ID", async () => {
    const http = scriptedHttp([
      jsonResponse(200, { id: "9999999999", user_id: "17841400000000001", username: "studio", name: "Studio", account_type: "BUSINESS" }),
    ]);

    const identity = await fetchIdentity(config(http.port), LONG_LIVED);

    expect(identity).toEqual({
      ok: true,
      value: { appScopedId: "9999999999", userId: "17841400000000001", username: "studio", name: "Studio", accountType: "BUSINESS" },
    });
    expect(new URL(http.requests[0]?.url ?? "").pathname).toBe("/v26.0/me");
  });

  it("accepts numeric ids and refuses a response missing the messaging id", async () => {
    const numeric = await fetchIdentity(config(scriptedHttp([jsonResponse(200, { id: 9_999_999_999, user_id: 1_784_140_000_001 })]).port), LONG_LIVED);
    const missing = await fetchIdentity(config(scriptedHttp([jsonResponse(200, { id: "9999999999", username: "studio" })]).port), LONG_LIVED);

    expect(numeric.ok).toBe(true);
    expect(missing).toEqual({ ok: false, reason: "invalid_response" });
  });

  it("names the scopes a person declined", () => {
    expect(missingScopes([...INSTAGRAM_MESSAGING_SCOPES])).toEqual([]);
    expect(missingScopes(["instagram_business_basic"])).toEqual(["instagram_business_manage_messages"]);
    expect(missingScopes([])).toEqual([...INSTAGRAM_MESSAGING_SCOPES]);
  });
});
