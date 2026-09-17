import { literalGuard } from "./enum";

/**
 * Stable internal IDs of the default lead pipeline (LEADS_ANALYTICS_UX.md). Display labels are separate;
 * workspace-defined custom stages are a later extension.
 */
export const LEAD_STAGES = ["NEW", "ENGAGED", "QUALIFYING", "QUALIFIED", "BOOKED", "WON", "LOST"] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];
export const isLeadStage = literalGuard(LEAD_STAGES);
