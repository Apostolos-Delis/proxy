import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import {
  eventOutbox,
  events,
  modelCatalog,
  providers,
  type ProxyTransaction,
  type ProxyTransactionalDatabase
} from "@proxy/db";

import type { Dialect } from "../types.js";
import { createId, sha256, stableJson } from "../util.js";

const MODELS_DEV_API_URL = "https://models.dev/api.json";
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const source = "models.dev-refresh";

type Fetcher = (url: string) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

type ProviderRow = {
  id: string;
  slug: string;
  endpoints: { dialect: Dialect; path: string }[];
};

type RefreshModel = {
  provider: string;
  model: string;
  capabilities: Record<string, unknown>;
  pricing: Record<string, unknown>;
};

export type ModelCatalogRefreshResult =
  | {
    status: "completed";
    providersSeen: number;
    providersMatched: number;
    modelsSeen: number;
    modelsApplied: number;
    inserted: number;
    updated: number;
    skippedProviders: string[];
  }
  | {
    status: "failed";
    error: string;
  };

type ModelCatalogRefreshOptions = {
  auditOrganizationId: string;
  sourceUrl?: string;
  fetcher?: Fetcher;
  now?: () => Date;
};

const costSchema = z.object({
  input: z.number().nonnegative().finite().optional(),
  output: z.number().nonnegative().finite().optional(),
  cache_read: z.number().nonnegative().finite().optional(),
  cache_write: z.number().nonnegative().finite().optional()
}).passthrough();

const modelSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().optional(),
  family: z.string().optional(),
  attachment: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  reasoning_options: z.array(z.unknown()).optional(),
  tool_call: z.boolean().optional(),
  structured_output: z.boolean().optional(),
  temperature: z.boolean().optional(),
  modalities: z.object({
    input: z.array(z.string()).optional(),
    output: z.array(z.string()).optional()
  }).passthrough().optional(),
  open_weights: z.boolean().optional(),
  limit: z.object({
    context: z.number().nonnegative().finite().optional(),
    input: z.number().nonnegative().finite().optional(),
    output: z.number().nonnegative().finite().optional()
  }).passthrough().optional(),
  cost: costSchema.optional(),
  release_date: z.string().optional(),
  last_updated: z.string().optional()
}).passthrough();

const payloadSchema = z.record(
  z.string(),
  z.object({
    models: z.record(z.string(), modelSchema)
  }).passthrough()
);

export class ModelCatalogRefreshJob {
  private readonly sourceUrl: string;
  private readonly fetcher: Fetcher;
  private readonly now: () => Date;

  constructor(
    private readonly db: ProxyTransactionalDatabase,
    private readonly options: ModelCatalogRefreshOptions
  ) {
    this.sourceUrl = options.sourceUrl ?? MODELS_DEV_API_URL;
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async refresh(): Promise<ModelCatalogRefreshResult> {
    try {
      const response = await this.fetcher(this.sourceUrl);
      if (!response.ok) throw new Error(`models_dev_refresh_http_${response.status}`);
      return this.refreshPayload(await response.json());
    } catch (error) {
      return this.recordFailure(error);
    }
  }

  async refreshPayload(payload: unknown): Promise<ModelCatalogRefreshResult> {
    try {
      const parsed = parseModelsDevPayload(payload);
      const result = await this.db.transaction(async (tx) => {
        const applied = await applyRefresh(tx, parsed, this.now());
        await appendRefreshAudit(tx, this.options.auditOrganizationId, {
          status: "completed",
          ...applied
        });
        return applied;
      });
      return { status: "completed", ...result };
    } catch (error) {
      return this.recordFailure(error);
    }
  }

  private async recordFailure(error: unknown): Promise<ModelCatalogRefreshResult> {
    const result = {
      status: "failed" as const,
      error: error instanceof Error ? error.message : "models_dev_refresh_failed"
    };
    try {
      await this.db.transaction(async (tx) => {
        await appendRefreshAudit(tx, this.options.auditOrganizationId, result);
      });
    } catch {
      return result;
    }
    return result;
  }
}

export function scheduleDailyModelCatalogRefresh(
  job: ModelCatalogRefreshJob,
  log?: { warn: (obj: unknown, msg?: string) => void },
  intervalMs = REFRESH_INTERVAL_MS
) {
  const run = () => {
    void job.refresh().then((result) => {
      if (result.status === "failed") log?.warn({ error: result.error }, "models.dev refresh failed");
    }, (error) => {
      log?.warn({ err: error }, "models.dev refresh failed");
    });
  };
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  run();
  return timer;
}

function parseModelsDevPayload(payload: unknown) {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) throw new Error("models_dev_payload_invalid");
  const rows: RefreshModel[] = [];
  for (const [provider, providerData] of Object.entries(parsed.data)) {
    for (const [modelKey, model] of Object.entries(providerData.models)) {
      rows.push({
        provider,
        model: model.id || modelKey,
        capabilities: capabilitiesFromModel(model),
        pricing: pricingFromModel(model)
      });
    }
  }
  return rows;
}

