import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import type { Provider, RouteName } from "@prompt-proxy/schema";

import type { PromptProxyDbSession } from "./client.js";
import * as schema from "./schema.js";
import {
  modelCatalog,
  organizationMembers,
  organizationSettings,
  organizations,
  providerAccounts,
  routePolicies,
  users,
  userSettings
} from "./schema.js";

export type SeedOptions = {
  organizationId: string;
  userId: string;
  userEmail?: string;
  userName?: string;
  classifierModel: string;
  classifierPromptVersion: string;
  openaiBaseUrl: string;
  anthropicBaseUrl: string;
  models: SeedModel[];
};

export type SeedModel = {
  provider: Provider;
  model: string;
  route: RouteName;
  surface: "openai-responses" | "anthropic-messages";
};

export async function seedDatabase(db: PromptProxyDbSession, options: SeedOptions) {
  const now = new Date();
  const organizationSlug = slug(options.organizationId);

  await db
    .insert(organizations)
    .values({
      id: options.organizationId,
      slug: organizationSlug,
      name: options.organizationId
    })
    .onConflictDoUpdate({
      target: organizations.id,
      set: {
        slug: organizationSlug,
        name: options.organizationId,
        updatedAt: now
      }
    });

  await db
    .insert(organizationSettings)
    .values({
      organizationId: options.organizationId,
      promptCaptureMode: "hash_only",
      retentionDays: 30,
      settings: {
        seeded: true
      }
    })
    .onConflictDoUpdate({
      target: organizationSettings.organizationId,
      set: {
        updatedAt: now
      }
    });

  await db
    .insert(users)
    .values({
      id: options.userId,
      email: options.userEmail,
      name: options.userName,
      externalId: options.userId
    })
    .onConflictDoUpdate({
      target: users.id,
      set: {
        email: options.userEmail,
        name: options.userName,
        externalId: options.userId,
        updatedAt: now
      }
    });

  await db
    .insert(organizationMembers)
    .values({
      organizationId: options.organizationId,
      userId: options.userId,
      role: "owner",
      status: "active"
    })
    .onConflictDoUpdate({
      target: [organizationMembers.organizationId, organizationMembers.userId],
      set: {
        role: "owner",
        status: "active",
        updatedAt: now
      }
    });

  await db
    .insert(userSettings)
    .values({
      organizationId: options.organizationId,
      userId: options.userId,
      settings: {
        seeded: true
      }
    })
    .onConflictDoUpdate({
      target: [userSettings.organizationId, userSettings.userId],
      set: {
        updatedAt: now
      }
    });

  const providerRows = [
    {
      id: `${options.organizationId}:provider:openai`,
      organizationId: options.organizationId,
      provider: "openai" as const,
      name: "OpenAI",
      secretRef: "env:OPENAI_API_KEY",
      settings: {
        baseUrl: options.openaiBaseUrl
      }
    },
    {
      id: `${options.organizationId}:provider:anthropic`,
      organizationId: options.organizationId,
      provider: "anthropic" as const,
      name: "Anthropic",
      secretRef: "env:ANTHROPIC_API_KEY",
      settings: {
        baseUrl: options.anthropicBaseUrl
      }
    }
  ];

  for (const row of providerRows) {
    await db
      .insert(providerAccounts)
      .values(row)
      .onConflictDoUpdate({
        target: providerAccounts.id,
        set: {
          secretRef: row.secretRef,
          settings: row.settings,
          status: "active",
          updatedAt: now
        }
      });
  }

  const modelRows = modelCatalogRows(options);
  for (const row of modelRows) {
    await db
      .insert(modelCatalog)
      .values(row)
      .onConflictDoUpdate({
        target: modelCatalog.id,
        set: {
          route: row.route,
          capabilities: row.capabilities,
          pricing: row.pricing,
          updatedAt: now
        }
      });
  }

  await db
    .insert(routePolicies)
    .values({
      id: `${options.organizationId}:route-policy:default`,
      organizationId: options.organizationId,
      name: "default",
      classifierModel: options.classifierModel,
      classifierPromptVersion: options.classifierPromptVersion,
      policy: {
        routeAliases: ["router-auto", "router-fast", "router-balanced", "router-hard", "router-deep"],
        seeded: true
      }
    })
    .onConflictDoUpdate({
      target: routePolicies.id,
      set: {
        classifierModel: options.classifierModel,
        classifierPromptVersion: options.classifierPromptVersion,
        updatedAt: now
      }
    });

  return {
    organizationId: options.organizationId,
    userId: options.userId,
    providerAccounts: providerRows.length,
    models: modelRows.length
  };
}

