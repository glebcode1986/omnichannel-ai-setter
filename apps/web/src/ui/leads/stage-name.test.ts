/**
 * One name per stage, everywhere (Issue #33, Issue #111 item 3).
 *
 * The defect this exists to prevent is not a wrong string — it is a *second* answer to the same question.
 * The rule had four implementations and the fourth, the leads page's own stage filter, did not have it, so
 * one page rendered a dropdown reading "New" beside a column heading reading "Новый", from the same array.
 * Every surface now calls `stageName`, and the last test here is what keeps that true: it holds that no
 * leads surface reads a `StageDisplay`'s `label` for itself.
 *
 * What this file cannot do, stated rather than implied: the filter lives inside an async server component
 * that reads the database, so there is no render here that draws the real `<option>` list. The guard below
 * is the substitute, and it is a stronger one than a render of today's markup would be — a render proves
 * one surface, the guard proves there is no fifth.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_STAGE_LABELS, type StageDisplay } from "@omnichannel/db";
import { describe, expect, it } from "vitest";

import { stageName, stageNameOf } from "./stage-name";
import { catalogues } from "@/i18n/catalogue";
import { createTranslator } from "@/i18n/translate";

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const display = (overrides: Partial<StageDisplay> = {}): StageDisplay => ({
  stage: "NEW",
  label: DEFAULT_STAGE_LABELS.NEW,
  position: 0,
  hidden: false,
  isDefault: true,
  ...overrides,
});

/** Every leads surface that could render a stage name, less the module that is allowed to. */
function leadsSurfaces(): readonly { readonly file: string; readonly source: string }[] {
  const uiDirectory = path.join(srcRoot, "ui/leads");
  const files = readdirSync(uiDirectory)
    .filter((entry) => /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) && entry !== "stage-name.ts")
    .map((entry) => path.join("ui/leads", entry));
  files.push("app/workspaces/[workspaceId]/profiles/[businessProfileId]/leads/page.tsx");
  return files.map((file) => ({ file, source: readFileSync(path.join(srcRoot, file), "utf8") }));
}

/**
 * The source with comments and string literals removed.
 *
 * Both are necessary and for the same reason: `t.t("stages.label")` is a message key and this file's own
 * prose quotes `display.label` on purpose, so a scan over the raw text answers about neither the code nor
 * the question. A counter-test below proves the stripping does not also hide a real match.
 */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, " ")
    .replace(/\/\/[^\n]*/gu, " ")
    .replace(/"(?:[^"\\\n]|\\.)*"/gu, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/gu, "''");
}

/** A property read of the form `something.label`, which on these surfaces can only be a stage's. */
const READS_A_LABEL = /\b[A-Za-z_$][A-Za-z0-9_$]*\.label\b/gu;

describe("a stage's name", () => {
  it("translates the stage nobody has renamed, in each language", () => {
    expect(stageName(createTranslator("en"), display())).toBe(catalogues.en["leadStage.NEW"]);
    expect(stageName(createTranslator("ru"), display())).toBe(catalogues.ru["leadStage.NEW"]);

    // And the translated name is not the placeholder: the Russian console must not read "New".
    expect(stageName(createTranslator("ru"), display())).not.toBe(DEFAULT_STAGE_LABELS.NEW);
  });

  it("leaves what a person typed exactly as they typed it, in each language", () => {
    const named = display({ label: "Готов записаться", isDefault: false });

    expect(stageName(createTranslator("en"), named)).toBe("Готов записаться");
    expect(stageName(createTranslator("ru"), named)).toBe("Готов записаться");
  });

  it("does not translate an operator's wording even when it collides with a key's value", () => {
    // The failure a careless fix produces: run every label through the translator and an operator who
    // happens to name a column "New" gets the product's translation instead of their own word.
    const collides = display({ label: DEFAULT_STAGE_LABELS.NEW, isDefault: false });

    expect(stageName(createTranslator("ru"), collides)).toBe(DEFAULT_STAGE_LABELS.NEW);
  });

  it("looks a name up by stage id, and answers with the id when the board has no such stage", () => {
    const stages = [display(), display({ stage: "WON", label: "Закрыт", isDefault: false })];
    const ru = createTranslator("ru");

    expect(stageNameOf(ru, stages, "NEW")).toBe(catalogues.ru["leadStage.NEW"]);
    expect(stageNameOf(ru, stages, "WON")).toBe("Закрыт");
    // A history entry can name a stage the board no longer carries. The id is not a name, but it is true.
    expect(stageNameOf(ru, stages, "QUALIFYING")).toBe("QUALIFYING");
  });
});

describe("there is only one implementation of the rule", () => {
  it("lets no leads surface read a stage's label for itself", () => {
    const offenders = leadsSurfaces().flatMap(({ file, source }) =>
      [...code(source).matchAll(READS_A_LABEL)].map((found) => `${file}: ${found[0]}`),
    );

    expect(offenders, "every stage name comes from stage-name.ts").toEqual([]);
  });

  it("looks at the surfaces it claims to, including the page whose filter was the defect", () => {
    // Otherwise an empty result above means the walk found nothing rather than that nothing is wrong.
    const files = leadsSurfaces().map((surface) => surface.file);

    expect(files).toContain("ui/leads/lead-board.tsx");
    expect(files).toContain("ui/leads/lead-panel.tsx");
    expect(files).toContain("ui/leads/stage-config.tsx");
    expect(files).toContain("app/workspaces/[workspaceId]/profiles/[businessProfileId]/leads/page.tsx");
    expect(files).not.toContain("ui/leads/stage-name.ts");
  });

  it("would catch the defect it was written for, and is not fooled by a message key", () => {
    // The exact line that shipped, and the two forms that must stay quiet.
    expect([...code("<option>{display.label}</option>").matchAll(READS_A_LABEL)].map((f) => f[0])).toEqual([
      "display.label",
    ]);
    expect([...code('{t.t("stages.label")}').matchAll(READS_A_LABEL)]).toEqual([]);
    expect([...code("// printing display.label here was the bug").matchAll(READS_A_LABEL)]).toEqual([]);

    // And stripping a string must not swallow code that follows it on the same line.
    expect([...code('{t.t("stages.label")} {stage.label}').matchAll(READS_A_LABEL)].map((f) => f[0])).toEqual([
      "stage.label",
    ]);
  });
});
