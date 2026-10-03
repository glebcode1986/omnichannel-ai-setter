/**
 * One item in the Review queue (PRODUCT_UX.md, HUMAN_HANDOFF.md, Issue #29).
 *
 * The card's job is to make a decision *informed*, which means showing the three things the gates knew
 * and the operator otherwise would not: why the reply is waiting, what the knowledge base supplied versus
 * what the model actually used, and which send a decision here would authorize. Reason codes are shown as
 * the gates wrote them — an identifier someone can quote at us is worth more than a paraphrase that loses
 * it — with the sentence that matters underneath.
 *
 * Each item is decided on its own. There is no select-all and no bulk approve, and that is a product rule
 * rather than a missing feature: a person approving twenty customer-facing replies with one click has not
 * reviewed twenty replies. The card says so once, quietly, so nobody files it as an omission.
 *
 * A stale item still renders, with its send controls gone rather than disabled. Disabled reads as "you may
 * not"; the truth is that the customer has moved on and there is nothing here to send. Dismissing stays,
 * because somebody has to be able to clear it.
 */
import Link from "next/link";
import type { ReviewItem } from "@omnichannel/db";

import type { MessageKey } from "@/i18n/catalogue";
import type { Translator } from "@/i18n/translate";
import type { ConversationTarget } from "@/server/review-actions";

export interface ReviewCardProps {
  readonly t: Translator;
  readonly item: ReviewItem;
  readonly basePath: string;
  /** Where the person is deciding from, so the action returns them there. */
  readonly from: "review" | "inbox";
  readonly actions: {
    readonly approve: (target: ConversationTarget, formData: FormData) => Promise<void>;
    readonly editAndSend: (target: ConversationTarget, formData: FormData) => Promise<void>;
    readonly dismiss: (target: ConversationTarget, formData: FormData) => Promise<void>;
    readonly claim: (target: ConversationTarget, formData: FormData) => Promise<void>;
  };
  readonly target: { readonly workspaceId: string; readonly businessProfileId: string };
}

/** Reason codes whose consequence needs a sentence, not just the code. */
const EXPLAINED: Partial<Record<string, MessageKey>> = {
  HUMAN_AGENT_REVIEW_REQUIRED: "review.humanAgentSend",
  TEMPLATE_REQUIRED: "review.templateRequired",
};

export function ReviewCard({ t, item, basePath, from, actions, target }: ReviewCardProps) {
  const conversationTarget: ConversationTarget = { ...target, conversationId: item.conversationId };
  const bind = (action: (target: ConversationTarget, formData: FormData) => Promise<void>) => action.bind(null, conversationTarget);
  /** Carried on every form so the decision returns the person to the surface they acted from. */
  const context = (
    <>
      <input type="hidden" name="draftId" value={item.draftId} />
      <input type="hidden" name="from" value={from} />
      <input type="hidden" name="reviewMode" value={item.reviewMode} />
    </>
  );

  return (
    <article className="review-card" data-draft={item.draftId} data-stale={String(item.stale)} data-review-mode={item.reviewMode}>
      <header className="review-head">
        <Link href={`${basePath}/inbox/${item.conversationId}`}>{item.contactName ?? item.handle}</Link>
        <span className="badge" data-tone="muted" data-channel={item.channel}>
          {t.t(`channel.${item.channel}` as MessageKey)}
        </span>
        {item.reviewMode === "HUMAN_AGENT" ? (
          <span className="badge" data-tone="warn" data-human-agent="true">
            {t.t("transportPath.HUMAN_AGENT")}
          </span>
        ) : undefined}
        {item.stale ? (
          <span className="badge" data-tone="stop" data-stale-badge="true">
            {t.t("review.staleShort")}
          </span>
        ) : undefined}
        <time className="muted" dateTime={item.createdAt.toISOString()}>
          {t.t("review.waitingSince", { time: t.date(item.createdAt, { dateStyle: "short", timeStyle: "short" }) })}
        </time>
      </header>

      <section className="review-why">
        <h4>{t.t("review.whyHeld")}</h4>
        <ul className="reason-codes">
          {item.reasonCodes.map((code) => (
            <li key={code} data-reason={code}>
              <code>{code}</code>
              {EXPLAINED[code] === undefined ? undefined : <span className="muted"> {t.t(EXPLAINED[code])}</span>}
            </li>
          ))}
        </ul>
        <p className="muted">
          {t.t("context.confidence")}: {t.number(item.confidence, { style: "percent", maximumFractionDigits: 0 })}
        </p>
        {/* Supplied and cited are different numbers on purpose: "it had nothing to go on" and "it ignored
            what it had" are different problems wearing the same empty list. */}
        {item.retrieval.status === "UNAVAILABLE" ? (
          <p className="muted" data-retrieval="UNAVAILABLE">
            {t.t("review.retrievalUnavailable")}
          </p>
        ) : (
          <p className="muted" data-retrieval="OK">
            {t.t("review.factsSupplied", { count: item.retrieval.suppliedCount })} ·{" "}
            {t.t("review.factsCited", { count: item.citedSourceIds.length })}
          </p>
        )}
      </section>

      <section className="review-draft">
        <h4>{t.t("review.draftHeading")}</h4>
        {item.text === null ? <p className="muted">{t.t("review.noText")}</p> : <p className="message-text">{item.text}</p>}
      </section>

      {item.stale ? (
        <p className="notice" data-tone="stop" role="status">
          {t.t("review.stale")}
        </p>
      ) : undefined}

      <div className="review-actions">
        {/* Sending is only offered where a send is possible: a stale item has nothing to send, and a
            draft with no usable text has no wording to approve. */}
        {item.stale || item.text === null ? undefined : (
          <>
            <form action={bind(actions.approve)}>
              {context}
              <button className="button primary" type="submit" data-action="approve">
                {t.t("review.approve")}
              </button>
            </form>

            <form action={bind(actions.editAndSend)} className="review-edit">
              {context}
              <label htmlFor={`edit-${item.draftId}`}>{t.t("review.editLabel")}</label>
              <textarea id={`edit-${item.draftId}`} name="text" rows={3} defaultValue={item.text} />
              <label className="checkbox" htmlFor={`learn-${item.draftId}`}>
                <input id={`learn-${item.draftId}`} type="checkbox" name="learn" />
                {t.t("review.learn")}
              </label>
              <button className="button" type="submit" data-action="edit">
                {t.t("review.edit")}
              </button>
            </form>
          </>
        )}

        <form action={bind(actions.dismiss)} className="review-dismiss">
          {context}
          <label htmlFor={`note-${item.draftId}`}>{t.t("review.dismissNote")}</label>
          <input id={`note-${item.draftId}`} name="note" type="text" />
          <button className="button" type="submit" data-action="dismiss">
            {t.t("review.dismiss")}
          </button>
        </form>

        <form action={bind(actions.claim)}>
          {context}
          <button className="button" type="submit" data-action="claim">
            {t.t("review.claim")}
          </button>
        </form>
      </div>
    </article>
  );
}
