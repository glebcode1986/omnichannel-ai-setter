/**
 * Taking a conversation, handing it back, and stopping a reply before it goes out (Issue #29).
 *
 * The one thing this must never do is offer to stop a send it cannot stop. A delivery the worker has
 * claimed may be at the provider already, and ADR-012 forbids guessing about a send whose outcome is
 * unknown — so a claimed send is shown *without* a cancel button and with a sentence saying why. Offering
 * the button and failing afterwards would imply the customer did not receive something they may well have.
 *
 * Every control is a form posting to a server action. There is no optimistic state: the delivery
 * coordinator decides whether a send happens, and a button that turned green before the server agreed
 * would be the UI reporting a platform outcome it does not know.
 */
import type { ConversationDetail } from "@omnichannel/db";

import type { Translator } from "@/i18n/translate";
import type { ConversationTarget } from "@/server/review-actions";

export interface ConversationControlsProps {
  readonly t: Translator;
  readonly conversation: ConversationDetail;
  readonly target: { readonly workspaceId: string; readonly businessProfileId: string };
  /** The signed-in member, so the pane can say "you" rather than naming them to themselves. */
  readonly viewerUserId: string;
  readonly takeoverByUserId: string | null;
  readonly takeoverPausedUntil: Date | null;
  readonly actions: {
    readonly takeOver: (target: ConversationTarget, formData: FormData) => Promise<void>;
    readonly handBack: (target: ConversationTarget, formData: FormData) => Promise<void>;
    readonly cancelSend: (target: ConversationTarget, formData: FormData) => Promise<void>;
  };
}

export function ConversationControls({
  t,
  conversation,
  target,
  viewerUserId,
  takeoverByUserId,
  takeoverPausedUntil,
  actions,
}: ConversationControlsProps) {
  const conversationTarget: ConversationTarget = { ...target, conversationId: conversation.id };
  const bind = (action: (target: ConversationTarget, formData: FormData) => Promise<void>) => action.bind(null, conversationTarget);
  const held = conversation.takeoverState === "HUMAN_ACTIVE";
  const heldByViewer = held && takeoverByUserId === viewerUserId;

  return (
    <section className="conversation-controls" aria-labelledby="conversation-controls-heading">
      <h3 id="conversation-controls-heading">{t.t("control.title")}</h3>

      {held ? (
        <p className="muted" data-held={heldByViewer ? "you" : "someone"}>
          {heldByViewer
            ? t.t("control.heldByYou")
            : t.t("control.heldBySomeone", { name: conversation.takeoverByName ?? t.t("messageSource.HUMAN") })}
        </p>
      ) : undefined}

      {takeoverPausedUntil === null ? undefined : (
        <p className="muted" data-paused-until={takeoverPausedUntil.toISOString()}>
          {t.t("control.pausedUntil", { time: t.date(takeoverPausedUntil, { dateStyle: "short", timeStyle: "short" }) })}
        </p>
      )}

      <div className="control-row">
        {held ? (
          <form action={bind(actions.handBack)}>
            <button className="button" type="submit" data-action="hand-back">
              {t.t("control.handBack")}
            </button>
          </form>
        ) : (
          <form action={bind(actions.takeOver)}>
            <button className="button" type="submit" data-action="take-over">
              {t.t("control.takeOver")}
            </button>
          </form>
        )}

        {/* A pause is a hand-back with a deadline: automation stays out until then. */}
        <form action={bind(actions.handBack)} className="control-pause">
          <label htmlFor="pause-hours">{t.t("control.pauseHours")}</label>
          <input id="pause-hours" name="pauseHours" type="number" min="1" max="72" defaultValue="6" />
          <button className="button" type="submit" data-action="pause">
            {t.t("control.pause")}
          </button>
        </form>
      </div>

      {conversation.pendingSends.length === 0 ? undefined : (
        <section className="pending-sends">
          <h4>{t.t("control.pendingTitle")}</h4>
          <ul>
            {conversation.pendingSends.map((send) => (
              <li key={send.operationId} data-operation={send.operationId} data-claimed={String(send.claimed)}>
                <time dateTime={send.scheduledFor.toISOString()}>
                  {t.t("control.pendingAt", { time: t.date(send.scheduledFor, { dateStyle: "short", timeStyle: "short" }) })}
                </time>
                {send.text === null ? undefined : <p className="message-text">{send.text}</p>}
                {send.claimed ? (
                  // No cancel control at all. The send may already be at the provider, and a button that
                  // failed afterwards would suggest the customer did not get it.
                  <p className="muted" data-uncancellable="true">
                    {t.t("control.sending")}
                  </p>
                ) : (
                  <form action={bind(actions.cancelSend)}>
                    <input type="hidden" name="operationId" value={send.operationId} />
                    <button className="button" type="submit" data-action="cancel-send">
                      {t.t("control.cancelSend")}
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>
          {/* The window's own edge. Cancelling a visible send takes it out of this window and the next
              one appears, so every queued reply is reachable — but nothing said there was anything left
              to reach, and the read's own comment is that a send the operator cannot see is a send they
              cannot stop. */}
          {conversation.pendingSendsBeyondWindow === 0 ? undefined : (
            <p className="muted" data-pending-beyond={conversation.pendingSendsBeyondWindow}>
              {t.plural("control.pendingBeyond", conversation.pendingSendsBeyondWindow, { count: t.number(conversation.pendingSendsBeyondWindow) })}
            </p>
          )}
        </section>
      )}
    </section>
  );
}
