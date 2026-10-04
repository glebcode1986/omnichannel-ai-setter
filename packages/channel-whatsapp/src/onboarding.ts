/**
 * Embedded Signup: the provider half (Issue #19, ADR-015).
 *
 * This module speaks Meta's onboarding protocol and nothing else. It holds no state, reads no environment,
 * touches no database and never logs; the caller injects the HTTP port, so the suite never reaches the
 * network and no test needs a production credential.
 *
 * Re-verified against Meta's live documentation on 2026-10-04 — see the Issue #19 section of
 * docs/research/META_WHATSAPP_PHASE4_VERIFICATION.md. Three facts from that reading shape this file:
 *
 * **Embedded Signup v2 and v3 are deprecated on 15 October 2026**, so this targets v4 only. There is no
 * compatibility path worth building for a flow that stops working in eleven days.
 *
 * **The exchangeable code lives 30 seconds.** It is therefore never persisted, queued or retried: the
 * exchange happens in the request that receives it, and an expiry is an ordinary refusal the operator can
 * resume from, not an error to recover in the background.
 *
 * **`waba_id` now denotes the messaging-account ID.** Meta is splitting the WhatsApp Business Account into
 * a WhatsApp Account for phone numbers and identity and a Messaging Account for templates, billing and
 * webhook subscriptions; existing values keep working and mean the latter. Both identifiers are kept
 * separately, and neither reaches channel-neutral code.
 */
import { z } from "zod";

import type { TemplateParameterFormat } from "@omnichannel/domain";

import { DEFAULT_GRAPH_HOST, DEFAULT_GRAPH_VERSION } from "./config";
import { formatErrorCode, parseWhatsAppError } from "./errors";
import type { WhatsAppHttpPort, WhatsAppHttpResult } from "./http";
import { readTemplateShape } from "./templates";

/**
 * Least privilege. Management is needed to read the messaging account's numbers and templates and to
 * register a number; messaging is needed to send and receive. Nothing else is requested — Meta's own
 * guidance is that a customer who reaches a selection screen for an asset the product does not use
 * abandons the flow and asks why.
 */
export const EMBEDDED_SIGNUP_SCOPES = ["whatsapp_business_management", "whatsapp_business_messaging"] as const;

/**
 * The scope the *provider's* system user needs, alongside an Admin or Finance Editor role in the business
 * portfolio. It is not requested from the customer, and it is listed here so the deployment check and the
 * documentation cannot drift apart.
 */
export const SYSTEM_USER_SCOPE = "business_management";

/** Meta's own number: the exchangeable code expires 30 seconds after Embedded Signup returns it. */
export const SIGNUP_CODE_TTL_MS = 30_000;

/** Two-step verification for a business phone number is exactly six digits. */
export const PHONE_PIN_LENGTH = 6;

/** One page of templates per request, and a bound on how many pages one bootstrap will walk. */
const TEMPLATE_PAGE_SIZE = 100;
const MAX_TEMPLATE_PAGES = 10;

const ONBOARDING_TIMEOUT_MS = 10_000;

export interface WhatsAppSignupConfig {
  readonly appId: string;
  readonly appSecret: string;
  /** The Business Login configuration the client launches; carried here so one object configures the flow. */
  readonly configId: string;
  readonly http: WhatsAppHttpPort;
  readonly graphHost?: string;
  readonly graphVersion?: string;
}

/**
 * Why a step failed, in fixed vocabulary. Provider prose never travels with it: Meta's messages quote the
 * request, and one of these values ends up in a redirect an operator can read.
 */
export type SignupFailureReason =
  | "provider_rejected"
  | "invalid_response"
  | "unavailable"
  | "missing_scope"
  | "wrong_app"
  | "asset_mismatch"
  | "invalid_pin";

export type SignupResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: SignupFailureReason; readonly code?: string };

/** The business-integration system-user token the code is exchanged for. */
export interface BusinessToken {
  readonly accessToken: string;
  /** Present when Meta states one; the 60-day configuration template does. */
  readonly expiresInSeconds?: number;
}

