import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import {
  modelCatalog,
  providers,
  type ProxyTransaction,
  type ProxyTransactionalDatabase
} from "@proxy/db";

import { completeModelPricing } from "../pricing.js";
import { createId } from "../util.js";
import { appendAdminAuditEvent } from "./adminAudit.js";
import { AdminMutationError } from "./adminErrors.js";
import { repriceZeroCostUsage } from "./usageRepricing.js";

const setPricingBodySchema = z.object({
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1).max(256),
  inputCostPerMtok: z.number().nonnegative().finite(),
  outputCostPerMtok: z.number().nonnegative().finite(),
  cacheReadCostPerMtok: z.number().nonnegative().finite().optional(),
  cacheWriteCostPerMtok: z.number().nonnegative().finite().optional()
}).strict();

const clearPricingBodySchema = z.object({
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1).max(256)
}).strict();

export class ModelPricingAdminError extends AdminMutationError {}

export class ModelPricingAdminService {
  constructor(private readonly db: ProxyTransactionalDatabase) {}

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
      const providerRow = await providerBySlug(tx, input.organizationId, provider);
      if (!providerRow) throw new ModelPricingAdminError("provider_not_found", 404);
      await tx
        .insert(modelCatalog)
        .values({
          id: createId("model"),
          organizationId: input.organizationId,
          providerId: providerRow.id,
          providerAccountId: null,
          region: null,
          model,
          catalogSource: "manual",
          pricing,
          createdAt: now,
          updatedAt: now
        })
        .onConflictDoUpdate({
          target: [modelCatalog.organizationId, modelCatalog.providerId, modelCatalog.providerAccountId, modelCatalog.region, modelCatalog.model],
          set: {
            pricing,
            catalogSource: "manual",
            updatedAt: now
          }
        });
      await appendAdminAuditEvent(tx, {
        organizationId: input.organizationId,
        scopeType: "model_pricing",
        scopeId: `${provider}:${model}`,
        actorUserId: input.actorUserId,
        producer: "proxy.admin.model-pricing",
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
      await repriceZeroCostUsage(tx, {
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
      const providerRow = await providerBySlug(tx, input.organizationId, provider);
      if (!providerRow) throw new ModelPricingAdminError("provider_not_found", 404);
      const updated = await tx
        .update(modelCatalog)
        .set({
          pricing: {},
          updatedAt: now
        })
        .where(and(
          eq(modelCatalog.organizationId, input.organizationId),
          eq(modelCatalog.providerId, providerRow.id),
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
        producer: "proxy.admin.model-pricing",
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

async function providerBySlug(
  tx: ProxyTransaction,
  organizationId: string,
  slug: string
) {
  const [orgProvider] = await tx
    .select({ id: providers.id })
    .from(providers)
    .where(and(
      eq(providers.organizationId, organizationId),
      eq(providers.slug, slug)
    ))
    .limit(1);
  if (orgProvider) return orgProvider;

  const [provider] = await tx
    .select({ id: providers.id })
    .from(providers)
    .where(and(
      isNull(providers.organizationId),
      eq(providers.slug, slug)
    ))
    .limit(1);
  return provider;
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
