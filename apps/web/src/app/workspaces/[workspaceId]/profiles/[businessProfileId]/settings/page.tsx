/**
 * AI settings and the no-send playground (AI_CONFIGURATION_UX.md, Issue #30).
 *
 * Everything an owner chooses here is a *name* — a mode, a preset, an after-window policy — and the
 * server decides what it costs. The one thing this page is careful never to imply is that raw model
 * confidence controls sending: the deterministic gates run afterwards and can refuse a reply the model was
 * certain about, which is why the playground shows the policy outcome and not just the draft.
 *
 * Provider and model choice are deliberately absent. `AI_CONFIGURATION_UX.md` puts them under an
 * Advanced/Infrastructure area, and the contract forbids SDK details leaking into normal owner UX — so
 * this page names no provider, no model and no token limit anywhere.
 */
import { listPolicyAudits, readPolicies } from "@omnichannel/db";
import { CONFIDENCE_PRESETS, POLICY_IMPACTS, TIMING_PRESETS } from "@omnichannel/domain";

import { OutcomeNotice } from "@/ui/outcome-notice";
import { requestTranslator } from "@/i18n/request-locale";
import { requireBusinessProfileContext } from "@/server/request-context";
import { getDb } from "@/server/db";
import { saveSettingsAction } from "@/server/settings-actions";
import { runSimulation } from "@/server/simulation";
import type { MessageKey } from "@/i18n/catalogue";
import type { RawSearchParams } from "@/server/inbox-view";

function one(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined || first === "" ? undefined : first;
}

const MODES = ["OFF", "DRAFT", "AUTOPILOT"] as const;
const INSTAGRAM = ["STANDARD_ONLY", "HUMAN_ASSISTED_EXTENDED"] as const;
const WHATSAPP = ["SERVICE_WINDOW_ONLY", "TEMPLATE_REVIEW", "TEMPLATE_AUTOPILOT"] as const;

