import {
  createPostgresDatabase,
  createTransactionalDatabase,
  type PromptProxyDatabase
} from "@prompt-proxy/db";

import type { ModelCatalog } from "../catalog.js";
import type { AppConfig } from "../config.js";
import { AdminQueryService, type AdminQueryConfig } from "./adminQueries.js";
import { AdminSessionStore } from "./adminSessions.js";
import { DatabaseEventSink } from "./eventSink.js";
import { ApiKeyIdentityStore } from "./identity.js";
import { PromptAccessAuditStore } from "./promptAccessAudit.js";
import { PromptArtifactStore } from "./promptArtifacts.js";
import { PersistentRequestStateStore } from "./requestState.js";
import { RoutingConfigResolver } from "./routingConfig.js";

export function createPostgresPersistence(databaseUrl: string, catalog: ModelCatalog, config: AppConfig) {
  return createDatabasePersistence(createPostgresDatabase(databaseUrl), catalog, config, true);
}

export function createDatabasePersistence(
  db: PromptProxyDatabase,
  catalog: ModelCatalog,
  config: AdminQueryConfig,
  useAdvisoryLocks: boolean
) {
  const transactional = createTransactionalDatabase(db);
  return {
    apiKeys: new ApiKeyIdentityStore(db),
    adminSessions: new AdminSessionStore(db),
    eventSink: new DatabaseEventSink(transactional, catalog, useAdvisoryLocks),
    promptAccessAudit: new PromptAccessAuditStore(db),
    promptArtifacts: new PromptArtifactStore(transactional, db),
    requestStates: new PersistentRequestStateStore(transactional, db, config.defaultOrganizationId),
    routingConfigs: new RoutingConfigResolver(db),
    adminQueries: new AdminQueryService(db, catalog, config)
  };
}
