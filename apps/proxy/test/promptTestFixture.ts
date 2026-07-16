import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { expect } from "vitest";

import {
  createPgliteDatabase,
  defaultWorkspaceId,
  events,
  organizationMembers,
  organizationSettings,
  organizations,
  users,
  workspaces
} from "@proxy/db";
import { defaultProviderModelCatalog, seedDatabase, seedOptionsFromEnv } from "@proxy/db/seed";

import { loadConfig } from "../src/config.js";
import { LlmClassifier } from "../src/classifier.js";
import { NoopMetricsCollector, type MetricsCollector } from "../src/metrics.js";
import { createEnvironmentSecretReferenceResolver } from "../src/persistence/environmentSecretReferences.js";
import { createDatabasePersistence } from "../src/persistence/index.js";
import { ProviderConnectionClassifierTargetResolver } from "../src/persistence/providerConnectionClassifierTarget.js";
import { buildServer } from "../src/server.js";
import { listen, startAnthropicMock, startOpenAIMock, type MockServer } from "./helpers.js";

type PromptCaptureMode = "none" | "hash_only" | "raw_text";
type OpenAIOptions = Parameters<typeof startOpenAIMock>[0];

export type PromptTestFixture = Awaited<ReturnType<typeof captureFixture>>;

export function testEnv(overrides: NodeJS.ProcessEnv = {}) {
  return {
    ...process.env,
    DATABASE_URL: "",
    EVENT_STORE_PATH: "",
    PROXY_TOKEN: "proxy-token",
    OPENAI_API_KEY: "openai-upstream-key",
    OPENAI_BASE_URL: "http://127.0.0.1",
    ANTHROPIC_API_KEY: "anthropic-upstream-key",
    ANTHROPIC_BASE_URL: "http://127.0.0.1",
    GATEWAY_SEED_CLASSIFIER_MODEL: "route-classifier-cheap",
    ALLOWED_PRIVATE_UPSTREAM_CIDRS: "127.0.0.0/8",
    ADMIN_DEV_LOGIN_ENABLED: "true",
    ADMIN_DEV_LOGIN_EMAIL: "local@example.com",
    ADMIN_DEV_LOGIN_PASSWORD: "dev-password",
    SEED_USER_ID: "local-user",
    SEED_USER_NAME: "Local User",
    ...overrides
  };
}

