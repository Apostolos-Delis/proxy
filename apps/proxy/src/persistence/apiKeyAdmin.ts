import { randomBytes } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { z } from "zod";

import {
  apiKeys,
  hashApiKey,
  type PromptProxyTransactionalDatabase
} from "@prompt-proxy/db";

import { createId } from "../util.js";
import { AdminMutationError } from "./adminErrors.js";
import { appendAdminAuditEvent } from "./adminAudit.js";
import {
  routingConfigForAssignment,
  type RoutingConfigAssignmentTarget
} from "./routingConfigAdmin.js";

export const apiKeyScopeValues = ["proxy", "admin"] as const;

const createApiKeyBodySchema = z.object({
  name: z.string().trim().min(1),
  scopes: z.array(z.enum(apiKeyScopeValues)).min(1).optional(),
  routingConfigId: z.string().trim().min(1).nullable().optional()
}).strict();

export class ApiKeyAdminError extends AdminMutationError {}

export class ApiKeyAdminService {
  constructor(private readonly db: PromptProxyTransactionalDatabase) {}

  async createApiKey(input: {
    organizationId: string;
    workspaceId: string;
    actorUserId: string;
    body: unknown;
  }) {
    const body = createApiKeyBodySchema.safeParse(input.body);
    if (!body.success) throw validationError("invalid_api_key_request", body.error);
    const scopes = [...new Set(body.data.scopes ?? ["proxy"])];
    const routingConfigId = body.data.routingConfigId ?? null;
    const secret = `pp_${randomBytes(24).toString("hex")}`;
    const apiKeyId = createId("api_key");
    const now = new Date();

    return this.db.transaction(async (tx) => {
      let targetConfig: RoutingConfigAssignmentTarget | null = null;
      if (routingConfigId) {
        targetConfig = await routingConfigForAssignment(tx, input.organizationId, input.workspaceId, routingConfigId);
        if (!targetConfig) throw new ApiKeyAdminError("routing_config_not_found", 404);
        if (targetConfig.status === "archived") throw new ApiKeyAdminError("routing_config_archived", 409);
        if (targetConfig.status !== "active") throw new ApiKeyAdminError("routing_config_inactive", 409);
        if (!targetConfig.activeVersionId) {
          throw new ApiKeyAdminError("routing_config_active_version_missing", 409);
        }
        if (!targetConfig.activeVersionHash) {
          throw new ApiKeyAdminError("routing_config_active_version_not_found", 409);
        }
      }

      await tx.insert(apiKeys).values({
        id: apiKeyId,
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        userId: input.actorUserId,
        keyHash: hashApiKey(secret),
        name: body.data.name,
        routingConfigId,
        scopes,
        createdAt: now
      });
      await appendAdminAuditEvent(tx, {
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        scopeType: "api_key",
        scopeId: apiKeyId,
        correlationId: apiKeyId,
        actorUserId: input.actorUserId,
        producer: "prompt-proxy.admin.api-keys",
        eventType: "api_key.created",
        payload: {
          apiKeyId,
          name: body.data.name,
          userId: input.actorUserId,
          scopes,
          routingConfigId,
          routingConfigVersionId: targetConfig?.activeVersionId ?? null,
          routingConfigHash: targetConfig?.activeVersionHash ?? null
        },
        createdAt: now
      });

      return { apiKeyId, secret };
    });
  }

  async revokeApiKey(input: {
    organizationId: string;
    workspaceId: string;
    actorUserId: string;
    apiKeyId: string;
  }) {
    const now = new Date();
    return this.db.transaction(async (tx) => {
      const [apiKey] = await tx
        .select({
          id: apiKeys.id,
          name: apiKeys.name,
          revokedAt: apiKeys.revokedAt
        })
        .from(apiKeys)
        .where(and(
          eq(apiKeys.organizationId, input.organizationId),
          eq(apiKeys.workspaceId, input.workspaceId),
          eq(apiKeys.id, input.apiKeyId)
        ))
        .limit(1);
      if (!apiKey) throw new ApiKeyAdminError("api_key_not_found", 404);
      if (apiKey.revokedAt) throw new ApiKeyAdminError("api_key_revoked", 409);

      await tx
        .update(apiKeys)
        .set({ revokedAt: now })
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
        correlationId: input.apiKeyId,
        actorUserId: input.actorUserId,
        producer: "prompt-proxy.admin.api-keys",
        eventType: "api_key.revoked",
        payload: {
          apiKeyId: input.apiKeyId,
          name: apiKey.name,
          revokedAt: now.toISOString()
        },
        createdAt: now
      });

      return { apiKeyId: input.apiKeyId, revokedAt: now };
    });
  }
}

function validationError(message: string, error: z.ZodError) {
  return new ApiKeyAdminError(
    message,
    400,
    error.issues.map((issue) => ({
      path: issue.path.join(".") || "body",
      message: issue.message
    }))
  );
}
