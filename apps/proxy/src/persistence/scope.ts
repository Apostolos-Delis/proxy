import { and, eq } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

type WorkspaceScopedTable = {
  organizationId: AnyPgColumn;
  workspaceId: AnyPgColumn;
};

// Canonical tenancy predicate for workspace-scoped tables. Every read of a
// workspace-scoped table must include this (not hand-rolled eq pairs) so a
// missing workspace filter stays grep-auditable.
export function workspaceScope(
  table: WorkspaceScopedTable,
  organizationId: string,
  workspaceId: string
) {
  return and(eq(table.organizationId, organizationId), eq(table.workspaceId, workspaceId));
}
