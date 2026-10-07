/**
 * Localization behaviour (Issue #58).
 *
 * The case this file exists for is the last one: a dashboard locale must never reach a customer. The rest
 * are the formatting that English quietly hides — Russian's four plural categories, its date order, its
 * decimal comma — because code written and reviewed in English passes every English test.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { WORKSPACE_ROLES } from "@omnichannel/domain";

import { catalogues, pluralCatalogues, type MessageKey } from "./catalogue";
import { FALLBACK_LOCALE, resolveUiLocale, UI_LOCALES } from "./locales";
import { createTranslator } from "./translate";

const MOMENT = new Date("2026-03-09T14:05:00.000Z");

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolving a stored preference", () => {
  it("falls back when nothing was ever chosen", () => {
    expect(resolveUiLocale(undefined)).toBe(FALLBACK_LOCALE);
    expect(resolveUiLocale(null)).toBe(FALLBACK_LOCALE);
    expect(resolveUiLocale("")).toBe(FALLBACK_LOCALE);
  });

  it("treats one language written three ways as one preference", () => {
    // Otherwise a person who set "ru-RU" on one device and "RU" on another has two preferences and no way
    // to tell why the product keeps changing language.
    expect(resolveUiLocale("ru")).toBe("ru");
    expect(resolveUiLocale("RU")).toBe("ru");
    expect(resolveUiLocale("ru-RU")).toBe("ru");
  });

  it("reads a regional variant as its language rather than refusing it", () => {
    // Someone in Kazakhstan asking for ru-KZ is a Russian reader. Telling them the product has no Russian
    // would be wrong.
    expect(resolveUiLocale("ru-KZ")).toBe("ru");
  });

  it("falls back for a language the product does not have, and for nonsense", () => {
    expect(resolveUiLocale("de")).toBe(FALLBACK_LOCALE);
    expect(resolveUiLocale("not a tag")).toBe(FALLBACK_LOCALE);
  });
});

describe("the catalogues", () => {
  it("covers every key in every locale", () => {
    // The types already enforce this; the test states it so a future `as never` cannot quietly undo it.
    const keys = Object.keys(catalogues[FALLBACK_LOCALE]) as MessageKey[];
    for (const locale of UI_LOCALES) {
      for (const key of keys) {
        expect(catalogues[locale][key], `${locale} is missing ${key}`).toBeTruthy();
      }
    }
  });

  it("actually translates rather than copying English through", () => {
    // A Russian catalogue that echoed English would pass a "covers every key" check and fail every reader.
    const identical = (Object.keys(catalogues.en) as MessageKey[]).filter((key) => catalogues.en[key] === catalogues.ru[key]);

    // Two kinds of key may legitimately match. Proper nouns — two platform names and the product's own —
    // and a pure format string with no words in it. `leads.stageColumn` is `{label} ({count})` and
    // `billing.addOnQuantity` is `{name} × {quantity}`: both stay in the catalogue because a locale could
    // want different separators or spacing, and both are identical today because neither language wants
    // anything different yet.
    // The platform names appear twice over, as channels and as the plan features that sell them. They are
    // deliberately not shared: a component that mapped a feature onto a channel key would be branching on
    // a channel name, which `no-provider-payloads.test.ts` forbids in a pane for good reasons of its own.
    // The console's three are the same category again (#59): `{actor} ({role})`, `{plan} v{version} —
    // {state}` and `{channel} — {status} ({external})` are assemblies of values a reader needs in a
    // stable order. They stay in the catalogue so a locale can change the punctuation or the order, and
    // they are identical today because neither language wants anything different.
    expect(identical.toSorted()).toEqual(
      [
        "admin.auditActor",
        "admin.channelLine",
        "admin.planLine",
        "billing.addOnQuantity",
        "channel.INSTAGRAM",
        "channel.WHATSAPP",
        "feature.INSTAGRAM",
        "feature.WHATSAPP",
        "landing.title",
        "leads.stageColumn",
      ].toSorted(),
    );
  });

  it("names every workspace role in every locale", () => {
    // Driven off the domain's own list rather than a copy, so a role added later fails here instead of
    // reaching a Russian reader in English. That is how the first version of this slipped: the sentence
    // "Ваша роль: {role}" was localized and the role interpolated into it was not.
    for (const locale of UI_LOCALES) {
      for (const role of WORKSPACE_ROLES) {
        expect(catalogues[locale][`role.${role}`], `${locale} is missing role.${role}`).toBeTruthy();
      }
    }
  });

  it("renders the role in the reader's language, not the enum's", () => {
    const english = createTranslator("en");
    const russian = createTranslator("ru");

    for (const role of WORKSPACE_ROLES) {
      const line = russian.t("workspaces.role", { role: russian.t(`role.${role}`) });
      // The defect an independent review found: a Russian user saw "Ваша роль: owner".
      expect(line).not.toMatch(/[A-Za-z]/u);
      expect(english.t("workspaces.role", { role: english.t(`role.${role}`) })).toContain("Your role:");
    }
  });

  it("gives Russian the plural categories Russian has", () => {
    for (const key of Object.keys(pluralCatalogues.ru)) {
      const forms = pluralCatalogues.ru[key];
      expect(forms?.few, `${key} has no "few" form`).toBeTruthy();
      expect(forms?.many, `${key} has no "many" form`).toBeTruthy();
    }
  });
});

describe("rendering a message", () => {
  it("fills placeholders", () => {
    expect(createTranslator("en").t("setup.resumeHint", { step: "Knowledge" })).toBe("Next: Knowledge");
    expect(createTranslator("ru").t("setup.resumeHint", { step: "Знания" })).toBe("Далее: Знания");
  });

  it("leaves an unfilled placeholder visible", () => {
    // "Next: {step}" is a bug someone reports. "Next: " reads like an empty state and ships.
    expect(createTranslator("en").t("setup.resumeHint")).toBe("Next: {step}");
  });

  it("asks the locale which plural form applies", () => {
    const ru = createTranslator("ru");

    // The numbers English can never distinguish: 1 / 2 / 5 / 21 / 22 are four different Russian forms.
    expect(ru.plural("setup.reviewItemsWaiting", 1)).toBe("1 диалог ждёт человека.");
    expect(ru.plural("setup.reviewItemsWaiting", 2)).toBe("2 диалога ждут человека.");
    expect(ru.plural("setup.reviewItemsWaiting", 5)).toBe("5 диалогов ждут человека.");
    expect(ru.plural("setup.reviewItemsWaiting", 22)).toBe("22 диалога ждут человека.");
  });

  it("uses English's two forms for English", () => {
    const en = createTranslator("en");

    expect(en.plural("setup.reviewItemsWaiting", 1)).toBe("1 conversation is waiting for a person.");
    expect(en.plural("setup.reviewItemsWaiting", 22)).toBe("22 conversations are waiting for a person.");
  });
});

describe("locale-aware formatting", () => {
  it("formats dates the way each locale writes them", () => {
    const options: Intl.DateTimeFormatOptions = { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "UTC" };

    // Day and month in the other order is the classic silent defect: 03/09 and 09/03 are both "valid".
    expect(createTranslator("en").date(MOMENT, options)).toBe("03/09/2026");
    expect(createTranslator("ru").date(MOMENT, options)).toBe("09.03.2026");
  });

  it("renders a time in the timezone the surface is about, not the reader's", () => {
    const berlin = createTranslator("ru").date(MOMENT, { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });

    // A business's quiet hours belong to the business's timezone. Rendering them in the reader's would
    // tell an operator in another country the wrong thing about someone else's evening.
    expect(berlin).toBe("15:05");
  });

  it("formats numbers and money per locale", () => {
    expect(createTranslator("en").number(1234.5)).toBe("1,234.5");
    // Grouped by a space and decimal by a comma. The pattern rather than the literal, because the space
    // ICU actually emits is a non-breaking one — a difference invisible in a diff and worth not pinning.
    expect(createTranslator("ru").number(1234.5)).toMatch(/^1\s234,5$/u);
    expect(createTranslator("en").money(19.99, "USD")).toContain("19.99");
    expect(createTranslator("ru").money(19.99, "EUR")).toContain("19,99");
  });
});

describe("a missing key", () => {
  it("throws while a screen is being written", () => {
    vi.stubEnv("NODE_ENV", "development");
    const translator = createTranslator("ru");

    expect(() => translator.t("does.not.exist" as MessageKey)).toThrow(/missing translation/);
  });

  it("falls back to English in production, and reports it once", () => {
    vi.stubEnv("NODE_ENV", "production");
    const onMiss = vi.fn();
    const translator = createTranslator("ru", { onMiss });

    // A person mid-task sees readable English rather than a raw key or a blank.
    expect(translator.t("setup.activate")).toBe(catalogues.ru["setup.activate"]);
    const rendered = translator.t("absent.key.for.fallback" as MessageKey);
    expect(rendered).toBe("absent.key.for.fallback");
    translator.t("absent.key.for.fallback" as MessageKey);
    expect(onMiss).toHaveBeenCalledTimes(1);
    expect(onMiss.mock.calls[0]?.[1]).toMatchObject({ locale: "ru", key: "absent.key.for.fallback" });
  });
});
