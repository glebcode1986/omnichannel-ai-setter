/**
 * Approved templates, as the platform defines them (Issue #20).
 *
 * The cases that matter are the ones where a cached catalogue row and the current platform rule disagree:
 * a template approved yesterday and paused today, a shape whose example drifted from its text, a named
 * template whose values arrive with no names. Each would send — or refuse — a message a customer sees.
 */
import { describe, expect, it } from "vitest";

import { readTemplateShape, readTemplateStatusChanges, SENDABLE_TEMPLATE_STATUS, templateSendable, UNSENDABLE_TEMPLATE_STATUSES } from "./templates";

const positional = readTemplateShape({
  name: "appointment_reminder",
  language: "en_US",
  parameterFormat: "positional",
  components: [{ type: "BODY", text: "Hi {{1}}! Your appointment is at {{2}}." }],
});

const named = readTemplateShape({
  name: "order_confirmation",
  language: "en_US",
  parameterFormat: "named",
  components: [{ type: "BODY", text: "Thank you, {{first_name}}! Your order number is {{order_number}}." }],
});

describe("which templates may be sent", () => {
  it("permits only APPROVED", () => {
    // Meta's wording: a template rejected, or whose status changed to anything else, cannot be used in
    // messages. Quality feedback moves an approved template to PAUSED or DISABLED *after* approval, so a
    // status cached at connect time is not a permission later.
    expect(templateSendable(SENDABLE_TEMPLATE_STATUS)).toBe(true);
    for (const status of UNSENDABLE_TEMPLATE_STATUSES) {
      expect(templateSendable(status)).toBe(false);
    }
  });

  it("does not treat an unrecognised status as approved", () => {
    for (const status of ["approved", "ACTIVE", "", "APPROVED_WITH_NOTES"]) {
      expect(templateSendable(status)).toBe(false);
    }
  });
});

describe("reading the approved shape", () => {
  it("reads positional placeholders in numeric order", () => {
    expect(positional).toEqual({ name: "appointment_reminder", languageCode: "en_US", format: "POSITIONAL", parameters: ["1", "2"] });
  });

  it("orders positional placeholders by number, not by where they appear", () => {
    // `{{2}}` first in the text still expects values 1, 2 — the number is the position.
    const shape = readTemplateShape({
      name: "odd",
      language: "en_US",
      parameterFormat: "positional",
      components: [{ type: "BODY", text: "At {{2}} on {{1}}." }],
    });

    expect(shape.parameters).toEqual(["1", "2"]);
  });

  it("reads named placeholders in the order the approved text uses them", () => {
    expect(named).toEqual({
      name: "order_confirmation",
      languageCode: "en_US",
      format: "NAMED",
      parameters: ["first_name", "order_number"],
    });
  });

  it("reads the text, not the example, because the text is what customers see", () => {
    // A template whose example drifted from its body would otherwise set the expectation a send is
    // validated against — and the example is what was submitted for review, not what is delivered.
    const shape = readTemplateShape({
      name: "drifted",
      language: "en_US",
      parameterFormat: "positional",
      components: [{ type: "BODY", text: "One value: {{1}}.", example: { body_text: [["a", "b", "c"]] } }],
    });

    expect(shape.parameters).toEqual(["1"]);
  });

  it("defaults to positional when the template declares no format", () => {
    const shape = readTemplateShape({ name: "plain", language: "en_US", components: [{ type: "BODY", text: "Hi {{1}}." }] });

    expect(shape.format).toBe("POSITIONAL");
  });

  it("does not call a body with a named placeholder positional, whatever the missing field would default to", () => {
    const shape = readTemplateShape({ name: "lost_format", language: "ru", components: [{ type: "BODY", text: "Привет, {{first_name}}." }] });

    expect(shape).toMatchObject({ format: "NAMED", parameters: ["first_name"] });
  });

  it("reads only the body, because header and button parameters are not supported yet", () => {
    // Deriving a shape for components the send path cannot fill would make an unsupported template look
    // sendable and have Meta refuse it at dispatch.
    const shape = readTemplateShape({
      name: "with_header",
      language: "en_US",
      parameterFormat: "positional",
      components: [
        { type: "HEADER", format: "TEXT", text: "Order {{1}}" },
        { type: "BODY", text: "Ready at {{1}}." },
        { type: "BUTTONS", buttons: [{ type: "URL", url: "https://example.test/{{1}}" }] },
      ],
    });

    expect(shape.parameters).toEqual(["1"]);
  });

  it("reads a template with no placeholders as taking no values", () => {
    expect(readTemplateShape({ name: "fixed", language: "en_US", components: [{ type: "BODY", text: "We are closed today." }] })).toMatchObject({
      format: "POSITIONAL",
      parameters: [],
    });
  });

  it("survives a row with no components at all", () => {
    expect(readTemplateShape({ name: "bare", language: "en_US" })).toMatchObject({ parameters: [] });
  });

  it("tolerates whitespace inside a placeholder and counts a repeat once", () => {
    const shape = readTemplateShape({
      name: "repeated",
      language: "en_US",
      parameterFormat: "named",
      components: [{ type: "BODY", text: "{{ first_name }}, we have your order, {{first_name}}." }],
    });

    expect(shape.parameters).toEqual(["first_name"]);
  });
});

