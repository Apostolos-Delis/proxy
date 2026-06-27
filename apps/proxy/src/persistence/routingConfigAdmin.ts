import { createHash } from "node:crypto";

import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";

import {
  apiKeys,
  modelCatalog,
  providerAccounts,
  providers,
  routingConfigs,
  routingConfigVersions,
  workspaces,
  type ProxyTransaction,
  type ProxyTransactionalDatabase
} from "@proxy/db";
import { routingConfigSchema, type RoutingConfig } from "@proxy/schema";

import { createId } from "../util.js";
import { AdminMutationError } from "./adminErrors.js";
import { appendAdminAuditEvent } from "./adminAudit.js";
import { ensureWorkspaceDefaultRoutingConfig } from "./routingConfigProvisioning.js";

const createConfigBodySchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().min(1).nullable().optional(),
  config: z.unknown()
}).strict();

const createVersionBodySchema = z.object({
  config: z.unknown()
}).strict();

const assignApiKeyRoutingConfigBodySchema = z.object({
  routingConfigId: z.string().trim().min(1).nullable()
}).strict();

export class RoutingConfigAdminError extends AdminMutationError {}

export class RoutingConfigAdminService {
  constructor(
    private readonly db: ProxyTransactionalDatabase,
    private readonly onApiKeysChanged: () => void = () => {},
    private readonly onRoutingConfigsChanged: () => void = () => {}
  ) {}

  async createConfig(input: {
    organizationId: string;
    workspaceId: string;
    actorUserId: string;
    body: unknown;
  }) {
    const body = createConfigBodySchema.safeParse(input.body);
    if (!body.success) throw validationError("invalid_routing_config_request", body.error);
    const config = parseRoutingConfig(body.data.config);
    const now = new Date();
    const configId = createId("routing_config");
    const versionId = createId("routing_config_version");
    const slug = slugValue(body.data.name);
    const hash = configHash(config);

    const result = await this.db.transaction(async (tx) => {
      await rejectDuplicateSlug(tx, input.organizationId, input.workspaceId, slug);
      await validateRoutingConfigPublishability(tx, input.organizationId, config);
      await tx.insert(routingConfigs).values({
        id: configId,
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        name: body.data.name,
        slug,
        description: body.data.description ?? null,
        status: "active",
        createdAt: now,
        updatedAt: now
      });
      await tx.insert(routingConfigVersions).values({
        id: versionId,
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        routingConfigId: configId,
        version: 1,
        configHash: hash,
        config,
        status: "active",
        createdByUserId: input.actorUserId,
        createdAt: now,
        activatedAt: now
      });
      await tx
        .update(routingConfigs)
        .set({
          activeVersionId: versionId,
          updatedAt: now
        })
        .where(and(
          eq(routingConfigs.organizationId, input.organizationId),
          eq(routingConfigs.workspaceId, input.workspaceId),
          eq(routingConfigs.id, configId)
        ));
      await appendAdminAuditEvent(tx, {
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        scopeType: "routing_config",
        scopeId: configId,
        correlationId: versionId,
        actorUserId: input.actorUserId,
        producer: "proxy.admin.routing-configs",
        eventType: "routing_config.created",
        payload: {
          configId,
          versionId,
          version: 1,
          configHash: hash,
          slug,
          status: "active"
        },
        createdAt: now
      });
      await appendAdminAuditEvent(tx, {
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        scopeType: "routing_config",
        scopeId: configId,
        correlationId: versionId,
        actorUserId: input.actorUserId,
        producer: "proxy.admin.routing-configs",
        eventType: "routing_config.version_created",
        payload: {
          configId,
          versionId,
          version: 1,
          configHash: hash,
          status: "active"
        },
        createdAt: now
      });
      return { configId, versionId, version: 1, configHash: hash };
    });
    return result;
  }

  // Backfills the seeded default config for workspaces that predate
  // provisioning-on-creation. Called best-effort from the routing-config read
  // path so a stuck workspace heals the first time its Routing page loads.
  async ensureWorkspaceDefaultConfig(input: {
    organizationId: string;
    workspaceId: string;
    actorUserId: string;
  }) {
    const result = await this.db.transaction((tx) => ensureWorkspaceDefaultRoutingConfig(tx, input));
    if (result) this.onRoutingConfigsChanged();
    return result;
  }

