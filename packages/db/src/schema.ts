import { sql } from "drizzle-orm";
import { boolean, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";

import type {
  EventOutboxStatus,
  InvitationStatus,
  OrganizationMemberRole,
  OrganizationMemberStatus,
  PromptCaptureMode,
  ProviderAccountAuthType,
  ProviderAttemptStatus,
  ProviderHealthErrorType,
  ProviderHealthStatus,
  RequestStatus,
  RouteExecutionPlan,
  RouteSkipReason,
  RoutingConfig,
  RouteName,
  SessionPinnedSettings,
  UsageLedgerKind
} from "@proxy/schema";

export const organizations = pgTable(
  "organizations",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [uniqueIndex("organizations_slug_idx").on(table.slug)]
);

export const workspaces = pgTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    defaultRoutingConfigId: text("default_routing_config_id"),
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table): PgTableExtraConfigValue[] => [
    uniqueIndex("workspaces_org_slug_idx").on(table.organizationId, table.slug),
    uniqueIndex("workspaces_org_id_idx").on(table.organizationId, table.id),
    foreignKey({
      name: "workspaces_default_routing_config_fk",
      columns: [table.organizationId, table.id, table.defaultRoutingConfigId],
      foreignColumns: [
        routingConfigs.organizationId,
        routingConfigs.workspaceId,
        routingConfigs.id
      ]
    })
  ]
);

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email"),
    name: text("name"),
    externalId: text("external_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("users_email_idx").on(table.email),
    uniqueIndex("users_external_id_idx").on(table.externalId)
  ]
);

export const organizationMembers = pgTable(
  "organization_members",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").$type<OrganizationMemberRole>().notNull(),
    status: text("status").$type<OrganizationMemberStatus>().notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    primaryKey({ name: "organization_members_pk", columns: [table.organizationId, table.userId] }),
    index("organization_members_user_id_idx").on(table.userId)
  ]
);

export const invitations = pgTable(
  "invitations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    name: text("name"),
    role: text("role").$type<OrganizationMemberRole>().notNull(),
    status: text("status").$type<InvitationStatus>().notNull().default("pending"),
    tokenHash: text("token_hash").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    invitedByUserId: text("invited_by_user_id").references(() => users.id, { onDelete: "set null" }),
    acceptedUserId: text("accepted_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true })
  },
  (table) => [
    uniqueIndex("invitations_token_hash_idx").on(table.tokenHash),
    index("invitations_org_email_idx").on(table.organizationId, table.email),
    index("invitations_org_status_idx").on(table.organizationId, table.status)
  ]
);

export const userSessions = pgTable(
  "user_sessions",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
    sessionTokenHash: text("session_token_hash").notNull(),
    sessionTokenPrefix: text("session_token_prefix").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true })
  },
  (table) => [
    uniqueIndex("user_sessions_token_hash_idx").on(table.sessionTokenHash),
    index("user_sessions_organization_user_idx").on(table.organizationId, table.userId),
    index("user_sessions_expires_at_idx").on(table.expiresAt)
  ]
);

export const routingConfigs = pgTable(
  "routing_configs",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    status: text("status").notNull().default("active"),
    activeVersionId: text("active_version_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table): PgTableExtraConfigValue[] => [
    uniqueIndex("routing_configs_org_workspace_id_idx").on(table.organizationId, table.workspaceId, table.id),
    uniqueIndex("routing_configs_org_workspace_slug_idx").on(table.organizationId, table.workspaceId, table.slug),
    index("routing_configs_organization_id_idx").on(table.organizationId),
    index("routing_configs_active_version_idx").on(table.organizationId, table.activeVersionId),
    foreignKey({
      name: "routing_configs_active_version_fk",
      columns: [table.organizationId, table.id, table.activeVersionId],
      foreignColumns: [
        routingConfigVersions.organizationId,
        routingConfigVersions.routingConfigId,
        routingConfigVersions.id
      ]
    })
  ]
);

