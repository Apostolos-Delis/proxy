import { index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import type {
  EventOutboxStatus,
  OrganizationMemberRole,
  PromptCaptureMode,
  Provider,
  ProviderAttemptStatus,
  RequestStatus,
  RouteName,
  Surface
} from "@prompt-proxy/schema";

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
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    primaryKey({ name: "organization_members_pk", columns: [table.organizationId, table.userId] }),
    index("organization_members_user_id_idx").on(table.userId)
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

export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    keyHash: text("key_hash").notNull(),
    name: text("name").notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true })
  },
  (table) => [
    uniqueIndex("api_keys_hash_idx").on(table.keyHash),
    index("api_keys_organization_id_idx").on(table.organizationId)
  ]
);

export const organizationSettings = pgTable("organization_settings", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  promptCaptureMode: text("prompt_capture_mode").$type<PromptCaptureMode>().notNull().default("hash_only"),
  retentionDays: integer("retention_days").notNull().default(30),
  maxRoute: text("max_route").$type<RouteName>(),
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

export const providerAccounts = pgTable(
  "provider_accounts",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    provider: text("provider").$type<Provider>().notNull(),
    name: text("name").notNull(),
    secretRef: text("secret_ref"),
    status: text("status").notNull().default("active"),
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("provider_accounts_org_provider_name_idx").on(table.organizationId, table.provider, table.name),
    index("provider_accounts_organization_id_idx").on(table.organizationId)
  ]
);

export const modelCatalog = pgTable(
  "model_catalog",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
    provider: text("provider").$type<Provider>().notNull(),
    model: text("model").notNull(),
    route: text("route").$type<RouteName>(),
    capabilities: jsonb("capabilities").$type<Record<string, unknown>>().notNull().default({}),
    pricing: jsonb("pricing").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("model_catalog_org_provider_model_idx").on(table.organizationId, table.provider, table.model),
    index("model_catalog_route_idx").on(table.organizationId, table.route)
  ]
);

export const routePolicies = pgTable(
  "route_policies",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    classifierModel: text("classifier_model").notNull(),
    classifierPromptVersion: text("classifier_prompt_version").notNull(),
    policy: jsonb("policy").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("route_policies_org_name_idx").on(table.organizationId, table.name),
    index("route_policies_organization_id_idx").on(table.organizationId)
  ]
);

export const agentSessions = pgTable(
  "agent_sessions",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    surface: text("surface").$type<Surface>().notNull(),
    externalSessionId: text("external_session_id"),
    currentRoute: text("current_route").$type<RouteName>(),
    requestCount: integer("request_count").notNull().default(0),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("agent_sessions_org_surface_external_idx").on(table.organizationId, table.surface, table.externalSessionId),
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
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    sessionId: text("session_id").references(() => agentSessions.id, { onDelete: "set null" }),
    turnId: text("turn_id").references(() => turns.id, { onDelete: "set null" }),
    surface: text("surface").$type<Surface>().notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestedModel: text("requested_model").notNull(),
    inputHash: text("input_hash").notNull(),
    inputChars: integer("input_chars").notNull().default(0),
    estimatedInputTokens: integer("estimated_input_tokens"),
    routingInputHash: text("routing_input_hash"),
    routingInputChars: integer("routing_input_chars"),
    routingEstimatedInputTokens: integer("routing_estimated_input_tokens"),
    status: text("status").$type<RequestStatus>().notNull().default("received"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true })
  },
  (table) => [
    uniqueIndex("requests_org_idempotency_idx").on(table.organizationId, table.idempotencyKey),
    index("requests_organization_created_idx").on(table.organizationId, table.createdAt),
    index("requests_session_id_idx").on(table.sessionId),
    index("requests_user_id_idx").on(table.organizationId, table.userId)
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
    requestedModel: text("requested_model").notNull(),
    classifierRoute: text("classifier_route").$type<RouteName>(),
    finalRoute: text("final_route").$type<RouteName>(),
    selectedProvider: text("selected_provider").$type<Provider>(),
    selectedModel: text("selected_model"),
    reasoningEffort: text("reasoning_effort"),
    verbosity: text("verbosity"),
    confidence: integer("confidence_basis_points"),
    reasonCodes: jsonb("reason_codes").$type<string[]>().notNull().default([]),
    guardrailActions: jsonb("guardrail_actions").$type<string[]>().notNull().default([]),
    budgetChecks: jsonb("budget_checks").$type<Record<string, unknown>[]>().notNull().default([]),
    classifier: jsonb("classifier").$type<Record<string, unknown>>().notNull().default({}),
    policyVersion: text("policy_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("route_decisions_request_id_idx").on(table.requestId),
    index("route_decisions_organization_id_idx").on(table.organizationId),
    index("route_decisions_final_route_idx").on(table.organizationId, table.finalRoute)
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
    surface: text("surface").$type<Surface>().notNull(),
    provider: text("provider").$type<Provider>().notNull(),
    model: text("model").notNull(),
    upstreamRequestId: text("upstream_request_id"),
    terminalStatus: text("terminal_status").$type<ProviderAttemptStatus>().notNull().default("pending"),
    statusCode: integer("status_code"),
    error: text("error"),
    usage: jsonb("usage").$type<Record<string, unknown>>().notNull().default({}),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    firstByteAt: timestamp("first_byte_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true })
  },
  (table) => [
    index("provider_attempts_request_id_idx").on(table.requestId),
    index("provider_attempts_organization_id_idx").on(table.organizationId),
    index("provider_attempts_model_idx").on(table.organizationId, table.provider, table.model)
  ]
);

export const usageLedger = pgTable(
  "usage_ledger",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    sessionId: text("session_id").references(() => agentSessions.id, { onDelete: "set null" }),
    requestId: text("request_id")
      .notNull()
      .references(() => requests.id, { onDelete: "cascade" }),
    providerAttemptId: text("provider_attempt_id")
      .notNull()
      .references(() => providerAttempts.id, { onDelete: "cascade" }),
    provider: text("provider").$type<Provider>().notNull(),
    model: text("model").notNull(),
    route: text("route").$type<RouteName>(),
    inputTokens: integer("input_tokens").notNull().default(0),
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
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
    index("usage_ledger_org_created_idx").on(table.organizationId, table.createdAt),
    index("usage_ledger_user_created_idx").on(table.organizationId, table.userId, table.createdAt),
    index("usage_ledger_model_idx").on(table.organizationId, table.provider, table.model)
  ]
);

export const promptArtifacts = pgTable(
  "prompt_artifacts",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
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
    index("prompt_artifacts_org_created_idx").on(table.organizationId, table.createdAt),
    index("prompt_artifacts_content_hash_idx").on(table.organizationId, table.contentHash)
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
