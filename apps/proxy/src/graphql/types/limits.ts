import { builder } from "../builder.js";
import type {
  ActiveRequestLimitModel,
  ApiKeyLimitPolicyModel,
  BudgetWindowModel,
  LimitsDashboardModel,
  WorkspaceLimitPolicyModel
} from "../models.js";
import { ProxyEvent } from "./core.js";

export const WorkspaceLimitPolicy = builder
  .objectRef<WorkspaceLimitPolicyModel>("WorkspaceLimitPolicy")
  .implement({
    fields: (t) => ({
      id: t.exposeString("id"),
      organizationId: t.exposeString("organizationId"),
      workspaceId: t.exposeString("workspaceId"),
      policy: t.field({ type: "JSON", resolve: (row) => row.policy }),
      createdAt: t.exposeString("createdAt"),
      updatedAt: t.exposeString("updatedAt")
    })
  });

export const ApiKeyLimitPolicy = builder
  .objectRef<ApiKeyLimitPolicyModel>("ApiKeyLimitPolicy")
  .implement({
    fields: (t) => ({
      id: t.exposeString("id"),
      organizationId: t.exposeString("organizationId"),
      workspaceId: t.exposeString("workspaceId"),
      apiKeyId: t.exposeString("apiKeyId", { nullable: true }),
      apiKeyName: t.exposeString("apiKeyName", { nullable: true }),
      policy: t.field({ type: "JSON", resolve: (row) => row.policy }),
      createdAt: t.exposeString("createdAt"),
      updatedAt: t.exposeString("updatedAt")
    })
  });

export const ActiveRequestLimit = builder
  .objectRef<ActiveRequestLimitModel>("ActiveRequestLimit")
  .implement({
    fields: (t) => ({
      id: t.exposeString("id"),
      organizationId: t.exposeString("organizationId"),
      workspaceId: t.exposeString("workspaceId"),
      apiKeyId: t.exposeString("apiKeyId", { nullable: true }),
      apiKeyName: t.exposeString("apiKeyName", { nullable: true }),
      providerAccountId: t.exposeString("providerAccountId", { nullable: true }),
      providerAccountName: t.exposeString("providerAccountName", { nullable: true }),
      requestId: t.exposeString("requestId"),
      startedAt: t.exposeString("startedAt"),
      expiresAt: t.exposeString("expiresAt")
    })
  });

export const BudgetWindow = builder.objectRef<BudgetWindowModel>("BudgetWindow").implement({
  fields: (t) => ({
    id: t.exposeString("id"),
    organizationId: t.exposeString("organizationId"),
    workspaceId: t.exposeString("workspaceId"),
    scopeType: t.exposeString("scopeType"),
    scopeId: t.exposeString("scopeId"),
    windowType: t.exposeString("windowType"),
    periodStartAt: t.exposeString("periodStartAt"),
    periodEndAt: t.exposeString("periodEndAt"),
    limitUsd: t.exposeFloat("limitUsd"),
    reservedUsd: t.exposeFloat("reservedUsd"),
    actualUsd: t.exposeFloat("actualUsd"),
    warningEmittedAt: t.exposeString("warningEmittedAt", { nullable: true }),
    exceededEmittedAt: t.exposeString("exceededEmittedAt", { nullable: true }),
    createdAt: t.exposeString("createdAt"),
    updatedAt: t.exposeString("updatedAt")
  })
});

export const LimitsDashboard = builder.objectRef<LimitsDashboardModel>("LimitsDashboard").implement({
  fields: (t) => ({
    workspacePolicies: t.expose("workspacePolicies", { type: [WorkspaceLimitPolicy] }),
    apiKeyPolicies: t.expose("apiKeyPolicies", { type: [ApiKeyLimitPolicy] }),
    activeRequests: t.expose("activeRequests", { type: [ActiveRequestLimit] }),
    budgetWindows: t.expose("budgetWindows", { type: [BudgetWindow] }),
    rejectionEvents: t.expose("rejectionEvents", { type: [ProxyEvent] })
  })
});