export interface GrantedAccess {
  /** Scopes the customer actually granted. They may deselect some and still complete the flow. */
  readonly scopes: readonly string[];
  readonly expiresAt?: Date;
}

/** The phone-number asset as Meta describes it, read back from the messaging account rather than trusted. */
export interface PhoneNumberAsset {
  readonly phoneNumberId: string;
  readonly displayPhoneNumber?: string;
  readonly verifiedName?: string;
  readonly qualityRating?: string;
  readonly codeVerificationStatus?: string;
  /** `CLOUD_API`, `ON_PREMISE`, `NOT_APPLICABLE` — corroborates the flow's own coexistence signal. */
  readonly platformType?: string;
}

export interface MessageTemplateRecord {
  readonly providerTemplateId: string;
  readonly name: string;
  readonly language: string;
  readonly category?: string;
  readonly status: string;
  /** Kept as provider JSON: the catalogue is an audit record, and re-modelling it here would lose detail. */
  readonly components?: readonly unknown[];
  /**
   * The approved shape, parsed here rather than at send time (Issue #20).
   *
   * The provider's two parameter formats serialize differently and a send in the wrong one is refused, so
   * the shape is a stored fact. Parsed where the provider's own payload is read, which is the only place
   * that should ever know what `components` looks like.
   */
  readonly parameterFormat: TemplateParameterFormat;
  readonly parameters: readonly string[];
}

/**
 * How the number arrived, which decides whether coexistence is on.
 *
 * It comes from the flow's own finish event, not from a guess: `COEXISTENCE_EXISTING_BUSINESS_APP` means
 * Meta reported that the customer finished with a number that is on the WhatsApp Business App. The spec is
 * explicit that coexistence is capability-gated and must never be promised before the provider confirms
 * it, so `UNKNOWN` exists and is not quietly turned into either answer.
 */
export type WhatsAppOnboardingMode = "NEW_OR_MIGRATED_CLOUD_NUMBER" | "COEXISTENCE_EXISTING_BUSINESS_APP" | "UNKNOWN";

/** What the browser observed, after parsing. Untrusted: every identifier in it is verified against Meta. */
export type SignupNotice =
  | {
      readonly kind: "FINISHED";
      readonly event: string;
      readonly phoneNumberId?: string;
      readonly wabaId?: string;
      readonly businessPortfolioId?: string;
      readonly mode: WhatsAppOnboardingMode;
    }
  | { readonly kind: "CANCELLED"; readonly currentStep?: string }
  /** The customer reported an error through the flow. `code` and `sessionId` are what support asks for. */
  | { readonly kind: "ERRORED"; readonly code?: string; readonly sessionId?: string }
  | { readonly kind: "UNREADABLE" };

const finishEvents = new Set([
  "FINISH",
  "FINISH_ONLY_WABA",
  "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
  "FINISH_OBO_MIGRATION",
  "FINISH_GRANT_ONLY_API_ACCESS",
]);

const noticeSchema = z.looseObject({
  type: z.string().optional(),
  event: z.string().optional(),
  data: z
    .looseObject({
      phone_number_id: z.string().optional(),
      waba_id: z.string().optional(),
      business_id: z.string().optional(),
      current_step: z.string().optional(),
      error_code: z.union([z.string(), z.number()]).optional(),
      session_id: z.string().optional(),
    })
    .optional(),
});

/**
 * Reads the session-log object the browser forwards.
 *
 * Loose on purpose. Meta adds fields to this payload — the asset arrays for pages, catalogues and
 * datasets arrived that way — and a strict schema would turn a successful onboarding into an unreadable
 * one the day another array appears. What matters is the finish type and the three identifiers, and all
 * three are verified against Meta before anything is stored.
 */
