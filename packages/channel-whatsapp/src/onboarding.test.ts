/**
 * Embedded Signup, provider side (Issue #19).
 *
 * The cases worth having at this level are the ones where believing the provider — or believing the
 * browser — would connect the wrong thing: a token minted for another application, a phone number that is
 * not on the messaging account it claims, a paging cursor pointing at a host that is not Meta's. None of
 * them is a malformed-input bug; each is a well-formed answer to a question nobody asked.
 */
import { describe, expect, it } from "vitest";

import {
  coexistenceCorroborated,
  EMBEDDED_SIGNUP_SCOPES,
  exchangeSignupCode,
  fetchGrantedAccess,
  fetchMessageTemplates,
  findPhoneNumberAsset,
  missingSignupScopes,
  onboardingModeOf,
  PHONE_PIN_LENGTH,
  readSignupNotice,
  registerPhoneNumber,
  SIGNUP_CODE_TTL_MS,
  subscribeMessagingAccount,
  unsubscribeMessagingAccount,
} from "./onboarding";
import {
  APP_ID,
  BUSINESS_TOKEN,
  cancelNotice,
  debugToken,
  errorNotice,
  EXCHANGE_CODE,
  exchanged,
  finishNotice,
  graphError,
  ok,
  PHONE_NUMBER_ID,
  phoneNumbers,
  signupConfig,
  success,
  templates,
  WABA_ID,
} from "./__fixtures__/signup";

describe("the platform facts this file is pinned to", () => {
  it("states Meta's thirty-second code window and six-digit PIN", () => {
    // Both re-verified 2026-10-04. They are here as constants so the one place that has to change when
    // Meta changes them is the place the comment explaining them lives.
    expect(SIGNUP_CODE_TTL_MS).toBe(30_000);
    expect(PHONE_PIN_LENGTH).toBe(6);
  });

  it("asks for messaging and management, and nothing else", () => {
    expect([...EMBEDDED_SIGNUP_SCOPES]).toEqual(["whatsapp_business_management", "whatsapp_business_messaging"]);
  });
});