  async createVersion(input: {
    organizationId: string;
    workspaceId: string;
    actorUserId: string;
    configId: string;
    body: unknown;
  }) {
    const body = createVersionBodySchema.safeParse(input.body);
    if (!body.success) throw validationError("invalid_routing_config_request", body.error);
    const config = parseRoutingConfig(body.data.config);
    const now = new Date();
    const versionId = createId("routing_config_version");
    const hash = configHash(config);

    const result = await this.db.transaction(async (tx) => {
      const configRow = await lockedConfig(tx, input.organizationId, input.workspaceId, input.configId);
      if (!configRow) throw new RoutingConfigAdminError("routing_config_not_found", 404);
      if (configRow.status === "archived") throw new RoutingConfigAdminError("routing_config_archived", 409);
      await validateRoutingConfigPublishability(tx, input.organizationId, config);

      const version = await nextVersion(tx, input.organizationId, input.configId);
      await tx.insert(routingConfigVersions).values({
        id: versionId,
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        routingConfigId: input.configId,
        version,
        configHash: hash,
        config,
        status: "draft",
        createdByUserId: input.actorUserId,
        createdAt: now
      });
      await tx
        .update(routingConfigs)
        .set({ updatedAt: now })
        .where(and(
          eq(routingConfigs.organizationId, input.organizationId),
          eq(routingConfigs.workspaceId, input.workspaceId),
          eq(routingConfigs.id, input.configId)
        ));
      await appendAdminAuditEvent(tx, {
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        scopeType: "routing_config",
        scopeId: input.configId,
        correlationId: versionId,
        actorUserId: input.actorUserId,
        producer: "proxy.admin.routing-configs",
        eventType: "routing_config.version_created",
        payload: {
          configId: input.configId,
          versionId,
          version,
          configHash: hash,
          status: "draft"
        },
        createdAt: now
      });
      return { configId: input.configId, versionId, version, configHash: hash };
    });
    return result;
  }

  async activateVersion(input: {
    organizationId: string;
    workspaceId: string;
    actorUserId: string;
    configId: string;
    versionId: string;
  }) {
    const now = new Date();
    const result = await this.db.transaction(async (tx) => {
      const configRow = await lockedConfig(tx, input.organizationId, input.workspaceId, input.configId);
      if (!configRow) throw new RoutingConfigAdminError("routing_config_not_found", 404);
      if (configRow.status === "archived") throw new RoutingConfigAdminError("routing_config_archived", 409);

      const [version] = await tx
        .select()
        .from(routingConfigVersions)
        .where(and(
          eq(routingConfigVersions.organizationId, input.organizationId),
          eq(routingConfigVersions.routingConfigId, input.configId),
          eq(routingConfigVersions.id, input.versionId)
        ))
        .limit(1);
      if (!version) throw new RoutingConfigAdminError("routing_config_version_not_found", 404);
      if (version.archivedAt || version.status === "archived") {
        throw new RoutingConfigAdminError("routing_config_version_archived", 409);
      }
      await validateRoutingConfigPublishability(tx, input.organizationId, parseRoutingConfig(version.config));

      await tx
        .update(routingConfigVersions)
        .set({
          status: "active",
          activatedAt: version.activatedAt ?? now
        })
        .where(and(
          eq(routingConfigVersions.organizationId, input.organizationId),
          eq(routingConfigVersions.workspaceId, input.workspaceId),
          eq(routingConfigVersions.routingConfigId, input.configId),
          eq(routingConfigVersions.id, input.versionId)
        ));
      await tx
        .update(routingConfigs)
        .set({
          activeVersionId: input.versionId,
          updatedAt: now
        })
        .where(and(
          eq(routingConfigs.organizationId, input.organizationId),
          eq(routingConfigs.workspaceId, input.workspaceId),
          eq(routingConfigs.id, input.configId)
        ));
      await appendAdminAuditEvent(tx, {
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        scopeType: "routing_config",
        scopeId: input.configId,
        correlationId: input.versionId,
        actorUserId: input.actorUserId,
        producer: "proxy.admin.routing-configs",
        eventType: "routing_config.version_activated",
        payload: {
          configId: input.configId,
          versionId: input.versionId,
          version: version.version,
          configHash: version.configHash
        },
        createdAt: now
      });
      return {
        configId: input.configId,
        versionId: input.versionId,
        version: version.version,
        configHash: version.configHash
      };
    });
    this.onRoutingConfigsChanged();
    return result;
  }

