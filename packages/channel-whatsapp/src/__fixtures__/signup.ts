/**
 * Fixtures for Embedded Signup (Issue #19).
 *
 * Every provider response here is a shape read from Meta's live documentation on 2026-10-04, trimmed to
 * what the code reads. No production credential appears in this repository: the tokens below are obvious
 * placeholders and the HTTP port is scripted, so no test reaches the network.
 */
import type { WhatsAppHttpResult } from "../http";
import type { WhatsAppSignupConfig } from "../onboarding";
import { scriptedHttp } from "./payloads";

export const APP_ID = "1234567890123456";
export const APP_SECRET = "test-app-secret-not-a-real-one";
export const CONFIG_ID = "9876543210987654";
export const WABA_ID = "102290129340398";
export const PHONE_NUMBER_ID = "106540352242922";
export const BUSINESS_ID = "2729063490586005";
export const EXCHANGE_CODE = "AQB-test-exchangeable-code";
export const BUSINESS_TOKEN = "EAAtest-business-token-not-a-real-one";

export function signupConfig(results: readonly WhatsAppHttpResult[]): {
  readonly config: WhatsAppSignupConfig;
  readonly requests: { url: string; body: unknown; headers: Readonly<Record<string, string>> }[];
} {
  const http = scriptedHttp(results);
  return {
    requests: http.requests,
    config: { appId: APP_ID, appSecret: APP_SECRET, configId: CONFIG_ID, http: http.port, graphVersion: "v26.0" },
  };
}

export const ok = (body: Readonly<Record<string, unknown>>): WhatsAppHttpResult => ({ kind: "RESPONSE", status: 200, body: JSON.stringify(body) });

export const graphError = (status: number, code: number, subcode?: number): WhatsAppHttpResult => ({
  kind: "RESPONSE",
  status,
  body: JSON.stringify({
    error: {
      // Provider prose, deliberately quoting a request, so a test can prove it never escapes.
      message: `Invalid parameter for phone ${PHONE_NUMBER_ID} with token ${BUSINESS_TOKEN}`,
      type: "OAuthException",
      code,
      ...(subcode === undefined ? {} : { error_subcode: subcode }),
      fbtrace_id: "Atrace123",
    },
  }),
});

export const exchanged = (): WhatsAppHttpResult => ok({ access_token: BUSINESS_TOKEN, token_type: "bearer", expires_in: 5_184_000 });

export const debugToken = (
  overrides: { readonly scopes?: readonly string[]; readonly appId?: string; readonly isValid?: boolean; readonly expiresAt?: number } = {},
): WhatsAppHttpResult =>
  ok({
    data: {
      app_id: overrides.appId ?? APP_ID,
      type: "SYSTEM_USER",
      application: "Test provider app",
      is_valid: overrides.isValid ?? true,
      scopes: overrides.scopes ?? ["whatsapp_business_management", "whatsapp_business_messaging", "business_management"],
      ...(overrides.expiresAt === undefined ? {} : { expires_at: overrides.expiresAt }),
    },
  });

export const phoneNumbers = (
  overrides: { readonly id?: string; readonly quality?: string; readonly platformType?: string } = {},
): WhatsAppHttpResult =>
  ok({
    data: [
      {
        id: overrides.id ?? PHONE_NUMBER_ID,
        display_phone_number: "+1 555 0100",
        verified_name: "Test Business",
        quality_rating: overrides.quality ?? "GREEN",
        code_verification_status: "VERIFIED",
        platform_type: overrides.platformType ?? "CLOUD_API",
      },
    ],
    paging: { cursors: { before: "a", after: "b" } },
  });

export const success = (): WhatsAppHttpResult => ok({ success: true });

export const templates = (count = 2, next?: string): WhatsAppHttpResult =>
  ok({
    data: Array.from({ length: count }, (_unused, index) => ({
      id: `tpl_${String(index)}`,
      name: `appointment_reminder_${String(index)}`,
      language: "en_US",
      category: "UTILITY",
      status: index === 0 ? "APPROVED" : "PENDING",
      parameter_format: "positional",
      components: [{ type: "BODY", text: "Your appointment is at {{1}}." }],
    })),
    ...(next === undefined ? {} : { paging: { next } }),
  });

/** The session-log object the browser forwards, in the shape Meta documents. */
export const finishNotice = (
  overrides: { readonly event?: string; readonly phoneNumberId?: string | null; readonly wabaId?: string | null } = {},
): unknown => ({
  type: "WA_EMBEDDED_SIGNUP",
  event: overrides.event ?? "FINISH",
  data: {
    ...(overrides.phoneNumberId === null ? {} : { phone_number_id: overrides.phoneNumberId ?? PHONE_NUMBER_ID }),
    ...(overrides.wabaId === null ? {} : { waba_id: overrides.wabaId ?? WABA_ID }),
    business_id: BUSINESS_ID,
  },
});

export const cancelNotice = (step = "PHONE_NUMBER_SETUP"): unknown => ({
  type: "WA_EMBEDDED_SIGNUP",
  event: "CANCEL",
  data: { current_step: step },
});

export const errorNotice = (): unknown => ({
  type: "WA_EMBEDDED_SIGNUP",
  event: "CANCEL",
  data: {
    // Provider prose again: a test asserts this string never reaches a log or a response.
    error_message: "The verified name violates WhatsApp policy. Change it and try again.",
    error_code: "524126",
    session_id: "f34b51dab5e0498",
    timestamp: "1746041036",
  },
});
