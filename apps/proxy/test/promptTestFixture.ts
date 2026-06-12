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
} from "@prompt-proxy/db";
import { seedDatabase, seedOptionsFromEnv } from "@prompt-proxy/db/seed";

import { buildModelCatalog } from "../src/catalog.js";
import { loadConfig } from "../src/config.js";
import { createDatabasePersistence } from "../src/persistence/index.js";
import { buildServer } from "../src/server.js";
import { listen, startAnthropicMock, startOpenAIMock, type MockServer } from "./helpers.js";

type PromptCaptureMode = "hash_only" | "raw_text";
type OpenAIOptions = Parameters<typeof startOpenAIMock>[0];

export type PromptTestFixture = Awaited<ReturnType<typeof captureFixture>>;

export function testEnv(overrides: NodeJS.ProcessEnv = {}) {
  return {
    ...process.env,
    DATABASE_URL: "",
    EVENT_STORE_PATH: "",
    PROMPT_PROXY_TOKEN: "proxy-token",
    OPENAI_API_KEY: "openai-upstream-key",
    OPENAI_BASE_URL: "http://127.0.0.1",
    OPENAI_CHATGPT_BASE_URL: "http://127.0.0.1",
    OPENAI_FAST_MODEL: "gpt-5.4-mini",
    OPENAI_BALANCED_MODEL: "gpt-5.4",
    OPENAI_HARD_MODEL: "gpt-5.5",
    OPENAI_DEEP_MODEL: "gpt-5.5-pro",
    ANTHROPIC_API_KEY: "anthropic-upstream-key",
    ANTHROPIC_BASE_URL: "http://127.0.0.1",
    ANTHROPIC_FAST_MODEL: "claude-haiku-4-5",
    ANTHROPIC_BALANCED_MODEL: "claude-sonnet-4-5",
    ANTHROPIC_HARD_MODEL: "claude-sonnet-4-5",
    ANTHROPIC_DEEP_MODEL: "claude-opus-4-5",
    CLASSIFIER_PROVIDER: "openai",
    CLASSIFIER_MODEL: "route-classifier-cheap",
    MODEL_COSTS_JSON: "",
    ADMIN_DEV_LOGIN_ENABLED: "true",
    ADMIN_DEV_LOGIN_EMAIL: "local@example.com",
    ADMIN_DEV_LOGIN_PASSWORD: "dev-password",
    SEED_USER_ID: "local-user",
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
    openAIChatGPTOptions?: OpenAIOptions;
    anthropicOptions?: Parameters<typeof startAnthropicMock>[0];
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
  const openaiChatgpt = options.openAIChatGPTOptions
    ? await startOpenAIMock(options.openAIChatGPTOptions)
    : openai;
  const anthropic = await startAnthropicMock(options.anthropicOptions);
  const env = testEnv(options.envOverrides);
  const config = loadConfig({
    ...env,
    DEFAULT_ORGANIZATION_ID: organizationId,
    OPENAI_BASE_URL: openai.url,
    OPENAI_CHATGPT_BASE_URL: openaiChatgpt.url,
    ANTHROPIC_BASE_URL: anthropic.url,
    LOG_LEVEL: "fatal"
  });
  const catalog = buildModelCatalog(config);
  const persistence = createDatabasePersistence(db, catalog, config, false);
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
  await seedDatabase(db, seedOptionsFromEnv({
    ...env,
    DEFAULT_ORGANIZATION_ID: organizationId,
    OPENAI_BASE_URL: openai.url,
    OPENAI_CHATGPT_BASE_URL: openaiChatgpt.url,
    ANTHROPIC_BASE_URL: anthropic.url,
    PROMPT_PROXY_TOKEN: env.PROMPT_PROXY_TOKEN,
    SEED_USER_ID: "local-user"
  }));
  await db
    .update(organizationSettings)
    .set({ promptCaptureMode })
    .where(eq(organizationSettings.organizationId, organizationId));

  const app = buildServer(config, { persistence });
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
    openaiChatgpt,
    anthropic,
    client,
    adminHeaders: await loginAdmin(proxyUrl),
    close: () => closeFixture({ app, openai, openaiChatgpt, anthropic, client })
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
  surface: "openai-responses" | "anthropic-messages",
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
    requestedModel: "router-auto",
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
  finalRoute: "fast" | "hard",
  selectedProvider: "openai" | "anthropic",
  selectedModel: string
) {
  return {
    id,
    requestId,
    organizationId,
    workspaceId: defaultWorkspaceId(organizationId),
    requestedModel: "router-auto",
    finalRoute,
    selectedProvider,
    selectedModel,
    policyVersion: "test"
  };
}

export function usageAttempt(
  id: string,
  requestId: string,
  organizationId: string,
  surface: "openai-responses" | "anthropic-messages",
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
  route: "fast" | "hard",
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
    route,
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
      requestedModel: "router-auto"
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
  openaiChatgpt: MockServer;
  anthropic: MockServer;
  client: PGlite;
}) {
  await input.app.close();
  await input.openai.close();
  if (input.openaiChatgpt !== input.openai) {
    await input.openaiChatgpt.close();
  }
  await input.anthropic.close();
  await input.client.close();
}
