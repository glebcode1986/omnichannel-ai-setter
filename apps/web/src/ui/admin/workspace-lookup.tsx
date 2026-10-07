/**
 * Finding a tenant (#59).
 *
 * Cross-tenant lookup is itself the privilege, which is why the search is the console's front door and
 * why the hit list carries counts rather than content. An empty term returns nothing rather than every
 * tenant: an unbounded listing of the whole customer base is a different feature with a different
 * conversation attached to it.
 */
import type { WorkspaceHit } from "@omnichannel/db";

import type { Translator } from "@/i18n/translate";

export function WorkspaceLookup({
  t,
  term,
  hits,
  basePath,
}: {
  readonly t: Translator;
  readonly term: string;
  readonly hits: readonly WorkspaceHit[];
  readonly basePath: string;
}) {
  return (
    <section className="card" data-admin="lookup">
      <h2>{t.t("admin.lookupTitle")}</h2>

      <form action={basePath} method="get" role="search">
        <label htmlFor="admin-lookup">{t.t("admin.lookupLabel")}</label>
        <input id="admin-lookup" name="q" type="search" defaultValue={term} />
        <button className="button" type="submit" data-action="lookup">
          {t.t("admin.lookupSubmit")}
        </button>
      </form>

      {term.trim() === "" ? (
        <p className="muted" data-lookup="idle">
          {t.t("admin.lookupIdle")}
        </p>
      ) : hits.length === 0 ? (
        <p className="muted" data-lookup="empty">
          {t.t("admin.lookupEmpty")}
        </p>
      ) : (
        <ul className="admin-hits">
          {hits.map((hit) => (
            <li key={hit.workspaceId} data-hit={hit.workspaceId}>
              <a href={`${basePath}/workspaces/${hit.workspaceId}`} data-action="open-workspace">
                {hit.name}
              </a>
              <p className="muted">
                {t.t("admin.hitLine", {
                  profiles: t.number(hit.businessProfiles),
                  members: t.number(hit.members),
                  created: t.date(hit.createdAt, { dateStyle: "medium" }),
                })}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
