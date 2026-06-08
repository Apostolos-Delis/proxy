import {
  createPostgresDatabase,
  createTransactionalDatabase,
  type PromptProxyDatabase
} from "@prompt-proxy/db";

import type { ModelCatalog } from "../catalog.js";
import type { AppConfig } from "../config.js";
import { AdminQueryService, type AdminQueryConfig } from "./adminQueries.js";
import { DatabaseEventSink } from "./eventSink.js";
import { PersistentRequestStateStore } from "./requestState.js";

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
    eventSink: new DatabaseEventSink(transactional, catalog, useAdvisoryLocks),
    requestStates: new PersistentRequestStateStore(transactional, db, config.defaultOrganizationId),
    adminQueries: new AdminQueryService(db, catalog, config)
  };
}