export const routingConfigVersions = pgTable(
  "routing_config_versions",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    routingConfigId: text("routing_config_id").notNull(),
    version: integer("version").notNull(),
    configHash: text("config_hash").notNull(),
    config: jsonb("config").$type<RoutingConfig>().notNull(),
    status: text("status").notNull().default("draft"),
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true })
  },
  (table): PgTableExtraConfigValue[] => [
    uniqueIndex("routing_config_versions_config_version_idx").on(
      table.organizationId,
      table.routingConfigId,
      table.version
    ),
    uniqueIndex("routing_config_versions_config_id_idx").on(table.organizationId, table.routingConfigId, table.id),
    uniqueIndex("routing_config_versions_org_workspace_hash_idx").on(table.organizationId, table.workspaceId, table.configHash),
    index("routing_config_versions_config_idx").on(table.organizationId, table.routingConfigId),
    foreignKey({
      name: "routing_config_versions_config_fk",
      columns: [table.organizationId, table.workspaceId, table.routingConfigId],
      foreignColumns: [routingConfigs.organizationId, routingConfigs.workspaceId, routingConfigs.id]
    }).onDelete("cascade")
  ]
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    keyHash: text("key_hash").notNull(),
    name: text("name").notNull(),
    routingConfigId: text("routing_config_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true })
  },
  (table) => [
    uniqueIndex("api_keys_hash_idx").on(table.keyHash),
    uniqueIndex("api_keys_org_workspace_id_idx").on(table.organizationId, table.workspaceId, table.id),
    index("api_keys_organization_id_idx").on(table.organizationId),
    index("api_keys_routing_config_idx").on(table.organizationId, table.routingConfigId),
    foreignKey({
      name: "api_keys_routing_config_fk",
      columns: [table.organizationId, table.workspaceId, table.routingConfigId],
      foreignColumns: [routingConfigs.organizationId, routingConfigs.workspaceId, routingConfigs.id]
    })
  ]
);

export const organizationSettings = pgTable("organization_settings", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  promptCaptureMode: text("prompt_capture_mode").$type<PromptCaptureMode>().notNull().default("raw_text"),
  retentionDays: integer("retention_days").notNull().default(30),
  maxRoute: text("max_route").$type<RouteName>(),
  systemPrompt: text("system_prompt"),
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const userSettings = pgTable(
  "user_settings",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    preferredRoute: text("preferred_route").$type<RouteName>(),
    maxReasoningEffort: text("max_reasoning_effort"),
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    primaryKey({ name: "user_settings_pk", columns: [table.organizationId, table.userId] })
  ]
);

export const providers = pgTable(
  "providers",
  {
    id: uuid("id").primaryKey(),
    organizationId: text("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    displayName: text("display_name").notNull(),
    baseUrl: text("base_url").notNull(),
    authStyle: text("auth_style").$type<"bearer" | "x-api-key" | "none">().notNull(),
    endpoints: jsonb("endpoints").$type<{ dialect: string; path: string }[]>().notNull().default([]),
    defaultHeaders: jsonb("default_headers").$type<Record<string, string>>().notNull().default({}),
    capabilities: jsonb("capabilities").$type<Record<string, unknown>>().notNull().default({}),
    forwardHarnessHeaders: boolean("forward_harness_headers").notNull().default(false),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("providers_org_slug_idx").on(table.organizationId, table.slug)
  ]
);

export const providerAccounts = pgTable(
  "provider_accounts",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providers.id),
    name: text("name").notNull(),
    baseUrl: text("base_url"),
    authType: text("auth_type").$type<ProviderAccountAuthType>().notNull().default("api_key"),
    secretRef: text("secret_ref"),
    secretCiphertext: text("secret_ciphertext"),
    secretHint: text("secret_hint"),
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    status: text("status").notNull().default("active"),
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true })
  },
  (table): PgTableExtraConfigValue[] => [
    uniqueIndex("provider_accounts_org_provider_id_name_idx")
      .on(table.organizationId, table.providerId, table.name)
      .where(sql`status = 'active'`),
    uniqueIndex("provider_accounts_org_id_idx").on(table.organizationId, table.id),
    uniqueIndex("provider_accounts_org_id_provider_id_idx").on(table.organizationId, table.id, table.providerId),
    index("provider_accounts_organization_id_idx").on(table.organizationId)
  ]
);

export const apiKeyProviderAccounts = pgTable(
  "api_key_provider_accounts",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").notNull(),
    apiKeyId: text("api_key_id").notNull(),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providers.id),
    providerAccountId: text("provider_account_id").notNull(),
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table): PgTableExtraConfigValue[] => [
    primaryKey({ name: "api_key_provider_accounts_pk", columns: [table.organizationId, table.apiKeyId, table.providerId] }),
    index("api_key_provider_accounts_account_idx").on(table.organizationId, table.providerAccountId),
    index("api_key_provider_accounts_api_key_idx").on(table.organizationId, table.apiKeyId),
    foreignKey({
      name: "api_key_provider_accounts_api_key_fk",
      columns: [table.organizationId, table.workspaceId, table.apiKeyId],
      foreignColumns: [apiKeys.organizationId, apiKeys.workspaceId, apiKeys.id]
    }).onDelete("cascade"),
    foreignKey({
      name: "api_key_provider_accounts_account_fk",
      columns: [table.organizationId, table.providerAccountId],
      foreignColumns: [providerAccounts.organizationId, providerAccounts.id]
    }).onDelete("cascade")
  ]
);

