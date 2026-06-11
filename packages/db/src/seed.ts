import { createHash } from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import {
  routingConfigSchema,
  type Provider,
  type RouteName,
  type RoutingConfig
} from "@prompt-proxy/schema";

import { hashApiKey } from "./apiKeyHash.js";
import type { PromptProxyDbSession } from "./client.js";
import * as schema from "./schema.js";
import {
  apiKeys,
  modelCatalog,
  organizationMembers,
  organizationSettings,
  organizations,
  providerAccounts,
  routePolicies,
  routingConfigs,
  routingConfigVersions,
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
  classifierPromptVersion: string;
  classifierTimeoutMs: number;
  classifierAllowRedactedExcerpt: boolean;
  replaceRoutingConfigVersion: boolean;
  openaiBaseUrl: string;
  anthropicBaseUrl: string;
  proxyToken: string;
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
  const workspaceId = defaultWorkspaceId(options.organizationId);
  const routingConfigId = `${options.organizationId}:routing-config:default`;
  const defaultApiKeyId = `${options.organizationId}:api-key:default`;
  const proxyTokenHash = hashApiKey(options.proxyToken);
  const [tokenOwner] = await db
    .select({
      id: apiKeys.id,
      organizationId: apiKeys.organizationId
    })
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, proxyTokenHash))
    .limit(1);

  if (tokenOwner && tokenOwner.id !== defaultApiKeyId) {
    throw new Error(
      `PROMPT_PROXY_TOKEN is already assigned to ${tokenOwner.id} in organization ${tokenOwner.organizationId}; set a unique PROMPT_PROXY_TOKEN for ${options.organizationId}.`
    );
  }

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
      promptCaptureMode: "raw_text",
      retentionDays: 30,
      settings: {
        seeded: true
      }
    })
    .onConflictDoUpdate({
      target: organizationSettings.organizationId,
      set: {
        promptCaptureMode: "raw_text",
        retentionDays: 30,
        updatedAt: now
      }
    });

  await upsertDefaultWorkspace(db, options.organizationId, now);

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

  const sandboxOrganizationId = `${options.organizationId}-sandbox`;
  await db
    .insert(organizations)
    .values({
      id: sandboxOrganizationId,
      slug: slug(sandboxOrganizationId),
      name: `${options.organizationId} Sandbox`
    })
    .onConflictDoUpdate({
      target: organizations.id,
      set: {
        slug: slug(sandboxOrganizationId),
        name: `${options.organizationId} Sandbox`,
        updatedAt: now
      }
    });

  await db
    .insert(organizationSettings)
    .values({
      organizationId: sandboxOrganizationId,
      promptCaptureMode: "raw_text",
      retentionDays: 30,
      settings: {
        seeded: true
      }
    })
    .onConflictDoUpdate({
      target: organizationSettings.organizationId,
      set: {
        promptCaptureMode: "raw_text",
        retentionDays: 30,
        updatedAt: now
      }
    });

  await db
    .insert(organizationMembers)
    .values({
      organizationId: sandboxOrganizationId,
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

  await upsertDefaultWorkspace(db, sandboxOrganizationId, now);

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

  const routingConfig = defaultRoutingConfig(options);
  const routingConfigVersionId = `${routingConfigId}:v1`;
  const routingConfigHash = sha256Hex(JSON.stringify(routingConfig));

  await db
    .insert(routingConfigs)
    .values({
      id: routingConfigId,
      organizationId: options.organizationId,
      workspaceId,
      name: "Default routing config",
      slug: "default",
      description: "Seeded default routing config for coding-agent traffic.",
      status: "active"
    })
    .onConflictDoUpdate({
      target: routingConfigs.id,
      set: {
        name: "Default routing config",
        description: "Seeded default routing config for coding-agent traffic.",
        status: "active",
        updatedAt: now
      }
    });

  const versionValues = {
    id: routingConfigVersionId,
    organizationId: options.organizationId,
    workspaceId,
    routingConfigId,
    version: 1,
    configHash: routingConfigHash,
    config: routingConfig,
    status: "active",
    createdByUserId: options.userId,
    activatedAt: now
  };

  if (options.replaceRoutingConfigVersion) {
    await db
      .insert(routingConfigVersions)
      .values(versionValues)
      .onConflictDoUpdate({
        target: routingConfigVersions.id,
        set: {
          configHash: routingConfigHash,
          config: routingConfig,
          status: "active",
          createdByUserId: options.userId,
          activatedAt: now,
          archivedAt: null
        }
      });
  } else {
    await db
      .insert(routingConfigVersions)
      .values(versionValues)
      .onConflictDoNothing({
        target: routingConfigVersions.id
      });
  }

  await db
    .update(routingConfigs)
    .set({
      activeVersionId: routingConfigVersionId,
      updatedAt: now
    })
    .where(options.replaceRoutingConfigVersion
      ? eq(routingConfigs.id, routingConfigId)
      : and(
        eq(routingConfigs.id, routingConfigId),
        isNull(routingConfigs.activeVersionId)
      ));

  await db
    .insert(apiKeys)
    .values({
      id: defaultApiKeyId,
      organizationId: options.organizationId,
      workspaceId,
      userId: null,
      keyHash: proxyTokenHash,
      name: "Default local API key",
      routingConfigId,
      scopes: ["proxy", "admin", "harness_identity"]
    })
    .onConflictDoUpdate({
      target: apiKeys.id,
      set: {
        userId: null,
        keyHash: proxyTokenHash,
        name: "Default local API key",
        routingConfigId,
        scopes: ["proxy", "admin", "harness_identity"]
      }
    });

  await db
    .update(workspaces)
    .set({
      defaultRoutingConfigId: routingConfigId,
      updatedAt: now
    })
    .where(eq(workspaces.id, workspaceId));

  return {
    organizationId: options.organizationId,
    userId: options.userId,
    providerAccounts: providerRows.length,
    models: modelRows.length
  };
}

async function upsertDefaultWorkspace(db: PromptProxyDbSession, organizationId: string, now: Date) {
  await db
    .insert(workspaces)
    .values({
      id: defaultWorkspaceId(organizationId),
      organizationId,
      slug: DEFAULT_WORKSPACE_SLUG,
      name: DEFAULT_WORKSPACE_NAME,
      settings: {
        seeded: true
      }
    })
    .onConflictDoUpdate({
      target: workspaces.id,
      set: {
        slug: DEFAULT_WORKSPACE_SLUG,
        name: DEFAULT_WORKSPACE_NAME,
        updatedAt: now
      }
    });
}

export function seedOptionsFromEnv(env: NodeJS.ProcessEnv): SeedOptions {
  return {
    organizationId: env.DEFAULT_ORGANIZATION_ID ?? "local",
    userId: env.SEED_USER_ID ?? "local-user",
    userEmail: env.SEED_USER_EMAIL ?? "local@example.com",
    userName: env.SEED_USER_NAME ?? "Local User",
    classifierModel: env.CLASSIFIER_MODEL ?? "gpt-5-nano-2025-08-07",
    classifierPromptVersion: env.CLASSIFIER_PROMPT_VERSION ?? "2026-06-08",
    classifierTimeoutMs: positiveIntegerEnv(env.CLASSIFIER_TIMEOUT_MS, 30000),
    classifierAllowRedactedExcerpt: booleanEnv(env.CLASSIFIER_ALLOW_REDACTED_EXCERPT),
    replaceRoutingConfigVersion: booleanEnv(env.SEED_REPLACE_ROUTING_CONFIG),
    openaiBaseUrl: env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    anthropicBaseUrl: env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com/v1",
    proxyToken: env.PROMPT_PROXY_TOKEN ?? "dev-proxy-token",
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

function defaultRoutingConfig(options: SeedOptions): RoutingConfig {
  return routingConfigSchema.parse({
    schemaVersion: 1,
    displayName: "Default coding router",
    description: "Seeded default routing config for coding-agent traffic.",
    classifier: {
      provider: "openai",
      model: options.classifierModel,
      reasoningEffort: "minimal",
      timeoutMs: options.classifierTimeoutMs,
      maxAttempts: 2,
      allowRedactedExcerpt: options.classifierAllowRedactedExcerpt,
      structuredOutput: {
        mode: "json_schema",
        schemaName: "routing_classifier"
      }
    },
    routes: {
      fast: routeConfig(options, "fast", "Simple shell/status/read-only tasks", "low"),
      balanced: routeConfig(options, "balanced", "Default coding tasks", "medium"),
      hard: routeConfig(options, "hard", "Debugging, multi-file edits, and migrations", "high"),
      deep: routeConfig(options, "deep", "Architecture, system design, security, and storage design", "xhigh")
    },
    limits: {
      maxRoute: "deep",
      fallbackRoute: "hard",
      maxEstimatedInputTokens: 200000
    },
    session: {
      pinInitialRoute: true,
      allowUpgrade: true,
      allowDowngrade: false
    }
  });
}

function routeConfig(
  options: SeedOptions,
  route: RouteName,
  description: string,
  openaiEffort: "low" | "medium" | "high" | "xhigh"
): RoutingConfig["routes"][RouteName] {
  return {
    description,
    openai: {
      model: modelFor(options, "openai", route),
      reasoning: {
        effort: openaiEffort
      },
      text: {
        verbosity: route === "fast" || route === "balanced" ? "low" : "medium"
      }
    },
    anthropic: {
      model: modelFor(options, "anthropic", route),
      // Fast omits thinking: "disabled" is rejected by adaptive-only models,
      // while omitting the field lets the provider apply its default.
      ...(route === "fast" ? {} : { thinking: { type: "adaptive" as const, display: "omitted" as const } })
    }
  };
}

function modelFor(options: SeedOptions, provider: Provider, route: RouteName) {
  const match = options.models.find((entry) => entry.provider === provider && entry.route === route);
  if (!match) throw new Error(`Missing seeded model for provider=${provider} route=${route}`);
  return match.model;
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

function booleanEnv(value: string | undefined) {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0" || normalized === "") return false;
  throw new Error(`Invalid boolean env value: ${value}`);
}

function positiveIntegerEnv(value: string | undefined, fallback: number) {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive integer env value: ${value}`);
  }
  return parsed;
}

function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
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
