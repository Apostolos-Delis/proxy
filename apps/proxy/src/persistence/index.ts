import {
  createPostgresDatabase,
  createTransactionalDatabase,
  type ProxyDatabase
} from "@proxy/db";

import type { AppConfig } from "../config.js";
import { CompressionCacheWindowResolver } from "../compressionCacheWindow.js";
import { ModelDiscoveryStore } from "../modelDiscovery.js";
import { ModelCatalogRefreshJob } from "../jobs/modelCatalogRefresh.js";
import { AdminQueryService, type AdminQueryConfig } from "./adminQueries.js";
import { AdminSessionStore } from "./adminSessions.js";
import { ApiKeyAdminService } from "./apiKeyAdmin.js";
import { CompressionRetrievalResolver } from "./compressionReceipts.js";
import { DatabaseEventSink } from "./eventSink.js";
import { ApiKeyIdentityStore } from "./identity.js";
import { ModelPricingAdminService } from "./modelPricingAdmin.js";
import { OrganizationSettingsStore } from "./organizationSettings.js";
import { ProviderCredentialAdminService } from "./providerCredentialAdmin.js";
import { ProviderCredentialOAuthService } from "./providerCredentialOAuth.js";
import { ProviderCredentialStore, type ProviderCredentialOptions } from "./providerCredentials.js";
import { ProviderHealthStore } from "./providerHealth.js";
import { ProviderRegistryAdminService } from "./providerRegistryAdmin.js";
import { ProviderRegistryStore } from "./providers.js";
import { PromptAccessAuditStore } from "./promptAccessAudit.js";
import { PromptArtifactStore } from "./promptArtifacts.js";
import { PersistentRequestStateStore } from "./requestState.js";
import { RoutingConfigAdminService } from "./routingConfigAdmin.js";
import { RoutingConfigResolver } from "./routingConfig.js";
import { createSessionPinLoader, SessionSystemPromptStore } from "./sessionRoute.js";
import { normalizeLegacyCachedUsage } from "./usageNormalization.js";
import { repriceZeroCostUsage } from "./usageRepricing.js";
import { UserAdminService } from "./userAdmin.js";
import { WorkspaceAdminService } from "./workspaceAdmin.js";
import type { MetricsCollector } from "../metrics.js";

export type DatabasePersistenceConfig = AdminQueryConfig & {
  defaultOrganizationId: string;
  invitationTtlSeconds: number;
  allowedPrivateUpstreamCidrs: string[];
  providerSecretEncryptionKey?: string;
  subscriptionOAuthEnabled: boolean;
};

export function createPostgresPersistence(databaseUrl: string, config: AppConfig, metrics?: MetricsCollector) {
  return createDatabasePersistence(createPostgresDatabase(databaseUrl), config, true, metrics);
}

export function createDatabasePersistence(
  db: ProxyDatabase,
  config: DatabasePersistenceConfig,
  useAdvisoryLocks: boolean,
  metrics?: MetricsCollector
) {
  const transactional = createTransactionalDatabase(db);
  // Getter, not a snapshot: a kill-switch flip must reach the create, resolve,
  // and forward layers together (headersFor already reads config live).
  const credentialOptions: ProviderCredentialOptions = {
    encryptionKey: config.providerSecretEncryptionKey,
    allowedPrivateUpstreamCidrs: config.allowedPrivateUpstreamCidrs,
    get subscriptionOAuthEnabled() {
      return config.subscriptionOAuthEnabled;
    }
  };
  const providerCredentialAdmin = new ProviderCredentialAdminService(transactional, credentialOptions);
  return {
    apiKeyAdmin: new ApiKeyAdminService(transactional),
    apiKeys: new ApiKeyIdentityStore(db),
    adminSessions: new AdminSessionStore(db),
    compressionCacheWindows: new CompressionCacheWindowResolver(db),
    compressionRetrieval: new CompressionRetrievalResolver(db),
    providerCredentials: new ProviderCredentialStore(db, credentialOptions),
    providerCredentialAdmin,
    providerCredentialOAuth: new ProviderCredentialOAuthService(providerCredentialAdmin),
    providerHealth: new ProviderHealthStore(db),
    providerRegistryAdmin: new ProviderRegistryAdminService(transactional, config),
    providerRegistry: new ProviderRegistryStore(db, config),
    eventSink: new DatabaseEventSink(transactional, useAdvisoryLocks, metrics),
    modelCatalogRefresh: new ModelCatalogRefreshJob(transactional, {
      auditOrganizationId: config.defaultOrganizationId
    }),
    modelDiscovery: new ModelDiscoveryStore(db),
    modelPricingAdmin: new ModelPricingAdminService(transactional),
    organizationSettings: new OrganizationSettingsStore(db),
    promptAccessAudit: new PromptAccessAuditStore(db),
    promptArtifacts: new PromptArtifactStore(transactional, db),
    requestStates: new PersistentRequestStateStore(transactional, db, config.defaultOrganizationId),
    routingConfigAdmin: new RoutingConfigAdminService(transactional),
    routingConfigs: new RoutingConfigResolver(db),
    sessionPins: createSessionPinLoader(db),
    sessionPrompts: new SessionSystemPromptStore(db),
    userAdmin: new UserAdminService(transactional, { invitationTtlSeconds: config.invitationTtlSeconds }),
    workspaceAdmin: new WorkspaceAdminService(transactional),
    normalizeLegacyCachedUsage: () => normalizeLegacyCachedUsage(db),
    repriceZeroCostUsage: () => repriceZeroCostUsage(db),
    adminQueries: {
      forScope: (organizationId: string, workspaceId: string) =>
        new AdminQueryService(db, organizationId, workspaceId, {
          routeQualityLowConfidenceThreshold: config.routeQualityLowConfidenceThreshold,
          classifierModel: config.classifierModel,
          classifierProvider: config.classifierProvider
        }, metrics)
    }
  };
}
