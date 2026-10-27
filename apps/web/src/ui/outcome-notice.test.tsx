// @vitest-environment jsdom
/**
 * The one sentence after an action (Issue #29).
 *
 * It lives in the URL rather than in client state so a refusal survives a reload, which is exactly when
 * someone re-reads one they did not expect. The cases here are about not inventing a sentence: an outcome
 * nobody defined can only come from a hand-edited URL, and rendering something for it would be the page
 * agreeing with an event that never happened.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { OutcomeNotice } from "./outcome-notice";
import { catalogues, type MessageKey } from "@/i18n/catalogue";
import { createTranslator } from "@/i18n/translate";

const t = createTranslator("en");
const text = (key: MessageKey) => catalogues.en[key];

afterEach(cleanup);

describe("the outcome notice", () => {
  it.each([
    ["SENT", "outcome.SENT"],
    ["SEND_CANCELLED", "outcome.SEND_CANCELLED"],
    ["TOO_LATE", "outcome.TOO_LATE"],
    ["STALE", "outcome.STALE"],
    ["ALREADY_RESOLVED", "outcome.ALREADY_RESOLVED"],
  ])("renders %s", (outcome, key) => {
    render(<OutcomeNotice t={t} outcome={outcome} />);

    expect(screen.getByText(text(key as MessageKey))).toBeDefined();
  });

  it("marks a refusal differently from a success", () => {
    const { rerender } = render(<OutcomeNotice t={t} outcome="TOO_LATE" />);
    expect(document.querySelector('[data-outcome="TOO_LATE"]')?.getAttribute("data-tone")).toBe("stop");

    rerender(<OutcomeNotice t={t} outcome="SENT" />);
    expect(document.querySelector('[data-outcome="SENT"]')?.getAttribute("data-tone")).toBeNull();
  });

  it("renders nothing when no action just happened", () => {
    render(<OutcomeNotice t={t} outcome={undefined} />);

    expect(document.querySelector("[data-outcome]")).toBeNull();
  });

  it("renders nothing for an outcome nobody defined", () => {
    // Only a hand-edited URL produces this, and a sentence for it would be the page agreeing with
    // something that never happened.
    render(<OutcomeNotice t={t} outcome="EVERYTHING_IS_FINE" />);

    expect(document.querySelector("[data-outcome]")).toBeNull();
  });

  it("is announced rather than only shown", () => {
    render(<OutcomeNotice t={t} outcome="SENT" />);

    expect(screen.getByRole("status").textContent).toBe(text("outcome.SENT"));
  });

  it("distinguishes a send that was stopped from one that was too late to stop", () => {
    // Both are "nothing more you can do", and only one of them means the customer did not get it.
    render(<OutcomeNotice t={createTranslator("ru")} outcome="TOO_LATE" />);

    expect(screen.getByText(catalogues.ru["outcome.TOO_LATE"])).toBeDefined();
    expect(catalogues.ru["outcome.TOO_LATE"]).not.toBe(catalogues.ru["outcome.SEND_CANCELLED"]);
  });

  it("renders a sentence for every outcome a server action can produce", () => {
    // The gap this closes: `checkout-actions.ts` redirected with `?outcome=PROVIDER_UNREACHABLE` on the
    // one path where the contract is written and the customer was handed nowhere, and that name was in
    // neither the list above nor the catalogue — so the page said nothing at all. Producing an outcome
    // and rendering it are two files apart, and nothing but this holds them together.
    const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../server");
    const sources: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory)) {
        const full = path.join(directory, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
        } else if (/\.tsx?$/u.test(entry) && !/\.test\.tsx?$/u.test(entry)) {
          sources.push(readFileSync(full, "utf8"));
        }
      }
    };
    walk(serverRoot);
    // Comments stripped before the scan: a comment explaining a URL that *used* to be produced quotes the
    // very shape this searches for, and the explanation would be read as a producer.
    const everything = sources
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .replace(/^[ \t]*\/\/.*$/gmu, "");

    // Read from the declared unions, not from the shape of a call. The first version of this scanned for
    // `finish(target, "NAME")` and missed an outcome the moment the redirect moved out of a `try` and
    // became an assignment — a test that only sees one spelling is a test that stops looking when the
    // code is rewritten. Each `…Outcome` type is the contract: every member of it can reach the URL.
    const produced = new Set<string>(
      [...everything.matchAll(/export type \w*Outcome\s*=(?<members>[^;]+);/gu)].flatMap((found) =>
        [...(found.groups?.members ?? "").matchAll(/"(?<name>[A-Z_]+)"/gu)].map((member) => member.groups?.name ?? ""),
      ),
    );

    // And the two literal shapes as well, for an outcome written straight into a URL without a union.
    for (const found of everything.matchAll(/\?outcome=(?<name>[A-Z_]+)(?![A-Z_$])/gu)) {
      produced.add(found.groups?.name ?? "");
    }

    // Two outcomes are built from a prefix and a union member, so the scan cannot read them: they are
    // named here with every value their union can take. The count is asserted rather than the shape — a
    // third prefix added later fails this line instead of slipping past unchecked. A bare
    // `?outcome=${outcome}` is not one of these: that is the redirect helper, and its names are the
    // literals at its call sites, which the first pattern already collected.
    const computed = [...everything.matchAll(/\?outcome=[A-Z_]+\$\{/gu)];
    expect(computed.length, "settings-actions builds two outcomes from a prefix and a union").toBe(2);
    for (const expansion of [
      "TAKEOVER_INCOMPLETE",
      "TAKEOVER_OUT_OF_RANGE",
      "TIMING_INCOMPLETE",
      "TIMING_OUT_OF_RANGE",
      "TIMING_REVERSED",
    ]) {
      produced.add(expansion);
    }

    expect(produced.size, "the server actions produce outcomes").toBeGreaterThan(0);
    for (const outcome of produced) {
      render(<OutcomeNotice t={t} outcome={outcome} />);
      expect(document.querySelector(`[data-outcome="${outcome}"]`), `${outcome} is produced but renders nothing`).not.toBeNull();
      cleanup();
    }
  });
});
