/**
 * The one screen in the console that shows a customer's own words (#59, ADMIN_OPERATIONS.md).
 *
 * It exists in this slice on purpose. Without one content-bearing read, the support session, the data
 * scopes, the expiry arithmetic and the break-glass path would all be types nothing consumes — the
 * "exported, tested, never called" shape this codebase has shipped before. With it, the metadata default
 * is real: the same page renders with the thread or with the reason it does not.
 *
 * The refusal is the domain's own word — no session, expired, revoked, out of scope — because "denied"
 * would send an operator to request access they already hold for the wrong tenant.
 */
import { loadAdminConversation } from "@/server/admin-page";

export const dynamic = "force-dynamic";

export default async function AdminConversationPage({
  params,
}: {
  readonly params: Promise<{ readonly workspaceId: string; readonly businessProfileId: string; readonly conversationId: string }>;
}) {
  const { workspaceId, businessProfileId, conversationId } = await params;
  const data = await loadAdminConversation(workspaceId, businessProfileId, conversationId);
  const { t } = data;

  return (
    <div className="stack">
      <div className="page-header">
        <h1>{t.t("admin.conversation")}</h1>
        <a className="button" href={data.basePath} data-action="back-to-workspace">
          {t.t("admin.backToWorkspace")}
        </a>
      </div>

      {data.lines === undefined ? (
        <p className="notice" data-tone="stop" data-admin="content-hidden" data-refusal={data.refusal ?? ""}>
          {data.refusal === "NO_SESSION" ? t.t("admin.contentHidden") : t.t("admin.contentRefused", { reason: data.refusal ?? "" })}
        </p>
      ) : (
        <section className="card" data-admin="conversation-content">
          <ul className="admin-messages">
            {data.lines.map((line) => (
              <li key={line.messageId} data-message={line.messageId} data-direction={line.direction}>
                <p className="muted">{t.date(line.occurredAt, { dateStyle: "short", timeStyle: "short" })}</p>
                <p>{line.text ?? ""}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
