/**
 * The Inbox's right pane (PRODUCT_UX.md, Issue #28).
 *
 * This pane answers "why did the assistant do that, and who owns this conversation now" — the two
 * questions an operator has before touching a reply. Reason codes and cited source ids come from the
 * draft record exactly as the gates wrote them; they are not re-derived here, because a second
 * implementation of the same judgement would eventually disagree with the one that actually ran.
 *
 * It is display only. Approving, editing and rejecting belong to the Review queue (Issue #29), and the
 * panel says so in words rather than showing buttons that do nothing — a disabled Approve button reads
 * as "not allowed", which is a different and false statement.
 */
import type { ConversationDetail } from "@omnichannel/db";

import type { MessageKey } from "@/i18n/catalogue";
import type { Translator } from "@/i18n/translate";

export interface ContextPanelProps {
  readonly t: Translator;
  readonly conversation: ConversationDetail;
}

const KNOWN_STAGES = new Set(["NEW", "ENGAGED", "QUALIFYING", "QUALIFIED", "BOOKED", "WON", "LOST"]);
const KNOWN_MODES = new Set(["OFF", "DRAFT", "AUTOPILOT"]);

export function ContextPanel({ t, conversation }: ContextPanelProps) {
  const draft = conversation.latestDraft;

  return (
    <aside className="inbox-context" aria-labelledby="inbox-context-heading">
      <h2 className="visually-hidden" id="inbox-context-heading">
        {t.t("inbox.contextLabel")}
      </h2>

      <section>
        <h3>{t.t("context.contactTitle")}</h3>
        <p>
          <strong>{conversation.contactName ?? conversation.handle}</strong>
        </p>
        <p className="muted">{conversation.handle}</p>
      </section>

      <section>
        <h3>{t.t("context.leadTitle")}</h3>
        <p>
          <span className="badge" data-tone="muted" data-lead={conversation.leadStage}>
            {stageLabel(t, conversation.leadStage)}
          </span>
        </p>
      </section>

      <section>
        <h3>{t.t("context.channelTitle")}</h3>
        <p className="muted" data-channel={conversation.channel}>
          {t.t(`channel.${conversation.channel}` as MessageKey)}
        </p>
        {/* The effective mode, which is the conversation's override when it has one. */}
        <p className="muted" data-mode={conversation.mode ?? "INHERITED"}>
          {conversation.mode === null ? t.t("aiMode.OFF") : modeLabel(t, conversation.mode)}
        </p>
        <dl className="context-times">
          <dt>{t.t("context.lastInbound")}</dt>
          <dd>{conversation.lastInboundAt === null ? t.t("context.never") : t.date(conversation.lastInboundAt, { dateStyle: "medium", timeStyle: "short" })}</dd>
          <dt>{t.t("context.lastOutbound")}</dt>
          <dd>{conversation.lastOutboundAt === null ? t.t("context.never") : t.date(conversation.lastOutboundAt, { dateStyle: "medium", timeStyle: "short" })}</dd>
        </dl>
      </section>

      <section>
        <h3>{t.t("context.takeoverTitle")}</h3>
        {conversation.takeoverState === "HUMAN_ACTIVE" ? (
          <p data-takeover="HUMAN_ACTIVE">
            {t.t("context.takeoverBy", { name: conversation.takeoverByName ?? t.t("messageSource.HUMAN") })}
            {conversation.humanTakeoverAt === null
              ? ""
              : ` ${t.t("context.takeoverSince", { time: t.date(conversation.humanTakeoverAt, { dateStyle: "medium", timeStyle: "short" }) })}`}
          </p>
        ) : conversation.takeoverState === "REVIEW_REQUIRED" ? (
          <p data-takeover="REVIEW_REQUIRED">{t.t("context.reviewQueued")}</p>
        ) : (
          <p className="muted" data-takeover="NONE">
            {t.t("context.takeoverNone")}
          </p>
        )}
      </section>

      <section>
        <h3>{t.t("context.assistantTitle")}</h3>
        {draft === undefined ? (
          <p className="muted" data-draft="none">
            {t.t("context.noDecision")}
          </p>
        ) : (
          <div data-draft={draft.id}>
            <p>
              {t.t("context.confidence")}: <strong>{t.number(draft.confidence, { style: "percent", maximumFractionDigits: 0 })}</strong>
            </p>
            {draft.intent === null ? undefined : (
              <p className="muted">
                {t.t("context.intent")}: {draft.intent}
              </p>
            )}
            {draft.suggestedLeadStage === null ? undefined : (
              <p className="muted">
                {t.t("context.suggestedStage")}: {stageLabel(t, draft.suggestedLeadStage)}
              </p>
            )}
            {draft.reasonCodes.length === 0 ? undefined : (
              <>
                <h4>{t.t("context.reasons")}</h4>
                <ul className="reason-codes">
                  {draft.reasonCodes.map((code) => (
                    // Shown as the gate wrote it. An untranslated code an operator can search for and
                    // quote in a bug report is worth more than a friendly sentence that loses it.
                    <li key={code} data-reason={code}>
                      <code>{code}</code>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <h4>{t.t("context.sources")}</h4>
            {draft.citedSourceIds.length === 0 ? (
              <p className="muted">{t.t("context.noSources")}</p>
            ) : (
              <ul className="cited-sources">
                {draft.citedSourceIds.map((id) => (
                  <li key={id} data-source-id={id}>
                    <code>{id}</code>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <p className="muted" data-review-actions="deferred">
          {t.t("context.reviewActionsLater")}
        </p>
      </section>
    </aside>
  );
}

function stageLabel(t: Translator, stage: string): string {
  return KNOWN_STAGES.has(stage) ? t.t(`leadStage.${stage}` as MessageKey) : stage;
}

function modeLabel(t: Translator, mode: string): string {
  return KNOWN_MODES.has(mode) ? t.t(`aiMode.${mode}` as MessageKey) : mode;
}