export function seedOptionsFromEnv(env: NodeJS.ProcessEnv): SeedOptions {
  return {
    organizationId: env.DEFAULT_ORGANIZATION_ID ?? "local",
    userId: env.SEED_USER_ID ?? "local-user",
    userEmail: env.SEED_USER_EMAIL ?? "local@example.com",
    userName: env.SEED_USER_NAME ?? "Local User",
    classifierModel: env.CLASSIFIER_MODEL ?? "gpt-5-nano-2025-08-07",
    classifierPromptVersion: env.CLASSIFIER_PROMPT_VERSION ?? "2026-06-08",
    openaiBaseUrl: env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    anthropicBaseUrl: env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com/v1",
    models: [
      model("openai", env.OPENAI_FAST_MODEL ?? "gpt-5.4-mini", "fast", "openai-responses"),
      model("openai", env.OPENAI_BALANCED_MODEL ?? "gpt-5.4", "balanced", "openai-responses"),
      model("openai", env.OPENAI_HARD_MODEL ?? "gpt-5.5", "hard", "openai-responses"),
      model("openai", env.OPENAI_DEEP_MODEL ?? "gpt-5.5-pro", "deep", "openai-responses"),
      model("anthropic", env.ANTHROPIC_FAST_MODEL ?? "claude-haiku-4-5", "fast", "anthropic-messages"),
      model("anthropic", env.ANTHROPIC_BALANCED_MODEL ?? "claude-sonnet-4-5", "balanced", "anthropic-messages"),
      model("anthropic", env.ANTHROPIC_HARD_MODEL ?? "claude-sonnet-4-5", "hard", "anthropic-messages"),
      model("anthropic", env.ANTHROPIC_DEEP_MODEL ?? "claude-opus-4-5", "deep", "anthropic-messages")
    ]
  };
}

function model(provider: Provider, modelName: string, route: RouteName, surface: SeedModel["surface"]) {
  return {
    provider,
    model: modelName,
    route,
    surface
  };
}

function modelCatalogRows(options: SeedOptions) {
  const rows = new Map<string, {
    id: string;
    organizationId: string;
    provider: Provider;
    model: string;
    route: RouteName;
    capabilities: Record<string, unknown>;
    pricing: Record<string, unknown>;
  }>();

  for (const entry of options.models) {
    const key = `${entry.provider}:${entry.model}`;
    const existing = rows.get(key);
    if (existing) {
      const routes = Array.isArray(existing.capabilities.routes) ? existing.capabilities.routes : [];
      existing.capabilities = {
        ...existing.capabilities,
        routes: [...new Set([...routes, entry.route])]
      };
      continue;
    }

    rows.set(key, {
      id: `${options.organizationId}:model:${entry.provider}:${slug(entry.model)}`,
      organizationId: options.organizationId,
      provider: entry.provider,
      model: entry.model,
      route: entry.route,
      capabilities: {
        surfaces: [entry.surface],
        routes: [entry.route],
        seeded: true
      },
      pricing: {
        source: "env"
      }
    });
  }

  return [...rows.values()];
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "local";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to seed the database.");
  }

  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  const db = drizzlePostgres(sql, { schema });
  try {
    const result = await seedDatabase(db, seedOptionsFromEnv(process.env));
    console.log(`seeded organization=${result.organizationId} user=${result.userId} providers=${result.providerAccounts} models=${result.models}`);
  } finally {
    await sql.end();
  }
}
