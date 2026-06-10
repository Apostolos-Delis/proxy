import { createHash } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import {
  apiKeys,
  organizationSettings,
  routingConfigs,
  routingConfigVersions,
  type PromptProxyTransaction,
  type PromptProxyTransactionalDatabase
} from "@prompt-proxy/db";
import { routingConfigSchema, type RoutingConfig } from "@prompt-proxy/schema";

import { createId } from "../util.js";
import { AdminMutationError } from "./adminErrors.js";
import { appendAdminAuditEvent } from "./adminAudit.js";

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
  constructor(private readonly db: PromptProxyTransactionalDatabase) {}

  async createConfig(input: {
    organizationId: string;
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

    return this.db.transaction(async (tx) => {
      await rejectDuplicateSlug(tx, input.organizationId, slug);
      await tx.insert(routingConfigs).values({
        id: configId,
        organizationId: input.organizationId,
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
          eq(routingConfigs.id, configId)
        ));
      await appendAdminAuditEvent(tx, {
        organizationId: input.organizationId,
        scopeType: "routing_config",
        scopeId: configId,
        correlationId: versionId,
        actorUserId: input.actorUserId,
        producer: "prompt-proxy.admin.routing-configs",
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
        scopeType: "routing_config",
        scopeId: configId,
        correlationId: versionId,
        actorUserId: input.actorUserId,
        producer: "prompt-proxy.admin.routing-configs",
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
  }

  async createVersion(input: {
    organizationId: string;
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

    return this.db.transaction(async (tx) => {
      const configRow = await lockedConfig(tx, input.organizationId, input.configId);
      if (!configRow) throw new RoutingConfigAdminError("routing_config_not_found", 404);
      if (configRow.status === "archived") throw new RoutingConfigAdminError("routing_config_archived", 409);

      const version = await nextVersion(tx, input.organizationId, input.configId);
      await tx.insert(routingConfigVersions).values({
        id: versionId,
        organizationId: input.organizationId,
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
          eq(routingConfigs.id, input.configId)
        ));
      await appendAdminAuditEvent(tx, {
        organizationId: input.organizationId,
        scopeType: "routing_config",
        scopeId: input.configId,
        correlationId: versionId,
        actorUserId: input.actorUserId,
        producer: "prompt-proxy.admin.routing-configs",
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
  }

  async activateVersion(input: {
    organizationId: string;
    actorUserId: string;
    configId: string;
    versionId: string;
  }) {
    const now = new Date();
    return this.db.transaction(async (tx) => {
      const configRow = await lockedConfig(tx, input.organizationId, input.configId);
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

      await tx
        .update(routingConfigVersions)
        .set({
          status: "active",
          activatedAt: version.activatedAt ?? now
        })
        .where(and(
          eq(routingConfigVersions.organizationId, input.organizationId),
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
          eq(routingConfigs.id, input.configId)
        ));
      await appendAdminAuditEvent(tx, {
        organizationId: input.organizationId,
        scopeType: "routing_config",
        scopeId: input.configId,
        correlationId: input.versionId,
        actorUserId: input.actorUserId,
        producer: "prompt-proxy.admin.routing-configs",
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
  }

  async assignApiKeyRoutingConfig(input: {
    organizationId: string;
    actorUserId: string;
    apiKeyId: string;
    body: unknown;
  }) {
    const body = assignApiKeyRoutingConfigBodySchema.safeParse(input.body);
    if (!body.success) throw validationError("invalid_api_key_routing_config_request", body.error);
    const routingConfigId = body.data.routingConfigId;

    return this.db.transaction(async (tx) => {
      const [apiKey] = await tx
        .select({
          id: apiKeys.id,
          routingConfigId: apiKeys.routingConfigId
        })
        .from(apiKeys)
        .where(and(
          eq(apiKeys.organizationId, input.organizationId),
          eq(apiKeys.id, input.apiKeyId)
        ))
        .limit(1);
      if (!apiKey) throw new RoutingConfigAdminError("api_key_not_found", 404);

      let targetConfig: RoutingConfigAssignmentTarget | null = null;
      if (routingConfigId) {
        targetConfig = await routingConfigForAssignment(tx, input.organizationId, routingConfigId);
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
          eq(apiKeys.id, input.apiKeyId)
        ));
      await appendAdminAuditEvent(tx, {
        organizationId: input.organizationId,
        scopeType: "api_key",
        scopeId: input.apiKeyId,
        correlationId: routingConfigId ?? input.apiKeyId,
        actorUserId: input.actorUserId,
        producer: "prompt-proxy.admin.api-keys",
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
  }

  async archiveConfig(input: {
    organizationId: string;
    actorUserId: string;
    configId: string;
  }) {
    const now = new Date();
    return this.db.transaction(async (tx) => {
      const configRow = await lockedConfig(tx, input.organizationId, input.configId);
      if (!configRow) throw new RoutingConfigAdminError("routing_config_not_found", 404);
      if (configRow.status === "archived") throw new RoutingConfigAdminError("routing_config_archived", 409);
      if (await routingConfigInUse(tx, input.organizationId, input.configId)) {
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
          eq(routingConfigs.id, input.configId)
        ));
      await appendAdminAuditEvent(tx, {
        organizationId: input.organizationId,
        scopeType: "routing_config",
        scopeId: input.configId,
        correlationId: configRow.activeVersionId ?? input.configId,
        actorUserId: input.actorUserId,
        producer: "prompt-proxy.admin.routing-configs",
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
  }
}

async function lockedConfig(tx: PromptProxyTransaction, organizationId: string, configId: string) {
  await tx.execute(sql`
    select id
    from routing_configs
    where organization_id = ${organizationId}
      and id = ${configId}
    for update
  `);
  const [config] = await tx
    .select()
    .from(routingConfigs)
    .where(and(
      eq(routingConfigs.organizationId, organizationId),
      eq(routingConfigs.id, configId)
    ))
    .limit(1);
  return config ?? null;
}

async function nextVersion(tx: PromptProxyTransaction, organizationId: string, configId: string) {
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

async function rejectDuplicateSlug(tx: PromptProxyTransaction, organizationId: string, slug: string) {
  const [existing] = await tx
    .select({ id: routingConfigs.id })
    .from(routingConfigs)
    .where(and(
      eq(routingConfigs.organizationId, organizationId),
      eq(routingConfigs.slug, slug)
    ))
    .limit(1);
  if (existing) throw new RoutingConfigAdminError("routing_config_name_exists", 409);
}

export async function routingConfigForAssignment(tx: PromptProxyTransaction, organizationId: string, configId: string) {
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
      eq(routingConfigs.id, configId)
    ))
    .limit(1);
  return config ?? null;
}

async function routingConfigVersion(
  tx: PromptProxyTransaction,
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

async function routingConfigInUse(tx: PromptProxyTransaction, organizationId: string, configId: string) {
  const [apiKey] = await tx
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(and(
      eq(apiKeys.organizationId, organizationId),
      eq(apiKeys.routingConfigId, configId)
    ))
    .limit(1);
  if (apiKey) return true;

  const [settings] = await tx
    .select({ organizationId: organizationSettings.organizationId })
    .from(organizationSettings)
    .where(and(
      eq(organizationSettings.organizationId, organizationId),
      eq(organizationSettings.defaultRoutingConfigId, configId)
    ))
    .limit(1);
  return Boolean(settings);
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
