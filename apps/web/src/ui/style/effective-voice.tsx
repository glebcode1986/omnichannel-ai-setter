/**
 * The voice the assistant actually obeys (Issue #32, KNOWLEDGE_STYLE_UX.md).
 *
 * The editors above this show the two *layers*, which is what a person writes. This shows what is left
 * after they are merged field by field, which is what the model is given. They are different things, and
 * the difference is the whole reason the spec asks this screen to display the effective instructions: an
 * operator who edits the profile layer and sees a candidate in the base layer's tone needs to be able to
 * see, without guessing, which instruction won.
 *
 * Read-only by construction — no form, no action, no inputs. The place to change the voice is the editor.
 */
import type { StyleProfile } from "@omnichannel/domain";

import type { Translator } from "@/i18n/translate";

export function EffectiveVoice({ t, voice }: { readonly t: Translator; readonly voice: StyleProfile }) {
  return (
    <dl className="effective-voice" data-effective-voice="true">
      <Row field="persona" label={t.t("style.persona")} value={voice.persona} />
      <Row field="tone" label={t.t("style.tone")} value={voice.tone} />
      <Row field="replyLength" label={t.t("style.replyLength")} value={t.t(`replyLength.${voice.replyLength}`)} />
      <Row field="emoji" label={t.t("style.emoji")} value={t.t(`emojiUsage.${voice.emoji}`)} />
      <Row field="greeting" label={t.t("style.greeting")} value={voice.greeting} />
      <Row field="signOff" label={t.t("style.signOff")} value={voice.signOff} />
      {/* No fixed language is a decision with a visible consequence, so it is stated rather than hidden:
          the assistant answers in whatever language the customer wrote in. */}
      <Row field="language" label={t.t("style.language")} value={voice.language ?? t.t("styleTest.anyLanguage")} />
      <Phrases field="preferred" label={t.t("style.preferred")} values={voice.preferredPhrases} />
      <Phrases field="avoided" label={t.t("style.avoided")} values={voice.avoidedPhrases} />
    </dl>
  );
}

/** One resolved field, or nothing at all where no layer and no fallback had an opinion. */
function Row({
  field,
  label,
  value,
}: {
  readonly field: string;
  readonly label: string;
  readonly value?: string;
}) {
  if (value === undefined || value === "") {
    return undefined;
  }
  return (
    <div data-voice-field={field}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Phrases({
  field,
  label,
  values,
}: {
  readonly field: string;
  readonly label: string;
  readonly values: readonly string[];
}) {
  if (values.length === 0) {
    return undefined;
  }
  return (
    <div data-voice-field={field}>
      <dt>{label}</dt>
      <dd>
        <ul>
          {values.map((phrase) => (
            <li key={phrase}>{phrase}</li>
          ))}
        </ul>
      </dd>
    </div>
  );
}
