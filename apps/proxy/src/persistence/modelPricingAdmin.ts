import { and, eq } from "drizzle-orm";
import { z } from "zod";

import {
  modelCatalog,
  type PromptProxyTransactionalDatabase
} from "@prompt-proxy/db";

import { completeModelPricing, type ModelPricingTable } from "../pricing.js";
import { createId } from "../util.js";
import { appendAdminAuditEvent } from "./adminAudit.js";
import { AdminMutationError } from "./adminErrors.js";
import { repriceZeroCostUsage } from "./usageRepricing.js";

const setPricingBodySchema = z.object({
  provider: z.enum(["openai", "anthropic"]),
  model: z.string().trim().min(1).max(256),
  inputCostPerMtok: z.number().nonnegative().finite(),
  outputCostPerMtok: z.number().nonnegative().finite(),
  cacheReadCostPerMtok: z.number().nonnegative().finite().optional(),
  cacheWriteCostPerMtok: z.number().nonnegative().finite().optional()
}).strict();

const clearPricingBodySchema = z.object({
  provider: z.enum(["openai", "anthropic"]),
  model: z.string().trim().min(1).max(256)
}).strict();

export class ModelPricingAdminError extends AdminMutationError {}

export class ModelPricingAdminService {
  constructor(
    private readonly db: PromptProxyTransactionalDatabase,
    private readonly staticPricing: ModelPricingTable
  ) {}

  async setPricing(input: {
    organizationId: string;
    actorUserId: string;
    body: unknown;
  }) {
    const body = setPricingBodySchema.safeParse(input.body);
    if (!body.success) throw validationError("invalid_model_pricing_request", body.error);
    const { provider, model } = body.data;
    const pricing = completeModelPricing(body.data);
    const now = new Date();

    return this.db.transaction(async (tx) => {
      await tx
        .insert(modelCatalog)
        .values({
          id: createId("model"),
          organizationId: input.organizationId,
          provider,
          model,
          pricing,
          createdAt: now,
          updatedAt: now
        })
        .onConflictDoUpdate({
          target: [modelCatalog.organizationId, modelCatalog.provider, modelCatalog.model],
          set: {
            pricing,
            updatedAt: now
          }
        });
      await appendAdminAuditEvent(tx, {
        organizationId: input.organizationId,
        scopeType: "model_pricing",
        scopeId: `${provider}:${model}`,
        actorUserId: input.actorUserId,
        producer: "prompt-proxy.admin.model-pricing",
        eventType: "model_pricing.updated",
        payload: {
          provider,
          model,
          ...pricing
        },
        createdAt: now
      });
      // Heal traffic that booked $0 while this model had no rate; rows priced
      // at ingest keep their snapshot.
      await repriceZeroCostUsage(tx, this.staticPricing, {
        organizationId: input.organizationId,
        provider,
        model
      });
      return { provider, model, pricing };
    });
  }

  async clearPricing(input: {
    organizationId: string;
    actorUserId: string;
    body: unknown;
  }) {
    const body = clearPricingBodySchema.safeParse(input.body);
    if (!body.success) throw validationError("invalid_model_pricing_request", body.error);
    const { provider, model } = body.data;
    const now = new Date();

    return this.db.transaction(async (tx) => {
      const updated = await tx
        .update(modelCatalog)
        .set({
          pricing: {},
          updatedAt: now
        })
        .where(and(
          eq(modelCatalog.organizationId, input.organizationId),
          eq(modelCatalog.provider, provider),
          eq(modelCatalog.model, model)
        ))
        .returning();
      if (updated.length === 0) {
        throw new ModelPricingAdminError("model_pricing_not_found", 404);
      }
      await appendAdminAuditEvent(tx, {
        organizationId: input.organizationId,
        scopeType: "model_pricing",
        scopeId: `${provider}:${model}`,
        actorUserId: input.actorUserId,
        producer: "prompt-proxy.admin.model-pricing",
        eventType: "model_pricing.cleared",
        payload: {
          provider,
          model
        },
        createdAt: now
      });
      return { provider, model };
    });
  }
}

function validationError(message: string, error: z.ZodError): never {
  throw new ModelPricingAdminError(
    message,
    400,
    error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message
    }))
  );
}
