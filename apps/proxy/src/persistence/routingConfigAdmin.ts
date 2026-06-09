import { createHash } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import {
  apiKeys,
  routingConfigs,
  routingConfigVersions,
  type PromptProxyTransaction,
  type PromptProxyTransactionalDatabase
} from "@prompt-proxy/db";
import { routingConfigSchema, type RoutingConfig } from "@prompt-proxy/schema";

import { createId } from "../util.js";

const createConfigBodySchema = z.object({
  name: z.string().trim().min(1),
  slug: z.string().trim().min(1).optional(),
  description: z.string().trim().min(1).nullable().optional(),
  config: z.unknown()
}).strict();

const createVersionBodySchema = z.object({
  config: z.unknown()
}).strict();

const assignApiKeyRoutingConfigBodySchema = z.object({
  routingConfigId: z.string().trim().min(1).nullable()
}).strict();

export class RoutingConfigAdminError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly issues?: { path: string; message: string }[]
  ) {
    super(message);
  }
}

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
    const slug = slugValue(body.data.slug ?? body.data.name);
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
      return { configId: input.configId, versionId, version, configHash: hash };
    });
  }

  async activateVersion(input: {
    organizationId: string;
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

      if (routingConfigId) {
        const configRow = await routingConfigForAssignment(tx, input.organizationId, routingConfigId);
        if (!configRow) throw new RoutingConfigAdminError("routing_config_not_found", 404);
        if (configRow.status === "archived") throw new RoutingConfigAdminError("routing_config_archived", 409);
        if (configRow.status !== "active") throw new RoutingConfigAdminError("routing_config_inactive", 409);
        if (!configRow.activeVersionId) {
          throw new RoutingConfigAdminError("routing_config_active_version_missing", 409);
        }
      }

      await tx
        .update(apiKeys)
        .set({ routingConfigId })
        .where(and(
          eq(apiKeys.organizationId, input.organizationId),
          eq(apiKeys.id, input.apiKeyId)
        ));

      return {
        apiKeyId: input.apiKeyId,
        previousRoutingConfigId: apiKey.routingConfigId ?? null,
        routingConfigId
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
  if (existing) throw new RoutingConfigAdminError("routing_config_slug_exists", 409);
}

async function routingConfigForAssignment(tx: PromptProxyTransaction, organizationId: string, configId: string) {
  const [config] = await tx
    .select({
      id: routingConfigs.id,
      status: routingConfigs.status,
      activeVersionId: routingConfigs.activeVersionId
    })
    .from(routingConfigs)
    .where(and(
      eq(routingConfigs.organizationId, organizationId),
      eq(routingConfigs.id, configId)
    ))
    .limit(1);
  return config ?? null;
}

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