describe("the session-log object the browser forwards", () => {
  it("reads a completed flow", () => {
    expect(readSignupNotice(finishNotice())).toEqual({
      kind: "FINISHED",
      event: "FINISH",
      phoneNumberId: PHONE_NUMBER_ID,
      wabaId: WABA_ID,
      businessPortfolioId: "2729063490586005",
      mode: "NEW_OR_MIGRATED_CLOUD_NUMBER",
    });
  });

  it("reads a flow that finished on a WhatsApp Business App number as coexistence", () => {
    const notice = readSignupNotice(finishNotice({ event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING" }));

    expect(notice).toMatchObject({ kind: "FINISHED", mode: "COEXISTENCE_EXISTING_BUSINESS_APP" });
  });

  it("does not guess a mode for a flow that finished without a number", () => {
    // `FINISH_ONLY_WABA` and `FINISH_GRANT_ONLY_API_ACCESS` are successes with nothing to connect yet.
    // Coexistence is capability-gated, so neither answer is true of them and the honest one is neither.
    expect(onboardingModeOf("FINISH_ONLY_WABA")).toBe("UNKNOWN");
    expect(onboardingModeOf("FINISH_GRANT_ONLY_API_ACCESS")).toBe("UNKNOWN");
    const notice = readSignupNotice(finishNotice({ event: "FINISH_ONLY_WABA", phoneNumberId: null }));
    expect(notice).toMatchObject({ kind: "FINISHED", mode: "UNKNOWN" });
    // Absent rather than present-and-undefined: the flow branches on whether there is a number at all.
    expect("phoneNumberId" in notice).toBe(false);
  });

  it("reads an abandoned flow, and which screen it was abandoned on", () => {
    expect(readSignupNotice(cancelNotice("BUSINESS_VERIFICATION"))).toEqual({ kind: "CANCELLED", currentStep: "BUSINESS_VERIFICATION" });
  });

  it("reads a reported error as its code and session, never its message", () => {
    const notice = readSignupNotice(errorNotice());

    expect(notice).toEqual({ kind: "ERRORED", code: "524126", sessionId: "f34b51dab5e0498" });
    // The provider's prose is shown to the customer by Meta and is untrusted text here. Nothing in the
    // parsed result can carry it into a log or a page.
    expect(JSON.stringify(notice)).not.toContain("violates WhatsApp policy");
  });

  it("refuses anything that is not this flow's message", () => {
    for (const raw of [undefined, null, "FINISH", { type: "SOMETHING_ELSE", event: "FINISH" }, { event: "FINISH" }]) {
      expect(readSignupNotice(raw)).toEqual({ kind: "UNREADABLE" });
    }
  });

  it("survives a payload with fields it has never seen", () => {
    // Meta adds arrays to this object — pages, catalogues, datasets arrived that way. A strict schema
    // would turn a successful onboarding into an unreadable one the day another one appears.
    const notice = readSignupNotice({
      type: "WA_EMBEDDED_SIGNUP",
      event: "FINISH",
      data: { phone_number_id: PHONE_NUMBER_ID, waba_id: WABA_ID, something_new: ["x"], catalog_ids: ["c1"] },
    });

    expect(notice).toMatchObject({ kind: "FINISHED", phoneNumberId: PHONE_NUMBER_ID });
  });
});

describe("exchanging the code", () => {
  it("sends the app credentials and reads the business token", async () => {
    const { config, requests } = signupConfig([exchanged()]);

    const result = await exchangeSignupCode(config, EXCHANGE_CODE);

    expect(result).toEqual({ ok: true, value: { accessToken: BUSINESS_TOKEN, expiresInSeconds: 5_184_000 } });
    expect(requests[0]?.url).toContain("/v26.0/oauth/access_token");
    expect(requests[0]?.url).toContain(`code=${EXCHANGE_CODE}`);
  });

  it("reports a refused code as a rejection, with its code and not its message", async () => {
    const { config } = signupConfig([graphError(400, 100, 36_009)]);

    const result = await exchangeSignupCode(config, EXCHANGE_CODE);

    expect(result).toEqual({ ok: false, reason: "provider_rejected", code: "100/36009" });
  });

  it("reports an unreachable provider as unavailable rather than a rejection", async () => {
    // Nothing was created by a failed read, so this is the one kind of failure that is safe to retry —
    // and reporting it as a rejection would be telling an operator their code was bad when it was not.
    const { config } = signupConfig([{ kind: "NO_RESPONSE", reason: "TIMEOUT", message: "timed out" }]);

    expect(await exchangeSignupCode(config, EXCHANGE_CODE)).toEqual({ ok: false, reason: "unavailable" });
  });

  it("refuses a 200 that carries no token", async () => {
    const { config } = signupConfig([ok({ token_type: "bearer" })]);

    expect(await exchangeSignupCode(config, EXCHANGE_CODE)).toEqual({ ok: false, reason: "invalid_response" });
  });
});

describe("what the customer actually granted", () => {
  it("reads the scopes, using the app token to inspect the business token", async () => {
    const { config, requests } = signupConfig([debugToken()]);

    const result = await fetchGrantedAccess(config, BUSINESS_TOKEN);

    expect(result.ok).toBe(true);
    expect(requests[0]?.url).toContain("/debug_token");
    expect(requests[0]?.url).toContain(`input_token=${BUSINESS_TOKEN}`);
    // The app access token: the only credential allowed to inspect another token of this app.
    expect(decodeURIComponent(requests[0]?.url ?? "")).toContain(`access_token=${APP_ID}|`);
  });

  it("refuses a token minted for another application", async () => {
    // The whole point of the check. Such a token passes every later call it happens to be permitted on,
    // and the account would be connected on a credential this deployment does not control.
    const { config } = signupConfig([debugToken({ appId: "999999999999999" })]);

    expect(await fetchGrantedAccess(config, BUSINESS_TOKEN)).toEqual({ ok: false, reason: "wrong_app", code: "TOKEN_FOREIGN_APP" });
  });

  it("refuses a token the provider says is not valid", async () => {
    const { config } = signupConfig([debugToken({ isValid: false })]);

    expect(await fetchGrantedAccess(config, BUSINESS_TOKEN)).toMatchObject({ ok: false, reason: "provider_rejected" });
  });

  it("names the permissions a customer deselected", async () => {
    const { config } = signupConfig([debugToken({ scopes: ["whatsapp_business_management"] })]);
    const access = await fetchGrantedAccess(config, BUSINESS_TOKEN);

    expect(access.ok && missingSignupScopes(access.value.scopes)).toEqual(["whatsapp_business_messaging"]);
  });

  it("treats a zero expiry as no expiry, not as 1970", async () => {
    // Zero is Meta's "never expires" for a system-user token, and a date of 1970 would make every health
    // check believe the credential is already dead.
    const { config } = signupConfig([debugToken({ expiresAt: 0 })]);
    const access = await fetchGrantedAccess(config, BUSINESS_TOKEN);

    expect(access.ok && access.value.expiresAt).toBeUndefined();
  });
});

describe("validating the assets the browser named", () => {
  it("finds the number on the messaging account and reads what Meta says it is", async () => {
    const { config, requests } = signupConfig([phoneNumbers()]);

    const result = await findPhoneNumberAsset(config, BUSINESS_TOKEN, { wabaId: WABA_ID, phoneNumberId: PHONE_NUMBER_ID });

    expect(result).toEqual({
      ok: true,
      value: {
        phoneNumberId: PHONE_NUMBER_ID,
        displayPhoneNumber: "+1 555 0100",
        verifiedName: "Test Business",
        qualityRating: "GREEN",
        codeVerificationStatus: "VERIFIED",
        platformType: "CLOUD_API",
      },
    });
    expect(requests[0]?.url).toContain(`/${WABA_ID}/phone_numbers`);
    expect(requests[0]?.headers["authorization"]).toBe(`Bearer ${BUSINESS_TOKEN}`);
  });

  it("refuses a number that is not on the account it claims", async () => {
    // Both identifiers come from a browser. This is the check that stops one being swapped for another
    // business's number, and it is a mismatch rather than a provider error because nothing failed.
    const { config } = signupConfig([phoneNumbers({ id: "111111111111111" })]);

    expect(await findPhoneNumberAsset(config, BUSINESS_TOKEN, { wabaId: WABA_ID, phoneNumberId: PHONE_NUMBER_ID })).toEqual({
      ok: false,
      reason: "asset_mismatch",
      code: "PHONE_NOT_ON_ACCOUNT",
    });
  });

  it("refuses an account the token cannot read", async () => {
    const { config } = signupConfig([graphError(403, 200)]);

    expect(await findPhoneNumberAsset(config, BUSINESS_TOKEN, { wabaId: WABA_ID, phoneNumberId: PHONE_NUMBER_ID })).toMatchObject({
      ok: false,
      reason: "provider_rejected",
      code: "200",
    });
  });

  it("reports a disagreement about coexistence instead of resolving it", () => {
    const asset = { phoneNumberId: PHONE_NUMBER_ID, platformType: "CLOUD_API" };

    // The flow said the number came from the Business App and Meta describes it as a Cloud API number.
    // That is something an operator should see, not something a helper should average out.
    expect(coexistenceCorroborated("COEXISTENCE_EXISTING_BUSINESS_APP", asset)).toBe(false);
    expect(coexistenceCorroborated("COEXISTENCE_EXISTING_BUSINESS_APP", { ...asset, platformType: "NOT_APPLICABLE" })).toBe(true);
    expect(coexistenceCorroborated("NEW_OR_MIGRATED_CLOUD_NUMBER", asset)).toBe(false);
  });
});

describe("subscribing and registering", () => {
  it("subscribes the app to the messaging account", async () => {
    const { config, requests } = signupConfig([success()]);

    expect(await subscribeMessagingAccount(config, BUSINESS_TOKEN, WABA_ID)).toEqual({ ok: true, value: true });
    expect(requests[0]?.url).toContain(`/${WABA_ID}/subscribed_apps`);
  });

  it("does not treat an unreadable 200 as a subscription", async () => {
    // Meta answers `{"success": true}`. An account connected on a 200 nobody could read is an account
    // that looks live and receives nothing, which is the hardest state to notice.
    const { config } = signupConfig([ok({ unexpected: "shape" })]);

    expect(await subscribeMessagingAccount(config, BUSINESS_TOKEN, WABA_ID)).toEqual({ ok: false, reason: "invalid_response" });
  });

  it("unsubscribes through the same edge", async () => {
    const { config, requests } = signupConfig([success()]);

    expect(await unsubscribeMessagingAccount(config, BUSINESS_TOKEN, WABA_ID)).toEqual({ ok: true, value: true });
    expect(requests[0]?.url).toContain("method=delete");
  });

  it("registers the number with its six-digit PIN", async () => {
    const { config, requests } = signupConfig([success()]);

    expect(await registerPhoneNumber(config, BUSINESS_TOKEN, { phoneNumberId: PHONE_NUMBER_ID, pin: "581063" })).toEqual({ ok: true, value: true });
    expect(requests[0]?.url).toContain(`/${PHONE_NUMBER_ID}/register`);
    expect(requests[0]?.body).toEqual({ messaging_product: "whatsapp", pin: "581063" });
  });

  it("refuses a PIN that is not six digits without dispatching anything", async () => {
    const { config, requests } = signupConfig([success()]);

    for (const pin of ["12345", "1234567", "12a456", "", " 123456"]) {
      expect(await registerPhoneNumber(config, BUSINESS_TOKEN, { phoneNumberId: PHONE_NUMBER_ID, pin })).toEqual({ ok: false, reason: "invalid_pin" });
    }
    // Refused locally: the answer cannot change on a retry, and a local refusal reads as a sentence
    // rather than as a provider error code.
    expect(requests).toHaveLength(0);
  });

  it("reports a provider registration failure with its code, not its prose", async () => {
    const { config } = signupConfig([graphError(400, 133_010)]);

    const result = await registerPhoneNumber(config, BUSINESS_TOKEN, { phoneNumberId: PHONE_NUMBER_ID, pin: "581063" });

    expect(result).toEqual({ ok: false, reason: "provider_rejected", code: "133010" });
    expect(JSON.stringify(result)).not.toContain(BUSINESS_TOKEN);
  });
});

describe("the template bootstrap", () => {
  it("reads the catalogue", async () => {
    const { config, requests } = signupConfig([templates(2)]);

    const result = await fetchMessageTemplates(config, BUSINESS_TOKEN, WABA_ID);

    expect(result.ok && result.value.complete).toBe(true);
    expect(result.ok && result.value.templates.map((template) => `${template.name}/${template.status}`)).toEqual([
      "appointment_reminder_0/APPROVED",
      "appointment_reminder_1/PENDING",
    ]);
    expect(requests[0]?.url).toContain(`/${WABA_ID}/message_templates`);
  });

  it("follows Meta's own paging cursor", async () => {
    const { config, requests } = signupConfig([templates(1, "https://graph.facebook.com/v26.0/next-page"), templates(1)]);

    const result = await fetchMessageTemplates(config, BUSINESS_TOKEN, WABA_ID);

    expect(result.ok && result.value.templates).toHaveLength(2);
    expect(requests[1]?.url).toBe("https://graph.facebook.com/v26.0/next-page");
  });

  it("does not follow a cursor to another host", async () => {
    // The next request carries the customer's access token in its header. A `paging.next` is a URL chosen
    // by a provider response, and following one elsewhere would hand that token to whatever the body said.
    const { config, requests } = signupConfig([templates(1, "https://attacker.example/v26.0/next-page"), templates(1)]);

    const result = await fetchMessageTemplates(config, BUSINESS_TOKEN, WABA_ID);

    expect(result.ok && result.value.templates).toHaveLength(1);
    expect(requests).toHaveLength(1);
  });

  it("drops a template with no identity rather than storing one no send can name", async () => {
    const { config } = signupConfig([ok({ data: [{ id: "tpl_1", name: "named", language: "en_US", status: "APPROVED" }, { id: "tpl_2", name: "no_language" }] })]);

    const result = await fetchMessageTemplates(config, BUSINESS_TOKEN, WABA_ID);

    expect(result.ok && result.value.templates.map((template) => template.name)).toEqual(["named"]);
  });

  it("says so when the catalogue was larger than one bootstrap will walk", async () => {
    // Ten pages that each promise another. A truncated bootstrap reported as complete would let a screen
    // imply a business has eleven templates when it has hundreds.
    const pages = Array.from({ length: 10 }, () => templates(1, "https://graph.facebook.com/v26.0/more"));
    const { config } = signupConfig(pages);

    const result = await fetchMessageTemplates(config, BUSINESS_TOKEN, WABA_ID);

    expect(result.ok && result.value.complete).toBe(false);
    expect(result.ok && result.value.templates).toHaveLength(10);
  });
});

describe("the shape the bootstrap stores", () => {
  it("parses each template's parameter format and placeholders at sync time", async () => {
    // Parsed where the provider's payload is read, so nothing downstream has to know what `components`
    // looks like — and so a parser never runs on the way to a customer (Issue #20).
    const { config, requests } = signupConfig([templates(1)]);

    const result = await fetchMessageTemplates(config, BUSINESS_TOKEN, WABA_ID);

    expect(result.ok && result.value.templates[0]).toMatchObject({ parameterFormat: "POSITIONAL", parameters: ["1"] });
    // And the request asks for the field, or the format would always fall back to the default.
    expect(requests[0]?.url).toContain("parameter_format");
  });

  it("parses a named template's placeholders by name", async () => {
    const { config } = signupConfig([
      ok({
        data: [
          {
            id: "tpl_named",
            name: "order_confirmation",
            language: "en_US",
            status: "APPROVED",
            parameter_format: "named",
            components: [{ type: "BODY", text: "Thank you, {{first_name}}! Your order is {{order_number}}." }],
          },
        ],
      }),
    ]);

    const result = await fetchMessageTemplates(config, BUSINESS_TOKEN, WABA_ID);

    expect(result.ok && result.value.templates[0]).toMatchObject({
      parameterFormat: "NAMED",
      parameters: ["first_name", "order_number"],
    });
  });
});