export const providerAccountHealth = pgTable(
  "provider_account_health",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id"),
    providerAccountId: text("provider_account_id").notNull(),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providers.id),
    status: text("status").$type<ProviderHealthStatus>().notNull(),
    lastErrorType: text("last_error_type").$type<ProviderHealthErrorType>(),
    lastErrorMessage: text("last_error_message"),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    cooldownUntil: timestamp("cooldown_until", { withTimezone: true }),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({})
  },
  (table): PgTableExtraConfigValue[] => [
    uniqueIndex("provider_account_health_org_account_idx").on(table.organizationId, table.providerAccountId),
    index("provider_account_health_org_provider_idx").on(table.organizationId, table.providerId),
    index("provider_account_health_org_cooldown_idx").on(table.organizationId, table.cooldownUntil),
    foreignKey({
      name: "provider_account_health_workspace_fk",
      columns: [table.organizationId, table.workspaceId],
      foreignColumns: [workspaces.organizationId, workspaces.id]
    }).onDelete("cascade"),
    foreignKey({
      name: "provider_account_health_account_fk",
      columns: [table.organizationId, table.providerAccountId, table.providerId],
      foreignColumns: [providerAccounts.organizationId, providerAccounts.id, providerAccounts.providerId]
    }).onDelete("cascade")
  ]
);

export const providerModelHealth = pgTable(
  "provider_model_health",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id"),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providers.id),
    providerAccountId: text("provider_account_id").notNull(),
    model: text("model").notNull(),
    status: text("status").$type<ProviderHealthStatus>().notNull(),
    lastErrorType: text("last_error_type").$type<ProviderHealthErrorType>(),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    lockoutUntil: timestamp("lockout_until", { withTimezone: true }),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({})
  },
  (table): PgTableExtraConfigValue[] => [
    uniqueIndex("provider_model_health_org_provider_account_model_idx").on(
      table.organizationId,
      table.providerId,
      table.providerAccountId,
      table.model
    ),
    index("provider_model_health_org_provider_model_idx").on(table.organizationId, table.providerId, table.model),
    index("provider_model_health_org_lockout_idx").on(table.organizationId, table.lockoutUntil),
    foreignKey({
      name: "provider_model_health_workspace_fk",
      columns: [table.organizationId, table.workspaceId],
      foreignColumns: [workspaces.organizationId, workspaces.id]
    }).onDelete("cascade"),
    foreignKey({
      name: "provider_model_health_account_fk",
      columns: [table.organizationId, table.providerAccountId, table.providerId],
      foreignColumns: [providerAccounts.organizationId, providerAccounts.id, providerAccounts.providerId]
    }).onDelete("cascade")
  ]
);

export const modelCatalog = pgTable(
  "model_catalog",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providers.id),
    model: text("model").notNull(),
    route: text("route").$type<RouteName>(),
    capabilities: jsonb("capabilities").$type<Record<string, unknown>>().notNull().default({}),
    pricing: jsonb("pricing").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("model_catalog_org_provider_id_model_idx").on(table.organizationId, table.providerId, table.model),
    index("model_catalog_route_idx").on(table.organizationId, table.route)
  ]
);

export const agentSessions = pgTable(
  "agent_sessions",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    surface: text("surface").notNull(),
    externalSessionId: text("external_session_id"),
    currentRoute: text("current_route").$type<RouteName>(),
    pinnedSettings: jsonb("pinned_settings").$type<SessionPinnedSettings>(),
    routingConfigVersionId: text("routing_config_version_id"),
    requestCount: integer("request_count").notNull().default(0),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("agent_sessions_org_workspace_surface_external_idx").on(
      table.organizationId,
      table.workspaceId,
      table.surface,
      table.externalSessionId
    ),
    index("agent_sessions_organization_id_idx").on(table.organizationId),
    index("agent_sessions_user_id_idx").on(table.organizationId, table.userId)
  ]
);

