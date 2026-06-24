import { modelCatalog, providers, type ProxyDbSession } from "@proxy/db";
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";

import { modelAliasIds } from "./catalog.js";

type CatalogModel = {
  provider: string;
  model: string;
};

type ModelListEntry = {
  id: string;
  object?: "model";
  owned_by?: string;
  type?: "model";
  display_name?: string;
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
        provider: providers.slug,
        model: modelCatalog.model
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

    const byProviderModel = new Map<string, CatalogModel>();
    for (const row of rows) {
      byProviderModel.set(`${row.provider}:${row.model}`, {
        provider: row.provider,
        model: row.model
      });
    }
    return [...byProviderModel.values()];
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
      display_name: model.model
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
