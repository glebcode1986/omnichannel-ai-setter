/**
 * What a deletion request can cover (#57).
 *
 * In the domain because the scope is a product decision rather than a storage detail: it decides what a
 * business is promising when it says "deleted", and four separate answers exist because collapsing them
 * would make the narrowest request indistinguishable from the widest.
 */
export const DELETION_SCOPES = ["CONTACT", "CONVERSATION", "BUSINESS_PROFILE", "WORKSPACE"] as const;
export type DeletionScopeValue = (typeof DELETION_SCOPES)[number];

export function isDeletionScope(value: string): value is DeletionScopeValue {
  return (DELETION_SCOPES as readonly string[]).includes(value);
}

export const DELETION_STATES = ["REQUESTED", "PROCESSING", "COMPLETED", "PARTIAL_FAILURE"] as const;
export type DeletionStateValue = (typeof DELETION_STATES)[number];
