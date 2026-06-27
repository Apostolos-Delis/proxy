import { modelCatalog, providers, type ProxyDbSession } from "@proxy/db";
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";

import { modelAliasIds } from "./catalog.js";

type CatalogModel = {
  provider: string;
  model: string;
  displayName: string | null;
};

export type ModelTargetCapabilities = {
  toolCall: boolean | null;
  image: boolean | null;
  streaming: boolean | null;
  contextWindow: number | null;
};

type ModelListEntry = {
  id: string;
  object?: "model";
  owned_by?: string;
  type?: "model";
  display_name?: string;
};

export type CatalogMergeRow = {
  organizationId: string | null;
  providerAccountId?: string | null;
  region?: string | null;
  catalogSource: string;
  capabilities: Record<string, unknown>;
  pricing?: Record<string, unknown>;
};

export class ModelDiscoveryStore {
  constructor(private readonly db: ProxyDbSession) {}

  async catalogModels(organizationId?: string): Promise<CatalogModel[]> {
    const providerRows = await this.effectiveProviders(organizationId);
    const providerIds = providerRows.map((provider) => provider.id);
    if (providerIds.length === 0) return [];

    const rows = await this.db
      .select({
        organizationId: modelCatalog.organizationId,
        providerAccountId: modelCatalog.providerAccountId,
        region: modelCatalog.region,
        provider: providers.slug,
        model: modelCatalog.model,
        catalogSource: modelCatalog.catalogSource,
        capabilities: modelCatalog.capabilities
      })
      .from(modelCatalog)
      .innerJoin(providers, eq(providers.id, modelCatalog.providerId))
      .where(and(
        inArray(modelCatalog.providerId, providerIds),
        organizationId
          ? or(
              isNull(modelCatalog.organizationId),
              eq(modelCatalog.organizationId, organizationId)
            )
          : isNull(modelCatalog.organizationId)
      ))
      .orderBy(asc(providers.slug), asc(modelCatalog.model));

    const byProviderModel = new Map<string, typeof rows>();
    for (const row of rows) {
      const key = `${row.provider}:${row.model}`;
      byProviderModel.set(key, [...(byProviderModel.get(key) ?? []), row]);
    }
    return [...byProviderModel.values()].map((group) => {
      const row = group[0]!;
      const capabilities = mergeCatalogCapabilities(group, organizationId);
      return {
        provider: row.provider,
        model: row.model,
        displayName: displayNameFromCapabilities(capabilities)
      };
    });
  }

  async targetCapabilities(input: {
    organizationId: string;
    providerId: string;
    model: string;
    providerAccountId?: string;
    region?: string;
  }): Promise<ModelTargetCapabilities | undefined> {
    const filters = [
      eq(modelCatalog.providerId, input.providerId),
      eq(modelCatalog.model, input.model),
      or(
        isNull(modelCatalog.organizationId),
        eq(modelCatalog.organizationId, input.organizationId)
      ),
      input.providerAccountId
        ? or(
            isNull(modelCatalog.providerAccountId),
            eq(modelCatalog.providerAccountId, input.providerAccountId)
          )
        : isNull(modelCatalog.providerAccountId)
    ];
    if (input.region) {
      filters.push(or(
        isNull(modelCatalog.region),
        eq(modelCatalog.region, input.region)
      ));
    }
    const rows = await this.db
      .select({
        organizationId: modelCatalog.organizationId,
        providerAccountId: modelCatalog.providerAccountId,
        region: modelCatalog.region,
        catalogSource: modelCatalog.catalogSource,
        capabilities: modelCatalog.capabilities
      })
      .from(modelCatalog)
      .where(and(...filters))
      .orderBy(asc(modelCatalog.organizationId), asc(modelCatalog.providerAccountId), asc(modelCatalog.region));

    if (rows.length === 0) return undefined;
    const capabilities = mergeCatalogCapabilities(rows, input.organizationId);
    return {
      toolCall: booleanOrNull(capabilities.toolCall),
      image: booleanOrNull(capabilities.image) ?? imageSupportFromModalities(capabilities.modalities),
      streaming: booleanOrNull(capabilities.streaming),
      contextWindow: positiveNumberOrNull(capabilities.contextWindow)
    };
  }

  private async effectiveProviders(organizationId?: string) {
    const rows = await this.db
      .select({
        id: providers.id,
        organizationId: providers.organizationId,
        slug: providers.slug,
        enabled: providers.enabled
      })
      .from(providers)
      .where(organizationId
        ? or(
            isNull(providers.organizationId),
            eq(providers.organizationId, organizationId)
          )
        : isNull(providers.organizationId))
      .orderBy(asc(providers.slug), asc(providers.organizationId));

    const bySlug = new Map<string, typeof rows[number]>();
    for (const row of rows) {
      const existing = bySlug.get(row.slug);
      if (!existing || row.organizationId === organizationId) bySlug.set(row.slug, row);
    }
    return [...bySlug.values()].filter((provider) => provider.enabled);
  }
}

