/**
 * No provider-specific payloads in the generic Inbox components (Issue #28).
 *
 * The acceptance criterion is "no provider-specific payload leakage into generic components", and the way
 * that criterion gets broken is never a deliberate decision. It is someone passing a stored record
 * straight through because it already has the field they wanted — `ChannelAccountRecord` carries a
 * provider-shaped `capabilities` blob, a credential shape carries a token, a webhook envelope carries
 * Meta's own nesting — and from then on the Inbox knows about Instagram.
 *
 * So this reads the panes' own source — the Inbox and the Review queue both — and checks what they import
 * and what they name. It is a coarse instrument and says so: what it proves is that they depend on the
 * neutral row, item and detail types and on nothing from a channel package.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const inboxDir = path.dirname(fileURLToPath(import.meta.url));
/** Every directory of panes this rule covers. The Review queue is held to the same criterion. */
const paneDirs = [
  inboxDir,
  path.resolve(inboxDir, "../review"),
  path.resolve(inboxDir, "../knowledge"),
  path.resolve(inboxDir, "../style"),
  path.resolve(inboxDir, "../leads"),
  path.resolve(inboxDir, "../analytics"),
];

/**
 * Comments are stripped before anything is matched.
 *
 * The checks below look for words like `capabilities`, and the panes explain in prose *why* they do not
 * use it. A guard that could not tell an explanation from a dependency would force the code to stop
 * describing its own boundaries in order to stay inside them.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function componentSources(): { readonly file: string; readonly source: string }[] {
  return paneDirs.flatMap((dir) =>
    readdirSync(dir)
      .filter((entry) => /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry))
      .map((entry) => ({ file: `${path.basename(dir)}/${entry}`, source: withoutComments(readFileSync(path.join(dir, entry), "utf8")) })),
  );
}

describe("the Inbox components", () => {
  it("import nothing from a channel package or a provider SDK", () => {
    const offenders: string[] = [];
    for (const { file, source } of componentSources()) {
      for (const match of source.matchAll(/from "([^"]+)"/g)) {
        const specifier = match[1] ?? "";
        if (/channel-instagram|channel-whatsapp|graph\.facebook|instagram|whatsapp/iu.test(specifier)) {
          offenders.push(`${file} imports ${specifier}`);
        }
      }
    }

    expect(offenders, "a pane that imports a channel package is a pane with a favourite channel").toEqual([]);
  });

  it("name no provider payload or credential type", () => {
    // The types that carry a provider's own shape. A pane that mentions one is reaching past the
    // neutral row it was given.
    const forbidden = [
      "ChannelAccountRecord",
      "ChannelCredential",
      "InstagramBinding",
      "InstagramWebhook",
      "WhatsAppWebhook",
      "capabilities",
      "accessToken",
      "messaging_product",
    ];
    const offenders: string[] = [];
    for (const { file, source } of componentSources()) {
      for (const name of forbidden) {
        if (source.includes(name)) {
          offenders.push(`${file} mentions ${name}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("treat the channel as a value, never as a branch in the layout", () => {
    // Rendering a different pane per channel is the silo this Inbox exists to replace. A channel may
    // decide a label or a badge — which is what the catalogue lookup does — but not a code path.
    const offenders: string[] = [];
    for (const { file, source } of componentSources()) {
      // `channel === "INSTAGRAM"` and friends. The interpolated catalogue key is not a comparison.
      for (const match of source.matchAll(/===\s*"(INSTAGRAM|WHATSAPP)"/g)) {
        offenders.push(`${file}: ${match[0]}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("would notice a leak if one were introduced", () => {
    // Otherwise the three checks above pass because the matchers are broken, not because the panes are.
    const sample = 'import type { ChannelAccountRecord } from "@omnichannel/channel-instagram";\nconst x = row.channel === "INSTAGRAM";\n';

    expect([...sample.matchAll(/from "([^"]+)"/g)].some((match) => /channel-instagram/u.test(match[1] ?? ""))).toBe(true);
    expect(sample.includes("ChannelAccountRecord")).toBe(true);
    expect([...sample.matchAll(/===\s*"(INSTAGRAM|WHATSAPP)"/g)]).toHaveLength(1);
  });

  it("strips comments without eating the code around them", () => {
    const sample = ['/** mentions capabilities */', 'const url = "https://example.test/x";', 'const keep = 1; // mentions accessToken', 'const after = 2;'].join("\n");
    const stripped = withoutComments(sample);

    expect(stripped).not.toContain("capabilities");
    expect(stripped).not.toContain("accessToken");
    // A `//` inside a string is not a comment, and the statements survive.
    expect(stripped).toContain('"https://example.test/x"');
    expect(stripped).toContain("const keep = 1;");
    expect(stripped).toContain("const after = 2;");
  });

  it("looks at every pane, so a clean result means something", () => {
    const files = componentSources().map((entry) => entry.file);

    expect(files).toContain("inbox/conversation-list.tsx");
    expect(files).toContain("inbox/message-thread.tsx");
    expect(files).toContain("inbox/context-panel.tsx");
    expect(files).toContain("inbox/conversation-controls.tsx");
    expect(files).toContain("inbox/view.ts");
    // The Review queue is held to the same criterion, and is where a provider payload would be most
    // tempting: a template name, a window state, an eligibility blob.
    expect(files).toContain("review/review-card.tsx");
    expect(files).toContain("knowledge/knowledge-list.tsx");
    expect(files).toContain("knowledge/retrieval-results.tsx");
    expect(files).toContain("analytics/metrics-view.tsx");
    expect(files).toContain("analytics/audit-table.tsx");
    expect(files).toContain("style/style-example-list.tsx");
    expect(files).toContain("style/voice-editor.tsx");
    expect(files).toContain("leads/lead-board.tsx");
    expect(files).toContain("leads/lead-panel.tsx");
    expect(files).toContain("leads/stage-config.tsx");
  });
});