  async assignApiKeyRoutingConfig(input: {
    organizationId: string;
    workspaceId: string;
    actorUserId: string;
    apiKeyId: string;
    body: unknown;
  }) {
    const body = assignApiKeyRoutingConfigBodySchema.safeParse(input.body);
    if (!body.success) throw validationError("invalid_api_key_routing_config_request", body.error);
    const routingConfigId = body.data.routingConfigId;

    const result = await this.db.transaction(async (tx) => {
      const [apiKey] = await tx
        .select({
          id: apiKeys.id,
          routingConfigId: apiKeys.routingConfigId
        })
        .from(apiKeys)
        .where(and(
          eq(apiKeys.organizationId, input.organizationId),
          eq(apiKeys.workspaceId, input.workspaceId),
          eq(apiKeys.id, input.apiKeyId)
        ))
        .limit(1);
      if (!apiKey) throw new RoutingConfigAdminError("api_key_not_found", 404);

      let targetConfig: RoutingConfigAssignmentTarget | null = null;
      if (routingConfigId) {
        targetConfig = await routingConfigForAssignment(tx, input.organizationId, input.workspaceId, routingConfigId);
        if (!targetConfig) throw new RoutingConfigAdminError("routing_config_not_found", 404);
        if (targetConfig.status === "archived") throw new RoutingConfigAdminError("routing_config_archived", 409);
        if (targetConfig.status !== "active") throw new RoutingConfigAdminError("routing_config_inactive", 409);
        if (!targetConfig.activeVersionId) {
          throw new RoutingConfigAdminError("routing_config_active_version_missing", 409);
        }
        if (!targetConfig.activeVersionHash) {
          throw new RoutingConfigAdminError("routing_config_active_version_not_found", 409);
        }
      }

      await tx
        .update(apiKeys)
        .set({ routingConfigId })
        .where(and(
          eq(apiKeys.organizationId, input.organizationId),
          eq(apiKeys.workspaceId, input.workspaceId),
          eq(apiKeys.id, input.apiKeyId)
        ));
      await appendAdminAuditEvent(tx, {
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        scopeType: "api_key",
        scopeId: input.apiKeyId,
        correlationId: routingConfigId ?? input.apiKeyId,
        actorUserId: input.actorUserId,
        producer: "proxy.admin.api-keys",
        eventType: "routing_config.api_key_assignment_changed",
        payload: {
          apiKeyId: input.apiKeyId,
          previousRoutingConfigId: apiKey.routingConfigId ?? null,
          routingConfigId,
          routingConfigVersionId: targetConfig?.activeVersionId ?? null,
          routingConfigHash: targetConfig?.activeVersionHash ?? null
        }
      });

      return {
        apiKeyId: input.apiKeyId,
        previousRoutingConfigId: apiKey.routingConfigId ?? null,
        routingConfigId
      };
    });
    this.onApiKeysChanged();
    return result;
  }

