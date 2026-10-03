/**
 * What the Inbox looks like while its first page is being read (Issue #28).
 *
 * The route is a Server Component that awaits a database read, so without this the navigation shows the
 * previous screen until the new one is ready — which reads as a click that did nothing. A skeleton in the
 * shape of the panes is enough: the point is that something is happening, not a pixel-accurate preview.
 */
import { requestTranslator } from "@/i18n/request-locale";

export default async function InboxLoading() {
  const t = await requestTranslator();

  return (
    <div className="inbox" data-pane="list" aria-busy="true">
      <section className="inbox-list">
        <p className="muted">{t.t("inbox.loading")}</p>
        <ul className="conversation-rows" aria-hidden="true">
          {[0, 1, 2, 3, 4].map((slot) => (
            <li key={slot}>
              <span className="conversation-row skeleton-row" />
            </li>
          ))}
        </ul>
      </section>
      <section className="inbox-thread inbox-thread-empty">
        <p className="muted">{t.t("inbox.loading")}</p>
      </section>
    </div>
  );
}
