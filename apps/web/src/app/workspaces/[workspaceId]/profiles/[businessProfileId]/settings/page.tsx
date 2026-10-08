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
 *
 * Three arrangements worth naming, because each answers a way this screen was previously wrong:
 *
 * - **the form is rendered from the pending proposal when there is one**, so a refused high-impact change
 *   is confirmed next to the values it describes rather than next to the stored ones;
 * - **the acknowledgement is the summary's own checkbox**, carrying the impact codes it acknowledges, and
 *   it exists only on a render that showed them;
 * - **the history is paged and shows both sides of every change**, because a record that cannot be read is
 *   not meaningfully kept.
 */
import { listPolicyAudits, readPolicies } from "@omnichannel/db";
import { CONFIDENCE_PRESETS, POLICY_IMPACTS, TIMING_PRESETS } from "@omnichannel/domain";

import { OutcomeNotice } from "@/ui/outcome-notice";
import { requestTranslator } from "@/i18n/request-locale";
import { requireBusinessProfileContext } from "@/server/request-context";
import { getDb } from "@/server/db";
import { saveSettingsAction } from "@/server/settings-actions";
import {
  auditHistoryHref,
  decodeAuditCursor,
  decodeProposal,
  impactsFromQuery,
  MAX_PROPOSAL_FIELD_CHARS,
  mayEditSettings,
  one,
  policyChangeDiff,
  simulationInputsFrom,
} from "@/server/settings-view";
import { runSimulation, SIMULATION_ACCOUNTS, SIMULATION_CHANNELS, SIMULATION_HUMAN_SUPPORT, SIMULATION_WINDOWS } from "@/server/simulation";
import type { MessageKey } from "@/i18n/catalogue";
import type { RawSearchParams } from "@/server/inbox-view";

