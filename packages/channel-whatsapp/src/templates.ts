/**
 * Approved templates, as the platform defines them (Issue #20, ADR-016).
 *
 * Re-verified against Meta's live template documentation on 2026-10-04. Four facts from that reading are
 * what this file exists to hold.
 *
 * **A template message is the only kind that may be sent outside the customer-service window.** That is
 * the whole reason `TEMPLATE_ONLY` is a window state rather than a closed window.
 *
 * **Only `APPROVED` may be sent.** Meta's wording is that a template rejected, or whose status changed to
 * anything else, cannot be used in messages. Quality feedback moves an approved template to `PAUSED` or
 * `DISABLED` *after* approval, so a status cached at connect time is not a permission later.
 *
 * **A template is identified by name *and* language.** Names are deliberately not unique: one name exists
 * once per language, and sending the wrong language is sending different words.
 *
 * **Parameters are either `positional` or `named`, and the payload shapes differ.** Positional parameters
 * are `{{1}}`, `{{2}}` and travel in order; named parameters are `{{snake_case}}` and each value must
 * carry its `parameter_name`. `parameter_format` defaults to `positional` when a template does not say.
 * Sending a named template's values positionally is refused by Meta, which is what `buildTemplatePayload`
 * now distinguishes.
 *
 * What this file deliberately does **not** do is invent rules. Meta's current documentation states the
 * status rule, the identity rule and the two parameter formats; it does not publish a whitespace rule for
 * parameter values, so nothing here refuses one. A local refusal we cannot point at is a rule of our own
 * pretending to be the platform's.
 */
import { z } from "zod";

import type { ApprovedTemplateShape, TemplateParameterFormat } from "@omnichannel/domain";

import type { WhatsAppWebhook } from "./payload";

/** The one status Meta permits a send on. Everything else — including `PAUSED` — cannot be used. */
export const SENDABLE_TEMPLATE_STATUS = "APPROVED";

/**
 * Statuses an approved template can fall into afterwards, listed so the reason a send was refused can name
 * the state rather than merely say "not approved". `PENDING_DELETION` arrives with a status webhook; an
 * unused template is archived after 12 months and deleted 28 days later, so a catalogue row can describe a
 * template that no longer exists.
 */
export const UNSENDABLE_TEMPLATE_STATUSES = ["PENDING", "IN_APPEAL", "REJECTED", "PAUSED", "DISABLED", "PENDING_DELETION", "ARCHIVED"] as const;

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/gu;
const POSITIONAL_NAME = /^[1-9][0-9]*$/u;

export function templateSendable(status: string): boolean {
  return status === SENDABLE_TEMPLATE_STATUS;
}

/**
 * Reads the approved shape out of a provider template row.
 *
 * The placeholders come from the component text rather than from the `example` block, because the example
 * is what the business submitted for review and the text is what customers are actually shown. A template
 * whose example drifted from its text would otherwise set the expectation a send is validated against.
 *
 * Only the body is read. Header and button parameters exist and are not supported by this product yet —
 * the capability flag says so — and silently deriving a shape for components the send path cannot fill
 * would turn an unsupported template into one that looks sendable and is refused by Meta at dispatch.
 */
export function readTemplateShape(template: {
  readonly name: string;
  readonly language: string;
  readonly parameterFormat?: string;
  readonly components?: readonly unknown[];
}): ApprovedTemplateShape {
  const body = bodyText(template.components);
  const placeholders = [...new Set([...body.matchAll(PLACEHOLDER)].map((match) => match[1] ?? ""))].filter((name) => name !== "");
  const declared = template.parameterFormat?.toUpperCase();
  const format: TemplateParameterFormat =
    declared === "NAMED" || declared === "POSITIONAL"
      ? declared
      : // Meta's default is positional when a template does not declare a format. Inferring from the
        // placeholders only matters for a row that lost the field: a body with `{{first_name}}` cannot be
        // positional whatever the absent field would have defaulted to.
        placeholders.every((name) => POSITIONAL_NAME.test(name))
        ? "POSITIONAL"
        : "NAMED";
  return {
    name: template.name,
    languageCode: template.language,
    format,
    // Positional placeholders are read in numeric order rather than textual order, so `{{2}}` appearing
    // before `{{1}}` in the approved text still expects values 1, 2.
    parameters: format === "POSITIONAL" ? [...placeholders].sort((left, right) => Number(left) - Number(right)) : placeholders,
  };
}



function bodyText(components: readonly unknown[] | undefined): string {
  for (const component of components ?? []) {
    if (typeof component !== "object" || component === null) {
      continue;
    }
    const row = component as Readonly<Record<string, unknown>>;
    const type = typeof row["type"] === "string" ? row["type"].toUpperCase() : "";
    if (type === "BODY" && typeof row["text"] === "string") {
      return row["text"];
    }
  }
  return "";
}

/**
 * A provider status change for one template, read out of a verified webhook.
 *
 * `message_template_status_update` is the only way a status change reaches us without being asked for, and
 * it matters because the alternative is a cached `APPROVED` outliving the approval. The webhook is
 * delivered to the *messaging account*, so `entry.id` is the scope and the template is named rather than
 * identified by the connection.
 */
export interface TemplateStatusChange {
  /** `entry.id`: the messaging account the template belongs to. */
  readonly wabaId: string;
  readonly providerTemplateId?: string;
  readonly name: string;
  readonly languageCode: string;
  /** The provider's new status word, taken from the event. */
  readonly status: string;
  /** The provider's own reason code, kept for audit. Never its prose. */
  readonly reason?: string;
}

const templateStatusValue = z.looseObject({
  event: z.string().optional(),
  message_template_id: z.union([z.string(), z.number()]).optional(),
  message_template_name: z.string().optional(),
  message_template_language: z.string().optional(),
  reason: z.string().optional(),
});

/** The field name Meta delivers template status changes under. */
export const TEMPLATE_STATUS_FIELD = "message_template_status_update";

/**
 * Every template status change in this webhook.
 *
 * Returns a list because one delivery may carry several changes, and drops anything it cannot act on: a
 * change with no template name or no language names no row, and guessing which template was meant is how
 * the wrong one gets paused. A dropped change is not a loss — Meta retries a failed delivery for up to
 * seven days, and the catalogue is re-read on every sync.
 */
export function readTemplateStatusChanges(webhook: WhatsAppWebhook): readonly TemplateStatusChange[] {
  const changes: TemplateStatusChange[] = [];
  for (const entry of webhook.entry ?? []) {
    const wabaId = entry.id;
    if (wabaId === undefined || wabaId === "") {
      continue;
    }
    for (const change of entry.changes ?? []) {
      if (change.field !== TEMPLATE_STATUS_FIELD) {
        continue;
      }
      const parsed = templateStatusValue.safeParse(change.value);
      if (!parsed.success) {
        continue;
      }
      const { event, message_template_name: name, message_template_language: language, message_template_id: id, reason } = parsed.data;
      if (event === undefined || name === undefined || language === undefined) {
        continue;
      }
      changes.push({
        wabaId,
        name,
        languageCode: language,
        status: event,
        ...(id === undefined ? {} : { providerTemplateId: String(id) }),
        ...(reason === undefined ? {} : { reason }),
      });
    }
  }
  return changes;
}
