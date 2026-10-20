/**
 * Coexistence offboarding and reconnection, as Meta reports them (#23, P4-06).
 *
 * The reason this is read rather than inferred: Meta's own documentation is inconsistent about whether
 * these are separate webhook fields or `event` values on `account_update`, and an event nobody has
 * classified must not be guessed into one of the two answers — reading an unrecognised one as
 * "reconnected" would resume sending on a number that is gone.
 */
import { describe, expect, it } from "vitest";

import { readAccountLifecycleChanges } from "./account-lifecycle";
import { parseWebhook } from "./payload";

const WABA_ID = "123456789012345";

const webhook = (value: Readonly<Record<string, unknown>>, field = "account_update") =>
  parseWebhook(new TextEncoder().encode(JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: WABA_ID, changes: [{ field, value }] }] })));

const read = (value: Readonly<Record<string, unknown>>, field?: string) => readAccountLifecycleChanges(webhook(value, field) ?? { entry: [] });

describe("reading an account lifecycle change", () => {
  it("reads the automatic offboard that follows a device change or re-registration", () => {
    expect(read({ event: "ACCOUNT_OFFBOARDED" })).toEqual([{ wabaId: WABA_ID, event: "OFFBOARDED" }]);
  });

  it("reads an explicit disconnect from inside the Business App as the same answer", () => {
    // Different cause, identical consequence: the number has stopped being ours to send on.
    expect(read({ event: "PARTNER_REMOVED" })).toEqual([{ wabaId: WABA_ID, event: "OFFBOARDED" }]);
  });

  it("carries the provider's own reason code when it supplies one, and never its prose", () => {
    const [change] = read({ event: "PARTNER_REMOVED", disconnection_info: { reason: "PRIMARY_INACTIVITY", message: "the business stopped using it" } });

    expect(change).toEqual({ wabaId: WABA_ID, event: "OFFBOARDED", reason: "PRIMARY_INACTIVITY" });
    expect(JSON.stringify(change)).not.toContain("stopped using it");
  });

  it("reads a reconnection", () => {
    expect(read({ event: "ACCOUNT_RECONNECTED" })).toEqual([{ wabaId: WABA_ID, event: "RECONNECTED" }]);
  });

  it("ignores an event it has not been taught, rather than guessing which of the two it is", () => {
    // The cost is asymmetric: an unrecognised event read as "reconnected" resumes sending on a number
    // that may be gone, while one read as nothing leaves the account exactly as it was.
    expect(read({ event: "ACCOUNT_VIOLATION" })).toEqual([]);
    expect(read({ event: "" })).toEqual([]);
    expect(read({})).toEqual([]);
  });

  it("ignores the same event on another field", () => {
    expect(read({ event: "ACCOUNT_OFFBOARDED" }, "messages")).toEqual([]);
    expect(read({ event: "ACCOUNT_OFFBOARDED" }, "message_template_status_update")).toEqual([]);
  });

  it("ignores an entry that names no messaging account", () => {
    const anonymous = parseWebhook(
      new TextEncoder().encode(JSON.stringify({ entry: [{ changes: [{ field: "account_update", value: { event: "ACCOUNT_OFFBOARDED" } }] }] })),
    );

    // The event is about an account, so one that names none names nothing this product stores.
    expect(readAccountLifecycleChanges(anonymous ?? { entry: [] })).toEqual([]);
  });

  it("reads every change in one delivery", () => {
    const many = parseWebhook(
      new TextEncoder().encode(
        JSON.stringify({
          entry: [
            { id: WABA_ID, changes: [{ field: "account_update", value: { event: "ACCOUNT_OFFBOARDED" } }] },
            { id: "999", changes: [{ field: "account_update", value: { event: "ACCOUNT_RECONNECTED" } }] },
          ],
        }),
      ),
    );

    expect(readAccountLifecycleChanges(many ?? { entry: [] })).toEqual([
      { wabaId: WABA_ID, event: "OFFBOARDED" },
      { wabaId: "999", event: "RECONNECTED" },
    ]);
  });
});