const MODES = ["OFF", "DRAFT", "AUTOPILOT"] as const;
const INSTAGRAM = ["STANDARD_ONLY", "HUMAN_ASSISTED_EXTENDED"] as const;
const WHATSAPP = ["SERVICE_WINDOW_ONLY", "TEMPLATE_REVIEW", "TEMPLATE_AUTOPILOT"] as const;
const MS_PER_SECOND = 1_000;

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
  const auditCursor = decodeAuditCursor(one(query["auditCursor"]));

  const [policies, audits] = await Promise.all([
    readPolicies(getDb(), context),
    listPolicyAudits(getDb(), context, { limit: 20, ...(auditCursor === undefined ? {} : { cursor: auditCursor }) }),
  ]);
  const stored = policies.find((candidate) => candidate.channelAccountId === null);
  // The store refuses a save from anyone else, so a form offered to an AGENT would be a form that cannot
  // be submitted. Showing the settings read-only is the honest version of the same restriction.
  const mayEdit = mayEditSettings(context.role);

  const ask = one(query["ask"]);
  const simulationInputs = simulationInputsFrom(query);
  const simulation = await runSimulation(context, ask ?? "", simulationInputs);

  // The impacts the server refused to save without an acknowledgement, and the proposal it refused.
  const pending = impactsFromQuery(one(query["impacts"]));
  const proposed = decodeProposal(one(query["proposal"]));
  // What the form shows: the rejected proposal when there is one, otherwise what is stored. The version
  // always comes from the proposal when it has one, so confirming re-submits the same claim about the
  // world rather than a fresh one — if the policy moved meanwhile, the store refuses it as a conflict.
  const form =
    stored === undefined
      ? undefined
      : {
          mode: proposed?.mode ?? stored.mode,
          businessGoal: proposed?.businessGoal ?? stored.businessGoal ?? "",
          criteria: (proposed?.qualificationCriteria ?? stored.qualificationCriteria).join("\n"),
          confidencePreset: proposed?.confidencePreset ?? stored.confidencePreset ?? "",
          timingPreset: proposed?.timingPreset ?? stored.timingPreset,
          debounceMinSeconds: Math.round((proposed?.timing?.debounceWindowMs.minMs ?? stored.debounceWindowMs.minMs) / MS_PER_SECOND),
          debounceMaxSeconds: Math.round((proposed?.timing?.debounceWindowMs.maxMs ?? stored.debounceWindowMs.maxMs) / MS_PER_SECOND),
          deliveryDelayMinSeconds: Math.round((proposed?.timing?.deliveryDelayMs.minMs ?? stored.deliveryDelayMs.minMs) / MS_PER_SECOND),
          deliveryDelayMaxSeconds: Math.round((proposed?.timing?.deliveryDelayMs.maxMs ?? stored.deliveryDelayMs.maxMs) / MS_PER_SECOND),
          takeoverPauseHours: proposed?.takeoverPauseHours ?? Math.round(stored.takeoverPauseMs / 3_600_000),
          instagramAfterWindowPolicy: proposed?.instagramAfterWindowPolicy ?? stored.instagramAfterWindowPolicy,
          whatsappAfterWindowPolicy: proposed?.whatsappAfterWindowPolicy ?? stored.whatsappAfterWindowPolicy,
          allowlist: (proposed?.whatsappTemplateAutomationAllowlist ?? stored.whatsappTemplateAutomationAllowlist).join("\n"),
          expectedVersion: proposed?.expectedVersion ?? stored.version,
        };

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
          {/* Said plainly, because the form below is showing the proposal rather than what is stored. */}
          <p>{t.t("settings.confirmPending")}</p>
        </div>
      )}

      {one(query["outcome"]) !== "CONFLICT" || proposed === undefined ? undefined : (
        <div className="notice" data-tone="stop" data-stale-proposal="true" role="alert">
          {/* Said here rather than in the shared outcome line, because the shared one tells the reader to
              reload — and reloading would discard the values this form is still showing. What they need
              to know is that these are *their* values, that somebody else's change is already stored, and
              that saving again applies theirs over it. What the other person changed is in the history
              below, with both sides of every field. */}
          <p>{t.t("settings.conflictProposal")}</p>
        </div>
      )}

      {!mayEdit ? (
        <p className="notice" data-tone="stop" data-read-only="true">
          {t.t("settings.readOnly")}
        </p>
      ) : undefined}

      {form === undefined ? undefined : (
        <form action={saveSettingsAction.bind(null, target)} className="knowledge-editor">
          {/* The version this form was rendered from. A save that names another one is refused rather than
              applied, so a second tab cannot revert a change its author never saw. */}
          <input type="hidden" name="expectedVersion" value={String(form.expectedVersion)} />

          <label htmlFor="settings-mode">{t.t("settings.mode")}</label>
          <select id="settings-mode" name="mode" defaultValue={form.mode} disabled={!mayEdit}>
            {MODES.map((mode) => (
              <option key={mode} value={mode}>
                {t.t(`aiMode.${mode}`)}
              </option>
            ))}
          </select>

          <label htmlFor="settings-goal">{t.t("settings.goal")}</label>
          <input
            id="settings-goal"
            name="businessGoal"
            type="text"
            maxLength={MAX_PROPOSAL_FIELD_CHARS}
            defaultValue={form.businessGoal}
            disabled={!mayEdit}
          />
          <p className="muted">{t.t("settings.goalHint")}</p>

          <label htmlFor="settings-criteria">{t.t("settings.criteria")}</label>
          <textarea id="settings-criteria" name="criteria" rows={3} defaultValue={form.criteria} disabled={!mayEdit} />

          <label htmlFor="settings-confidence">{t.t("settings.confidence")}</label>
          <select id="settings-confidence" name="confidencePreset" defaultValue={form.confidencePreset} disabled={!mayEdit}>
            {/* An owner who tuned values by hand is told so rather than shown a preset that no longer
                describes them. Choosing a preset then replaces those values. */}
            {form.confidencePreset === "" ? <option value="">{t.t("settings.custom")}</option> : undefined}
            {CONFIDENCE_PRESETS.map((preset) => (
              <option key={preset} value={preset}>
                {t.t(`confidencePreset.${preset}`)}
              </option>
            ))}
          </select>

          <label htmlFor="settings-timing">{t.t("settings.timing")}</label>
          <select id="settings-timing" name="timingPreset" defaultValue={form.timingPreset} disabled={!mayEdit}>
            {TIMING_PRESETS.map((preset) => (
              <option key={preset} value={preset}>
                {t.t(`timingPreset.${preset}`)}
              </option>
            ))}
          </select>
          <p className="muted">{t.t("settings.timingHint")}</p>

          {/* The four numbers CUSTOM means. Present whichever preset is selected, and only read when the
              preset is CUSTOM: a named preset carries its own ranges, and sending both is a contradiction
              the store refuses. Rendering them only for CUSTOM would mean selecting Custom saved the old
              ranges and required a second round trip before the inputs even appeared — which is how
              "Custom" came to be a preset an owner could choose and not configure.

              The preset shown here is always *derived* from the stored ranges and never stored itself, so
              choosing Custom and saving the numbers unchanged leaves the screen naming the preset those
              numbers match. That is the design holding rather than failing: the label describes the values,
              so it cannot drift from them, and "Custom" means ranges that match no preset. */}
          <fieldset data-custom-timing="true">
            <legend>{t.t("settings.customTiming")}</legend>
            <p className="muted">{t.t("settings.customTimingHint")}</p>

            <label htmlFor="settings-debounce-min">{t.t("settings.debounceMin")}</label>
            <input
              id="settings-debounce-min"
              name="debounceMinSeconds"
              type="number"
              min="0"
              max="600"
              defaultValue={form.debounceMinSeconds}
              disabled={!mayEdit}
            />

            <label htmlFor="settings-debounce-max">{t.t("settings.debounceMax")}</label>
            <input
              id="settings-debounce-max"
              name="debounceMaxSeconds"
              type="number"
              min="0"
              max="600"
              defaultValue={form.debounceMaxSeconds}
              disabled={!mayEdit}
            />

            <label htmlFor="settings-delay-min">{t.t("settings.deliveryDelayMin")}</label>
            <input
              id="settings-delay-min"
              name="deliveryDelayMinSeconds"
              type="number"
              min="0"
              max="86400"
              defaultValue={form.deliveryDelayMinSeconds}
              disabled={!mayEdit}
            />

            <label htmlFor="settings-delay-max">{t.t("settings.deliveryDelayMax")}</label>
            <input
              id="settings-delay-max"
              name="deliveryDelayMaxSeconds"
              type="number"
              min="0"
              max="86400"
              defaultValue={form.deliveryDelayMaxSeconds}
              disabled={!mayEdit}
            />
          </fieldset>

          <label htmlFor="settings-takeover">{t.t("settings.takeoverPause")}</label>
          <input
            id="settings-takeover"
            name="takeoverPauseHours"
            type="number"
            min="1"
            max="168"
            defaultValue={form.takeoverPauseHours}
            disabled={!mayEdit}
          />

          <label htmlFor="settings-instagram">{t.t("settings.instagram")}</label>
          <select id="settings-instagram" name="instagramAfterWindowPolicy" defaultValue={form.instagramAfterWindowPolicy} disabled={!mayEdit}>
            {INSTAGRAM.map((value) => (
              <option key={value} value={value}>
                {t.t(`instagramAfterWindow.${value}`)}
              </option>
            ))}
          </select>

          <label htmlFor="settings-whatsapp">{t.t("settings.whatsapp")}</label>
          <select id="settings-whatsapp" name="whatsappAfterWindowPolicy" defaultValue={form.whatsappAfterWindowPolicy} disabled={!mayEdit}>
            {WHATSAPP.map((value) => (
              <option key={value} value={value}>
                {t.t(`whatsappAfterWindow.${value}`)}
              </option>
            ))}
          </select>

          <label htmlFor="settings-allowlist">{t.t("settings.allowlist")}</label>
          <textarea id="settings-allowlist" name="allowlist" rows={3} defaultValue={form.allowlist} disabled={!mayEdit} />
          {form.whatsappAfterWindowPolicy === "TEMPLATE_AUTOPILOT" && form.allowlist.trim() === "" ? (
            <p className="notice" data-tone="stop" data-empty-allowlist="true">
              {t.t("settings.allowlistEmpty")}
            </p>
          ) : undefined}

          {/* The acknowledgement, and only on a render that showed the summary above. Its value *is* the
              list of impacts it acknowledges: the server recomputes them and compares, so a tick cannot
              stand for a change the owner never read, and a stale tick cannot stand for a different one.
              An always-present checkbox made "show the effect summary before save" skippable by ticking
              it first. */}
          {pending.length === 0 || !mayEdit ? undefined : (
            <label className="checkbox" htmlFor="settings-confirm">
              <input id="settings-confirm" type="checkbox" name="acknowledged" value={pending.join(",")} />
              {t.t("settings.confirmAck")}
            </label>
          )}

          <button className="button primary" type="submit" data-action="save-settings" disabled={!mayEdit}>
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

          {/* The facts a hypothetical message cannot carry. Explicit, because every run used to assume
              Instagram inside an open window on a healthy account — so the WhatsApp settings below could
              not affect the answer, and neither Instagram after-window choice was ever exercised. */}
          <label htmlFor="sim-channel">{t.t("sim.channel")}</label>
          <select id="sim-channel" name="simChannel" defaultValue={simulationInputs.channel}>
            {SIMULATION_CHANNELS.map((channel) => (
              <option key={channel} value={channel}>
                {t.t(`channel.${channel}`)}
              </option>
            ))}
          </select>

          <label htmlFor="sim-window">{t.t("sim.window")}</label>
          <select id="sim-window" name="simWindow" defaultValue={simulationInputs.window}>
            {SIMULATION_WINDOWS.map((window) => (
              <option key={window} value={window}>
                {t.t(`simWindow.${window}`)}
              </option>
            ))}
          </select>

          <label htmlFor="sim-account">{t.t("sim.account")}</label>
          <select id="sim-account" name="simAccount" defaultValue={simulationInputs.account}>
            {SIMULATION_ACCOUNTS.map((account) => (
              <option key={account} value={account}>
                {t.t(`simAccount.${account}`)}
              </option>
            ))}
          </select>

          {/* The input that makes the Instagram choice above mean something: that policy opens a
              human-only review path *only* while the exception is live, so with it assumed away both
              Instagram choices gave the same refusal and nothing selected here could change an answer. */}
          <label htmlFor="sim-human-support">{t.t("sim.humanSupport")}</label>
          <select id="sim-human-support" name="simHumanSupport" defaultValue={simulationInputs.humanSupport}>
            {SIMULATION_HUMAN_SUPPORT.map((value) => (
              <option key={value} value={value}>
                {t.t(`simHumanSupport.${value}`)}
              </option>
            ))}
          </select>

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

            {/* What this answer is about. Without it the outcome below is a claim with no stated case. */}
            <p className="muted" data-sim-inputs="true">
              {t.t("sim.inputsUsed", {
                channel: t.t(`channel.${simulation.inputs.channel}`),
                window: t.t(`simWindow.${simulation.inputs.window}`),
                account: t.t(`simAccount.${simulation.inputs.account}`),
                humanSupport: t.t(`simHumanSupport.${simulation.inputs.humanSupport}`),
              })}
            </p>

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
            {/* Said where an owner would otherwise draw the wrong conclusion. This run drafts a free-form
                reply, so it answers the free-form path; whether an approved template may go out is the
                template rules' decision and not this one. Without this line, a WhatsApp run whose outcome
                does not move when the allowlist changes reads as proof that the allowlist does nothing. */}
            {simulation.inputs.channel === "WHATSAPP" ? (
              <p className="muted" data-sim-scope="true">
                {t.t("sim.freeformOnly")}
              </p>
            ) : undefined}

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
        {audits.entries.length === 0 ? (
          <p className="muted" data-empty="true">
            {t.t("settings.auditEmpty")}
          </p>
        ) : (
          <ol>
            {audits.entries.map((audit) => (
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
                {/* Both sides of every field that moved, which is what the spec asks of a material
                    change. Only the fields that moved: an entry listing every column hides the one
                    that did. */}
                <dl data-audit-values="true">
                  {policyChangeDiff(audit.before, audit.after).map((change) => (
                    <div key={change.field} data-field={change.field}>
                      <dt>{t.t(`policyField.${change.field}` as MessageKey)}</dt>
                      <dd>
                        {t.t("settings.auditChange", {
                          before: change.before === undefined || change.before === "" ? t.t("settings.auditNoValue") : change.before,
                          after: change.after === undefined || change.after === "" ? t.t("settings.auditNoValue") : change.after,
                        })}
                      </dd>
                    </div>
                  ))}
                </dl>
              </li>
            ))}
          </ol>
        )}
        {/* Older entries are reachable rather than merely retained: the read is paged, and this is the
            link that continues it. */}
        {audits.nextCursor === undefined ? undefined : (
          <a className="button" data-audit-more="true" href={auditHistoryHref(basePath, query, audits.nextCursor)}>
            {t.t("settings.auditOlder")}
          </a>
        )}
      </section>
    </>
  );
}