export function mergeCatalogCapabilities(rows: CatalogMergeRow[], organizationId?: string) {
  return mergeCatalogRecord(rows, organizationId, "capabilities");
}

export function mergeCatalogPricing(rows: CatalogMergeRow[], organizationId?: string) {
  return mergeCatalogRecord(rows, organizationId, "pricing");
}

export function effectiveCatalogSource(rows: CatalogMergeRow[], organizationId?: string) {
  return sortedCatalogRows(rows, organizationId).at(-1)?.catalogSource ?? "manual";
}

export function catalogWarnings(capabilities: Record<string, unknown>, pricing: Record<string, unknown>) {
  const warnings = new Set<string>();
  for (const warning of stringArray(capabilities.warnings)) warnings.add(warning);
  for (const warning of stringArray(pricing.warnings)) warnings.add(warning);
  if (pricingKnown(pricing)) warnings.delete("bedrock_pricing_unknown");
  if (criticalCapabilitiesKnown(capabilities)) warnings.delete("bedrock_capabilities_unknown");
  return [...warnings].sort();
}

function mergeCatalogRecord(rows: CatalogMergeRow[], organizationId: string | undefined, key: "capabilities" | "pricing") {
  const merged: Record<string, unknown> = {};
  for (const row of sortedCatalogRows(rows, organizationId)) {
    Object.assign(merged, row[key] ?? {});
  }
  return merged;
}

function sortedCatalogRows(rows: CatalogMergeRow[], organizationId: string | undefined) {
  return [...rows].sort((left, right) =>
    catalogRowPriority(left, organizationId) - catalogRowPriority(right, organizationId) ||
    stringSort(left.providerAccountId, right.providerAccountId) ||
    stringSort(left.region, right.region) ||
    left.catalogSource.localeCompare(right.catalogSource)
  );
}

function catalogRowPriority(row: CatalogMergeRow, organizationId: string | undefined) {
  const override = row.catalogSource === "manual" || row.catalogSource === "env";
  if (organizationId && row.organizationId === organizationId && override) return 60;
  if (row.organizationId === null && override) return 40;
  if (organizationId && row.organizationId === organizationId && (row.providerAccountId || row.region)) return 20;
  if (organizationId && row.organizationId === organizationId) return 10;
  return 0;
}

function criticalCapabilitiesKnown(capabilities: Record<string, unknown>) {
  return positiveNumberOrNull(capabilities.contextWindow) !== null &&
    positiveNumberOrNull(capabilities.maxOutputTokens) !== null &&
    typeof capabilities.toolCall === "boolean" &&
    typeof capabilities.image === "boolean" &&
    typeof capabilities.streaming === "boolean";
}

function pricingKnown(pricing: Record<string, unknown>) {
  return numberOrNull(pricing.inputCostPerMtok) !== null && numberOrNull(pricing.outputCostPerMtok) !== null;
}

function stringSort(left: string | null | undefined, right: string | null | undefined) {
  return (left ?? "").localeCompare(right ?? "");
}

function booleanOrNull(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

function positiveNumberOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function numberOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function imageSupportFromModalities(value: unknown) {
  if (!Array.isArray(value)) return null;
  const modalities = value.filter((item): item is string => typeof item === "string");
  return modalities.length > 0 ? modalities.includes("image") : null;
}

export function modelDiscoveryResponse(catalogModels: CatalogModel[] = []) {
  const entries: ModelListEntry[] = [];
  const seen = new Set<string>();
  const add = (entry: ModelListEntry) => {
    if (seen.has(entry.id)) return;
    seen.add(entry.id);
    entries.push(entry);
  };

  for (const id of modelAliasIds()) add(aliasEntry(id));
  for (const model of catalogModels) {
    add({
      id: model.model,
      object: "model",
      owned_by: model.provider,
      type: "model",
      display_name: model.displayName ?? model.model
    });
  }

  return {
    object: "list",
    data: entries
  };
}

function aliasEntry(id: string): ModelListEntry {
  if (id.startsWith("claude-router-")) {
    return {
      id,
      type: "model",
      display_name: `Claude Router: ${aliasLabel(id)}`
    };
  }
  if (id.startsWith("anthropic-router-")) {
    return {
      id,
      type: "model",
      display_name: `Anthropic Router: ${aliasLabel(id)}`
    };
  }
  return {
    id,
    object: "model",
    owned_by: "proxy"
  };
}

function aliasLabel(id: string) {
  const suffix = id.split("-").at(-1) ?? id;
  return `${suffix.slice(0, 1).toUpperCase()}${suffix.slice(1)}`;
}

function displayNameFromCapabilities(capabilities: Record<string, unknown>) {
  const displayName = capabilities.displayName ?? capabilities.name;
  return typeof displayName === "string" && displayName.trim() ? displayName : null;
}
