/**
 * One answer to "what is this stage called", for every surface that asks (Issue #33).
 *
 * `StageDisplay.label` carries two different things under one field. Once an operator renames a column it
 * is their own wording; until then it is the product's placeholder, which `readStageDisplays()` takes from
 * the exported `DEFAULT_STAGE_LABELS` — `"New"`, `"Engaged"`, `"Qualifying"`, English words rather than the
 * `LeadStage` members — and the row is marked `isDefault: true`. So printing `label`
 * unconditionally put English in a Russian console, and translating it unconditionally would overwrite
 * what a person typed. `isDefault` is exactly that distinction and the only thing that decides.
 *
 * This lives in its own module because the rule had been written out four times, and the fourth copy — the
 * leads page's own stage filter — did not have it, so one page rendered both answers at once: a dropdown
 * reading "New" beside a column heading reading "Новый", from the same array. A rule with four
 * implementations has four chances to be the one that is wrong, and the one that was wrong was the one
 * nobody had a test for.
 */
import type { StageDisplay } from "@omnichannel/db";

import type { MessageKey } from "@/i18n/catalogue";
import type { Translator } from "@/i18n/translate";

/** The name a person should read for a stage the caller already has the display row for. */
export function stageName(t: Translator, display: StageDisplay): string {
  return display.isDefault ? t.t(`leadStage.${display.stage}` as MessageKey) : display.label;
}

/**
 * The same answer looked up by stage id.
 *
 * The id itself is the fallback, for a history entry naming a stage the board no longer carries — it is
 * not a name a person should see, but it is the truth, and inventing a label for it would be worse.
 */
export function stageNameOf(t: Translator, stages: readonly StageDisplay[], stage: string): string {
  const display = stages.find((candidate) => candidate.stage === stage);
  return display === undefined ? stage : stageName(t, display);
}
