import {
  createPostgresDatabase,
  createTransactionalDatabase,
  type PromptProxyDatabase
} from "@prompt-proxy/db";

import type { ModelCatalog } from "../catalog.js";
import type { AppConfig } from "../config.js";
import { AdminQueryService, type AdminQueryConfig } from "./adminQueries.js";
import { AdminSessionStore } from "./adminSessions.js";
import { ApiKeyAdminService } from "./apiKeyAdmin.js";
import { DatabaseEventSink } from "./eventSink.js";
import { ApiKeyIdentityStore } from "./identity.js";
import { PromptAccessAuditStore } from "./promptAccessAudit.js";
import { PromptArtifactStore } from "./promptArtifacts.js";
import { PersistentRequestStateStore } from "./requestState.js";
import { RoutingConfigAdminService } from "./routingConfigAdmin.js";
import { RoutingConfigResolver } from "./routingConfig.js";
import { UserAdminService } from "./userAdmin.js";

export type DatabasePersistenceConfig = AdminQueryConfig & {
  defaultOrganizationId: string;
  invitationTtlSeconds: number;
};

export function createPostgresPersistence(databaseUrl: string, catalog: ModelCatalog, config: AppConfig) {
  return createDatabasePersistence(createPostgresDatabase(databaseUrl), catalog, config, true);
}

export function createDatabasePersistence(
  db: PromptProxyDatabase,
  catalog: ModelCatalog,
  config: DatabasePersistenceConfig,
  useAdvisoryLocks: boolean
) {
  const transactional = createTransactionalDatabase(db);
  return {
    apiKeyAdmin: new ApiKeyAdminService(transactional),
    apiKeys: new ApiKeyIdentityStore(db),
    adminSessions: new AdminSessionStore(db),
    eventSink: new DatabaseEventSink(transactional, catalog, useAdvisoryLocks),
    promptAccessAudit: new PromptAccessAuditStore(db),
    promptArtifacts: new PromptArtifactStore(transactional, db),
    requestStates: new PersistentRequestStateStore(transactional, db, config.defaultOrganizationId),
    routingConfigAdmin: new RoutingConfigAdminService(transactional),
    routingConfigs: new RoutingConfigResolver(db),
    userAdmin: new UserAdminService(transactional, { invitationTtlSeconds: config.invitationTtlSeconds }),
    adminQueries: {
      forOrg: (organizationId: string) =>
        new AdminQueryService(db, catalog, organizationId, {
          routeQualityLowConfidenceThreshold: config.routeQualityLowConfidenceThreshold
        })
    }
  };
}
