import type { AdminAuthService } from "../adminAuth.js";
import type { AppConfig } from "../config.js";
import type { EmailService } from "../email.js";
import type { EventService } from "../events.js";
import type { AdminSessionIdentity } from "../persistence/adminSessions.js";
import type { createDatabasePersistence } from "../persistence/index.js";
import type { ProjectionService } from "../projections.js";

export type AppPersistence = ReturnType<typeof createDatabasePersistence>;
export type OrgAdminQueries = ReturnType<AppPersistence["adminQueries"]["forOrg"]>;

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
const orgQueriesByContext = new WeakMap<GraphQLContext, OrgAdminQueries>();

export function orgQueries(context: GraphQLContext): OrgAdminQueries | undefined {
  if (!context.persistence) return undefined;
  const existing = orgQueriesByContext.get(context);
  if (existing) return existing;
  const queries = context.persistence.adminQueries.forOrg(context.identity().organizationId);
  orgQueriesByContext.set(context, queries);
  return queries;
}

export async function viewerPayload(
  identity: AdminSessionIdentity,
  persistence: AppPersistence | undefined
) {
  return {
    user: identity,
    organizationId: identity.organizationId,
    organizations: persistence
      ? await persistence.adminSessions.organizationsForUser(identity.userId)
      : []
  };
}
