import { builder } from "../builder.js";
import type { ProviderHealthProbeResult } from "../../providerHealthProbe.js";
import { ProviderAccountAuthType } from "./core.js";
import type {
  HarnessCompatibilityMatrixRow,
  HarnessSmokeStatusModel
} from "../../harnessCompatibilityReport.js";
import type {
  ApiKeyModel,
  ApiKeyProviderBindingModel,
  ApiKeyRoutingConfigRefModel,
  ProviderEndpointModel,
  ProviderAccountModel,
  ProviderRegistryEntryModel,
  RouteTargetModel,
  RoutingConfigRouteModel,
  RoutingConfigDetailModel,
  RoutingConfigSummaryModel,
  RoutingConfigVersionDetailModel,
  RoutingConfigVersionModel
} from "../models.js";

export const ProviderEndpoint = builder.objectRef<ProviderEndpointModel>("ProviderEndpoint").implement({
  fields: (t) => ({
    dialect: t.exposeString("dialect"),
    path: t.exposeString("path")
  })
});

export const HarnessSmokeStatus = builder.objectRef<HarnessSmokeStatusModel>("HarnessSmokeStatus").implement({
  fields: (t) => ({
    status: t.exposeString("status"),
    checkedAt: t.exposeString("checkedAt", { nullable: true }),
    detail: t.exposeString("detail", { nullable: true })
  })
});

export const HarnessCompatibilityMatrixEntry = builder
  .objectRef<HarnessCompatibilityMatrixRow>("HarnessCompatibilityMatrixEntry")
  .implement({
    fields: (t) => ({
      profileId: t.exposeString("profileId"),
      displayName: t.exposeString("displayName"),
      harness: t.exposeString("harness"),
      surface: t.exposeString("surface"),
      transport: t.exposeString("transport"),
      targetDialect: t.exposeString("targetDialect"),
      effectiveDialect: t.exposeString("effectiveDialect", { nullable: true }),
      translatedFrom: t.exposeString("translatedFrom"),
      translatedTo: t.exposeString("translatedTo", { nullable: true }),
      status: t.exposeString("status"),
      support: t.exposeString("support"),
      nativeSupport: t.exposeBoolean("nativeSupport"),
      translatedSupport: t.exposeBoolean("translatedSupport"),
      statefulFeatures: t.exposeStringList("statefulFeatures"),
      unsupportedStatefulFeatures: t.exposeStringList("unsupportedStatefulFeatures"),
      reasonCodes: t.exposeStringList("reasonCodes"),
      testedFixtureCount: t.exposeInt("testedFixtureCount"),
      lastSmokeStatus: t.field({
        type: HarnessSmokeStatus,
        nullable: true,
        resolve: (row) => row.lastSmokeStatus ?? null
      })
    })
  });

export const ProviderRegistryEntry = builder.objectRef<ProviderRegistryEntryModel>("ProviderRegistryEntry").implement({
  fields: (t) => ({
    id: t.exposeString("id"),
    organizationId: t.exposeString("organizationId", { nullable: true }),
    slug: t.exposeString("slug"),
    displayName: t.exposeString("displayName"),
    baseUrl: t.exposeString("baseUrl"),
    authStyle: t.exposeString("authStyle"),
    endpoints: t.expose("endpoints", { type: [ProviderEndpoint] }),
    defaultHeaders: t.field({ type: "JSON", resolve: (provider) => provider.defaultHeaders }),
    capabilities: t.field({ type: "JSON", resolve: (provider) => provider.capabilities }),
    forwardHarnessHeaders: t.exposeBoolean("forwardHarnessHeaders"),
    enabled: t.exposeBoolean("enabled"),
    builtin: t.exposeBoolean("builtin")
  })
});

export const RouteTarget = builder.objectRef<RouteTargetModel>("RouteTarget").implement({
  fields: (t) => ({
    providerId: t.exposeString("providerId"),
    model: t.exposeString("model"),
    effort: t.exposeString("effort", { nullable: true }),
    effectiveEffort: t.exposeString("effectiveEffort", { nullable: true }),
    thinking: t.field({ type: "JSON", nullable: true, resolve: (target) => target.thinking }),
    maxOutputTokens: t.exposeInt("maxOutputTokens", { nullable: true }),
    verbosity: t.exposeString("verbosity", { nullable: true }),
    metadata: t.field({ type: "JSON", nullable: true, resolve: (target) => target.metadata })
  })
});

export const RoutingConfigRoute = builder.objectRef<RoutingConfigRouteModel>("RoutingConfigRoute").implement({
  fields: (t) => ({
    route: t.exposeString("route"),
    description: t.exposeString("description", { nullable: true }),
    targets: t.expose("targets", { type: [RouteTarget] })
  })
});

