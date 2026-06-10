import { builder } from "../builder.js";
import type {
  ApiKeyModel,
  ApiKeyRoutingConfigRefModel,
  RouteMatrixRowModel,
  RoutingConfigDetailModel,
  RoutingConfigSummaryModel,
  RoutingConfigVersionDetailModel,
  RoutingConfigVersionModel
} from "../models.js";

export const RouteMatrixRow = builder.objectRef<RouteMatrixRowModel>("RouteMatrixRow").implement({
  fields: (t) => ({
    route: t.exposeString("route"),
    description: t.exposeString("description", { nullable: true }),
    openaiModel: t.exposeString("openaiModel", { nullable: true }),
    openaiEffort: t.exposeString("openaiEffort", { nullable: true }),
    anthropicModel: t.exposeString("anthropicModel", { nullable: true }),
    anthropicEffort: t.exposeString("anthropicEffort", { nullable: true })
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
      systemPrompt: t.exposeString("systemPrompt", { nullable: true }),
      activeVersionId: t.exposeString("activeVersionId", { nullable: true }),
      activeVersion: t.field({
        type: RoutingConfigVersion,
        nullable: true,
        resolve: (config) => config.activeVersion
      }),
      routeMatrix: t.expose("routeMatrix", { type: [RouteMatrixRow] }),
      assignedApiKeyCount: t.exposeInt("assignedApiKeyCount"),
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

export const ApiKey = builder.objectRef<ApiKeyModel>("ApiKey").implement({
  fields: (t) => ({
    id: t.exposeString("id"),
    organizationId: t.exposeString("organizationId"),
    userId: t.exposeString("userId", { nullable: true }),
    name: t.exposeString("name"),
    scopes: t.exposeStringList("scopes"),
    routingConfigId: t.exposeString("routingConfigId", { nullable: true }),
    routingConfig: t.field({
      type: ApiKeyRoutingConfigRef,
      nullable: true,
      resolve: (key) => key.routingConfig
    }),
    createdAt: t.exposeString("createdAt"),
    expiresAt: t.exposeString("expiresAt", { nullable: true }),
    revokedAt: t.exposeString("revokedAt", { nullable: true }),
    lastUsedAt: t.exposeString("lastUsedAt", { nullable: true })
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
