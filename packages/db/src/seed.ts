import { readFileSync } from "node:fs";

import { eq } from "drizzle-orm";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import type { BuiltinProvider } from "@proxy/schema";

import { hashApiKey } from "./apiKeyHash.js";
import type { ProxyDbSession } from "./client.js";
import { seedGatewayResources, type GatewaySeedSnapshotEntry } from "./gatewaySeed.js";
import * as schema from "./schema.js";
import {
  apiKeys,
  organizationMembers,
  organizationSettings,
  organizations,
  users,
  userSettings,
  workspaces
} from "./schema.js";
import { DEFAULT_WORKSPACE_NAME, DEFAULT_WORKSPACE_SLUG, defaultWorkspaceId } from "./workspace.js";

export type SeedOptions = {
  organizationId: string;
  userId: string;
  userEmail?: string;
  userName?: string;
  classifierModel: string;
  classifierTimeoutMs: number;
  classifierMaxAttempts: number;
  openaiBaseUrl: string;
  anthropicBaseUrl: string;
  proxyToken: string;
  externalEconomyToken?: string;
  models: SeedModel[];
};

export type SeedModel = {
  provider: BuiltinProvider;
  model: string;
  surface: "openai-responses" | "openai-chat" | "anthropic-messages";
};

const ECONOMY_SEED_MODELS: SeedModel[] = [
  { provider: "openai", model: "gpt-5.4-mini", surface: "openai-responses" },
  { provider: "openai", model: "gpt-5.4-mini", surface: "openai-chat" },
  { provider: "anthropic", model: "claude-haiku-4-5", surface: "anthropic-messages" }
];

const DEFAULT_SEED_MODELS: SeedModel[] = [
  ...ECONOMY_SEED_MODELS,
  { provider: "openai", model: "gpt-5.4", surface: "openai-responses" },
  { provider: "openai", model: "gpt-5.4", surface: "openai-chat" },
  { provider: "openai", model: "gpt-5.5", surface: "openai-responses" },
  { provider: "openai", model: "gpt-5.5", surface: "openai-chat" },
  { provider: "anthropic", model: "claude-sonnet-4-5", surface: "anthropic-messages" },
  { provider: "anthropic", model: "claude-opus-4-5", surface: "anthropic-messages" }
];

const modelsDevSnapshot = JSON.parse(
  readFileSync(new URL("../data/models-dev-snapshot.json", import.meta.url), "utf8")
) as GatewaySeedSnapshotEntry[];

export async function seedDatabase(db: ProxyDbSession, options: SeedOptions) {
  const now = new Date();
  const workspaceId = defaultWorkspaceId(options.organizationId);
  const defaultApiKeyId = `${options.organizationId}:api-key:default`;
  const externalEconomyApiKeyId = `${options.organizationId}:api-key:external-economy`;
  const proxyTokenHash = hashApiKey(options.proxyToken);
  const externalEconomyTokenHash = options.externalEconomyToken
    ? hashApiKey(options.externalEconomyToken)
    : undefined;
  if (externalEconomyTokenHash === proxyTokenHash) {
    throw new Error("SEED_EXTERNAL_ECONOMY_TOKEN must differ from PROXY_TOKEN.");
  }
  for (const token of [
    { envName: "PROXY_TOKEN", hash: proxyTokenHash, apiKeyId: defaultApiKeyId },
    ...(externalEconomyTokenHash
      ? [{ envName: "SEED_EXTERNAL_ECONOMY_TOKEN", hash: externalEconomyTokenHash, apiKeyId: externalEconomyApiKeyId }]
      : [])
  ]) {
    const [owner] = await db
      .select({ id: apiKeys.id, organizationId: apiKeys.organizationId })
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, token.hash))
      .limit(1);
    if (owner && owner.id !== token.apiKeyId) {
      throw new Error(
        `${token.envName} is already assigned to ${owner.id} in organization ${owner.organizationId}; set a unique ${token.envName} for ${options.organizationId}.`
      );
    }
  }

  await upsertOrganization(db, options.organizationId, options.organizationId, now);
  await upsertDefaultWorkspace(db, options.organizationId, now);
  await db.insert(users).values({
    id: options.userId,
    email: options.userEmail,
    name: options.userName,
    externalId: options.userId
  }).onConflictDoUpdate({
    target: users.id,
    set: {
      email: options.userEmail,
      name: options.userName,
      externalId: options.userId,
      updatedAt: now
    }
  });
  await upsertOwner(db, options.organizationId, options.userId, now);
  await db.insert(userSettings).values({
    organizationId: options.organizationId,
    userId: options.userId,
    settings: { seeded: true }
  }).onConflictDoUpdate({
    target: [userSettings.organizationId, userSettings.userId],
    set: { updatedAt: now }
  });

  const sandboxOrganizationId = `${options.organizationId}-sandbox`;
  await upsertOrganization(db, sandboxOrganizationId, `${options.organizationId} Sandbox`, now);
  await upsertDefaultWorkspace(db, sandboxOrganizationId, now);
  await upsertOwner(db, sandboxOrganizationId, options.userId, now);

  const models = uniqueSeedModels([...options.models, ...ECONOMY_SEED_MODELS]);
  const gatewayResources = await seedGatewayResources(db, {
    organizationId: options.organizationId,
    workspaceId,
    classifierModel: options.classifierModel,
    classifierTimeoutMs: options.classifierTimeoutMs,
    classifierMaxAttempts: options.classifierMaxAttempts,
    openaiBaseUrl: options.openaiBaseUrl,
    anthropicBaseUrl: options.anthropicBaseUrl,
    models,
    codingTargets: uniqueGatewayTargets([
      ...models.map(({ provider, model }) => ({ provider, model })),
      { provider: "anthropic", model: "claude-fable-5" }
    ]),
    economyTargets: uniqueGatewayTargets(ECONOMY_SEED_MODELS)
  }, modelsDevSnapshot);

  await db.insert(apiKeys).values({
    id: defaultApiKeyId,
    organizationId: options.organizationId,
    workspaceId,
    userId: options.userId,
    keyHash: proxyTokenHash,
    name: "Default local API key",
    accessProfileId: gatewayResources.engineerAccessProfileId
  }).onConflictDoUpdate({
    target: apiKeys.id,
    set: {
      keyHash: proxyTokenHash,
      revokedAt: null
    }
  });

  if (externalEconomyTokenHash) {
    await db.insert(apiKeys).values({
      id: externalEconomyApiKeyId,
      organizationId: options.organizationId,
      workspaceId,
      keyHash: externalEconomyTokenHash,
      name: "External economy seed key",
      accessProfileId: gatewayResources.externalEconomyAccessProfileId
    }).onConflictDoUpdate({
      target: apiKeys.id,
      set: {
        keyHash: externalEconomyTokenHash,
        revokedAt: null
      }
    });
  }

  return {
    organizationId: options.organizationId,
    userId: options.userId,
    providerConnections: 3,
    models: models.length + 2
  };
}