export function readSignupNotice(raw: unknown): SignupNotice {
  const parsed = noticeSchema.safeParse(raw);
  if (!parsed.success || parsed.data.type !== "WA_EMBEDDED_SIGNUP") {
    return { kind: "UNREADABLE" };
  }
  const { event, data } = parsed.data;
  if (event !== undefined && finishEvents.has(event)) {
    return {
      kind: "FINISHED",
      event,
      ...(data?.phone_number_id === undefined ? {} : { phoneNumberId: data.phone_number_id }),
      ...(data?.waba_id === undefined ? {} : { wabaId: data.waba_id }),
      ...(data?.business_id === undefined ? {} : { businessPortfolioId: data.business_id }),
      mode: onboardingModeOf(event),
    };
  }
  if (data?.error_code !== undefined || event === "ERROR") {
    return {
      kind: "ERRORED",
      ...(data?.error_code === undefined ? {} : { code: String(data.error_code) }),
      ...(data?.session_id === undefined ? {} : { sessionId: data.session_id }),
    };
  }
  if (event === "CANCEL") {
    return { kind: "CANCELLED", ...(data?.current_step === undefined ? {} : { currentStep: data.current_step }) };
  }
  return { kind: "UNREADABLE" };
}

/**
 * The mode a finish event implies.
 *
 * `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` is the one that means coexistence. `FINISH_ONLY_WABA` and
 * `FINISH_GRANT_ONLY_API_ACCESS` finish without a number at all, so neither mode is true of them yet and
 * the answer is `UNKNOWN` rather than the cheerful default.
 */
export function onboardingModeOf(event: string): WhatsAppOnboardingMode {
  if (event === "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING") {
    return "COEXISTENCE_EXISTING_BUSINESS_APP";
  }
  if (event === "FINISH" || event === "FINISH_OBO_MIGRATION") {
    return "NEW_OR_MIGRATED_CLOUD_NUMBER";
  }
  return "UNKNOWN";
}

/**
 * Whether the provider's own description of the number agrees that coexistence is available.
 *
 * Kept separate from the event so a disagreement is visible rather than averaged: Meta reporting
 * `platform_type: "CLOUD_API"` for a number the flow called a Business App onboarding is something an
 * operator should see, not something this function should resolve.
 */
export function coexistenceCorroborated(mode: WhatsAppOnboardingMode, asset: PhoneNumberAsset): boolean {
  return mode === "COEXISTENCE_EXISTING_BUSINESS_APP" && asset.platformType !== "CLOUD_API";
}

export async function exchangeSignupCode(config: WhatsAppSignupConfig, code: string): Promise<SignupResult<BusinessToken>> {
  const url = graphUrl(config, "oauth/access_token");
  url.searchParams.set("client_id", config.appId);
  url.searchParams.set("client_secret", config.appSecret);
  url.searchParams.set("code", code);
  const payload = readJson(await get(config, url));
  if (!payload.ok) {
    return payload.failure;
  }
  const accessToken = stringField(payload.value, "access_token");
  if (accessToken === undefined) {
    return { ok: false, reason: "invalid_response" };
  }
  const expiresIn = payload.value["expires_in"];
  return {
    ok: true,
    value: {
      accessToken,
      ...(typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresInSeconds: Math.trunc(expiresIn) } : {}),
    },
  };
}

/**
 * What the customer actually granted, read from Meta rather than assumed from what was asked for.
 *
 * `is_valid` and `app_id` are both checked. A token minted for another application would otherwise pass
 * every later call that happens to be permitted, and the account would be connected on a credential this
 * deployment does not control.
 */
