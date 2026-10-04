/**
 * Choosing the approved template that may answer a conversation outside the service window
 * (ADR-016, Issue #20).
 *
 * This is where eligibility is *decided*, and the decision is deterministic. A model may have proposed
 * which template to use — ADR-016 permits ranking and suggesting — but everything that makes a proposal
 * sendable is checked here against the stored catalogue: that the template exists, in that language, that
 * it is approved *now*, that its values match the approved shape, and that the business allowlisted it for
 * unattended automation. A proposal that fails any of those is refused rather than repaired, because the
 * repair would be this layer choosing words.
 *
 * **A cached catalogue row is not a permission forever.** The provider pauses and disables approved
 * templates on quality feedback and archives unused ones, and it announces none of that synchronously. So
 * a row older than the caller's freshness bound is treated as unknown rather than as approved — the same
 * way an unknown window fails closed.
 *
 * What this file never does is pick a template on the product's behalf when the proposal is unusable.
 * "Some other template would have worked" is a sentence for a person, not a substitution to make quietly
 * on the way to a customer.
 */
import { templateVariablesProblem, type ApprovedTemplateShape, type TemplateValue, type TemplateVariableProblem } from "@omnichannel/domain";

import type { TemplateRoute } from "./inputs";

/** One stored template, as the catalogue knows it. The shape was parsed by the adapter at sync time. */
export interface CatalogueTemplate extends ApprovedTemplateShape {
  readonly providerTemplateId: string;
  /** The provider's own status word, unmapped. Only `APPROVED` may send. */
  readonly status: string;
  readonly category?: string;
  /** When this row was last read from the provider. Freshness is part of eligibility. */
  readonly syncedAt: Date;
}

/** What the draft proposes to send. Absent when the draft is free-form text. */
export interface ProposedTemplate {
  readonly templateName: string;
  readonly languageCode: string;
  readonly parameters: readonly TemplateValue[];
}

export interface TemplateSelectionInput {
  readonly catalogue: readonly CatalogueTemplate[];
  /** Template names the business enabled for unattended automation. Empty means none (ADR-016). */
  readonly automationAllowlist: readonly string[];
  readonly proposed?: ProposedTemplate;
  /** How old a catalogue row may be and still count as the provider's current answer. */
  readonly maxTemplateAgeMs: number;
  readonly now: Date;
}

/** Why a proposal may not be sent. Fixed vocabulary: each one is a different sentence to an operator. */
export type TemplateRefusal =
  | "NO_TEMPLATE_PROPOSED"
  | "TEMPLATE_NOT_IN_CATALOGUE"
  | "LANGUAGE_NOT_APPROVED"
  | "TEMPLATE_NOT_APPROVED"
  | "TEMPLATE_STATUS_STALE"
  | "PARAMETERS_INVALID";

export type TemplateSelection =
  | {
      readonly outcome: "SENDABLE";
      readonly template: CatalogueTemplate;
      readonly parameters: readonly TemplateValue[];
      /** Whether the business allowlisted this template for sending with no person involved. */
      readonly automatable: boolean;
      /** True when any approved, fresh template exists at all; always true here. */
      readonly approvedTemplateAvailable: true;
    }
  | {
      readonly outcome: "REFUSED";
      readonly refusal: TemplateRefusal;
      /** Set when the refusal was about the values rather than the template. */
      readonly problem?: TemplateVariableProblem;
      /** Whether a person could still choose some other approved template. */
      readonly approvedTemplateAvailable: boolean;
    };

export function selectTemplate(input: TemplateSelectionInput): TemplateSelection {
  const fresh = input.catalogue.filter((template) => isFresh(template, input));
  const approvedTemplateAvailable = fresh.some((template) => template.status === APPROVED);

  if (input.proposed === undefined) {
    return { outcome: "REFUSED", refusal: "NO_TEMPLATE_PROPOSED", approvedTemplateAvailable };
  }
  const proposed = input.proposed;
  const byName = input.catalogue.filter((template) => template.name === proposed.templateName);
  if (byName.length === 0) {
    return { outcome: "REFUSED", refusal: "TEMPLATE_NOT_IN_CATALOGUE", approvedTemplateAvailable };
  }
  const template = byName.find((candidate) => candidate.languageCode === proposed.languageCode);
  if (template === undefined) {
    // The name exists and the language does not. Worth its own refusal: sending the English version of a
    // template a Russian-speaking customer was promised is sending different words, and "not in the
    // catalogue" would send an operator looking for the wrong thing.
    return { outcome: "REFUSED", refusal: "LANGUAGE_NOT_APPROVED", approvedTemplateAvailable };
  }
  if (template.status !== APPROVED) {
    return { outcome: "REFUSED", refusal: "TEMPLATE_NOT_APPROVED", approvedTemplateAvailable };
  }
  if (!isFresh(template, input)) {
    // Approved as far as this row knows, and the row is too old to be the provider's current answer.
    return { outcome: "REFUSED", refusal: "TEMPLATE_STATUS_STALE", approvedTemplateAvailable };
  }
  const problem = templateVariablesProblem(template, proposed.parameters);
  if (problem !== undefined) {
    return { outcome: "REFUSED", refusal: "PARAMETERS_INVALID", problem, approvedTemplateAvailable };
  }
  return {
    outcome: "SENDABLE",
    template,
    parameters: proposed.parameters,
    // Matched by name, which is how ADR-016's allowlist is expressed: a business enables a template or a
    // use-case, not one of its translations. Every approved language of an enabled template is therefore
    // automatable, and a language that is not approved never reaches this line.
    automatable: input.automationAllowlist.includes(template.name),
    approvedTemplateAvailable: true,
  };
}

/** The two facts the policy engine is allowed to see. Nothing about which template, by design. */
export function templateRouteOf(selection: TemplateSelection): TemplateRoute {
  return {
    approvedTemplateAvailable: selection.approvedTemplateAvailable,
    automatable: selection.outcome === "SENDABLE" && selection.automatable,
  };
}

const APPROVED = "APPROVED";

function isFresh(template: CatalogueTemplate, input: TemplateSelectionInput): boolean {
  return input.now.getTime() - template.syncedAt.getTime() <= input.maxTemplateAgeMs;
}