async function upsertOrganization(
  db: ProxyDbSession,
  organizationId: string,
  name: string,
  now: Date
) {
  await db.insert(organizations).values({
    id: organizationId,
    slug: slug(organizationId),
    name
  }).onConflictDoUpdate({
    target: organizations.id,
    set: { slug: slug(organizationId), name, updatedAt: now }
  });
  await db.insert(organizationSettings).values({
    organizationId,
    promptCaptureMode: "raw_text",
    retentionDays: 30,
    settings: { seeded: true }
  }).onConflictDoUpdate({
    target: organizationSettings.organizationId,
    set: { promptCaptureMode: "raw_text", retentionDays: 30, updatedAt: now }
  });
}

async function upsertOwner(db: ProxyDbSession, organizationId: string, userId: string, now: Date) {
  await db.insert(organizationMembers).values({
    organizationId,
    userId,
    role: "owner",
    status: "active"
  }).onConflictDoUpdate({
    target: [organizationMembers.organizationId, organizationMembers.userId],
    set: { role: "owner", status: "active", updatedAt: now }
  });
}

async function upsertDefaultWorkspace(db: ProxyDbSession, organizationId: string, now: Date) {
  await db.insert(workspaces).values({
    id: defaultWorkspaceId(organizationId),
    organizationId,
    slug: DEFAULT_WORKSPACE_SLUG,
    name: DEFAULT_WORKSPACE_NAME,
    settings: { seeded: true }
  }).onConflictDoUpdate({
    target: workspaces.id,
    set: { slug: DEFAULT_WORKSPACE_SLUG, name: DEFAULT_WORKSPACE_NAME, updatedAt: now }
  });
}

export function seedOptionsFromEnv(env: NodeJS.ProcessEnv): SeedOptions {
  return {
    organizationId: env.DEFAULT_ORGANIZATION_ID ?? "local",
    userId: env.SEED_USER_ID ?? "local-user",
    userEmail: env.SEED_USER_EMAIL ?? "local@example.com",
    userName: env.SEED_USER_NAME ?? "Local User",
    classifierModel: env.GATEWAY_SEED_CLASSIFIER_MODEL ?? "gpt-5-nano-2025-08-07",
    classifierTimeoutMs: positiveIntegerEnv(env.GATEWAY_SEED_CLASSIFIER_TIMEOUT_MS, 30_000),
    classifierMaxAttempts: positiveIntegerEnv(env.GATEWAY_SEED_CLASSIFIER_MAX_ATTEMPTS, 2),
    openaiBaseUrl: env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    anthropicBaseUrl: env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com/v1",
    proxyToken: env.PROXY_TOKEN ?? "dev-token",
    externalEconomyToken: env.SEED_EXTERNAL_ECONOMY_TOKEN,
    models: DEFAULT_SEED_MODELS
  };
}

function uniqueSeedModels(models: SeedModel[]) {
  return [...new Map(models.map((model) => [
    `${model.provider}:${model.model}:${model.surface}`,
    model
  ])).values()];
}

function uniqueGatewayTargets(models: { provider: BuiltinProvider; model: string }[]) {
  return [...new Map(models.map((model) => [`${model.provider}:${model.model}`, model])).values()];
}

function positiveIntegerEnv(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "local";
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  const client = postgres(databaseUrl, { max: 1 });
  try {
    const db = drizzlePostgres(client, { schema });
    const result = await seedDatabase(db, seedOptionsFromEnv(process.env));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