export const RoutingConfigVersion = builder
  .objectRef<RoutingConfigVersionModel>("RoutingConfigVersion")
  .implement({
    fields: (t) => ({
      id: t.exposeString("id"),
      organizationId: t.exposeString("organizationId"),
      routingConfigId: t.exposeString("routingConfigId"),
      version: t.exposeInt("version"),
      configHash: t.exposeString("configHash"),
      status: t.exposeString("status"),
      active: t.exposeBoolean("active"),
      createdByUserId: t.exposeString("createdByUserId", { nullable: true }),
      createdAt: t.exposeString("createdAt"),
      activatedAt: t.exposeString("activatedAt", { nullable: true }),
      archivedAt: t.exposeString("archivedAt", { nullable: true })
    })
  });

export const RoutingConfigVersionDetail = builder
  .objectRef<RoutingConfigVersionDetailModel>("RoutingConfigVersionDetail")
  .implement({
    fields: (t) => ({
      id: t.exposeString("id"),
      organizationId: t.exposeString("organizationId"),
      routingConfigId: t.exposeString("routingConfigId"),
      version: t.exposeInt("version"),
      configHash: t.exposeString("configHash"),
      status: t.exposeString("status"),
      active: t.exposeBoolean("active"),
      createdByUserId: t.exposeString("createdByUserId", { nullable: true }),
      createdAt: t.exposeString("createdAt"),
      activatedAt: t.exposeString("activatedAt", { nullable: true }),
      archivedAt: t.exposeString("archivedAt", { nullable: true }),
      config: t.field({ type: "JSON", resolve: (version) => version.config })
    })
  });

export const RoutingConfigSummary = builder
  .objectRef<RoutingConfigSummaryModel>("RoutingConfigSummary")
  .implement({
    fields: (t) => ({
      id: t.exposeString("id"),
      organizationId: t.exposeString("organizationId"),
      name: t.exposeString("name"),
      slug: t.exposeString("slug"),
      description: t.exposeString("description", { nullable: true }),
      status: t.exposeString("status"),
      activeVersionId: t.exposeString("activeVersionId", { nullable: true }),
      activeVersion: t.field({
        type: RoutingConfigVersion,
        nullable: true,
        resolve: (config) => config.activeVersion
      }),
      routes: t.expose("routes", { type: [RoutingConfigRoute] }),
      assignedApiKeyCount: t.exposeInt("assignedApiKeyCount"),
      trafficShare: t.exposeFloat("trafficShare", {
        description: "Share of routed requests handled by this config over the trailing 7 days (0..1)."
      }),
      createdAt: t.exposeString("createdAt"),
      updatedAt: t.exposeString("updatedAt")
    })
  });

export const RoutingConfigDetail = builder
  .objectRef<RoutingConfigDetailModel>("RoutingConfigDetail")
  .implement({
    fields: (t) => ({
      config: t.expose("config", { type: RoutingConfigSummary }),
      versions: t.expose("versions", { type: [RoutingConfigVersionDetail] })
    })
  });

export const ApiKeyRoutingConfigRef = builder
  .objectRef<ApiKeyRoutingConfigRefModel>("ApiKeyRoutingConfigRef")
  .implement({
    fields: (t) => ({
      id: t.exposeString("id"),
      name: t.exposeString("name", { nullable: true }),
      status: t.exposeString("status", { nullable: true })
    })
  });

export const ApiKeyProviderBinding = builder
  .objectRef<ApiKeyProviderBindingModel>("ApiKeyProviderBinding")
  .implement({
    fields: (t) => ({
      provider: t.exposeString("provider"),
      providerId: t.exposeString("providerId"),
      providerAccountId: t.exposeString("providerAccountId"),
      name: t.exposeString("name", { nullable: true }),
      status: t.exposeString("status", { nullable: true })
    })
  });

export const ApiKey = builder.objectRef<ApiKeyModel>("ApiKey").implement({
  fields: (t) => ({
    id: t.exposeString("id"),
    organizationId: t.exposeString("organizationId"),
    userId: t.exposeString("userId", { nullable: true }),
    name: t.exposeString("name"),
    routingConfigId: t.exposeString("routingConfigId", { nullable: true }),
    routingConfig: t.field({
      type: ApiKeyRoutingConfigRef,
      nullable: true,
      resolve: (key) => key.routingConfig
    }),
    providerCredentials: t.expose("providerCredentials", { type: [ApiKeyProviderBinding] }),
    createdAt: t.exposeString("createdAt"),
    expiresAt: t.exposeString("expiresAt", { nullable: true }),
    revokedAt: t.exposeString("revokedAt", { nullable: true }),
    lastUsedAt: t.exposeString("lastUsedAt", { nullable: true })
  })
});

type ProviderAccountHealthModel = NonNullable<ProviderAccountModel["health"]>;
type ProviderModelHealthModel = ProviderAccountHealthModel["modelHealth"][number];

