import type { AppConfig } from "../config.js";
import type { EmailService } from "../email.js";
import type { EventService } from "../events.js";
import type { AdminSessionIdentity } from "../persistence/adminSessions.js";
import type { createDatabasePersistence } from "../persistence/index.js";
import type { ProjectionService } from "../projections.js";

export type AppPersistence = ReturnType<typeof createDatabasePersistence>;
export type OrgAdminQueries = ReturnType<AppPersistence["adminQueries"]["forOrg"]>;

export type GraphQLContext = {
  identity: AdminSessionIdentity;
  config: AppConfig;
  persistence?: AppPersistence;
  events: EventService;
  projections: ProjectionService;
  emailService: EmailService;
};

export function orgQueries(context: GraphQLContext): OrgAdminQueries | undefined {
  return context.persistence?.adminQueries.forOrg(context.identity.organizationId);
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
