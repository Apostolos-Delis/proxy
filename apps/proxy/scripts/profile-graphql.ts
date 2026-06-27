/**
 * Profiles every admin GraphQL operation against a seeded PGlite database:
 * wall time (median of 3 runs) plus SQL statements issued per request.
 *
 *   pnpm --filter @proxy/proxy profile:graphql
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

import { createPgliteDatabase } from "@proxy/db";
import {
  agentSessions,
  apiKeys,
  defaultWorkspaceId,
  events,
  hashApiKey,
  invitations,
  organizationMembers,
  organizationSettings,
  organizations,
  promptArtifacts,
  providerAttempts,
  requests,
  routeDecisions,
  usageLedger,
  users,
  workspaces
} from "@proxy/db";
import { seedDatabase, seedOptionsFromEnv } from "@proxy/db/seed";

import { loadConfig } from "../src/config.js";
import { createDatabasePersistence } from "../src/persistence/index.js";
import { buildServer } from "../src/server.js";

const ORG = "org_profile";
const WS = defaultWorkspaceId(ORG);
const DAY_MS = 86_400_000;
const SEED_EPOCH = Date.parse("2026-06-10T12:00:00.000Z");

const sqlCounter = { count: 0 };
const sqlSamples: { op: string; duration: number; sql: string }[] = [];
let currentOperation = "setup";

async function timeSql<T>(sql: unknown, run: () => Promise<T>) {
  const startedAt = performance.now();
  try {
    return await run();
  } finally {
    if (process.env.PROFILE_SQL === "1") {
      sqlSamples.push({
        op: currentOperation,
        duration: performance.now() - startedAt,
        sql: typeof sql === "string" ? sql.replace(/\s+/g, " ").trim() : String(sql)
      });
    }
  }
}

async function createFixture() {
  const client = new PGlite();
  const migrationsDir = fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url));
  const migrationFiles = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of migrationFiles) {
    await client.exec(await readFile(join(migrationsDir, file), "utf8"));
  }

  // Count every SQL statement the app issues.
  const originalQuery = client.query.bind(client);
  client.query = ((...args: Parameters<typeof originalQuery>) => {
    sqlCounter.count += 1;
    return timeSql(args[0], () => originalQuery(...args));
  }) as typeof client.query;
  const originalExec = client.exec.bind(client);
  client.exec = ((...args: Parameters<typeof originalExec>) => {
    sqlCounter.count += 1;
    return timeSql(args[0], () => originalExec(...args));
  }) as typeof client.exec;

  const db = createPgliteDatabase(client);
  const env = {
    ...process.env,
    DATABASE_URL: "",
    EVENT_STORE_PATH: "",
    PROXY_TOKEN: "proxile-token",
    OPENAI_API_KEY: "k",
    OPENAI_BASE_URL: "http://127.0.0.1:1",
    ANTHROPIC_API_KEY: "k",
    ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
    ADMIN_DEV_LOGIN_ENABLED: "true",
    ADMIN_DEV_LOGIN_EMAIL: "local@example.com",
    ADMIN_DEV_LOGIN_PASSWORD: "dev-password",
    SEED_USER_ID: "local-user",
    DEFAULT_ORGANIZATION_ID: ORG,
    LOG_LEVEL: process.env.LOG_LEVEL ?? "fatal"
  };
  const config = loadConfig(env);
  const persistence = createDatabasePersistence(db, config, false);

  await db.insert(organizations).values({ id: ORG, slug: ORG, name: ORG });
  await db.insert(workspaces).values({ id: WS, organizationId: ORG, slug: "default", name: "Default" });
  await db.insert(users).values({ id: "local-user", email: "local@example.com", name: "Local User" });
  await db.insert(organizationMembers).values({ organizationId: ORG, userId: "local-user", role: "owner" });
  await db.insert(organizationSettings).values({ organizationId: ORG, promptCaptureMode: "raw_text" });
  await seedDatabase(db, seedOptionsFromEnv(env));

  await seedVolume(db);

  const app = buildServer(config, { persistence });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  const proxyUrl = typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "";
  return { app, client, proxyUrl };
}

async function seedVolume(db: ReturnType<typeof createPgliteDatabase>) {
  const userCount = 24;
  const sessionCount = 40;
  const requestCount = 600;
  const surfaces = ["openai-responses", "anthropic-messages"] as const;
  const routes = ["fast", "balanced", "hard", "deep"] as const;
  const models = ["gpt-5.4-mini", "gpt-5.4", "gpt-5.5", "claude-sonnet-4-6", "claude-haiku-4-5"];

  await db.insert(users).values(
    Array.from({ length: userCount }, (_, index) => ({
      id: `user_${index}`,
      email: `user${index}@example.com`,
      name: `User ${index}`
    }))
  );
  await db.insert(organizationMembers).values(
    Array.from({ length: userCount }, (_, index) => ({
      organizationId: ORG,
      userId: `user_${index}`,
      role: index % 7 === 0 ? ("admin" as const) : ("member" as const)
    }))
  );
  await db.insert(apiKeys).values(
    Array.from({ length: 12 }, (_, index) => ({
      id: `key_${index}`,
      organizationId: ORG,
      workspaceId: WS,
      keyHash: hashApiKey(`profile-key-${index}`),
      name: `Profile key ${index}`
    }))
  );
  await db.insert(agentSessions).values(
    Array.from({ length: sessionCount }, (_, index) => ({
      id: `session_${index}`,
      organizationId: ORG,
      workspaceId: WS,
      userId: `user_${index % userCount}`,
      surface: surfaces[index % 2],
      externalSessionId: `external-${index}`,
      currentRoute: routes[index % 4],
      startedAt: new Date(SEED_EPOCH - (index % 30) * DAY_MS),
      updatedAt: new Date(SEED_EPOCH - (index % 7) * DAY_MS)
    }))
  );
  await db.insert(invitations).values(
    Array.from({ length: 10 }, (_, index) => ({
      id: `invitation_${index}`,
      organizationId: ORG,
      email: `invitee${index}@example.com`,
      role: "member" as const,
      status: "pending" as const,
      tokenHash: `hash_${index}`,
      tokenPrefix: `prefix_${index}`,
      invitedByUserId: "local-user",
      expiresAt: new Date(SEED_EPOCH + 7 * DAY_MS)
    }))
  );

  for (let batch = 0; batch < requestCount; batch += 100) {
    const ids = Array.from({ length: Math.min(100, requestCount - batch) }, (_, i) => batch + i);
    await db.insert(requests).values(ids.map((index) => ({
      id: `request_${index}`,
      organizationId: ORG,
      workspaceId: WS,
      userId: `user_${index % userCount}`,
      sessionId: `session_${index % sessionCount}`,
      apiKeyId: index % 3 === 0 ? null : `key_${index % 12}`,
      surface: surfaces[index % 2],
      idempotencyKey: `idem_${index}`,
      requestedModel: "router-auto",
      inputHash: `sha256:${index}`,
      inputChars: 100 + index,
      status: index % 17 === 0 ? ("failed" as const) : ("completed" as const),
      createdAt: new Date(SEED_EPOCH - (index % 30) * DAY_MS - (index % 24) * 3_600_000),
      completedAt: new Date(SEED_EPOCH - (index % 30) * DAY_MS)
    })));
    await db.insert(routeDecisions).values(ids.map((index) => ({
      id: `decision_${index}`,
      requestId: `request_${index}`,
      organizationId: ORG,
      workspaceId: WS,
      requestedModel: "router-auto",
      classifierRoute: routes[index % 4],
      finalRoute: routes[index % 4],
      selectedProvider: index % 2 === 0 ? ("openai" as const) : ("anthropic" as const),
      selectedModel: models[index % models.length],
      confidence: 3000 + (index % 7000),
      classifier: { provider: "openai", model: "route-classifier-cheap", confidence: 0.8 },
      policyVersion: "profile"
    })));
    await db.insert(providerAttempts).values(ids.flatMap((index) => {
      const attempt = (suffix: string, status: "completed" | "failed", offsetMs: number) => ({
        id: `attempt_${index}${suffix}`,
        requestId: `request_${index}`,
        organizationId: ORG,
        workspaceId: WS,
        surface: surfaces[index % 2],
        provider: index % 2 === 0 ? ("openai" as const) : ("anthropic" as const),
        model: models[index % models.length],
        terminalStatus: status,
        startedAt: new Date(SEED_EPOCH - (index % 30) * DAY_MS),
        firstByteAt: new Date(SEED_EPOCH - (index % 30) * DAY_MS + 120),
        completedAt: new Date(SEED_EPOCH - (index % 30) * DAY_MS + offsetMs)
      });
      return index % 11 === 0
        ? [attempt("_retry", "failed", 400), attempt("", "completed", 900)]
        : [attempt("", index % 17 === 0 ? "failed" : "completed", 700)];
    }));
    await db.insert(usageLedger).values(ids.map((index) => ({
      id: `usage_${index}`,
      organizationId: ORG,
      workspaceId: WS,
      requestId: `request_${index}`,
      providerAttemptId: `attempt_${index}`,
      userId: `user_${index % userCount}`,
      sessionId: `session_${index % sessionCount}`,
      provider: index % 2 === 0 ? ("openai" as const) : ("anthropic" as const),
      model: models[index % models.length],
      route: routes[index % 4],
      inputTokens: 500 + index,
      cachedInputTokens: index % 5 === 0 ? 200 : 0,
      outputTokens: 150 + (index % 90),
      reasoningTokens: index % 4 === 0 ? 64 : 0,
      totalTokens: 650 + index + (index % 90),
      inputCostMicros: 1200,
      outputCostMicros: 900,
      totalCostMicros: 2100
    })));
    await db.insert(events).values(ids.map((index) => ({
      id: `event_${index}`,
      sequence: 1,
      schemaVersion: 1,
      organizationId: ORG,
      scopeType: "request",
      scopeId: `request_${index}`,
      sessionId: `session_${index % sessionCount}`,
      correlationId: `request_${index}`,
      actorType: "user",
      actorId: `user_${index % userCount}`,
      producer: "profile",
      eventType: "proxy.request_received",
      payloadHash: `sha256:${index}`,
      sensitivity: "internal",
      redactionState: "redacted",
      payload: { surface: surfaces[index % 2], requestedModel: "router-auto" },
      metadata: {},
      createdAt: new Date(SEED_EPOCH - (index % 30) * DAY_MS)
    })));
  }

  const artifactIds = Array.from({ length: 300 }, (_, index) => index);
  await db.insert(promptArtifacts).values(artifactIds.map((index) => ({
    id: `artifact_${index}`,
    organizationId: ORG,
    workspaceId: WS,
    requestId: `request_${index * 2}`,
    kind: index % 3 === 2 ? "assistant_response" : "latest_user_message",
    storageMode: "raw_text" as const,
    contentHash: `sha256:artifact_${index}`,
    rawText: `Profile prompt ${index}: please refactor the billing module and keep tests green.`,
    sourceRole: index % 3 === 2 ? "assistant" : "user",
    metadata: { chars: 70 },
    createdAt: new Date(SEED_EPOCH - (index % 30) * DAY_MS)
  })));
}

type Operation = {
  name: string;
  query: string;
  variables?: Record<string, unknown>;
};

const RANGE = {
  start: new Date(SEED_EPOCH - 30 * DAY_MS).toISOString(),
  end: new Date(SEED_EPOCH).toISOString()
};

const PREVIOUS_RANGE = {
  start: new Date(SEED_EPOCH - 60 * DAY_MS).toISOString(),
  end: new Date(SEED_EPOCH - 30 * DAY_MS).toISOString()
};

const usageGroupSelection = `{
  key requestCount failedRequests retriedRequests failureRate retryRate
  latency { averageMs p95Ms }
  usage { inputTokens cachedInputTokens cacheCreationInputTokens outputTokens reasoningTokens totalTokens }
  cost { selected baseline savings }
}`;

const usageChartGroupSelection = `{
  key requestCount
  usage { inputTokens cachedInputTokens totalTokens }
  cost { selected }
}`;

const operations: Operation[] = [
  { name: "viewer", query: "query { viewer { organizationId user { userId role } organizations { id name role } } }" },
  { name: "overview", query: "query { overview { organizationId eventCount requestCount totals { totalTokens } cost { selected baseline savings } routeQuality { lowConfidenceCount cheaperLikelyWouldWorkCount cheapCausedRetriesOrRepairsCount } } }" },
  { name: "requests", query: "query { requests { requestId sessionId finalRoute selectedModel terminalStatus latencyMs selectedCost usage { totalTokens } routingConfig { configId configName version configHash } } }" },
  { name: "request", query: "query { request(requestId: \"request_10\") { request { requestId terminalStatus } events { eventId eventType payload } } }" },
  { name: "prompts", query: "query { prompts { data { artifactId requestId userId preview kind finalRoute selectedModel cost { selected } routingConfig { configId configName } } pagination { limit offset count } } }" },
  { name: "proxy", query: "query { prompt(artifactId: \"artifact_10\") { artifact { artifactId rawText } request { requestId } requestArtifacts { artifactId kind } events { eventId eventType } } }" },
  { name: "promptAccessAudit", query: "query { promptAccessAudit { id artifactId accessPath createdAt } }" },
  { name: "usage(route)", query: `query { usage(groupBy: route, start: "${RANGE.start}", end: "${RANGE.end}") { groupBy data ${usageGroupSelection} totals ${usageGroupSelection} } }` },
  { name: "usageTimeseries(model)", query: `query { usageTimeseries(groupBy: model, interval: day, start: "${RANGE.start}", end: "${RANGE.end}") { groupBy interval start end groups ${usageGroupSelection} points { ts totals ${usageGroupSelection} groups } } }` },
  { name: "usageDashboard (UsageDashboardView)", query: `query { usageDashboard(groupBy: model, interval: day, start: "${RANGE.start}", end: "${RANGE.end}") { usage { data ${usageGroupSelection} totals ${usageGroupSelection} } timeseries { groups ${usageChartGroupSelection} points { ts totals ${usageChartGroupSelection} groups } } } }` },
  { name: "usageDashboard (UsagePage shape)", query: `query { usageDashboard(groupBy: model, interval: day, start: "${RANGE.start}", end: "${RANGE.end}") { usage { data ${usageGroupSelection} totals ${usageGroupSelection} } timeseries { groups ${usageGroupSelection} points { ts totals ${usageGroupSelection} groups } } } members { userId name email } apiKeys { id name revokedAt } }` },
  { name: "overviewDashboard (OverviewPage shape)", query: `query { overviewDashboard { overview { requestCount totals { totalTokens } cost { selected baseline savings } routeQuality { lowConfidenceCount cheaperLikelyWouldWorkCount cheapCausedRetriesOrRepairsCount } } requests { createdAt selectedCost baselineCost usage { totalTokens } } modelUsage { data { key usage { totalTokens } cost { selected } } } } }` },
  { name: "costPage shape", query: `query { usageDashboard(groupBy: model, interval: day, start: "${RANGE.start}", end: "${RANGE.end}") { usage { data ${usageGroupSelection} totals ${usageGroupSelection} } timeseries { groups ${usageGroupSelection} points { ts totals ${usageGroupSelection} groups } } } spendTab: usage(groupBy: user, start: "${RANGE.start}", end: "${RANGE.end}") { data ${usageGroupSelection} totals ${usageGroupSelection} } members { userId name email } apiKeys { id name revokedAt } modelPricing { model provider source seenInTraffic } }` },
  { name: "cachingPage shape", query: `query { usageDashboard(groupBy: provider, interval: day, start: "${RANGE.start}", end: "${RANGE.end}") { usage { data ${usageGroupSelection} totals ${usageGroupSelection} } timeseries { groups ${usageGroupSelection} points { ts totals ${usageGroupSelection} groups } } } previous: usage(groupBy: provider, start: "${PREVIOUS_RANGE.start}", end: "${PREVIOUS_RANGE.end}") { totals ${usageGroupSelection} } keyUsage: usage(groupBy: api_key, start: "${RANGE.start}", end: "${RANGE.end}") { data ${usageGroupSelection} } modelUsage: usage(groupBy: model, start: "${RANGE.start}", end: "${RANGE.end}") { data ${usageGroupSelection} } modelPricing { model inputCostPerMtok cacheReadCostPerMtok cacheWriteCostPerMtok } members { userId name email } apiKeys { id name revokedAt } cacheBusts(start: "${RANGE.start}", end: "${RANGE.end}") { sessionsScanned sampled countsByCause busts { sessionId requestId at cause droppedCacheReadTokens rebuiltTokens model gapMs } } compressionSavings(start: "${RANGE.start}", end: "${RANGE.end}") { eventCount sampled blocks savedChars savedEstimatedTokens rows { rule ruleVersion tool blocks savedChars savedEstimatedTokens } } tokenAttribution(start: "${RANGE.start}", end: "${RANGE.end}") { requestCount sampled buckets { key chars estimatedTokens } toolSchemas { name chars estimatedTokens blocks } toolResults { name chars estimatedTokens blocks } schemaChurn { name estimatedTokens requests sessions schemaHashes churningSessions status } } idleGaps(start: "${RANGE.start}", end: "${RANGE.end}") { buckets { key label count } totalGaps overTtl recoverableByOneHourTtl estimatedRecoverableCacheReadTokens recommendationThresholdTokens recommendedTtlUpgrade sessionsScanned sampledRequests sampleWindowStart sampleWindowEnd sampled } }` },
  { name: "providersPage shape", query: "query { providerAccounts { id organizationId provider name authType status baseUrl secretHint ownerUserId boundKeyCount createdAt lastUsedAt } providers { id organizationId slug displayName baseUrl authStyle endpoints { dialect path } defaultHeaders capabilities forwardHarnessHeaders enabled builtin } users { userId name email } apiKeys { id name userId routingConfigId createdAt expiresAt revokedAt lastUsedAt providerCredentials { provider providerAccountId name status } routingConfig { id name status } } }" },
  { name: "billingPage shape", query: "query { overview { requestCount cost { selected baseline savings } } }" },
  { name: "users", query: "query { users { userId email name membership { role status } requestCount sessionCount usage { totalTokens } cost { selected } recentActivity createdAt } }" },
  { name: "user", query: "query { user(userId: \"user_3\") { user { userId requestCount } sessions { sessionId } requests { requestId } } }" },
  { name: "sessions", query: "query { sessions { sessionId userId surface currentRoute requestCount routeChanges modelMix routeMix terminalStatusSummary usage { totalTokens } cost { selected } } }" },
  { name: "session", query: "query { session(sessionId: \"session_5\") { session { sessionId requestCount } requests { requestId } promptArtifacts { artifactId kind rawText } routeDecisions { id finalRoute } providerAttempts { id terminalStatus } usageLedger { id totalCostMicros } events { eventId eventType } } }" },
  { name: "invitations", query: "query { invitations { id email role status invitedBy { userId name } expiresAt } }" },
  { name: "settings", query: "query { settings { organizationId databaseEnabled settings { schemaVersion cacheTtlUpgrade automaticCaching toolResultCompressionPolicy { mode minOriginalBytes minSavingsTokens enabledRules storeOriginalArtifact storeCompressedArtifact } duplicateToolResultReferences costBaseline { anthropicMessagesModel openaiResponsesModel openaiChatModel } classifier { model } routeQuality { lowConfidenceThreshold } promptCapture { promptCaptureMode retentionDays } } } }" },
  { name: "routingConfigs", query: "query { routingConfigs { id name slug status assignedApiKeyCount activeVersion { id version configHash } routes { route targets { providerId model effort effectiveEffort } } trafficShare } }" },
  { name: "routingConfig", query: `query { routingConfig(configId: "${ORG}:routing-config:default") { config { id name assignedApiKeyCount } versions { id version active config } } }` },
  { name: "apiKeys", query: "query { apiKeys { id name userId routingConfigId routingConfig { id name status } createdAt lastUsedAt } }" },
  { name: "apiKey", query: "query { apiKey(apiKeyId: \"key_3\") { id name } }" },
  { name: "search", query: "query { search(query: \"profile\") { query results { kind id title subtitle status snippet occurredAt } } }" },
  { name: "publicInvitation", query: "query { publicInvitation(token: \"missing\") { email } }" },
  { name: "keysPage shape", query: "query { apiKeys { id name userId routingConfigId routingConfig { id name status } createdAt expiresAt revokedAt lastUsedAt } routingConfigs { id name status assignedApiKeyCount activeVersion { id version } } }" }
];

const mutations: Operation[] = [
  { name: "mut updateSettings", query: "mutation { updateSettings(input: { schemaVersion: 1, automaticCaching: false, cacheTtlUpgrade: false, toolResultCompressionPolicy: { mode: \"disabled\", minOriginalBytes: 512, minSavingsTokens: 0, enabledRules: [\"mcp-json-whitespace\", \"json-whitespace\", \"bash-output-noise\"], storeOriginalArtifact: false, storeCompressedArtifact: false }, duplicateToolResultReferences: false, costBaseline: { anthropicMessagesModel: \"claude-sonnet-4-6\", openaiResponsesModel: \"gpt-5.4\", openaiChatModel: \"gpt-5.4\" }, classifier: { model: \"route-classifier-cheap\", timeoutMs: 1500, maxAttempts: 2, allowRedactedExcerpt: false }, routeQuality: { lowConfidenceThreshold: 0.5 }, promptCapture: { promptCaptureMode: \"raw_text\", retentionDays: 30 } }) { organizationId } }" },
  { name: "mut configurePromptCapture", query: "mutation { configurePromptCapture(promptCaptureMode: \"raw_text\", retentionDays: 30) { organizationId retentionDays } }" },
  { name: "mut createInvitation", query: "mutation { createInvitation(input: { email: \"profilee@example.com\", role: member }) { invitation { id status } inviteUrl emailDelivery { transport delivered } } }" },
  { name: "mut updateUserRole", query: "mutation { updateUserRole(userId: \"user_3\", role: admin) { userId role previousRole } }" },
  { name: "mut deactivateUser", query: "mutation { deactivateUser(userId: \"user_5\") { userId status } }" },
  { name: "mut reactivateUser", query: "mutation { reactivateUser(userId: \"user_5\") { userId status } }" },
  { name: "mut createApiKey", query: "mutation { createApiKey(input: { name: \"Profiled key\" }) { apiKey { id name } secret } }" },
  { name: "mut assignApiKeyRoutingConfig", query: `mutation { assignApiKeyRoutingConfig(apiKeyId: "key_2", routingConfigId: "${ORG}:routing-config:default") { id routingConfigId } }` },
  { name: "mut createRoutingConfigVersion", query: `mutation CreateVersion($configId: ID!, $config: JSON!) { createRoutingConfigVersion(configId: $configId, config: $config) { config { id } versions { id version } } }` }
];

async function gql(proxyUrl: string, cookie: string, op: Operation) {
  currentOperation = op.name;
  const response = await fetch(`${proxyUrl}/admin/graphql`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(op.variables ? { query: op.query, variables: op.variables } : { query: op.query })
  });
  const body = await response.json() as { errors?: { message: string }[] };
  if (body.errors?.length) {
    throw new Error(`${op.name} failed: ${body.errors[0].message}`);
  }
}

async function profile(proxyUrl: string, cookie: string, op: Operation, runs: number) {
  // Warm parse/validate caches and the database page cache.
  await gql(proxyUrl, cookie, op);
  const samples: { duration: number; sqlCount: number }[] = [];
  for (let run = 0; run < runs; run += 1) {
    const before = sqlCounter.count;
    const startedAt = performance.now();
    await gql(proxyUrl, cookie, op);
    samples.push({ duration: performance.now() - startedAt, sqlCount: sqlCounter.count - before });
  }
  samples.sort((left, right) => left.duration - right.duration);
  const median = samples[Math.floor(samples.length / 2)];
  return { median: median.duration, sqlCount: median.sqlCount };
}

let fixture: Awaited<ReturnType<typeof createFixture>> | undefined;
try {
  fixture = await createFixture();
  const loginResponse = await fetch(`${fixture.proxyUrl}/admin/graphql`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: "mutation { login(email: \"local@example.com\", password: \"dev-password\") { organizationId } }"
    })
  });
  const cookie = loginResponse.headers.get("set-cookie")?.split(";")[0] ?? "";
  if (!cookie) throw new Error("login failed");

  const rows: { name: string; median: number; sqlCount: number }[] = [];
  const operationFilter = process.env.PROFILE_OP;
  const selectedOperations = operationFilter
    ? operations.filter((op) => op.name.includes(operationFilter))
    : operations;
  if (operationFilter && selectedOperations.length === 0) throw new Error(`no operation matched PROFILE_OP=${operationFilter}`);

  for (const op of selectedOperations) {
    rows.push({ name: op.name, ...(await profile(fixture.proxyUrl, cookie, op, 7)) });
  }

  if (!operationFilter) {
    // Mutations mutate state; run each once (no warmup) with its own count.
    const defaultDetail = await fetch(`${fixture.proxyUrl}/admin/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        query: `query { routingConfig(configId: "${ORG}:routing-config:default") { versions { active config } } }`
      })
    }).then((item) => item.json()) as { data: { routingConfig: { versions: { active: boolean; config: unknown }[] } } };
    const activeConfig = defaultDetail.data.routingConfig.versions.find((version) => version.active)?.config;
    if (!activeConfig) throw new Error("no active routing config version found in seed");

    for (const op of mutations) {
      const prepared = op.name === "mut createRoutingConfigVersion"
        ? {
            ...op,
            variables: {
              configId: `${ORG}:routing-config:default`,
              config: { ...(activeConfig as Record<string, unknown>), displayName: "Profiled version" }
            }
          }
        : op;
      const before = sqlCounter.count;
      const startedAt = performance.now();
      await gql(fixture.proxyUrl, cookie, prepared);
      rows.push({ name: op.name, median: performance.now() - startedAt, sqlCount: sqlCounter.count - before });
    }
  }

  const width = Math.max(...rows.map((row) => row.name.length)) + 2;
  console.log(`\n${"operation".padEnd(width)}${"median ms".padStart(10)}${"sql".padStart(6)}`);
  console.log("-".repeat(width + 16));
  for (const row of [...rows].sort((left, right) => right.median - left.median)) {
    console.log(`${row.name.padEnd(width)}${row.median.toFixed(1).padStart(10)}${String(row.sqlCount).padStart(6)}`);
  }
  if (process.env.PROFILE_SQL === "1") {
    const slow = [...sqlSamples]
      .filter((sample) => sample.op !== "setup")
      .sort((left, right) => right.duration - left.duration)
      .slice(0, 20);
    const sqlWidth = Math.max(...slow.map((sample) => sample.op.length), "operation".length) + 2;
    console.log(`\n${"operation".padEnd(sqlWidth)}${"sql ms".padStart(10)}  sql`);
    console.log("-".repeat(sqlWidth + 80));
    for (const sample of slow) {
      console.log(`${sample.op.padEnd(sqlWidth)}${sample.duration.toFixed(1).padStart(10)}  ${sample.sql.slice(0, 240)}`);
    }
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await fixture?.app.close();
  await fixture?.client.close();
}
