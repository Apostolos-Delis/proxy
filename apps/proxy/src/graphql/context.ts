import type { AdminAuthService } from "../adminAuth.js";
import type { AppConfig } from "../config.js";
import type { EmailService } from "../email.js";
import type { EventService } from "../events.js";
import type { AdminSessionIdentity } from "../persistence/adminSessions.js";
import type { createDatabasePersistence } from "../persistence/index.js";
import type { ProjectionService } from "../projections.js";

export type AppPersistence = ReturnType<typeof createDatabasePersistence>;
export type ScopedAdminQueries = ReturnType<AppPersistence["adminQueries"]["forScope"]>;

export type GraphQLContext = {
  // Throws UNAUTHENTICATED (HTTP 401) when the request has no admin session;
  // session mutations (login, acceptInvitation, ...) use sessionIdentity instead.
  identity: () => AdminSessionIdentity;
  sessionIdentity: AdminSessionIdentity | null;
  config: AppConfig;
  persistence?: AppPersistence;
  events: EventService;
  projections: ProjectionService;
  emailService: EmailService;
  adminAuth: AdminAuthService;
  requestHeaders: Record<string, unknown>;
  setSessionCookie: (value: string) => void;
};

// One AdminQueryService per GraphQL request: its request-scoped caches let
// root fields of a single document (which execute concurrently) share row
// scans and summaries instead of re-reading the same tables.
const scopedQueriesByContext = new WeakMap<GraphQLContext, ScopedAdminQueries>();

export function scopedQueries(context: GraphQLContext): ScopedAdminQueries | undefined {
  if (!context.persistence) return undefined;
  const existing = scopedQueriesByContext.get(context);
  if (existing) return existing;
  const identity = context.identity();
  const queries = context.persistence.adminQueries.forScope(identity.organizationId, identity.workspaceId);
  scopedQueriesByContext.set(context, queries);
  return queries;
}

export async function viewerPayload(
  identity: AdminSessionIdentity,
  persistence: AppPersistence | undefined
) {
  return {
    user: identity,
    organizationId: identity.organizationId,
    workspaceId: identity.workspaceId,
    organizations: persistence
      ? await persistence.adminSessions.organizationsForUser(identity.userId)
      : [],
    workspaces: persistence
      ? await persistence.adminSessions.workspacesForOrganization(identity.organizationId)
      : []
  };
}
