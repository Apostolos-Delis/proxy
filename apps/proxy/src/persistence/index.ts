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
import { ModelPricingAdminService } from "./modelPricingAdmin.js";
import { OrganizationSettingsStore } from "./organizationSettings.js";
import { ProviderCredentialAdminService } from "./providerCredentialAdmin.js";
import { ProviderCredentialStore } from "./providerCredentials.js";
import { PromptAccessAuditStore } from "./promptAccessAudit.js";
import { PromptArtifactStore } from "./promptArtifacts.js";
import { PersistentRequestStateStore } from "./requestState.js";
import { RoutingConfigAdminService } from "./routingConfigAdmin.js";
import { RoutingConfigResolver } from "./routingConfig.js";
import { createSessionPinLoader } from "./sessionRoute.js";
import { repriceZeroCostUsage } from "./usageRepricing.js";
import { UserAdminService } from "./userAdmin.js";
import { WorkspaceAdminService } from "./workspaceAdmin.js";

export type DatabasePersistenceConfig = AdminQueryConfig & {
  defaultOrganizationId: string;
  invitationTtlSeconds: number;
  providerSecretEncryptionKey?: string;
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
    providerCredentials: new ProviderCredentialStore(db, config.providerSecretEncryptionKey),
    providerCredentialAdmin: new ProviderCredentialAdminService(transactional, config.providerSecretEncryptionKey),
    eventSink: new DatabaseEventSink(transactional, config.modelCosts, useAdvisoryLocks),
    modelPricingAdmin: new ModelPricingAdminService(transactional, config.modelCosts),
    organizationSettings: new OrganizationSettingsStore(db),
    promptAccessAudit: new PromptAccessAuditStore(db),
    promptArtifacts: new PromptArtifactStore(transactional, db),
    requestStates: new PersistentRequestStateStore(transactional, db, config.defaultOrganizationId),
    routingConfigAdmin: new RoutingConfigAdminService(transactional),
    routingConfigs: new RoutingConfigResolver(db),
    sessionPins: createSessionPinLoader(db),
    userAdmin: new UserAdminService(transactional, { invitationTtlSeconds: config.invitationTtlSeconds }),
    workspaceAdmin: new WorkspaceAdminService(transactional),
    repriceZeroCostUsage: () => repriceZeroCostUsage(db, config.modelCosts),
    adminQueries: {
      forScope: (organizationId: string, workspaceId: string) =>
        new AdminQueryService(db, catalog, organizationId, workspaceId, {
          routeQualityLowConfidenceThreshold: config.routeQualityLowConfidenceThreshold,
          modelCosts: config.modelCosts,
          modelCostsFromEnv: config.modelCostsFromEnv,
          classifierModel: config.classifierModel,
          classifierProvider: config.classifierProvider
        })
    }
  };
}