export async function fetchGrantedAccess(config: WhatsAppSignupConfig, accessToken: string): Promise<SignupResult<GrantedAccess>> {
  const url = graphUrl(config, "debug_token");
  url.searchParams.set("input_token", accessToken);
  // The app access token, which is the only credential allowed to inspect another token of this app.
  url.searchParams.set("access_token", `${config.appId}|${config.appSecret}`);
  const payload = readJson(await get(config, url));
  if (!payload.ok) {
    return payload.failure;
  }
  const data = payload.value["data"];
  if (!isJsonObject(data)) {
    return { ok: false, reason: "invalid_response" };
  }
  if (data["is_valid"] !== true) {
    return { ok: false, reason: "provider_rejected", code: "TOKEN_NOT_VALID" };
  }
  const appId = stringField(data, "app_id") ?? numberFieldAsString(data, "app_id");
  if (appId !== config.appId) {
    return { ok: false, reason: "wrong_app", code: "TOKEN_FOREIGN_APP" };
  }
  const scopes = stringArrayField(data, "scopes");
  const expiresAt = unixSecondsField(data, "data_access_expires_at") ?? unixSecondsField(data, "expires_at");
  return { ok: true, value: { scopes, ...(expiresAt === undefined ? {} : { expiresAt }) } };
}

/** Scopes the product cannot work without. A customer may grant fewer than were requested. */
export function missingSignupScopes(granted: readonly string[], required: readonly string[] = EMBEDDED_SIGNUP_SCOPES): readonly string[] {
  return required.filter((scope) => !granted.includes(scope));
}

/**
 * Reads the messaging account's numbers and finds the one the browser named.
 *
 * This is the asset validation the spec asks for, and it is one call because one call answers all three
 * questions: whether the token can read this messaging account at all, whether the phone number belongs to
 * it, and what Meta says the number actually is. A `phone_number_id` that is not on this `waba_id` — a
 * value a browser can simply type — is `asset_mismatch`, not a connection.
 */
export async function findPhoneNumberAsset(
  config: WhatsAppSignupConfig,
  accessToken: string,
  input: { readonly wabaId: string; readonly phoneNumberId: string },
): Promise<SignupResult<PhoneNumberAsset>> {
  const url = graphUrl(config, `${input.wabaId}/phone_numbers`);
  url.searchParams.set("fields", "id,display_phone_number,verified_name,quality_rating,code_verification_status,platform_type");
  const payload = readJson(await get(config, url, accessToken));
  if (!payload.ok) {
    return payload.failure;
  }
  const rows = payload.value["data"];
  if (!Array.isArray(rows)) {
    return { ok: false, reason: "invalid_response" };
  }
  for (const row of rows) {
    if (!isJsonObject(row)) {
      continue;
    }
    const id = stringField(row, "id") ?? numberFieldAsString(row, "id");
    if (id !== input.phoneNumberId) {
      continue;
    }
    return {
      ok: true,
      value: {
        phoneNumberId: id,
        ...optional("displayPhoneNumber", stringField(row, "display_phone_number")),
        ...optional("verifiedName", stringField(row, "verified_name")),
        ...optional("qualityRating", stringField(row, "quality_rating")),
        ...optional("codeVerificationStatus", stringField(row, "code_verification_status")),
        ...optional("platformType", stringField(row, "platform_type")),
      },
    };
  }
  return { ok: false, reason: "asset_mismatch", code: "PHONE_NOT_ON_ACCOUNT" };
}

/**
 * Subscribes this app to the customer's messaging account.
 *
 * Without it no webhook for this customer is ever delivered, so the connection would look complete and
 * receive nothing — which is why the onboarding flow treats this as a state of its own rather than a
 * best-effort afterthought.
 */
export async function subscribeMessagingAccount(config: WhatsAppSignupConfig, accessToken: string, wabaId: string): Promise<SignupResult<true>> {
  return readSuccess(await post(config, graphUrl(config, `${wabaId}/subscribed_apps`), accessToken, {}));
}

/** The reverse, for disconnect: the app stops receiving this customer's events. */
export async function unsubscribeMessagingAccount(config: WhatsAppSignupConfig, accessToken: string, wabaId: string): Promise<SignupResult<true>> {
  const url = graphUrl(config, `${wabaId}/subscribed_apps`);
  // Meta accepts the method override on this edge, and the port deliberately offers only GET and POST:
  // one transport shape per package means one place where a timeout or a retry opinion can live.
  url.searchParams.set("method", "delete");
  return readSuccess(await post(config, url, accessToken, {}));
}

