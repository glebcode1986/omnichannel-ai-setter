import { Prisma } from "./generated/prisma/client";

/**
 * The caller is not a member of the requested workspace, or presented a context that was not issued by
 * `authorizeWorkspaceAccess`. The message deliberately names neither the user nor the workspace.
 */
export class WorkspaceAccessDeniedError extends Error {
  constructor() {
    super("Workspace access denied");
    this.name = "WorkspaceAccessDeniedError";
  }
}

/** The caller is a member but their role does not permit the operation. */
export class WorkspacePermissionError extends Error {
  readonly operation: string;

  constructor(operation: string) {
    super(`Workspace role does not permit ${operation}`);
    this.name = "WorkspacePermissionError";
    this.operation = operation;
  }
}

/**
 * The record does not exist inside the caller's workspace. Records owned by other workspaces are reported
 * exactly like missing ones so their existence is not disclosed.
 */
export class TenantRecordNotFoundError extends Error {
  readonly entity: string;

  constructor(entity: string) {
    super(`${entity} not found in workspace`);
    this.name = "TenantRecordNotFoundError";
    this.entity = entity;
  }
}

/** Invalid repository input (e.g. an empty name); names the field, never echoes the value. */
export class DbInputError extends Error {
  readonly field: string;

  constructor(field: string, rule: string) {
    super(`${field}: ${rule}`);
    this.name = "DbInputError";
    this.field = field;
  }
}

const RECORD_NOT_FOUND = "P2025";
const FOREIGN_KEY_VIOLATION = "P2003";

/**
 * Converts "no row matched the workspace-scoped filter" and "referenced row is not in this workspace"
 * (composite foreign keys include workspace_id) into `TenantRecordNotFoundError`; rethrows anything else.
 */
export function rethrowAsTenantNotFound(error: unknown, entity: string): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === RECORD_NOT_FOUND || error.code === FOREIGN_KEY_VIOLATION)
  ) {
    throw new TenantRecordNotFoundError(entity);
  }
  throw error;
}
