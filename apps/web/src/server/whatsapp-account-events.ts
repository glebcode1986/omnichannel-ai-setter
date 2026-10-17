/**
 * WhatsApp's account-level webhooks, applied after verification (Issue #20, #23).
 *
 * Two fields matter to this product. `message_template_status_update` It is the only way a template
 * status change reaches us without being asked for, and it is what keeps a cached `APPROVED` from
 * outliving the approval — Meta pauses and disables approved templates on quality feedback, and a send
 * decided on a stale row is a message the provider refuses after the customer was promised a reply.
 *
 * `account_update` carries coexistence offboarding and reconnection. Meta's instruction to integrators on
 * an offboard is explicit — "Pause any pending Cloud API message sends for this client" — so this is not
 * telemetry either: a reply that goes out afterwards is a message sent on an authorization the business
 * has withdrawn.
 *
 * These events are deliberately not conversation events. They belong to the messaging account, they
 * produce no message and nothing in them can be attributed to a contact, so the normalizer never sees
 * them and this port applies them instead.
 *
 * **Scoped by the webhook's own `entry.id`, not by the route's channel account.** A messaging account may
 * own several numbers, and the template belongs to the account rather than to one of them — updating only
 * the number the webhook happened to arrive on would leave the others sending on a status Meta has
 * withdrawn. The scope is still a provider asset this deployment stores: a status update naming a
 * messaging account nobody connected matches no row and changes nothing.
 */
import type { AccountEventPort } from "@omnichannel/application";
import { readAccountLifecycleChanges, readTemplateStatusChanges, parseWebhook } from "@omnichannel/channel-whatsapp";
import { applyAccountLifecycle, applyTemplateStatusUpdate, type DbClient } from "@omnichannel/db";
import type { Logger } from "@omnichannel/observability";


export interface WhatsAppAccountEventOptions {
  readonly db: () => DbClient;
  readonly logger: () => Logger;
  readonly now: () => Date;
}

export function createWhatsAppAccountEventPort(options: WhatsAppAccountEventOptions): AccountEventPort {
  return {
    async apply({ account, webhook }) {
      if (account.channel !== "WHATSAPP" || webhook.method !== "POST") {
        return 0;
      }
      // Re-read from the same verified bytes the adapter verified. Parsing again rather than threading a
      // parsed object through the application keeps the provider's shape inside the channel package.
      const parsed = parseWebhook(webhook.rawBody);
      if (parsed === undefined) {
        return 0;
      }
      const at = options.now();
      let recorded = 0;

      for (const change of readAccountLifecycleChanges(parsed)) {
        const { updated } = await applyAccountLifecycle(options.db(), {
          wabaId: change.wabaId,
          event: change.event,
          ...(change.reason === undefined ? {} : { reason: change.reason }),
          at,
        });
        recorded += updated;
        options.logger().warn("whatsapp.account_lifecycle_applied", {
          workspaceId: account.workspaceId,
          channelAccountId: account.channelAccountId,
          event: change.event,
          // The provider's own code, never its prose.
          ...(change.reason === undefined ? {} : { reason: change.reason }),
          accounts: updated,
        });
      }

      const changes = readTemplateStatusChanges(parsed);
      if (changes.length === 0) {
        return recorded;
      }
      for (const change of changes) {
        const { updated } = await applyTemplateStatusUpdate(options.db(), {
          wabaId: change.wabaId,
          name: change.name,
          languageCode: change.languageCode,
          status: change.status,
          ...(change.reason === undefined ? {} : { event: change.reason }),
          at,
        });
        recorded += updated;
        // Identifiers and the provider's own codes only — never its prose, which quotes the template.
        options.logger().info("whatsapp.template_status_applied", {
          workspaceId: account.workspaceId,
          templateName: change.name,
          languageCode: change.languageCode,
          status: change.status,
          rows: updated,
        });
      }
      return recorded;
    },
  };
}