async function applyRefresh(tx: ProxyTransaction, rows: RefreshModel[], now: Date) {
  const providerRows = await tx
    .select({ id: providers.id, slug: providers.slug, endpoints: providers.endpoints })
    .from(providers)
    .where(isNull(providers.organizationId));
  const providerBySlug = new Map(providerRows.map((provider) => [provider.slug, provider as ProviderRow]));
  const providerIds = providerRows.map((provider) => provider.id);
  const existingRows = providerIds.length === 0
    ? []
    : await tx
      .select({
        id: modelCatalog.id,
        providerId: modelCatalog.providerId,
        model: modelCatalog.model,
        capabilities: modelCatalog.capabilities
      })
      .from(modelCatalog)
      .where(and(
        isNull(modelCatalog.organizationId),
        inArray(modelCatalog.providerId, providerIds)
      ));
  const existingByKey = new Map(existingRows.map((row) => [`${row.providerId}:${row.model}`, row]));
  const skippedProviders = new Set<string>();
  let inserted = 0;
  let updated = 0;
  let modelsApplied = 0;

  for (const row of rows) {
    const provider = providerBySlug.get(row.provider);
    if (!provider) {
      skippedProviders.add(row.provider);
      continue;
    }
    const key = `${provider.id}:${row.model}`;
    const existing = existingByKey.get(key);
    const capabilities = mergeCapabilities(existing?.capabilities ?? {}, {
      ...row.capabilities,
      dialects: provider.endpoints.map((endpoint) => endpoint.dialect)
    });
    await tx
      .insert(modelCatalog)
      .values({
        id: existing?.id ?? `model:${row.provider}:${slug(row.model)}`,
        organizationId: null,
        providerId: provider.id,
        model: row.model,
        capabilities,
        pricing: row.pricing,
        createdAt: now,
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: [modelCatalog.organizationId, modelCatalog.providerId, modelCatalog.model],
        set: {
          capabilities,
          pricing: row.pricing,
          updatedAt: now
        }
      });
    if (existing) updated += 1;
    else inserted += 1;
    modelsApplied += 1;
  }

  return {
    providersSeen: new Set(rows.map((row) => row.provider)).size,
    providersMatched: providerRows.filter((provider) => rows.some((row) => row.provider === provider.slug)).length,
    modelsSeen: rows.length,
    modelsApplied,
    inserted,
    updated,
    skippedProviders: [...skippedProviders].sort()
  };
}

function capabilitiesFromModel(model: z.infer<typeof modelSchema>) {
  const capabilities: Record<string, unknown> = {
    source
  };
  setIfDefined(capabilities, "name", model.name);
  setIfDefined(capabilities, "family", model.family);
  setIfDefined(capabilities, "attachment", model.attachment);
  setIfDefined(capabilities, "reasoning", model.reasoning);
  setIfDefined(capabilities, "toolCall", model.tool_call);
  setIfDefined(capabilities, "structuredOutput", model.structured_output);
  setIfDefined(capabilities, "temperature", model.temperature);
  setIfDefined(capabilities, "modalities", model.modalities?.input);
  setIfDefined(capabilities, "outputModalities", model.modalities?.output);
  setIfDefined(capabilities, "openWeights", model.open_weights);
  setIfDefined(capabilities, "contextWindow", model.limit?.context);
  setIfDefined(capabilities, "inputTokenLimit", model.limit?.input);
  setIfDefined(capabilities, "maxOutputTokens", model.limit?.output);
  setIfDefined(capabilities, "efforts", effortValues(model.reasoning_options));
  setIfDefined(capabilities, "releaseDate", model.release_date);
  setIfDefined(capabilities, "lastUpdated", model.last_updated);
  return capabilities;
}

