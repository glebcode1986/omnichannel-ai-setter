/**
 * Replying in your own words (ADR-018 Option B, accepted 2026-09-30; Issue #29).
 *
 * The composer hands wording to the same delivery coordinator automation uses. It does not send, and the
 * pane says so — because the difference matters to whoever presses the button: their reply is queued and
 * then re-checked against the takeover, a newer inbound message, the provider's window, the account's
 * health and the kill switch. A composer that promised delivery would be making a claim the coordinator
 * has not agreed to yet.
 *
 * While one reply is queued the box is gone rather than disabled. Disabled reads as "you may not"; the
 * truth is that one of theirs is already waiting, and the pane points at it so they can stop it.
 */
import type { ConversationDetail } from "@omnichannel/db";

import type { Translator } from "@/i18n/translate";
import type { ConversationTarget } from "@/server/review-actions";

export interface ComposerProps {
  readonly t: Translator;
  readonly conversation: ConversationDetail;
  readonly target: { readonly workspaceId: string; readonly businessProfileId: string };
  /** True when a reply of this person's is already queued for this conversation. */
  readonly hasPendingReply: boolean;
  /** Whether the provider's human-support path is available to authorize (ADR-014). */
  readonly humanAgentAvailable: boolean;
  readonly action: (target: ConversationTarget, formData: FormData) => Promise<void>;
}

export function Composer({ t, conversation, target, hasPendingReply, humanAgentAvailable, action }: ComposerProps) {
  const conversationTarget: ConversationTarget = { ...target, conversationId: conversation.id };

  if (conversation.status !== "OPEN") {
    return (
      <p className="muted" data-composer="closed">
        {t.t("composer.closed")}
      </p>
    );
  }

  if (hasPendingReply) {
    // Absent, not disabled: one of theirs is already waiting, and the pending-send card above is where
    // they stop it.
    return (
      <p className="muted" data-composer="pending">
        {t.t("composer.pending")}
      </p>
    );
  }

  return (
    <form action={action.bind(null, conversationTarget)} className="knowledge-editor" data-composer="open">
      <h3>{t.t("composer.title")}</h3>
      <label htmlFor="composer-text">{t.t("composer.label")}</label>
      <textarea id="composer-text" name="text" rows={3} required />

      {humanAgentAvailable ? (
        <>
          <label className="checkbox" htmlFor="composer-human-agent">
            {/* A checkbox rather than a second button, because it changes *which send* is authorized
                rather than whether one happens. The value is read server-side. */}
            <input id="composer-human-agent" type="checkbox" name="reviewMode" value="HUMAN_AGENT" />
            {t.t("composer.humanAgent")}
          </label>
          <p className="muted">{t.t("composer.humanAgentHint")}</p>
        </>
      ) : undefined}

      <button className="button primary" type="submit" data-action="compose">
        {t.t("composer.send")}
      </button>
      {/* Said plainly: pressing this queues a reply, it does not deliver one. */}
      <p className="muted" data-gates-note="true">
        {t.t("composer.gatesNote")}
      </p>
    </form>
  );
}
