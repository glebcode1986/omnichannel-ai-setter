import { literalGuard } from "./enum";

/**
 * The material actions the product records (LEADS_ANALYTICS_UX.md, Issue #34).
 *
 * "Material" is the spec's word and it means something specific: an action that changes what the product
 * will do to a customer, or who is allowed to make it do so. Reading a page is not material. Changing a
 * mode, approving a reply, connecting a channel or granting somebody access all are.
 *
 * A closed list rather than a free-text kind, so a search can offer the kinds that exist and a reader can
 * tell the difference between "nothing happened" and "somebody logged it under a name I did not guess".
 */
export const AUDIT_EVENT_KINDS = [
  "CHANNEL_CONNECTED",
  "CHANNEL_DISCONNECTED",
  "POLICY_CHANGED",
  "MODE_CHANGED",
  "KNOWLEDGE_VERSIONED",
  "STYLE_VERSIONED",
  "DRAFT_APPROVED",
  "DRAFT_EDITED",
  "DRAFT_REJECTED",
  "REPLY_COMPOSED",
  "TAKEOVER_STARTED",
  "TAKEOVER_ENDED",
  "TEMPLATE_POLICY_CHANGED",
  "AMBIGUOUS_SEND_RESOLVED",
  "MEMBER_CHANGED",
  /// Somebody read a customer's data out of the product. The read itself is the event (#57).
  "DATA_EXPORTED",
  /// Somebody asked for data to be deleted, and what the deletion actually removed.
  "DELETION_REQUESTED",
  "DELETION_COMPLETED",
  /// What the workspace is paying for, and any deliberate departure from it (#38).
  "SUBSCRIPTION_CHANGED",
  "ENTITLEMENT_OVERRIDDEN",
  /// A checkout was opened: which plan, which seller entity, and what terms were accepted (#46).
  "CHECKOUT_OPENED",
  /// A charge path started, ended or was migrated to another provider or selling entity (#46).
  "BILLING_ARRANGEMENT_CHANGED",
] as const;
export type AuditEventKind = (typeof AUDIT_EVENT_KINDS)[number];
export const isAuditEventKind = literalGuard(AUDIT_EVENT_KINDS);

/**
 * Who acted.
 *
 * Reconciliation resolves an ambiguous send and the scheduler cancels a superseded one without anybody
 * asking. Recording those as a person's action would put a name against something nobody did.
 */
export const AUDIT_ACTOR_KINDS = ["USER", "SYSTEM"] as const;
export type AuditActorKind = (typeof AUDIT_ACTOR_KINDS)[number];

/**
 * The kinds only an admin may read.
 *
 * Membership, roles and channel connections decide who can reach customers and on whose behalf. An Agent
 * doing their own work does not need to see who was granted access last Tuesday, and "admin-only" here
 * means the rows are absent rather than redacted: a row shown as `***` still discloses that somebody's
 * access changed at 14:02, which is most of what was being withheld.
 */
export const ADMIN_ONLY_AUDIT_KINDS: readonly AuditEventKind[] = [
  "MEMBER_CHANGED",
  "CHANNEL_CONNECTED",
  "CHANNEL_DISCONNECTED",
  // Exports and deletions are the two actions that move a customer's data out of, or out of existence
  // in, this product. Who did them is exactly the question an investigation asks, and showing the rows
  // to everybody would make "somebody exported this thread at 14:02" ordinary reading (#57).
  "DATA_EXPORTED",
  "DELETION_REQUESTED",
  "DELETION_COMPLETED",
  // What a business pays for, and who was given more than they pay for. An agent has no reason to read
  // either, and an override visible to everybody is an invitation to ask why somebody else got one.
  "SUBSCRIPTION_CHANGED",
  "ENTITLEMENT_OVERRIDDEN",
  // A checkout and a charge path name the selling entity, the amount and the person who accepted the
  // terms. Same reasoning, and the acceptance names an individual by role as well as by name (#46).
  "CHECKOUT_OPENED",
  "BILLING_ARRANGEMENT_CHANGED",
];

/**
 * Kinds that belong to the workspace rather than to one Business Profile.
 *
 * Membership was the first. Commercial state is the same shape — a workspace pays for a plan, not a
 * profile — and so is a deletion whose scope is the whole tenant, which by definition names no profile.
 * Filing any of them under one profile would hide them from the only view where they make sense.
 */
export const WORKSPACE_SCOPED_AUDIT_KINDS: readonly AuditEventKind[] = [
  "MEMBER_CHANGED",
  "SUBSCRIPTION_CHANGED",
  "ENTITLEMENT_OVERRIDDEN",
  "DELETION_REQUESTED",
  "DELETION_COMPLETED",
  // A workspace pays for a plan, not a profile, and a seller entity sells to the workspace (#46).
  "CHECKOUT_OPENED",
  "BILLING_ARRANGEMENT_CHANGED",
];

/** Whether this kind belongs to the workspace rather than to one Business Profile. */
export function isWorkspaceScopedAuditKind(kind: AuditEventKind): boolean {
  return WORKSPACE_SCOPED_AUDIT_KINDS.includes(kind);
}
