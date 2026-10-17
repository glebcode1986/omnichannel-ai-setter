/**
 * The template catalogue as the send path and the provider's own webhooks reach it (Issue #20, ADR-016).
 *
 * Separate from the onboarding store because these two callers have no user behind them. A delivery
 * decision runs in a worker, and a `message_template_status_update` arrives from Meta — neither can hold a
 * `BusinessProfileContext`, and inventing one so the call would type-check is how a background path
 * acquires authority nobody granted. Both are scoped instead by a provider asset that was already
 * resolved: the channel account for a read, the messaging account for a status update.
 *
 * **A stored status is a record of what the provider last said, not a permission.** Meta pauses and
 * disables approved templates on quality feedback, archives unused ones after twelve months and deletes
 * them twenty-eight days later, and announces all of it asynchronously. So the row carries `syncedAt` and
 * the eligibility decision reads it: freshness is part of whether a template may send.
 */
import { isTemplateParameterFormat, type TemplateParameterFormat } from "@omnichannel/domain";

import type { DbExecutor } from "./client";

/** One stored template, in the shape the eligibility decision needs. */
export interface StoredTemplate {
  readonly providerTemplateId: string;
  readonly name: string;
  readonly languageCode: string;
  /** The provider's own status word, unmapped. Only `APPROVED` may send. */
  readonly status: string;
  readonly category?: string;
  readonly format: TemplateParameterFormat;
  readonly parameters: readonly string[];
  readonly syncedAt: Date;
}

/**
 * Every template of the connection bound to this channel account.
 *
 * Scoped by workspace *and* channel account, so a catalogue read cannot cross a tenant even though no
 * authorization context reaches this far.
 */
export async function readTemplateCatalogue(
  db: DbExecutor,
  scope: { readonly workspaceId: string; readonly channelAccountId: string },
): Promise<readonly StoredTemplate[]> {
  const rows = await db.whatsAppMessageTemplate.findMany({
    where: { workspaceId: scope.workspaceId, connection: { workspaceId: scope.workspaceId, channelAccountId: scope.channelAccountId } },
    orderBy: [{ name: "asc" }, { language: "asc" }],
    select: {
      providerTemplateId: true,
      name: true,
      language: true,
      status: true,
      category: true,
      parameterFormat: true,
      parameters: true,
      syncedAt: true,
    },
  });
  return rows.map((row) => ({
    providerTemplateId: row.providerTemplateId,
    name: row.name,
    languageCode: row.language,
    status: row.status,
    // A row whose format is not one of the two is read as positional, which is the provider's own default
    // — and the variable validation refuses a mismatch either way rather than guessing at a send.
    format: isTemplateParameterFormat(row.parameterFormat) ? row.parameterFormat : "POSITIONAL",
    parameters: row.parameters,
    ...(row.category === null ? {} : { category: row.category }),
    syncedAt: row.syncedAt,
  }));
}

export interface TemplateStatusUpdate {
  /** `entry.id` of the webhook: the messaging account the template belongs to. */
  readonly wabaId: string;
  readonly name: string;
  readonly languageCode: string;
  readonly status: string;
  /** The provider's own event word, kept for audit: `APPROVED`, `REJECTED`, `PAUSED`, `PENDING_DELETION`. */
  readonly event?: string;
  readonly at: Date;
}

/**
 * Applies a provider status change to every connection on that messaging account.
 *
 * Every one, because a messaging account may own several numbers and the template belongs to the account
 * rather than to one of them — updating only the first would leave the others sending on a status Meta
 * has withdrawn.
 *
 * `syncedAt` moves too. The provider has just told us the current status, so this *is* a sync: leaving the
 * old timestamp would let a freshness bound refuse a template the webhook had only just confirmed.
 *
 * Idempotent on purpose. Meta retries a failed webhook with decreasing frequency for up to seven days and
 * delivers retries to every subscribed app, so a duplicate is ordinary rather than exceptional — and
 * writing the same status twice is the same row either way.
 */
export async function applyTemplateStatusUpdate(db: DbExecutor, update: TemplateStatusUpdate): Promise<{ readonly updated: number }> {
  const changed = await db.whatsAppMessageTemplate.updateMany({
    where: {
      name: update.name,
      language: update.languageCode,
      connection: { wabaId: update.wabaId },
    },
    data: { status: update.status, syncedAt: update.at },
  });
  return { updated: changed.count };
}