/**
 * Registers the number for the Cloud API with its two-step verification PIN.
 *
 * The PIN is validated before anything is dispatched. Meta would reject a five-digit PIN too, but a local
 * refusal costs no request and reads as a sentence rather than as a provider error code — and the PIN is
 * the one value here that a person types.
 */
export async function registerPhoneNumber(
  config: WhatsAppSignupConfig,
  accessToken: string,
  input: { readonly phoneNumberId: string; readonly pin: string },
): Promise<SignupResult<true>> {
  if (!new RegExp(`^[0-9]{${String(PHONE_PIN_LENGTH)}}$`, "u").test(input.pin)) {
    return { ok: false, reason: "invalid_pin" };
  }
  return readSuccess(
    await post(config, graphUrl(config, `${input.phoneNumberId}/register`), accessToken, { messaging_product: "whatsapp", pin: input.pin }),
  );
}

/**
 * The approved/pending/rejected template catalogue for the messaging account.
 *
 * Paged, because a business with a real catalogue has more than one page of it, and bounded, because an
 * onboarding request is not the place to walk an unbounded provider list. A truncated bootstrap is
 * reported as a truncated bootstrap: `complete: false` is what lets the connection say "synced 1000 of
 * them" instead of implying the catalogue is small.
 */
export async function fetchMessageTemplates(
  config: WhatsAppSignupConfig,
  accessToken: string,
  wabaId: string,
): Promise<SignupResult<{ readonly templates: readonly MessageTemplateRecord[]; readonly complete: boolean }>> {
  const first = graphUrl(config, `${wabaId}/message_templates`);
  first.searchParams.set("fields", "id,name,language,category,status,components,parameter_format");
  first.searchParams.set("limit", String(TEMPLATE_PAGE_SIZE));

  const templates: MessageTemplateRecord[] = [];
  let next: string | undefined = first.toString();
  for (let page = 0; page < MAX_TEMPLATE_PAGES; page += 1) {
    if (next === undefined) {
      return { ok: true, value: { templates, complete: true } };
    }
    const payload = readJson(await get(config, new URL(next), accessToken));
    if (!payload.ok) {
      return payload.failure;
    }
    const rows = payload.value["data"];
    if (!Array.isArray(rows)) {
      return { ok: false, reason: "invalid_response" };
    }
    for (const row of rows) {
      const template = readTemplate(row);
      if (template !== undefined) {
        templates.push(template);
      }
    }
    next = nextPageUrl(config, payload.value);
  }
  return { ok: true, value: { templates, complete: next === undefined } };
}

function readTemplate(row: unknown): MessageTemplateRecord | undefined {
  if (!isJsonObject(row)) {
    return undefined;
  }
  const providerTemplateId = stringField(row, "id") ?? numberFieldAsString(row, "id");
  const name = stringField(row, "name");
  const language = stringField(row, "language");
  const status = stringField(row, "status");
  if (providerTemplateId === undefined || name === undefined || language === undefined || status === undefined) {
    // A row missing its identity cannot be matched to a send later, and storing it would put a template in
    // the catalogue that no delivery can ever name.
    return undefined;
  }
  const components = row["components"];
  const shape = readTemplateShape({
    name,
    language,
    ...optional("parameterFormat", stringField(row, "parameter_format")),
    ...(Array.isArray(components) ? { components: components as readonly unknown[] } : {}),
  });
  return {
    providerTemplateId,
    name,
    language,
    status,
    parameterFormat: shape.format,
    parameters: shape.parameters,
    ...optional("category", stringField(row, "category")),
    ...(Array.isArray(components) ? { components: components as readonly unknown[] } : {}),
  };
}

/**
 * The next page, but only on the host this deployment already talks to.
 *
 * A `paging.next` is a URL chosen by the provider response, and the next request carries the customer's
 * access token in its header. Following one to another host would hand that token to whatever the body
 * said — the one thing a paging cursor must never be able to do — so a cursor pointing anywhere else ends
 * the walk instead.
 */
