/**
 * Renders a published legal document from parsed blocks (#121).
 *
 * A server component with no state and no client bundle: it is a page of text. Headings come from the
 * document, so the page's own `h1` is the document's title and the numbered clauses are `h2` — which is
 * also why nothing here renumbers anything. The clause numbers are part of the text, because a renderer
 * that generates them can shift a cross-reference ("see clause 14.4") without anybody noticing.
 *
 * The one thing it does that an ordinary markdown renderer does not: a `gap` is rendered as a visibly
 * marked span naming what is missing, never as prose. An unfilled value in a legal document has to look
 * unfilled.
 */
import type { Inline, LegalBlock } from "@/server/legal-markdown";
import type { Translator } from "@/i18n/translate";

function Runs({ content, t }: { readonly content: readonly Inline[]; readonly t: Translator }) {
  return (
    <>
      {content.map((run, at) => {
        const key = `${run.kind}-${String(at)}`;
        if (run.kind === "bold") {
          return <strong key={key}>{run.value}</strong>;
        }
        if (run.kind === "code") {
          return <code key={key}>{run.value}</code>;
        }
        if (run.kind === "link") {
          return (
            <a key={key} href={run.href}>
              {run.value}
            </a>
          );
        }
        if (run.kind === "gap") {
          // `title` names the value itself, so somebody filling these in can see which one this is
          // without reading the source.
          return (
            <span key={key} className="legal-gap" data-legal-gap={run.value} title={run.value}>
              {t.t("legal.gap")}
            </span>
          );
        }
        return <span key={key}>{run.value}</span>;
      })}
    </>
  );
}

export function LegalDocument({ blocks, t }: { readonly blocks: readonly LegalBlock[]; readonly t: Translator }) {
  return (
    <article className="legal-body">
      {blocks.map((block, at) => {
        const key = `${block.kind}-${String(at)}`;
        if (block.kind === "break") {
          return <hr key={key} />;
        }
        if (block.kind === "heading") {
          return block.level === 1 ? (
            <h1 key={key}>
              <Runs content={block.content} t={t} />
            </h1>
          ) : (
            <h2 key={key}>
              <Runs content={block.content} t={t} />
            </h2>
          );
        }
        if (block.kind === "quote") {
          return (
            <blockquote key={key}>
              <Runs content={block.content} t={t} />
            </blockquote>
          );
        }
        if (block.kind === "table") {
          return (
            <div className="legal-table" key={key}>
              <table>
                <thead>
                  <tr>
                    {block.head.map((cell, column) => (
                      <th key={`h-${String(column)}`} scope="col">
                        <Runs content={cell} t={t} />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, line) => (
                    <tr key={`r-${String(line)}`}>
                      {row.map((cell, column) => (
                        <td key={`c-${String(column)}`}>
                          <Runs content={cell} t={t} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        return (
          <p key={key} className={block.sub === true ? "legal-sub" : undefined}>
            <Runs content={block.content} t={t} />
          </p>
        );
      })}
    </article>
  );
}