  async archiveConfig(input: {
    organizationId: string;
    workspaceId: string;
    actorUserId: string;
    configId: string;
  }) {
    const now = new Date();
    const result = await this.db.transaction(async (tx) => {
      const configRow = await lockedConfig(tx, input.organizationId, input.workspaceId, input.configId);
      if (!configRow) throw new RoutingConfigAdminError("routing_config_not_found", 404);
      if (configRow.status === "archived") throw new RoutingConfigAdminError("routing_config_archived", 409);
      if (await routingConfigInUse(tx, input.organizationId, input.workspaceId, input.configId)) {
        throw new RoutingConfigAdminError("routing_config_in_use", 409);
      }
      const activeVersion = configRow.activeVersionId
        ? await routingConfigVersion(tx, input.organizationId, input.configId, configRow.activeVersionId)
        : null;

      await tx
        .update(routingConfigs)
        .set({
          status: "archived",
          updatedAt: now
        })
        .where(and(
          eq(routingConfigs.organizationId, input.organizationId),
          eq(routingConfigs.workspaceId, input.workspaceId),
          eq(routingConfigs.id, input.configId)
        ));
      await appendAdminAuditEvent(tx, {
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        scopeType: "routing_config",
        scopeId: input.configId,
        correlationId: configRow.activeVersionId ?? input.configId,
        actorUserId: input.actorUserId,
        producer: "proxy.admin.routing-configs",
        eventType: "routing_config.archived",
        payload: {
          configId: input.configId,
          versionId: configRow.activeVersionId ?? null,
          version: activeVersion?.version ?? null,
          configHash: activeVersion?.configHash ?? null,
          status: "archived"
        },
        createdAt: now
      });
      return {
        configId: input.configId,
        versionId: configRow.activeVersionId ?? null,
        version: activeVersion?.version ?? null,
        configHash: activeVersion?.configHash ?? null
      };
    });
    this.onRoutingConfigsChanged();
    return result;
  }
}

async function lockedConfig(tx: ProxyTransaction, organizationId: string, workspaceId: string, configId: string) {
  await tx.execute(sql`
    select id
    from routing_configs
    where organization_id = ${organizationId}
      and workspace_id = ${workspaceId}
      and id = ${configId}
    for update
  `);
  const [config] = await tx
    .select()
    .from(routingConfigs)
    .where(and(
      eq(routingConfigs.organizationId, organizationId),
      eq(routingConfigs.workspaceId, workspaceId),
      eq(routingConfigs.id, configId)
    ))
    .limit(1);
  return config ?? null;
}

async function nextVersion(tx: ProxyTransaction, organizationId: string, configId: string) {
  const [row] = await tx
    .select({
      version: sql<number>`coalesce(max(${routingConfigVersions.version}), 0) + 1`
    })
    .from(routingConfigVersions)
    .where(and(
      eq(routingConfigVersions.organizationId, organizationId),
      eq(routingConfigVersions.routingConfigId, configId)
    ));
  return Number(row?.version ?? 1);
}

async function rejectDuplicateSlug(tx: ProxyTransaction, organizationId: string, workspaceId: string, slug: string) {
  const [existing] = await tx
    .select({ id: routingConfigs.id })
    .from(routingConfigs)
    .where(and(
      eq(routingConfigs.organizationId, organizationId),
      eq(routingConfigs.workspaceId, workspaceId),
      eq(routingConfigs.slug, slug)
    ))
    .limit(1);
  if (existing) throw new RoutingConfigAdminError("routing_config_name_exists", 409);
}

async function validateClassifierProvider(
  tx: ProxyTransaction,
  organizationId: string,
  config: RoutingConfig
) {
  const provider = await providerForSlug(tx, organizationId, config.classifier.providerId);
  const path = "classifier.providerId";
  if (!provider) {
    throw new RoutingConfigAdminError("routing_config_classifier_provider_not_found", 400, [{
      path,
      message: "Classifier provider must resolve to a provider registry row."
    }]);
  }
  if (!provider.enabled) {
    throw new RoutingConfigAdminError("routing_config_classifier_provider_disabled", 400, [{
      path,
      message: "Classifier provider must be enabled."
    }]);
  }
  if (!provider.endpoints.some((endpoint) => endpoint.dialect === "openai-responses")) {
    throw new RoutingConfigAdminError("routing_config_classifier_provider_responses_endpoint_required", 400, [{
      path,
      message: "Classifier provider must expose an OpenAI Responses endpoint."
    }]);
  }
}