function nextPageUrl(config: WhatsAppSignupConfig, payload: JsonObject): string | undefined {
  const paging = payload["paging"];
  if (!isJsonObject(paging)) {
    return undefined;
  }
  const next = paging["next"];
  if (typeof next !== "string" || next === "") {
    return undefined;
  }
  try {
    return new URL(next).host === (config.graphHost ?? DEFAULT_GRAPH_HOST) ? next : undefined;
  } catch {
    return undefined;
  }
}

function graphUrl(config: WhatsAppSignupConfig, path: string): URL {
  return new URL(`https://${config.graphHost ?? DEFAULT_GRAPH_HOST}/${config.graphVersion ?? DEFAULT_GRAPH_VERSION}/${path}`);
}

async function get(config: WhatsAppSignupConfig, url: URL, accessToken?: string): Promise<WhatsAppHttpResult> {
  return config.http.send({
    url: url.toString(),
    method: "GET",
    headers: accessToken === undefined ? {} : { authorization: `Bearer ${accessToken}` },
    timeoutMs: ONBOARDING_TIMEOUT_MS,
  });
}

async function post(config: WhatsAppSignupConfig, url: URL, accessToken: string, body: Readonly<Record<string, unknown>>): Promise<WhatsAppHttpResult> {
  return config.http.send({
    url: url.toString(),
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(body),
    timeoutMs: ONBOARDING_TIMEOUT_MS,
  });
}

function readSuccess(result: WhatsAppHttpResult): SignupResult<true> {
  const payload = readJson(result);
  if (!payload.ok) {
    return payload.failure;
  }
  // Meta answers `{"success": true}`. Anything else is not a confirmation, and treating a 200 with an
  // unreadable body as a subscription is how an account ends up connected and silent.
  return payload.value["success"] === true ? { ok: true, value: true } : { ok: false, reason: "invalid_response" };
}

type JsonObject = Readonly<Record<string, unknown>>;

function readJson(result: WhatsAppHttpResult): { ok: true; value: JsonObject } | { ok: false; failure: SignupResult<never> } {
  if (result.kind === "NO_RESPONSE") {
    // Unlike a send, an onboarding read creates nothing, so an unknown outcome is safe to retry. The one
    // exception is the exchange, whose code expires in thirty seconds — the flow decides that, not this.
    return { ok: false, failure: { ok: false, reason: "unavailable" } };
  }
  if (result.status < 200 || result.status >= 300) {
    const error = parseWhatsAppError(result.body);
    const code = error === undefined ? `HTTP_${String(result.status)}` : (formatErrorCode(error) ?? `HTTP_${String(result.status)}`);
    // A throttled or broken provider has told us nothing about the credential. Reporting that as a
    // rejection would mark a sound connection as needing re-authorization.
    const transient = result.status >= 500 || result.status === 429;
    return { ok: false, failure: { ok: false, reason: transient ? "unavailable" : "provider_rejected", code } };
  }
  const parsed = safeJsonObject(result.body);
  return parsed === undefined ? { ok: false, failure: { ok: false, reason: "invalid_response" } } : { ok: true, value: parsed };
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

function optional<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}

function stringField(payload: JsonObject, field: string): string | undefined {
  const value = payload[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArrayField(payload: JsonObject, field: string): readonly string[] {
  const value = payload[field];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function unixSecondsField(payload: JsonObject, field: string): Date | undefined {
  const value = payload[field];
  // Zero is Meta's "never expires" for a system-user token, and a date of 1970 would make every health
  // check believe the credential is already dead.
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return new Date(value * 1000);
}

/**
 * Provider identifiers are long enough to lose precision as JSON numbers. If one ever arrives unquoted the
 * value is already wrong by the time it reaches us, so anything beyond exact integer range is refused
 * rather than stored as a different account.
 */
function numberFieldAsString(payload: JsonObject, field: string): string | undefined {
  const value = payload[field];
  return typeof value === "number" && Number.isSafeInteger(value) ? String(value) : undefined;
}
