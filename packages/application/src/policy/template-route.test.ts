/**
 * Choosing the template that answers an outside-window conversation (Issue #20, ADR-016).
 *
 * The refusals are the point. Each one is a different sentence to an operator — "that template does not
 * exist", "not in that language", "it was paused yesterday", "we have not checked lately", "those values
 * do not fit" — and collapsing them would send somebody looking for the wrong thing. None of them is
 * repaired by substituting a template that would have worked: that would be this layer choosing the words
 * a customer reads.
 */
import { describe, expect, it } from "vitest";

import { selectTemplate, templateRouteOf, type CatalogueTemplate, type TemplateSelectionInput } from "./template-route";

const NOW = new Date("2026-10-04T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

const reminder = (overrides: Partial<CatalogueTemplate> = {}): CatalogueTemplate => ({
  providerTemplateId: "tpl_1",
  name: "appointment_reminder",
  languageCode: "en_US",
  status: "APPROVED",
  category: "UTILITY",
  format: "POSITIONAL",
  parameters: ["1", "2"],
  syncedAt: new Date(NOW.getTime() - 60_000),
  ...overrides,
});

const input = (overrides: Partial<TemplateSelectionInput> = {}): TemplateSelectionInput => ({
  catalogue: [reminder()],
  automationAllowlist: [],
  proposed: { templateName: "appointment_reminder", languageCode: "en_US", parameters: [{ name: "1", value: "Jess" }, { name: "2", value: "10:00" }] },
  maxTemplateAgeMs: DAY,
  now: NOW,
  ...overrides,
});

describe("a proposal that may be sent", () => {
  it("is sendable, and not automatable until the business says so", () => {
    const selection = selectTemplate(input());

    expect(selection).toMatchObject({ outcome: "SENDABLE", automatable: false, approvedTemplateAvailable: true });
    expect(selection.outcome === "SENDABLE" && selection.template.providerTemplateId).toBe("tpl_1");
  });

  it("is automatable once the business allowlists it", () => {
    expect(selectTemplate(input({ automationAllowlist: ["appointment_reminder"] }))).toMatchObject({ outcome: "SENDABLE", automatable: true });
  });

  it("is automatable in every approved language of an allowlisted template", () => {
    // ADR-016's allowlist names a template or a use-case, not one of its translations — and a language
    // that is not approved never reaches this line.
    const selection = selectTemplate(
      input({
        catalogue: [reminder(), reminder({ providerTemplateId: "tpl_2", languageCode: "ru" })],
        automationAllowlist: ["appointment_reminder"],
        proposed: { templateName: "appointment_reminder", languageCode: "ru", parameters: [{ name: "1", value: "Женя" }, { name: "2", value: "10:00" }] },
      }),
    );

    expect(selection).toMatchObject({ outcome: "SENDABLE", automatable: true });
    expect(selection.outcome === "SENDABLE" && selection.template.languageCode).toBe("ru");
  });

  it("accepts a named template's values in any order", () => {
    const selection = selectTemplate(
      input({
        catalogue: [reminder({ format: "NAMED", parameters: ["first_name", "at"] })],
        proposed: {
          templateName: "appointment_reminder",
          languageCode: "en_US",
          parameters: [{ name: "at", value: "10:00" }, { name: "first_name", value: "Jess" }],
        },
      }),
    );

    expect(selection.outcome).toBe("SENDABLE");
  });
});

describe("a proposal that may not", () => {
  it("refuses a free-form draft, because there is nothing to send outside the window", () => {
    const selection = selectTemplate(input({ proposed: undefined }));

    expect(selection).toEqual({ outcome: "REFUSED", refusal: "NO_TEMPLATE_PROPOSED", approvedTemplateAvailable: true });
  });

  it("refuses a template the catalogue does not have", () => {
    // The model may rank and suggest; it may not invent. A name nobody approved is an invention.
    expect(selectTemplate(input({ proposed: { templateName: "made_up", languageCode: "en_US", parameters: [] } }))).toMatchObject({
      refusal: "TEMPLATE_NOT_IN_CATALOGUE",
    });
  });

  it("refuses a language the template was not approved in", () => {
    // Sending the English version to a customer promised the Russian one is sending different words, and
    // "not in the catalogue" would send an operator looking for the wrong thing.
    expect(
      selectTemplate(input({ proposed: { templateName: "appointment_reminder", languageCode: "ru", parameters: [{ name: "1", value: "a" }, { name: "2", value: "b" }] } })),
    ).toMatchObject({ refusal: "LANGUAGE_NOT_APPROVED" });
  });

  it("refuses every status but APPROVED", () => {
    for (const status of ["PENDING", "REJECTED", "PAUSED", "DISABLED", "PENDING_DELETION", "IN_APPEAL"]) {
      const selection = selectTemplate(input({ catalogue: [reminder({ status })] }));

      expect(selection).toMatchObject({ refusal: "TEMPLATE_NOT_APPROVED", approvedTemplateAvailable: false });
    }
  });

  it("refuses a row too old to be the provider's current answer", () => {
    // The provider pauses and disables approved templates on quality feedback and announces none of it
    // synchronously. A stale row is unknown, and unknown fails closed.
    const selection = selectTemplate(input({ catalogue: [reminder({ syncedAt: new Date(NOW.getTime() - DAY - 1) })] }));

    expect(selection).toMatchObject({ refusal: "TEMPLATE_STATUS_STALE", approvedTemplateAvailable: false });
  });

  it("refuses values that do not fit the approved shape, and says which problem", () => {
    const selection = selectTemplate(
      input({ proposed: { templateName: "appointment_reminder", languageCode: "en_US", parameters: [{ name: "1", value: "Jess" }] } }),
    );

    expect(selection).toMatchObject({ refusal: "PARAMETERS_INVALID", problem: { kind: "COUNT_MISMATCH", expected: 2, supplied: 1 } });
  });

  it("refuses an empty value, which renders as a gap in approved wording", () => {
    const selection = selectTemplate(
      input({ proposed: { templateName: "appointment_reminder", languageCode: "en_US", parameters: [{ name: "1", value: "Jess" }, { name: "2", value: " " }] } }),
    );

    expect(selection).toMatchObject({ refusal: "PARAMETERS_INVALID", problem: { kind: "EMPTY_VALUE", name: "2" } });
  });

  it("does not substitute a template that would have worked", () => {
    // "Some other template fits" is a sentence for a person, not a quiet swap on the way to a customer.
    const selection = selectTemplate(
      input({
        catalogue: [reminder(), reminder({ providerTemplateId: "tpl_2", name: "closed_today", parameters: [] })],
        proposed: { templateName: "appointment_reminder", languageCode: "en_US", parameters: [] },
      }),
    );

    expect(selection).toMatchObject({ refusal: "PARAMETERS_INVALID" });
  });
});

describe("whether a person could still act", () => {
  it("says yes while some fresh approved template exists, whatever happened to this one", () => {
    const selection = selectTemplate(
      input({
        catalogue: [reminder({ status: "PAUSED" }), reminder({ providerTemplateId: "tpl_2", name: "closed_today", parameters: [] })],
      }),
    );

    expect(selection).toMatchObject({ refusal: "TEMPLATE_NOT_APPROVED", approvedTemplateAvailable: true });
  });

  it("says no when the catalogue is empty, which ends the matter rather than queueing a dead review", () => {
    expect(selectTemplate(input({ catalogue: [] }))).toEqual({
      outcome: "REFUSED",
      refusal: "TEMPLATE_NOT_IN_CATALOGUE",
      approvedTemplateAvailable: false,
    });
  });

  it("says no when every approved row is stale, because a stale row is not a permission", () => {
    expect(selectTemplate(input({ catalogue: [reminder({ syncedAt: new Date(NOW.getTime() - DAY - 1) })], proposed: undefined }))).toEqual({
      outcome: "REFUSED",
      refusal: "NO_TEMPLATE_PROPOSED",
      approvedTemplateAvailable: false,
    });
  });
});

describe("what the policy engine is told", () => {
  it("is two booleans, and never which template", () => {
    // A policy engine holding a catalogue would be the place a model's ranking quietly became a send.
    const route = templateRouteOf(selectTemplate(input({ automationAllowlist: ["appointment_reminder"] })));

    expect(route).toEqual({ approvedTemplateAvailable: true, automatable: true });
    expect(Object.keys(route)).toEqual(["approvedTemplateAvailable", "automatable"]);
  });

  it("reports a refused proposal as not automatable, even where a route exists for a person", () => {
    expect(templateRouteOf(selectTemplate(input({ catalogue: [reminder({ status: "PAUSED" }), reminder({ providerTemplateId: "tpl_2", name: "other", parameters: [] })] })))).toEqual({
      approvedTemplateAvailable: true,
      automatable: false,
    });
  });
});
