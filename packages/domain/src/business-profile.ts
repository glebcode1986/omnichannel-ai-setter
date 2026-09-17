import { literalGuard } from "./enum";
import type { BusinessProfileId, WorkspaceId } from "./ids";

/**
 * Lifecycle status of a Business Profile (DATA_MODEL.md v0.4 §2). INACTIVE preserves data; it is not
 * deletion. Status is not operational readiness and not billing entitlement: both are evaluated separately
 * at execution time by later tasks, so no readiness or entitlement primitive is stored here.
 */
export const BUSINESS_PROFILE_STATUSES = ["SETUP", "ACTIVE", "INACTIVE"] as const;
export type BusinessProfileStatus = (typeof BUSINESS_PROFILE_STATUSES)[number];
export const isBusinessProfileStatus = literalGuard(BUSINESS_PROFILE_STATUSES);

/**
 * One business/brand/direction inside a Workspace and the operational/customer-data boundary: it owns its
 * channel accounts, contacts, conversations and policy. Workspace remains the tenant/billing boundary.
 */
export interface BusinessProfile {
  readonly id: BusinessProfileId;
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  readonly status: BusinessProfileStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