export const turns = pgTable(
  "turns",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => agentSessions.id, { onDelete: "set null" }),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    externalTurnId: text("external_turn_id"),
    status: text("status").notNull().default("received"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true })
  },
  (table) => [
    index("turns_organization_id_idx").on(table.organizationId),
    index("turns_session_id_idx").on(table.sessionId)
  ]
);

export const requests = pgTable(
  "requests",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    sessionId: text("session_id").references(() => agentSessions.id, { onDelete: "set null" }),
    turnId: text("turn_id").references(() => turns.id, { onDelete: "set null" }),
    apiKeyId: text("api_key_id").references(() => apiKeys.id, { onDelete: "set null" }),
    surface: text("surface").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestedModel: text("requested_model").notNull(),
    inputHash: text("input_hash").notNull(),
    inputChars: integer("input_chars").notNull().default(0),
    estimatedInputTokens: integer("estimated_input_tokens"),
    routingInputHash: text("routing_input_hash"),
    routingInputChars: integer("routing_input_chars"),
    routingEstimatedInputTokens: integer("routing_estimated_input_tokens"),
    routingConfigId: text("routing_config_id"),
    routingConfigVersionId: text("routing_config_version_id"),
    routingConfigVersion: integer("routing_config_version"),
    routingConfigHash: text("routing_config_hash"),
    status: text("status").$type<RequestStatus>().notNull().default("received"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true })
  },
  (table) => [
    uniqueIndex("requests_org_workspace_idempotency_idx").on(table.organizationId, table.workspaceId, table.idempotencyKey),
    index("requests_org_workspace_created_idx").on(table.organizationId, table.workspaceId, table.createdAt),
    index("requests_session_id_idx").on(table.sessionId),
    index("requests_user_id_idx").on(table.organizationId, table.userId),
    index("requests_routing_config_idx").on(table.organizationId, table.routingConfigId),
    index("requests_api_key_idx").on(table.organizationId, table.apiKeyId)
  ]
);

