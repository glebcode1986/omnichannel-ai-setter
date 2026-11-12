/**
 * The shell's sections, as structure rather than text.
 *
 * What is left here after localization: the identifiers and their order, which are product architecture
 * (PRODUCT_UX.md names these seven and their sequence). The words live in the catalogues, keyed off these.
 *
 * They are now also grouped. Seven equal links in one column make the reader scan all seven every time,
 * because nothing says which of them belong together — and three of these are the day's work while four
 * are things you set up once and revisit. The grouping is the same claim the product already makes
 * elsewhere: Knowledge and Style decide what the assistant knows and how it sounds, and neither is a
 * place you go to answer a customer.
 *
 * The order inside the groups, and the order of the groups, is the order the sections already had.
 */
export const NAV_SECTIONS = ["inbox", "review", "leads", "knowledge", "style", "analytics", "settings"] as const;
export type NavSection = (typeof NAV_SECTIONS)[number];

export const NAV_GROUPS = [
  { id: "work", sections: ["inbox", "review", "leads"] },
  { id: "assistant", sections: ["knowledge", "style"] },
  { id: "account", sections: ["analytics", "settings"] },
] as const satisfies readonly { id: string; sections: readonly NavSection[] }[];

export type NavGroup = (typeof NAV_GROUPS)[number]["id"];
