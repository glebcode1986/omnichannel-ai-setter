/**
 * One layer of the business's voice (KNOWLEDGE_STYLE_UX.md, Issue #32).
 *
 * Two layers exist — the Workspace base and this Business Profile's override — and an empty field in the
 * override means "use the base", not "say nothing". The form says so, because a blank box looks like a
 * blank instruction and the difference decides whether a greeting disappears.
 *
 * The pane also states, once, that style never decides what is true. It is the one thing about this screen
 * somebody could get badly wrong: a tone instruction that read as permission to assert a price would make
 * the whole knowledge/style separation pointless.
 */
import type { StyleProfileLayerView } from "@omnichannel/db";

import type { Translator } from "@/i18n/translate";
import type { StyleTarget } from "@/server/style-actions";

export interface VoiceEditorProps {
  readonly t: Translator;
  readonly layer: StyleProfileLayerView;
  readonly target: StyleTarget;
  readonly action: (formData: FormData) => Promise<void>;
}

const REPLY_LENGTHS = ["SHORT", "MEDIUM", "LONG"] as const;
const EMOJI_USAGES = ["NONE", "SPARING", "FREELY"] as const;

export function VoiceEditor({ t, layer, action }: VoiceEditorProps) {
  const id = (name: string) => `style-${layer.scope}-${name}`;

  return (
    <form action={action} className="knowledge-editor" data-layer={layer.scope}>
      <h3>{layer.scope === "WORKSPACE" ? t.t("style.layerWorkspace") : t.t("style.layerProfile")}</h3>
      {layer.exists ? undefined : (
        <p className="muted" data-unwritten="true">
          {t.t("style.layerUnwritten")}
        </p>
      )}
      {layer.scope === "BUSINESS_PROFILE" ? <p className="muted">{t.t("style.inherits")}</p> : undefined}
      <input type="hidden" name="scope" value={layer.scope} />
      {/*
        What this form was rendered against. Two tabs open on one business's voice is ordinary, and each
        of them carries a *complete* profile — so a save that did not say which version it started from
        would replace every field a colleague had just changed with an old copy of itself. Empty when no
        layer existed yet, which is a claim the store checks too.
      */}
      <input type="hidden" name="expectedUpdatedAt" value={layer.updatedAt?.toISOString() ?? ""} />

      <label htmlFor={id("persona")}>{t.t("style.persona")}</label>
      <input id={id("persona")} name="persona" type="text" defaultValue={layer.persona ?? ""} />

      <label htmlFor={id("tone")}>{t.t("style.tone")}</label>
      <input id={id("tone")} name="tone" type="text" defaultValue={layer.tone ?? ""} />

      <label htmlFor={id("replyLength")}>{t.t("style.replyLength")}</label>
      <select id={id("replyLength")} name="replyLength" defaultValue={layer.replyLength ?? ""}>
        <option value="">{t.t("style.noOpinion")}</option>
        {REPLY_LENGTHS.map((value) => (
          <option key={value} value={value}>
            {t.t(`replyLength.${value}`)}
          </option>
        ))}
      </select>

      <label htmlFor={id("emoji")}>{t.t("style.emoji")}</label>
      <select id={id("emoji")} name="emoji" defaultValue={layer.emoji ?? ""}>
        <option value="">{t.t("style.noOpinion")}</option>
        {EMOJI_USAGES.map((value) => (
          <option key={value} value={value}>
            {t.t(`emojiUsage.${value}`)}
          </option>
        ))}
      </select>

      <label htmlFor={id("greeting")}>{t.t("style.greeting")}</label>
      <input id={id("greeting")} name="greeting" type="text" defaultValue={layer.greeting ?? ""} />

      <label htmlFor={id("signOff")}>{t.t("style.signOff")}</label>
      <input id={id("signOff")} name="signOff" type="text" defaultValue={layer.signOff ?? ""} />

      <label htmlFor={id("preferred")}>{t.t("style.preferred")}</label>
      <textarea id={id("preferred")} name="preferred" rows={3} defaultValue={layer.preferredPhrases.join("\n")} />

      <label htmlFor={id("avoided")}>{t.t("style.avoided")}</label>
      <textarea id={id("avoided")} name="avoided" rows={3} defaultValue={layer.avoidedPhrases.join("\n")} />

      <label htmlFor={id("language")}>{t.t("style.language")}</label>
      <input id={id("language")} name="language" type="text" defaultValue={layer.language ?? ""} />
      <p className="muted">{t.t("style.languageHint")}</p>

      <button className="button primary" type="submit" data-action="save-voice">
        {t.t("style.saveVoice")}
      </button>
    </form>
  );
}