export const routeDecisions = pgTable(
  "route_decisions",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id")
      .notNull()
      .references(() => requests.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    requestedModel: text("requested_model").notNull(),
    classifierRoute: text("classifier_route").$type<RouteName>(),
    finalRoute: text("final_route").$type<RouteName>(),
    selectedProvider: text("selected_provider"),
    selectedModel: text("selected_model"),
    reasoningEffort: text("reasoning_effort"),
    verbosity: text("verbosity"),
    routingConfigId: text("routing_config_id"),
    routingConfigVersionId: text("routing_config_version_id"),
    routingConfigVersion: integer("routing_config_version"),
    routingConfigHash: text("routing_config_hash"),
    confidence: integer("confidence_basis_points"),
    reasonCodes: jsonb("reason_codes").$type<string[]>().notNull().default([]),
    guardrailActions: jsonb("guardrail_actions").$type<string[]>().notNull().default([]),
    budgetChecks: jsonb("budget_checks").$type<Record<string, unknown>[]>().notNull().default([]),
    classifier: jsonb("classifier").$type<Record<string, unknown>>().notNull().default({}),
    routeExecutionPlan: jsonb("route_execution_plan").$type<RouteExecutionPlan | Record<string, never>>().notNull().default({}),
    selectedCandidateId: text("selected_candidate_id"),
    translated: boolean("translated").notNull().default(false),
    translatorId: text("translator_id"),
    policyVersion: text("policy_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("route_decisions_request_id_idx").on(table.requestId),
    index("route_decisions_organization_id_idx").on(table.organizationId),
    index("route_decisions_final_route_idx").on(table.organizationId, table.workspaceId, table.finalRoute),
    index("route_decisions_routing_config_idx").on(table.organizationId, table.routingConfigId)
  ]
);

export const providerAttempts = pgTable(
  "provider_attempts",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id")
      .notNull()
      .references(() => requests.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    surface: text("surface").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    providerAccountId: text("provider_account_id"),
    upstreamRequestId: text("upstream_request_id"),
    terminalStatus: text("terminal_status").$type<ProviderAttemptStatus>().notNull().default("pending"),
    statusCode: integer("status_code"),
    error: text("error"),
    usage: jsonb("usage").$type<Record<string, unknown>>().notNull().default({}),
    routeCandidateId: text("route_candidate_id"),
    attemptIndex: integer("attempt_index"),
    fallbackIndex: integer("fallback_index"),
    skipReason: text("skip_reason").$type<RouteSkipReason>(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    firstByteAt: timestamp("first_byte_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true })
  },
  (table) => [
    index("provider_attempts_request_id_idx").on(table.requestId),
    index("provider_attempts_organization_id_idx").on(table.organizationId),
    index("provider_attempts_org_workspace_request_started_idx").on(
      table.organizationId,
      table.workspaceId,
      table.requestId,
      table.startedAt
    ),
    index("provider_attempts_model_idx").on(table.organizationId, table.workspaceId, table.provider, table.model),
    index("provider_attempts_org_provider_account_idx").on(table.organizationId, table.providerAccountId),
    foreignKey({
      name: "provider_attempts_provider_account_fk",
      columns: [table.organizationId, table.providerAccountId],
      foreignColumns: [providerAccounts.organizationId, providerAccounts.id]
    })
  ]
);

export const usageLedger = pgTable(
  "usage_ledger",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    sessionId: text("session_id").references(() => agentSessions.id, { onDelete: "set null" }),
    requestId: text("request_id")
      .notNull()
      .references(() => requests.id, { onDelete: "cascade" }),
    providerAttemptId: text("provider_attempt_id")
      .references(() => providerAttempts.id, { onDelete: "cascade" }),
    kind: text("kind").$type<UsageLedgerKind>().notNull().default("provider"),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    route: text("route").$type<RouteName>(),
    inputTokens: integer("input_tokens").notNull().default(0),
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    cacheCreationInputTokens: integer("cache_creation_input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    reasoningTokens: integer("reasoning_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    inputCostMicros: integer("input_cost_micros").notNull().default(0),
    outputCostMicros: integer("output_cost_micros").notNull().default(0),
    totalCostMicros: integer("total_cost_micros").notNull().default(0),
    usage: jsonb("usage").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("usage_ledger_provider_attempt_idx").on(table.providerAttemptId),
    uniqueIndex("usage_ledger_classifier_request_idx")
      .on(table.requestId)
      .where(sql`${table.kind} = 'classifier'`),
    index("usage_ledger_org_workspace_request_idx").on(table.organizationId, table.workspaceId, table.requestId),
    index("usage_ledger_org_workspace_created_idx").on(table.organizationId, table.workspaceId, table.createdAt),
    index("usage_ledger_user_created_idx").on(table.organizationId, table.workspaceId, table.userId, table.createdAt),
    index("usage_ledger_model_idx").on(table.organizationId, table.workspaceId, table.provider, table.model)
  ]
);

export const promptArtifacts = pgTable(
  "prompt_artifacts",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    requestId: text("request_id")
      .notNull()
      .references(() => requests.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    storageMode: text("storage_mode").$type<PromptCaptureMode>().notNull(),
    contentHash: text("content_hash").notNull(),
    rawText: text("raw_text"),
    tokenEstimate: integer("token_estimate"),
    sourceRole: text("source_role"),
    sourceIndex: integer("source_index"),
    redactedText: text("redacted_text"),
    encryptedBlobRef: text("encrypted_blob_ref"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("prompt_artifacts_request_id_idx").on(table.requestId),
    index("prompt_artifacts_org_workspace_created_idx").on(table.organizationId, table.workspaceId, table.createdAt),
    index("prompt_artifacts_content_hash_idx").on(table.organizationId, table.contentHash)
  ]
);

export const compressionReceipts = pgTable(
  "compression_receipts",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    requestId: text("request_id")
      .notNull()
      .references(() => requests.id, { onDelete: "cascade" }),
    apiKeyId: text("api_key_id").references(() => apiKeys.id, { onDelete: "set null" }),
    retrievalId: text("retrieval_id"),
    retrievalAvailable: boolean("retrieval_available").notNull().default(false),
    retrievalMarker: text("retrieval_marker"),
    mode: text("mode").notNull(),
    surface: text("surface").notNull(),
    blockPath: text("block_path").notNull(),
    toolName: text("tool_name").notNull(),
    command: text("command"),
    commandClass: text("command_class"),
    ruleId: text("rule_id").notNull(),
    ruleVersion: integer("rule_version").notNull(),
    status: text("status").notNull(),
    originalChars: integer("original_chars").notNull().default(0),
    compressedChars: integer("compressed_chars").notNull().default(0),
    savedChars: integer("saved_chars").notNull().default(0),
    originalBytes: integer("original_bytes").notNull().default(0),
    compressedBytes: integer("compressed_bytes").notNull().default(0),
    originalEstimatedTokens: integer("original_estimated_tokens").notNull().default(0),
    compressedEstimatedTokens: integer("compressed_estimated_tokens").notNull().default(0),
    savedEstimatedTokens: integer("saved_estimated_tokens").notNull().default(0),
    estimateSource: text("estimate_source").notNull().default("rough_chars_per_4"),
    originalSha256: text("original_sha256").notNull(),
    compressedSha256: text("compressed_sha256").notNull(),
    originalArtifactId: text("original_artifact_id").references(() => promptArtifacts.id, { onDelete: "set null" }),
    compressedArtifactId: text("compressed_artifact_id").references(() => promptArtifacts.id, { onDelete: "set null" }),
    skipReason: text("skip_reason"),
    eventId: text("event_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("compression_receipts_event_block_rule_idx").on(table.eventId, table.blockPath, table.ruleId, table.status),
    index("compression_receipts_request_id_idx").on(table.requestId),
    index("compression_receipts_org_workspace_request_idx").on(table.organizationId, table.workspaceId, table.requestId),
    uniqueIndex("compression_receipts_retrieval_id_idx")
      .on(table.retrievalId)
      .where(sql`${table.retrievalId} IS NOT NULL`),
    index("compression_receipts_org_workspace_retrieval_idx")
      .on(table.organizationId, table.workspaceId, table.retrievalId)
      .where(sql`${table.retrievalId} IS NOT NULL`),
    index("compression_receipts_api_key_idx").on(table.organizationId, table.workspaceId, table.apiKeyId),
    index("compression_receipts_org_workspace_created_idx").on(table.organizationId, table.workspaceId, table.createdAt)
  ]
);

export const promptAccessAudit = pgTable(
  "prompt_access_audit",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => promptArtifacts.id, { onDelete: "cascade" }),
    requestId: text("request_id")
      .notNull()
      .references(() => requests.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    adminSessionId: text("admin_session_id").references(() => userSessions.id, { onDelete: "set null" }),
    route: text("route").$type<RouteName>(),
    accessPath: text("access_path").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("prompt_access_audit_org_created_idx").on(table.organizationId, table.createdAt),
    index("prompt_access_audit_artifact_idx").on(table.organizationId, table.artifactId),
    index("prompt_access_audit_user_idx").on(table.organizationId, table.userId, table.createdAt)
  ]
);

export const events = pgTable(
  "events",
  {
    id: text("id").primaryKey(),
    sequence: integer("sequence").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // Nullable: traffic and workspace-entity events carry the workspace;
    // org-level events (members, invitations, provider accounts) do not.
    workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
    scopeType: text("scope_type").notNull(),
    scopeId: text("scope_id").notNull(),
    sessionId: text("session_id"),
    turnId: text("turn_id"),
    parentEventId: text("parent_event_id"),
    causationId: text("causation_id"),
    correlationId: text("correlation_id"),
    idempotencyKey: text("idempotency_key"),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    producer: text("producer").notNull(),
    eventType: text("event_type").notNull(),
    payloadHash: text("payload_hash").notNull(),
    sensitivity: text("sensitivity").notNull(),
    redactionState: text("redaction_state").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull()
  },
  (table) => [
    uniqueIndex("events_scope_sequence_idx").on(table.organizationId, table.scopeType, table.scopeId, table.sequence),
    index("events_organization_created_idx").on(table.organizationId, table.createdAt),
    index("events_org_workspace_created_idx").on(table.organizationId, table.workspaceId, table.createdAt),
    index("events_scope_created_idx").on(table.organizationId, table.scopeType, table.scopeId, table.createdAt),
    index("events_event_type_idx").on(table.organizationId, table.eventType),
    index("events_correlation_id_idx").on(table.organizationId, table.correlationId),
    index("events_idempotency_key_idx").on(table.organizationId, table.idempotencyKey)
  ]
);

export const eventOutbox = pgTable(
  "event_outbox",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    status: text("status").$type<EventOutboxStatus>().notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("event_outbox_status_available_idx").on(table.status, table.availableAt),
    index("event_outbox_event_id_idx").on(table.eventId)
  ]
);

export const projectionCursors = pgTable(
  "projection_cursors",
  {
    projectionName: text("projection_name").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    cursorEventId: text("cursor_event_id"),
    cursorSequence: integer("cursor_sequence"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    primaryKey({ name: "projection_cursors_pk", columns: [table.projectionName, table.organizationId] })
  ]
);
