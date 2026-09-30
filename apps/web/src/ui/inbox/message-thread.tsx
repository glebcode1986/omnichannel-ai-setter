/**
 * The Inbox's middle pane (PRODUCT_UX.md, Issue #28).
 *
 * The one thing this view owes an operator is an honest answer to "who said that?". A thread that renders
 * the assistant's words the same way it renders a colleague's is the fastest way to lose a customer's
 * trust, so `source` drives both the label and the styling, and the label is a word rather than a colour:
 * colour alone is not an answer for anyone reading this in greyscale or with a screen reader.
 *
 * Delivery state is shown where it is known and simply absent where it is not — an outbound message with
 * no status is not "delivered", and a dash would say more than the data does. `HUMAN_AGENT` is called out
 * because that transport carries different platform rules (ADR-004) and an operator watching a window
 * close needs to see which one a message went out on.
 */
import type { ConversationDetail, ThreadMessage } from "@omnichannel/db";

import type { MessageKey } from "@/i18n/catalogue";
import type { Translator } from "@/i18n/translate";

export interface MessageThreadProps {
  readonly t: Translator;
  readonly conversation: ConversationDetail;
}

const KNOWN_SOURCES = new Set(["PARTICIPANT", "AI", "HUMAN", "AUTOMATION", "SYSTEM"]);
const KNOWN_DELIVERY = new Set(["PENDING", "SENT", "DELIVERED", "READ", "FAILED"]);

export function MessageThread({ t, conversation }: MessageThreadProps) {
  return (
    <section className="inbox-thread" aria-labelledby="inbox-thread-heading">
      <header className="thread-header">
        <h2 id="inbox-thread-heading">{conversation.contactName ?? conversation.handle}</h2>
        <p className="muted">
          {t.t(`channel.${conversation.channel}` as MessageKey)} · {conversation.handle}
        </p>
      </header>

      {conversation.messages.length === 0 ? (
        <p className="muted" data-thread-empty="true">
          {t.t("inbox.threadEmpty")}
        </p>
      ) : (
        <ol className="thread-messages">
          {conversation.messages.map((message) => (
            <li key={message.id}>
              <article
                className="message"
                data-source={message.source}
                data-direction={message.direction}
                data-message-id={message.id}
              >
                <header className="message-meta">
                  {/* The author, as a word. A colour-only distinction is not a distinction. */}
                  <span className="badge" data-tone={toneFor(message.source)}>
                    {sourceLabel(t, message)}
                  </span>
                  <time className="muted" dateTime={message.occurredAt.toISOString()}>
                    {t.date(message.occurredAt, { dateStyle: "medium", timeStyle: "short" })}
                  </time>
                </header>
                {message.text === null ? (
                  <p className="muted">{t.t(`messageKind.${message.kind}` as MessageKey)}</p>
                ) : (
                  <p className="message-text">{message.text}</p>
                )}
                <footer className="message-status muted">
                  {message.deliveryStatus === null ? undefined : (
                    <span data-delivery={message.deliveryStatus}>{deliveryLabel(t, message.deliveryStatus)}</span>
                  )}
                  {/* Only the non-default path is named: "standard" on every bubble is noise. */}
                  {message.transportPath === "HUMAN_AGENT" ? (
                    <span data-transport="HUMAN_AGENT">{t.t("transportPath.HUMAN_AGENT")}</span>
                  ) : undefined}
                </footer>
              </article>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * A human sender is named; every other source is described by role.
 *
 * Naming the colleague who replied is the thing an operator actually wants from an audit trail, and the
 * assistant has no name to give. An unrecognised source falls back to the raw value rather than throwing:
 * a new enum member added by a migration should not blank out a whole thread.
 */
function sourceLabel(t: Translator, message: ThreadMessage): string {
  if (message.source === "HUMAN" && message.sentByUserName !== null) {
    return message.sentByUserName;
  }
  return KNOWN_SOURCES.has(message.source) ? t.t(`messageSource.${message.source}` as MessageKey) : message.source;
}

function deliveryLabel(t: Translator, status: string): string {
  return KNOWN_DELIVERY.has(status) ? t.t(`deliveryStatus.${status}` as MessageKey) : status;
}

function toneFor(source: string): string {
  if (source === "PARTICIPANT") {
    return "muted";
  }
  return source === "HUMAN" ? "ok" : "info";
}