describe("a provider status change arriving by webhook", () => {
  const webhook = (value: Readonly<Record<string, unknown>>, field = "message_template_status_update") => ({
    object: "whatsapp_business_account",
    entry: [{ id: "102290129340398", changes: [{ field, value }] }],
  });

  it("reads the template, its language and its new status", () => {
    // The only way a status change reaches us without being asked for — and the reason a cached APPROVED
    // does not outlive the approval.
    expect(
      readTemplateStatusChanges(
        webhook({
          event: "PAUSED",
          message_template_id: 1259544702043867,
          message_template_name: "order_confirmation",
          message_template_language: "en_US",
          reason: "QUALITY_SCORE",
        }) as never,
      ),
    ).toEqual([
      {
        wabaId: "102290129340398",
        providerTemplateId: "1259544702043867",
        name: "order_confirmation",
        languageCode: "en_US",
        status: "PAUSED",
        reason: "QUALITY_SCORE",
      },
    ]);
  });

  it("ignores every other webhook field", () => {
    expect(readTemplateStatusChanges(webhook({ event: "APPROVED", message_template_name: "x", message_template_language: "en" }, "messages") as never)).toEqual([]);
  });

  it("drops a change that names no template, rather than guessing which one was meant", () => {
    // Pausing the wrong template stops a business sending something that was never in question. Meta
    // retries a failed delivery for up to seven days, and every sync re-reads the catalogue.
    for (const value of [
      { event: "PAUSED", message_template_language: "en_US" },
      { event: "PAUSED", message_template_name: "order_confirmation" },
      { message_template_name: "order_confirmation", message_template_language: "en_US" },
    ]) {
      expect(readTemplateStatusChanges(webhook(value) as never)).toEqual([]);
    }
  });

  it("drops a change whose messaging account is missing, because it names no scope", () => {
    expect(
      readTemplateStatusChanges({
        entry: [{ changes: [{ field: "message_template_status_update", value: { event: "PAUSED", message_template_name: "x", message_template_language: "en" } }] }],
      }),
    ).toEqual([]);
  });

  it("reads several changes from one delivery", () => {
    const changes = readTemplateStatusChanges({
      entry: [
        {
          id: "102290129340398",
          changes: [
            { field: "message_template_status_update", value: { event: "APPROVED", message_template_name: "a", message_template_language: "en_US" } },
            { field: "message_template_status_update", value: { event: "REJECTED", message_template_name: "b", message_template_language: "ru" } },
          ],
        },
      ],
    });

    expect(changes.map((change) => `${change.name}/${change.status}`)).toEqual(["a/APPROVED", "b/REJECTED"]);
  });
});