export async function captureFixture(
  organizationId: string,
  promptCaptureMode: PromptCaptureMode = "raw_text",
  failCapture = false,
  options: {
    envOverrides?: NodeJS.ProcessEnv;
    openAIOptions?: OpenAIOptions;
    anthropicOptions?: Parameters<typeof startAnthropicMock>[0];
    metrics?: MetricsCollector;
  } = {}
) {
  const client = new PGlite();
  const migrationsDir = fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url));
  const migrationFiles = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of migrationFiles) {
    await client.exec(await readFile(join(migrationsDir, file), "utf8"));
  }
  const db = createPgliteDatabase(client);
  const openai = await startOpenAIMock(options.openAIOptions);
  const anthropic = await startAnthropicMock(options.anthropicOptions);
  const env = testEnv(options.envOverrides);
  const config = loadConfig({
    ...env,
    DEFAULT_ORGANIZATION_ID: organizationId,
    OPENAI_BASE_URL: openai.url,
    ANTHROPIC_BASE_URL: anthropic.url,
    LOG_LEVEL: "fatal"
  });
  const metrics = options.metrics ?? new NoopMetricsCollector();
  const classifierTargets = new ProviderConnectionClassifierTargetResolver(db, {
    allowedPrivateUpstreamCidrs: config.allowedPrivateUpstreamCidrs,
    encryptionKey: config.providerSecretEncryptionKey,
    resolveSecretReference: createEnvironmentSecretReferenceResolver(config)
  });
  const persistence = createDatabasePersistence(
    db,
    config,
    false,
    undefined,
    new LlmClassifier(metrics, classifierTargets)
  );
  if (failCapture) {
    persistence.promptArtifacts.capture = async () => {
      throw new Error("capture_failed");
    };
  }

  await db.insert(organizations).values({
    id: organizationId,
    slug: organizationId,
    name: organizationId
  });
  await db.insert(workspaces).values({
    id: defaultWorkspaceId(organizationId),
    organizationId,
    slug: "default",
    name: "Default"
  });
  await db.insert(users).values({
    id: "local-user",
    email: "local@example.com",
    name: "Local User"
  });
  await db.insert(organizationMembers).values({
    organizationId,
    userId: "local-user",
    role: "owner"
  });
  await db.insert(organizationSettings).values({
    organizationId,
    promptCaptureMode
  });
  const seedOptions = seedOptionsFromEnv({
    ...env,
    DEFAULT_ORGANIZATION_ID: organizationId,
    OPENAI_BASE_URL: openai.url,
    ANTHROPIC_BASE_URL: anthropic.url,
    PROXY_TOKEN: env.PROXY_TOKEN,
    SEED_USER_ID: "local-user"
  });
  if (!seedOptions.modelCatalog.entries.some((entry) =>
    entry.provider === "openai" && entry.upstreamModelId === seedOptions.classifierModel
  )) {
    seedOptions.modelCatalog = structuredClone(defaultProviderModelCatalog);
    seedOptions.modelCatalog.sources["test-classifier"] = {
      type: "manual",
      locator: "test:prompt-fixture"
    };
    seedOptions.modelCatalog.entries.push({
      provider: "openai",
      upstreamModelId: seedOptions.classifierModel,
      canonical: {
        key: seedOptions.classifierModel,
        slug: seedOptions.classifierModel.replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/^-|-$/g, ""),
        name: seedOptions.classifierModel,
        vendor: "openai",
        family: seedOptions.classifierModel,
        capabilities: {}
      },
      dialects: ["openai-responses"],
      capabilities: {},
      pricing: { status: "unpriced" },
      metadataSourceId: "test-classifier",
      pricingSourceId: "test-classifier"
    });
  }
  await seedDatabase(db, seedOptions);
  await db
    .update(organizationSettings)
    .set({ promptCaptureMode })
    .where(eq(organizationSettings.organizationId, organizationId));

  const app = buildServer(config, { persistence, metrics });
  const proxyUrl = await listen(app);

  return {
    db,
    persistence,
    // Live server config: tests may mutate flags (e.g. the oauth kill switch).
    // Safe only because fixtures are per-test and closed in afterEach.
    config,
    proxyUrl,
    app,
    openai,
    anthropic,
    client,
    adminHeaders: await loginAdmin(proxyUrl),
    close: () => closeFixture({ app, openai, anthropic, client })
  };
}

export async function adminGql(
  proxyUrl: string,
  headers: Record<string, string>,
  query: string,
  variables?: Record<string, unknown>
) {
  const response = await fetch(`${proxyUrl}/admin/graphql`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(variables ? { query, variables } : { query })
  });
  const body = await response.json().catch(() => null) as {
    data?: Record<string, any> | null;
    errors?: { message: string; extensions?: { code?: string; issues?: unknown[] } }[];
  } | null;
  return {
    status: response.status,
    data: body?.data ?? null,
    errors: body?.errors ?? undefined,
    setCookie: response.headers.get("set-cookie") ?? undefined
  };
}

export async function loginAdmin(proxyUrl: string) {
  const result = await adminGql(
    proxyUrl,
    {},
    `mutation Login($email: String!, $password: String!) {
      login(email: $email, password: $password) {
        organizationId
      }
    }`,
    { email: "local@example.com", password: "dev-password" }
  );
  expect(result.errors).toBeUndefined();
  const cookie = result.setCookie?.split(";")[0];
  expect(cookie).toBeTruthy();
  return { cookie: cookie ?? "" };
}