export const ProviderModelHealth = builder.objectRef<ProviderModelHealthModel>("ProviderModelHealth").implement({
  fields: (t) => ({
    providerId: t.exposeString("providerId"),
    providerAccountId: t.exposeString("providerAccountId"),
    model: t.exposeString("model"),
    status: t.exposeString("status"),
    lastErrorType: t.exposeString("lastErrorType", { nullable: true }),
    lastErrorAt: t.exposeString("lastErrorAt", { nullable: true }),
    lockoutUntil: t.exposeString("lockoutUntil", { nullable: true }),
    consecutiveFailures: t.exposeInt("consecutiveFailures"),
    lastSuccessAt: t.exposeString("lastSuccessAt", { nullable: true })
  })
});

export const ProviderAccountHealth = builder.objectRef<ProviderAccountHealthModel>("ProviderAccountHealth").implement({
  fields: (t) => ({
    status: t.exposeString("status", { nullable: true }),
    lastErrorType: t.exposeString("lastErrorType", { nullable: true }),
    lastErrorAt: t.exposeString("lastErrorAt", { nullable: true }),
    cooldownUntil: t.exposeString("cooldownUntil", { nullable: true }),
    consecutiveFailures: t.exposeInt("consecutiveFailures"),
    lastSuccessAt: t.exposeString("lastSuccessAt", { nullable: true }),
    lastCheckedAt: t.exposeString("lastCheckedAt", { nullable: true }),
    modelHealth: t.expose("modelHealth", { type: [ProviderModelHealth] })
  })
});

export const ProviderHealthProbeResultType = builder.objectRef<ProviderHealthProbeResult>("ProviderHealthProbeResult").implement({
  fields: (t) => ({
    probeId: t.exposeString("probeId"),
    providerAccountId: t.exposeString("providerAccountId"),
    provider: t.exposeString("provider"),
    model: t.exposeString("model"),
    status: t.exposeString("status"),
    healthStatus: t.exposeString("healthStatus"),
    errorType: t.exposeString("errorType", { nullable: true }),
    message: t.exposeString("message", { nullable: true }),
    statusCode: t.exposeInt("statusCode", { nullable: true }),
    latencyMs: t.exposeInt("latencyMs"),
    checkedAt: t.exposeString("checkedAt"),
    stateUpdated: t.exposeBoolean("stateUpdated"),
    dimensions: t.field({ type: "JSON", resolve: (result) => result.dimensions })
  })
});

export const ProviderAccount = builder.objectRef<ProviderAccountModel>("ProviderAccount").implement({
    fields: (t) => ({
      id: t.exposeString("id"),
      organizationId: t.exposeString("organizationId"),
      providerId: t.exposeString("providerId"),
      provider: t.exposeString("provider"),
      name: t.exposeString("name"),
      baseUrl: t.exposeString("baseUrl", { nullable: true }),
      authType: t.expose("authType", { type: ProviderAccountAuthType }),
    status: t.exposeString("status"),
    secretHint: t.exposeString("secretHint", { nullable: true }),
    ownerUserId: t.exposeString("ownerUserId", { nullable: true }),
    boundKeyCount: t.exposeInt("boundKeyCount"),
    health: t.expose("health", { type: ProviderAccountHealth, nullable: true }),
    createdAt: t.exposeString("createdAt"),
    lastUsedAt: t.exposeString("lastUsedAt", { nullable: true })
  })
});

export type ProviderCredentialOAuthStartModel = {
  loginId: string;
  verificationUrl: string;
  userCode?: string | null;
};

export const ProviderCredentialOAuthStart = builder
  .objectRef<ProviderCredentialOAuthStartModel>("ProviderCredentialOAuthStart")
  .implement({
    fields: (t) => ({
      loginId: t.exposeString("loginId"),
      verificationUrl: t.exposeString("verificationUrl"),
      userCode: t.exposeString("userCode", { nullable: true })
    })
  });

export type ProviderCredentialOAuthStatusModel = {
  loginId: string;
  status: string;
  providerAccountId?: string;
  error?: string;
};

export const ProviderCredentialOAuthStatus = builder
  .objectRef<ProviderCredentialOAuthStatusModel>("ProviderCredentialOAuthStatus")
  .implement({
    fields: (t) => ({
      loginId: t.exposeString("loginId"),
      status: t.exposeString("status"),
      providerAccountId: t.exposeString("providerAccountId", { nullable: true }),
      error: t.exposeString("error", { nullable: true })
    })
  });

export type CreateApiKeyResultModel = {
  apiKey: ApiKeyModel | null;
  secret: string;
};

export const CreateApiKeyResult = builder
  .objectRef<CreateApiKeyResultModel>("CreateApiKeyResult")
  .implement({
    fields: (t) => ({
      apiKey: t.field({
        type: ApiKey,
        nullable: true,
        resolve: (result) => result.apiKey
      }),
      secret: t.exposeString("secret")
    })
  });
