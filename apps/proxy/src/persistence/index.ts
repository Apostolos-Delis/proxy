import {
  createPostgresDatabase,
  createTransactionalDatabase,
  type ProxyDatabase
} from "@proxy/db";

import { LlmClassifier, type LogicalModelClassifier } from "../classifier.js";
import { CompressionCacheWindowResolver } from "../compressionCacheWindow.js";
import type { AppConfig } from "../config.js";
import { EventService } from "../events.js";
import type { MetricsCollector } from "../metrics.js";
import { AdminQueryService } from "./adminQueries.js";
import { AdminSessionStore } from "./adminSessions.js";
import { ApiKeyAdminService } from "./apiKeyAdmin.js";
import { CompressionRetrievalResolver } from "./compressionReceipts.js";
import { DatabaseEventSink } from "./eventSink.js";
import { createEnvironmentSecretReferenceResolver } from "./environmentSecretReferences.js";
import { GatewayConfigAdminService, type GatewayConfigAdminOptions } from "./gatewayConfigAdmin.js";
import { ApiKeyIdentityStore } from "./identity.js";
import { ModelResolutionService } from "./modelResolution.js";
import { OrganizationSettingsStore } from "./organizationSettings.js";
import { PromptAccessAuditStore } from "./promptAccessAudit.js";
import { PromptArtifactStore } from "./promptArtifacts.js";
import { ProviderConnectionClassifierTargetResolver } from "./providerConnectionClassifierTarget.js";
import { ProviderConnectionRuntimeTargetResolver } from "./providerConnectionRuntimeTarget.js";
import { PersistentRequestStateStore } from "./requestState.js";
import { SessionSystemPromptStore } from "./sessionRoute.js";
import { UserAdminService } from "./userAdmin.js";
import { WorkspaceAdminService } from "./workspaceAdmin.js";

export function createPostgresPersistence(databaseUrl: string, config: AppConfig, metrics?: MetricsCollector) {
  const db = createPostgresDatabase(databaseUrl, { max: config.dbPoolMax });
  return createDatabasePersistence(db, config, true, metrics);
}

export function createDatabasePersistence(
  db: ProxyDatabase,
  config: AppConfig,
  useAdvisoryLocks: boolean,
  metrics?: MetricsCollector,
  classifier?: LogicalModelClassifier,
  secretReferenceSupported?: GatewayConfigAdminOptions["secretReferenceSupported"]
) {
  const transactional = createTransactionalDatabase(db);
  const apiKeys = new ApiKeyIdentityStore(db);
  const eventSink = new DatabaseEventSink(transactional, useAdvisoryLocks, metrics);
  const eventService = new EventService(
    config.eventStorePath,
    undefined,
    eventSink,
    config.defaultOrganizationId,
    metrics,
    { mirrorLimit: 1_000, scopeLimit: 50_000 }
  );
  const resolveSecretReference = createEnvironmentSecretReferenceResolver(config);
  const classifierRuntime = classifier ?? new LlmClassifier(
    config,
    metrics,
    new ProviderConnectionClassifierTargetResolver(db, {
      allowedPrivateUpstreamCidrs: config.allowedPrivateUpstreamCidrs,
      encryptionKey: config.providerSecretEncryptionKey,
      resolveSecretReference
    })
  );
  const gatewaySecretReferenceSupported = secretReferenceSupported ?? ((input) => (
    Boolean(resolveSecretReference(input))
  ));
  const providerConnectionRuntimeTargets = new ProviderConnectionRuntimeTargetResolver(db, {
    allowedPrivateUpstreamCidrs: config.allowedPrivateUpstreamCidrs,
    encryptionKey: config.providerSecretEncryptionKey,
    resolveSecretReference
  });
  return {
    apiKeyAdmin: new ApiKeyAdminService(transactional, () => apiKeys.clearCache()),
    apiKeys,
    adminSessions: new AdminSessionStore(db),
    compressionCacheWindows: new CompressionCacheWindowResolver(db),
    compressionRetrieval: new CompressionRetrievalResolver(db),
    gatewayConfigAdmin: new GatewayConfigAdminService(db, transactional, eventService, {
      allowedPrivateUpstreamCidrs: config.allowedPrivateUpstreamCidrs,
      encryptionKey: config.providerSecretEncryptionKey,
      secretReferenceSupported: gatewaySecretReferenceSupported
    }),
    eventService,
    eventSink,
    modelResolution: new ModelResolutionService(db, { classifier: classifierRuntime }),
    providerConnectionRuntimeTargets,
    organizationSettings: new OrganizationSettingsStore(db),
    promptAccessAudit: new PromptAccessAuditStore(db),
    promptArtifacts: new PromptArtifactStore(transactional, db),
    requestStates: new PersistentRequestStateStore(transactional, db, config.defaultOrganizationId),
    sessionPrompts: new SessionSystemPromptStore(db),
    userAdmin: new UserAdminService(transactional, { invitationTtlSeconds: config.invitationTtlSeconds }),
    workspaceAdmin: new WorkspaceAdminService(transactional),
    adminQueries: {
      forScope: (organizationId: string, workspaceId: string) =>
        new AdminQueryService(db, organizationId, workspaceId, metrics)
    }
  };
}