async function validateRoutingConfigPublishability(
  tx: ProxyTransaction,
  organizationId: string,
  config: RoutingConfig
) {
  await validateClassifierProvider(tx, organizationId, config);
  const issues: { path: string; message: string }[] = [];
  for (const [route, routeConfig] of Object.entries(config.routes)) {
    const deployments = [
      ...(routeConfig.openai?.deployments.map((deployment, index) => ({
        provider: deployment.provider,
        model: deployment.model,
        providerAccountId: deployment.providerAccountId,
        path: `routes.${route}.openai.deployments.${index}.provider`
      })) ?? []),
      ...(routeConfig.anthropic?.deployments.map((deployment, index) => ({
        provider: deployment.provider,
        model: deployment.model,
        providerAccountId: deployment.providerAccountId,
        path: `routes.${route}.anthropic.deployments.${index}.provider`
      })) ?? [])
    ];
    for (const deployment of deployments) {
      const provider = await providerForSlug(tx, organizationId, deployment.provider);
      if (!provider) {
        issues.push({ path: deployment.path, message: "Target provider must resolve to a provider registry row." });
        continue;
      }
      if (!provider.enabled) {
        issues.push({ path: deployment.path, message: "Target provider must be enabled." });
        continue;
      }
      if (!canServeCurrentSurface(provider.endpoints)) {
        issues.push({ path: deployment.path, message: "Target provider must expose an OpenAI Responses, OpenAI Chat, Anthropic Messages, or Bedrock Converse endpoint." });
        continue;
      }
      if (provider.authStyle === "aws-sdk" && !deployment.providerAccountId) {
        issues.push({ path: deployment.path.replace(/\.provider$/, ".providerAccountId"), message: "AWS SDK target providers need an active provider account before publishing." });
        continue;
      }
      const providerAccount = deployment.providerAccountId
        ? await providerCredential(tx, organizationId, provider.id, deployment.providerAccountId)
        : undefined;
      if (deployment.providerAccountId && !providerAccount) {
        issues.push({ path: deployment.path.replace(/\.provider$/, ".providerAccountId"), message: "Provider account must be active and match the deployment provider." });
        continue;
      }
      if (provider.organizationId && provider.authStyle !== "none" && !await providerCredential(tx, organizationId, provider.id)) {
        issues.push({ path: deployment.path, message: "Auth-required custom target providers need a provider credential before publishing." });
        continue;
      }
      if (
        providerNeedsCatalogModel(provider) &&
        !await hasCatalogModel(tx, organizationId, provider.id, deployment.model, deployment.providerAccountId, providerAccountRegion(providerAccount))
      ) {
        issues.push({ path: deployment.path.replace(/\.provider$/, ".model"), message: "Target model must be present in the model catalog before publishing." });
      }
    }
  }
  if (issues.length > 0) {
    throw new RoutingConfigAdminError("routing_config_target_validation_failed", 400, issues);
  }
}

function canServeCurrentSurface(endpoints: { dialect: string }[]) {
  return endpoints.some((endpoint) =>
    endpoint.dialect === "openai-responses" ||
    endpoint.dialect === "openai-chat" ||
    endpoint.dialect === "anthropic-messages" ||
    endpoint.dialect === "bedrock-converse");
}

async function providerCredential(
  tx: ProxyTransaction,
  organizationId: string,
  providerId: string,
  providerAccountId?: string
) {
  const credentialPredicate = or(
    isNotNull(providerAccounts.secretCiphertext),
    and(
      eq(providers.adapterKind, "aws-bedrock-converse"),
      sql`${providerAccounts.settings}->>'credentialMode' in ('aws_default_chain', 'aws_profile')`
    )
  );
  const predicates = [
    eq(providerAccounts.organizationId, organizationId),
    eq(providerAccounts.providerId, providerId),
    eq(providerAccounts.status, "active"),
    credentialPredicate
  ];
  if (providerAccountId) predicates.push(eq(providerAccounts.id, providerAccountId));
  const [account] = await tx
    .select({
      id: providerAccounts.id,
      settings: providerAccounts.settings
    })
    .from(providerAccounts)
    .innerJoin(providers, eq(providers.id, providerAccounts.providerId))
    .where(and(...predicates))
    .limit(1);
  return account;
}

async function hasCatalogModel(
  tx: ProxyTransaction,
  organizationId: string,
  providerId: string,
  model: string,
  providerAccountId?: string,
  region?: string
) {
  const predicates = [
    eq(modelCatalog.providerId, providerId),
    eq(modelCatalog.model, model),
    or(
      isNull(modelCatalog.organizationId),
      eq(modelCatalog.organizationId, organizationId)
    ),
    providerAccountId
      ? or(
          isNull(modelCatalog.providerAccountId),
          eq(modelCatalog.providerAccountId, providerAccountId)
        )
      : isNull(modelCatalog.providerAccountId)
  ];
  if (region) {
    predicates.push(or(
      isNull(modelCatalog.region),
      eq(modelCatalog.region, region)
    ));
  }
  const [row] = await tx
    .select({ id: modelCatalog.id })
    .from(modelCatalog)
    .where(and(...predicates))
    .limit(1);
  return Boolean(row);
}