function pricingFromModel(model: z.infer<typeof modelSchema>) {
  const pricing: Record<string, unknown> = { source };
  setIfDefined(pricing, "inputCostPerMtok", model.cost?.input);
  setIfDefined(pricing, "outputCostPerMtok", model.cost?.output);
  setIfDefined(pricing, "cacheReadCostPerMtok", model.cost?.cache_read);
  setIfDefined(pricing, "cacheWriteCostPerMtok", model.cost?.cache_write);
  return pricing;
}

function mergeCapabilities(existing: Record<string, unknown>, incoming: Record<string, unknown>) {
  const merged = { ...existing, ...incoming };
  mergeArrayCapability(merged, existing, incoming, "dialects");
  mergeArrayCapability(merged, existing, incoming, "modalities");
  mergeArrayCapability(merged, existing, incoming, "outputModalities");
  mergeArrayCapability(merged, existing, incoming, "efforts");
  mergeArrayCapability(merged, existing, incoming, "surfaces");
  mergeArrayCapability(merged, existing, incoming, "routes");
  mergeBooleanCapability(merged, existing, incoming, "attachment");
  mergeBooleanCapability(merged, existing, incoming, "reasoning");
  mergeBooleanCapability(merged, existing, incoming, "toolCall");
  mergeBooleanCapability(merged, existing, incoming, "structuredOutput");
  mergeBooleanCapability(merged, existing, incoming, "temperature");
  mergeBooleanCapability(merged, existing, incoming, "openWeights");
  mergeNumericCapability(merged, existing, incoming, "contextWindow");
  mergeNumericCapability(merged, existing, incoming, "inputTokenLimit");
  mergeNumericCapability(merged, existing, incoming, "maxOutputTokens");
  merged.source = source;
  return merged;
}

function mergeArrayCapability(
  merged: Record<string, unknown>,
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
  key: string
) {
  const values = [...stringValues(existing[key]), ...stringValues(incoming[key])];
  if (values.length > 0) merged[key] = [...new Set(values)];
}

function mergeBooleanCapability(
  merged: Record<string, unknown>,
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
  key: string
) {
  if (existing[key] === true || incoming[key] === true) merged[key] = true;
}

function mergeNumericCapability(
  merged: Record<string, unknown>,
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
  key: string
) {
  const existingValue = typeof existing[key] === "number" ? existing[key] : undefined;
  const incomingValue = typeof incoming[key] === "number" ? incoming[key] : undefined;
  const values = [existingValue, incomingValue].filter((value): value is number => value !== undefined);
  if (values.length > 0) merged[key] = Math.max(...values);
}

function setIfDefined(target: Record<string, unknown>, key: string, value: unknown) {
  if (value !== undefined) target[key] = value;
}

function stringValues(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function effortValues(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  for (const option of value) {
    if (!option || typeof option !== "object" || Array.isArray(option)) continue;
    const record = option as Record<string, unknown>;
    if (record.type === "effort") return stringValues(record.values);
  }
  return undefined;
}

async function appendRefreshAudit(
  tx: ProxyTransaction,
  organizationId: string,
  payload: Record<string, unknown>
) {
  const eventId = createId("event");
  await tx.insert(events).values({
    id: eventId,
    sequence: await nextEventSequence(tx, organizationId),
    schemaVersion: 1,
    organizationId,
    scopeType: "model_catalog_refresh",
    scopeId: "models.dev",
    actorType: "system",
    actorId: "models.dev-refresh",
    producer: "proxy.jobs.model-catalog-refresh",
    eventType: payload.status === "completed"
      ? "model_catalog.refresh_completed"
      : "model_catalog.refresh_failed",
    payloadHash: sha256(stableJson(payload)),
    sensitivity: "internal",
    redactionState: "redacted",
    payload,
    metadata: {},
    createdAt: new Date()
  });
  await tx.insert(eventOutbox).values({
    id: createId("outbox"),
    eventId
  });
}

async function nextEventSequence(tx: ProxyTransaction, organizationId: string) {
  const [row] = await tx
    .select({
      sequence: sql<number>`coalesce(max(${events.sequence}), 0) + 1`
    })
    .from(events)
    .where(and(
      eq(events.organizationId, organizationId),
      eq(events.scopeType, "model_catalog_refresh"),
      eq(events.scopeId, "models.dev")
    ));
  return Number(row?.sequence ?? 1);
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "local";
}