export default async function SettingsPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly workspaceId: string; readonly businessProfileId: string }>;
  readonly searchParams: Promise<RawSearchParams>;
}) {
  const { workspaceId, businessProfileId } = await params;
  const context = await requireBusinessProfileContext(workspaceId, businessProfileId);
  const t = await requestTranslator();
  const query = await searchParams;
  const target = { workspaceId, businessProfileId };
  const basePath = `/workspaces/${workspaceId}/profiles/${businessProfileId}/settings`;

  const [policies, audits] = await Promise.all([readPolicies(getDb(), context), listPolicyAudits(getDb(), context, { limit: 20 })]);
  const policy = policies.find((candidate) => candidate.channelAccountId === null);

  const ask = one(query["ask"]);
  const simulation = await runSimulation(context, ask ?? "");
  // The impacts the server refused to save without an acknowledgement, if that is why we are here.
  const pending = (one(query["impacts"]) ?? "").split(",").filter((impact) => (POLICY_IMPACTS as readonly string[]).includes(impact));

  return (
    <>
      <div className="page-header">
        <h1>{t.t("settings.title")}</h1>
      </div>

      <OutcomeNotice t={t} outcome={one(query["outcome"])} />

      {pending.length === 0 ? undefined : (
        <div className="notice" data-tone="stop" data-confirm="true" role="alert">
          <h2>{t.t("settings.confirmTitle")}</h2>
          <ul>
            {pending.map((impact) => (
              <li key={impact} data-impact={impact}>
                {t.t(`impact.${impact}` as MessageKey)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {policy === undefined ? undefined : (
        <form action={saveSettingsAction.bind(null, target)} className="knowledge-editor">
          <label htmlFor="settings-mode">{t.t("settings.mode")}</label>
          <select id="settings-mode" name="mode" defaultValue={policy.mode}>
            {MODES.map((mode) => (
              <option key={mode} value={mode}>
                {t.t(`aiMode.${mode}`)}
              </option>
            ))}
          </select>

          <label htmlFor="settings-goal">{t.t("settings.goal")}</label>
          <input id="settings-goal" name="businessGoal" type="text" defaultValue={policy.businessGoal ?? ""} />
          <p className="muted">{t.t("settings.goalHint")}</p>

          <label htmlFor="settings-criteria">{t.t("settings.criteria")}</label>
          <textarea id="settings-criteria" name="criteria" rows={3} defaultValue={policy.qualificationCriteria.join("\n")} />

          <label htmlFor="settings-confidence">{t.t("settings.confidence")}</label>
          <select id="settings-confidence" name="confidencePreset" defaultValue={policy.confidencePreset ?? ""}>
            {/* An owner who tuned values by hand is told so rather than shown a preset that no longer
                describes them. Choosing a preset then replaces those values. */}
            {policy.confidencePreset === undefined ? <option value="">{t.t("settings.custom")}</option> : undefined}
            {CONFIDENCE_PRESETS.map((preset) => (
              <option key={preset} value={preset}>
                {t.t(`confidencePreset.${preset}`)}
              </option>
            ))}
          </select>

          <label htmlFor="settings-timing">{t.t("settings.timing")}</label>
          <select id="settings-timing" name="timingPreset" defaultValue={policy.timingPreset}>
            {TIMING_PRESETS.map((preset) => (
              <option key={preset} value={preset}>
                {t.t(`timingPreset.${preset}`)}
              </option>
            ))}
          </select>
          <p className="muted">{t.t("settings.timingHint")}</p>

          <label htmlFor="settings-takeover">{t.t("settings.takeoverPause")}</label>
          <input
            id="settings-takeover"
            name="takeoverPauseHours"
            type="number"
            min="1"
            max="168"
            defaultValue={Math.round(policy.takeoverPauseMs / 3_600_000)}
          />

          <label htmlFor="settings-instagram">{t.t("settings.instagram")}</label>
          <select id="settings-instagram" name="instagramAfterWindowPolicy" defaultValue={policy.instagramAfterWindowPolicy}>
            {INSTAGRAM.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>

          <label htmlFor="settings-whatsapp">{t.t("settings.whatsapp")}</label>
          <select id="settings-whatsapp" name="whatsappAfterWindowPolicy" defaultValue={policy.whatsappAfterWindowPolicy}>
            {WHATSAPP.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>

          <label htmlFor="settings-allowlist">{t.t("settings.allowlist")}</label>
          <textarea id="settings-allowlist" name="allowlist" rows={3} defaultValue={policy.whatsappTemplateAutomationAllowlist.join("\n")} />
          {policy.whatsappAfterWindowPolicy === "TEMPLATE_AUTOPILOT" && policy.whatsappTemplateAutomationAllowlist.length === 0 ? (
            <p className="notice" data-tone="stop" data-empty-allowlist="true">
              {t.t("settings.allowlistEmpty")}
            </p>
          ) : undefined}

          {/* Present always, so a change that turns out to be high-impact can be acknowledged in one
              step rather than sending the owner round again. */}
          <label className="checkbox" htmlFor="settings-confirm">
            <input id="settings-confirm" type="checkbox" name="confirm" />
            {t.t("settings.confirmAck")}
          </label>

          <button className="button primary" type="submit" data-action="save-settings">
            {pending.length === 0 ? t.t("settings.save") : t.t("settings.confirmSave")}
          </button>
        </form>
      )}

      <section className="knowledge-tester">
        <h2>{t.t("sim.title")}</h2>
        <p className="muted" data-never-sends="true">
          {t.t("sim.neverSends")}
        </p>
        <form action={basePath} method="get" role="search" className="inbox-search">
          <label htmlFor="settings-ask">{t.t("sim.queryLabel")}</label>
          <input id="settings-ask" name="ask" type="search" defaultValue={ask ?? ""} />
          <button className="button" type="submit">
            {t.t("sim.run")}
          </button>
        </form>

        {ask === undefined ? undefined : (
          <div data-simulation="true">
            {simulation.modelConfigured ? undefined : (
              <p className="notice" data-no-model="true">
                {t.t("sim.noModel")}
              </p>
            )}
            {simulation.failure === undefined ? undefined : (
              <p className="notice" data-tone="stop" data-failed="true">
                {t.t("sim.failed")}
              </p>
            )}

            <h3>{t.t("sim.reply")}</h3>
            {simulation.reply === undefined ? <p className="muted">{t.t("sim.noReply")}</p> : <p className="message-text">{simulation.reply}</p>}

            {simulation.confidence === undefined ? undefined : (
              <p className="muted">
                {t.t("sim.confidence")}: {t.number(simulation.confidence, { style: "percent", maximumFractionDigits: 0 })}
              </p>
            )}

            {simulation.reasonCodes.length === 0 ? undefined : (
              <>
                <h4>{t.t("sim.reasons")}</h4>
                <ul className="reason-codes">
                  {simulation.reasonCodes.map((code) => (
                    <li key={code} data-reason={code}>
                      <code>{code}</code>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {simulation.suggestedLeadStage === undefined ? undefined : (
              <p className="muted" data-lead-stage={simulation.suggestedLeadStage}>
                {t.t("sim.leadStage")}: {simulation.suggestedLeadStage}
              </p>
            )}

            {/* The outcome, in operational language. The spec is explicit that the UI must never imply
                raw confidence alone decides this. */}
            {simulation.policy === undefined ? undefined : (
              <>
                <p data-decision={simulation.policy.action}>
                  <strong>{t.t("sim.outcome")}:</strong> {t.t(`policyAction.${simulation.policy.action}` as MessageKey)}
                </p>
                {/* The gates' own reasons, which are the answer to "why not send?" — and the reason the
                    screen can say the outcome is not decided by model confidence alone. */}
                {simulation.policy.reasons.length === 0 ? undefined : (
                  <p className="muted">
                    {t.t("sim.policyReasons")}: {simulation.policy.reasons.join(", ")}
                  </p>
                )}
              </>
            )}
            <p className="muted">{t.t("sim.hypothetical")}</p>

            <h4>{t.t("sim.knowledge")}</h4>
            <ol className="retrieval-hits">
              {simulation.knowledge.map((hit) => (
                <li key={hit.chunkId} data-chunk={hit.chunkId}>
                  <p className="message-text">{hit.text}</p>
                  <p className="muted">{hit.documentTitle}</p>
                </li>
              ))}
            </ol>

            <h4>{t.t("sim.style")}</h4>
            <ol className="retrieval-hits">
              {simulation.style.map((hit) => (
                <li key={hit.exampleId} data-example={hit.exampleId}>
                  <p className="message-text">{hit.outboundText}</p>
                </li>
              ))}
            </ol>
          </div>
        )}
      </section>

      <section className="knowledge-history">
        <h2>{t.t("settings.auditTitle")}</h2>
        {audits.length === 0 ? (
          <p className="muted" data-empty="true">
            {t.t("settings.auditEmpty")}
          </p>
        ) : (
          <ol>
            {audits.map((audit) => (
              <li key={audit.id} data-audit={audit.id}>
                <p>{t.t("settings.auditEntry", { name: audit.actorName ?? t.t("knowledge.unknownAuthor"), time: t.date(audit.changedAt, { dateStyle: "short", timeStyle: "short" }) })}</p>
                {audit.impacts.length === 0 ? (
                  <p className="muted">{t.t("settings.auditNoImpact")}</p>
                ) : (
                  <ul>
                    {audit.impacts.map((impact) => (
                      <li key={impact} data-impact={impact}>
                        {(POLICY_IMPACTS as readonly string[]).includes(impact) ? t.t(`impact.${impact}` as MessageKey) : impact}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}