function providerNeedsCatalogModel(provider: { organizationId: string | null; adapterKind: string }) {
  return provider.organizationId !== null || provider.adapterKind === "aws-bedrock-converse";
}

function providerAccountRegion(account: { settings: unknown } | undefined) {
  const settings = account?.settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return undefined;
  const region = (settings as Record<string, unknown>).region;
  return typeof region === "string" && region.trim() ? region.trim() : undefined;
}

async function providerForSlug(
  tx: ProxyTransaction,
  organizationId: string,
  slug: string
) {
  const [orgProvider] = await tx
    .select()
    .from(providers)
    .where(and(
      eq(providers.organizationId, organizationId),
      eq(providers.slug, slug)
    ))
    .limit(1);
  if (orgProvider) return orgProvider;

  const [builtinProvider] = await tx
    .select()
    .from(providers)
    .where(and(
      eq(providers.slug, slug),
      isNull(providers.organizationId)
    ))
    .limit(1);
  return builtinProvider ?? null;
}

export async function routingConfigForAssignment(
  tx: ProxyTransaction,
  organizationId: string,
  workspaceId: string,
  configId: string
) {
  const [config] = await tx
    .select({
      id: routingConfigs.id,
      status: routingConfigs.status,
      activeVersionId: routingConfigs.activeVersionId,
      activeVersionHash: routingConfigVersions.configHash
    })
    .from(routingConfigs)
    .leftJoin(routingConfigVersions, and(
      eq(routingConfigVersions.organizationId, routingConfigs.organizationId),
      eq(routingConfigVersions.routingConfigId, routingConfigs.id),
      eq(routingConfigVersions.id, routingConfigs.activeVersionId)
    ))
    .where(and(
      eq(routingConfigs.organizationId, organizationId),
      eq(routingConfigs.workspaceId, workspaceId),
      eq(routingConfigs.id, configId)
    ))
    .limit(1);
  return config ?? null;
}

async function routingConfigVersion(
  tx: ProxyTransaction,
  organizationId: string,
  configId: string,
  versionId: string
) {
  const [version] = await tx
    .select()
    .from(routingConfigVersions)
    .where(and(
      eq(routingConfigVersions.organizationId, organizationId),
      eq(routingConfigVersions.routingConfigId, configId),
      eq(routingConfigVersions.id, versionId)
    ))
    .limit(1);
  return version ?? null;
}

async function routingConfigInUse(
  tx: ProxyTransaction,
  organizationId: string,
  workspaceId: string,
  configId: string
) {
  const [apiKey] = await tx
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(and(
      eq(apiKeys.organizationId, organizationId),
      eq(apiKeys.workspaceId, workspaceId),
      eq(apiKeys.routingConfigId, configId)
    ))
    .limit(1);
  if (apiKey) return true;

  const [workspace] = await tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(
      eq(workspaces.organizationId, organizationId),
      eq(workspaces.id, workspaceId),
      eq(workspaces.defaultRoutingConfigId, configId)
    ))
    .limit(1);
  return Boolean(workspace);
}

export type RoutingConfigAssignmentTarget = NonNullable<Awaited<ReturnType<typeof routingConfigForAssignment>>>;

function parseRoutingConfig(value: unknown): RoutingConfig {
  const parsed = routingConfigSchema.safeParse(value);
  if (!parsed.success) throw validationError("invalid_routing_config", parsed.error);
  return parsed.data;
}

function validationError(message: string, error: z.ZodError) {
  return new RoutingConfigAdminError(
    message,
    400,
    error.issues.map((issue) => ({
      path: issue.path.join(".") || "config",
      message: issue.message
    }))
  );
}

function configHash(config: RoutingConfig) {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

function slugValue(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "routing-config";
}
