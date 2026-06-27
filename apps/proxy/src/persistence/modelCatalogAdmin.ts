import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import {
  modelCatalog,
  providers,
  type ProxyTransaction,
  type ProxyTransactionalDatabase
} from "@proxy/db";

import { createId } from "../util.js";
import { appendAdminAuditEvent } from "./adminAudit.js";
import { AdminMutationError } from "./adminErrors.js";

const pricingBodySchema = z.object({
  inputCostPerMtok: z.number().nonnegative().finite().optional(),
  outputCostPerMtok: z.number().nonnegative().finite().optional(),
  cacheReadCostPerMtok: z.number().nonnegative().finite().optional(),
  cacheWriteCostPerMtok: z.number().nonnegative().finite().optional()
}).strict();

const upsertModelCatalogBodySchema = z.object({
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1).max(256),
  displayName: z.string().trim().min(1).max(256).optional(),
  dialects: z.array(z.string().trim().min(1)).max(10).optional(),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  supportsStreaming: z.boolean().optional(),
  supportsTools: z.boolean().optional(),
  supportsImages: z.boolean().optional(),
  supportsReasoning: z.boolean().optional(),
  pricing: pricingBodySchema.optional()
}).strict();

export class ModelCatalogAdminError extends AdminMutationError {}

export class ModelCatalogAdminService {
  constructor(private readonly db: ProxyTransactionalDatabase) {}

  async upsertManualModel(input: {
    organizationId: string;
    actorUserId: string;
    body: unknown;
  }) {
    const body = upsertModelCatalogBodySchema.safeParse(input.body);
    if (!body.success) throw validationError("invalid_model_catalog_request", body.error);
    const { provider, model } = body.data;
    const now = new Date();
    const capabilities = manualCapabilities(body.data);
    const pricing = manualPricing(body.data.pricing);

    return this.db.transaction(async (tx) => {
      const providerRow = await providerBySlug(tx, input.organizationId, provider);
      if (!providerRow) throw new ModelCatalogAdminError("provider_not_found", 404);
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
          capabilities,
          pricing,
          createdAt: now,
          updatedAt: now
        })
        .onConflictDoUpdate({
          target: [modelCatalog.organizationId, modelCatalog.providerId, modelCatalog.providerAccountId, modelCatalog.region, modelCatalog.model],
          set: {
            catalogSource: "manual",
            capabilities,
            pricing,
            updatedAt: now
          }
        });
      await appendAdminAuditEvent(tx, {
        organizationId: input.organizationId,
        scopeType: "model_catalog",
        scopeId: `${provider}:${model}`,
        actorUserId: input.actorUserId,
        producer: "proxy.admin.model-catalog",
        eventType: "model_catalog.manual_upserted",
        payload: {
          provider,
          model,
          catalogSource: "manual",
          capabilities,
          pricing
        },
        createdAt: now
      });
      return { provider, model };
    });
  }
}

type UpsertModelCatalogBody = z.infer<typeof upsertModelCatalogBodySchema>;

function manualCapabilities(body: UpsertModelCatalogBody) {
  const capabilities: Record<string, unknown> = { source: "manual" };
  setIfDefined(capabilities, "displayName", body.displayName);
  setIfDefined(capabilities, "dialects", body.dialects);
  setIfDefined(capabilities, "contextWindow", body.contextWindow);
  setIfDefined(capabilities, "maxOutputTokens", body.maxOutputTokens);
  setIfDefined(capabilities, "streaming", body.supportsStreaming);
  setIfDefined(capabilities, "toolCall", body.supportsTools);
  setIfDefined(capabilities, "image", body.supportsImages);
  setIfDefined(capabilities, "reasoning", body.supportsReasoning);
  return capabilities;
}

function manualPricing(pricing: UpsertModelCatalogBody["pricing"]) {
  return {
    source: "manual",
    ...pricing
  };
}

function setIfDefined(target: Record<string, unknown>, key: string, value: unknown) {
  if (value !== undefined) target[key] = value;
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
  throw new ModelCatalogAdminError(
    message,
    400,
    error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message
    }))
  );
}