export function usageRequest(
  id: string,
  organizationId: string,
  userId: string,
  sessionId: string,
  surface: "openai-responses" | "anthropic-messages" | "openai-chat",
  createdAt: Date,
  apiKeyId?: string
) {
  return {
    id,
    organizationId,
    workspaceId: defaultWorkspaceId(organizationId),
    userId,
    sessionId,
    apiKeyId,
    surface,
    idempotencyKey: `idem_${id}`,
    requestedModel: "coding-auto",
    ingressWireId: surface,
    operationId: "text.generate" as const,
    requestedLogicalModel: "coding-auto",
    inputHash: `sha256:${id}`,
    inputChars: 10,
    status: "completed" as const,
    createdAt
  };
}

export function usageDecision(
  id: string,
  requestId: string,
  organizationId: string,
  ingressWireId: "openai-responses" | "anthropic-messages" | "openai-chat",
  selectedProvider: "openai" | "anthropic",
  selectedModel: string
) {
  return {
    id,
    requestId,
    organizationId,
    workspaceId: defaultWorkspaceId(organizationId),
    requestedModel: "coding-auto",
    ingressWireId,
    operationId: "text.generate" as const,
    requestedLogicalModel: "coding-auto",
    selectedProvider,
    selectedModel,
    policyVersion: "test"
  };
}

export function usageAttempt(
  id: string,
  requestId: string,
  organizationId: string,
  surface: "openai-responses" | "anthropic-messages" | "openai-chat",
  provider: "openai" | "anthropic",
  model: string,
  terminalStatus: "completed" | "failed",
  startedAt: Date
) {
  return {
    id,
    requestId,
    organizationId,
    workspaceId: defaultWorkspaceId(organizationId),
    surface,
    provider,
    model,
    terminalStatus,
    startedAt,
    completedAt: startedAt
  };
}

export function usageRow(
  id: string,
  requestId: string,
  providerAttemptId: string,
  organizationId: string,
  provider: "openai" | "anthropic",
  model: string,
  inputTokens: number,
  outputTokens: number,
  totalCostMicros: number
) {
  return {
    id,
    organizationId,
    workspaceId: defaultWorkspaceId(organizationId),
    requestId,
    providerAttemptId,
    provider,
    model,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    totalCostMicros
  };
}

export function sessionPrompt(
  id: string,
  organizationId: string,
  requestId: string,
  rawText: string,
  createdAt: Date
) {
  return {
    id,
    organizationId,
    workspaceId: defaultWorkspaceId(organizationId),
    requestId,
    kind: "latest_user_message",
    storageMode: "raw_text" as const,
    contentHash: `sha256:${id}`,
    rawText,
    sourceRole: "user",
    metadata: { chars: rawText.length },
    createdAt
  };
}

export function sessionEvent(
  id: string,
  organizationId: string,
  requestId: string,
  sessionId: string,
  createdAt: Date
) {
  return {
    id,
    sequence: 1,
    schemaVersion: 1,
    organizationId,
    workspaceId: defaultWorkspaceId(organizationId),
    scopeType: "request",
    scopeId: requestId,
    sessionId,
    correlationId: requestId,
    actorType: "user",
    actorId: "test",
    producer: "test",
    eventType: "proxy.request_received",
    payloadHash: `sha256:${id}`,
    sensitivity: "internal",
    redactionState: "redacted",
    payload: {
      surface: "openai-responses",
      requestedModel: "coding-auto"
    },
    metadata: {},
    createdAt
  };
}

export function eventPayloadText(rows: Array<typeof events.$inferSelect>) {
  return rows.map((row) => JSON.stringify(row.payload)).join("\n");
}

async function closeFixture(input: {
  app: ReturnType<typeof buildServer>;
  openai: MockServer;
  anthropic: MockServer;
  client: PGlite;
}) {
  input.app.server.closeAllConnections();
  await input.app.close();
  await input.openai.close();
  await input.anthropic.close();
  await input.client.close();
}
