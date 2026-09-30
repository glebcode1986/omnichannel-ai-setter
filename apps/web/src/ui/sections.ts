/**
 * The shell's sections, as structure rather than text.
 *
 * What is left here after localization: the identifiers and their order, which are product architecture
 * (PRODUCT_UX.md names these seven and their sequence). The words live in the catalogues, keyed off these.
 */
export const NAV_SECTIONS = ["inbox", "review", "leads", "knowledge", "style", "analytics", "settings"] as const;
export type NavSection = (typeof NAV_SECTIONS)[number];
