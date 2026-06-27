import { and, eq, sql } from "drizzle-orm";

import {
  eventOutbox,
  events,
  modelCatalog,
  providerAccounts,
  providers,
  type ProxyTransaction,
  type ProxyTransactionalDatabase
} from "@proxy/db";
import { PROVIDER_ACCOUNT_STATUSES } from "@proxy/schema";

import type { ProviderCredentialStore } from "../persistence/providerCredentials.js";
import type { ProviderRegistryEntry } from "../persistence/providers.js";
import type { JsonObject, Provider } from "../types.js";
import { createId, sha256, stableJson } from "../util.js";
import { BedrockDiscoveryAdapter, type BedrockDiscoveryClientFactory, type BedrockDiscoveryConfig, type BedrockDiscoveryResult } from "../providerAdapters/bedrockDiscovery.js";

export type BedrockModelDiscoveryResult =
  | {
      status: "completed";
      provider: string;
      providerAccountId: string;
      regions: string[];
      modelsSeen: number;
      modelsApplied: number;
      inserted: number;
      updated: number;
      skipped: number;
      errors: BedrockModelDiscoveryRegionError[];
    }
  | {
      status: "failed";
      providerAccountId: string;
      error: string;
      regions: string[];
      modelsSeen: number;
      modelsApplied: number;
      inserted: number;
      updated: number;
      skipped: number;
      errors: BedrockModelDiscoveryRegionError[];
    };

type BedrockModelDiscoveryRegionError = {
  region: string;
  error: string;
};

type BedrockProviderAccount = {
  id: string;
  organizationId: string;
  providerId: string;
  provider: Provider;
  providerOrganizationId: string | null;
  baseUrl: string;
  adapterKind: ProviderRegistryEntry["adapterKind"];
  adapterConfig: Record<string, unknown>;
  authStyle: ProviderRegistryEntry["authStyle"];
  endpoints: ProviderRegistryEntry["endpoints"];
  defaultHeaders: Record<string, string>;
  capabilities: Record<string, unknown>;
  forwardHarnessHeaders: boolean;
  enabled: boolean;
  accountBaseUrl: string | null;
  settings: JsonObject;
  status: string;
};

export class BedrockModelDiscoveryJob {
  private readonly adapter: BedrockDiscoveryAdapter;
  private readonly now: () => Date;

  constructor(
    private readonly db: ProxyTransactionalDatabase,
    private readonly credentialStore: ProviderCredentialStore,
    config: BedrockDiscoveryConfig,
    options: {
      clientFactory?: BedrockDiscoveryClientFactory;
      now?: () => Date;
    } = {}
  ) {
    this.adapter = new BedrockDiscoveryAdapter(config, options.clientFactory);
    this.now = options.now ?? (() => new Date());
  }

  async refreshProviderAccount(input: {
    organizationId: string;
    providerAccountId: string;
    actorUserId?: string;
    signal?: AbortSignal;
  }): Promise<BedrockModelDiscoveryResult> {
    let account: BedrockProviderAccount;
    try {
      account = await this.db.transaction(async (tx) => {
        const found = await providerAccount(tx, input.organizationId, input.providerAccountId);
        if (!found) throw new Error("provider_account_not_found");
        if (found.status !== PROVIDER_ACCOUNT_STATUSES.ACTIVE) throw new Error("provider_account_inactive");
        if (found.adapterKind !== "aws-bedrock-converse") throw new Error("provider_account_not_bedrock");
        if (!found.enabled) throw new Error("provider_disabled");
        return found;
      });
    } catch (error) {
      return this.recordFailure(input, {
        error: errorMessage(error),
        regions: []
      });
    }

    const regions = discoveryRegions(account);
    const discovered: Array<{ region: string; result: BedrockDiscoveryResult }> = [];
    const errors: BedrockModelDiscoveryRegionError[] = [];

    for (const region of regions) {
      try {
        const credential = await this.credentialStore.resolveAccount({
          organizationId: input.organizationId,
          provider: account.provider,
          providerAccountId: input.providerAccountId
        });
        if (!credential) throw new Error("provider_credential_unresolved");
        const result = await this.adapter.discover({
          provider: providerEntry(account),
          credential,
          region,
          signal: input.signal
        });
        discovered.push({ region, result });
      } catch (error) {
        errors.push({ region, error: errorMessage(error) });
      }
    }

    const modelsSeen = discovered.reduce((count, entry) => count + entry.result.modelsSeen, 0);
    const skipped = discovered.reduce((count, entry) => count + entry.result.modelsSkipped, 0);
    if (discovered.length === 0) {
      return this.recordFailure(input, {
        error: errors[0]?.error ?? "bedrock_discovery_failed",
        regions,
        modelsSeen,
        errors
      });
    }

    const applied = await this.db.transaction(async (tx) => {
      const result = await applyDiscoveryRows(tx, {
        organizationId: input.organizationId,
        providerId: account.providerId,
        providerAccountId: input.providerAccountId,
        discovered,
        now: this.now()
      });
      const payload = {
        status: "completed",
        provider: account.provider,
        providerAccountId: input.providerAccountId,
        regions,
        modelsSeen,
        skipped,
        errors,
        ...result
      };
      await appendDiscoveryAudit(tx, {
        organizationId: input.organizationId,
        providerAccountId: input.providerAccountId,
        actorUserId: input.actorUserId,
        payload,
        createdAt: this.now()
      });
      return result;
    });

    return {
      status: "completed",
      provider: account.provider,
      providerAccountId: input.providerAccountId,
      regions,
      modelsSeen,
      skipped,
      errors,
      ...applied
    };
  }

  private async recordFailure(
    input: { organizationId: string; providerAccountId: string; actorUserId?: string },
    failure: {
      error: string;
      regions: string[];
      modelsSeen?: number;
      errors?: BedrockModelDiscoveryRegionError[];
    }
  ): Promise<Extract<BedrockModelDiscoveryResult, { status: "failed" }>> {
    const payload = {
      status: "failed" as const,
      providerAccountId: input.providerAccountId,
      error: failure.error,
      regions: failure.regions,
      modelsSeen: failure.modelsSeen ?? 0,
      modelsApplied: 0,
      inserted: 0,
      updated: 0,
      skipped: 0,
      errors: failure.errors ?? []
    };
    try {
      await this.db.transaction(async (tx) => {
        await appendDiscoveryAudit(tx, {
          organizationId: input.organizationId,
          providerAccountId: input.providerAccountId,
          actorUserId: input.actorUserId,
          payload,
          createdAt: this.now()
        });
      });
    } catch {
      return payload;
    }
    return payload;
  }
}

async function applyDiscoveryRows(
  tx: ProxyTransaction,
  input: {
    organizationId: string;
    providerId: string;
    providerAccountId: string;
    discovered: Array<{ region: string; result: BedrockDiscoveryResult }>;
    now: Date;
  }
) {
  const existing = await tx
    .select({
      id: modelCatalog.id,
      region: modelCatalog.region,
      model: modelCatalog.model
    })
    .from(modelCatalog)
    .where(and(
      eq(modelCatalog.organizationId, input.organizationId),
      eq(modelCatalog.providerId, input.providerId),
      eq(modelCatalog.providerAccountId, input.providerAccountId)
    ));
  const existingByKey = new Map(existing.map((row) => [`${row.region ?? ""}:${row.model}`, row]));
  let inserted = 0;
  let updated = 0;
  let modelsApplied = 0;

  for (const regionEntry of input.discovered) {
    for (const row of regionEntry.result.models) {
      const key = `${regionEntry.region}:${row.model}`;
      const existingRow = existingByKey.get(key);
      const capabilities = {
        ...row.capabilities,
        region: regionEntry.region,
        providerAccountId: input.providerAccountId
      };
      await tx
        .insert(modelCatalog)
        .values({
          id: existingRow?.id ?? `model:bedrock:${slug(input.providerAccountId)}:${slug(regionEntry.region)}:${slug(row.model)}`,
          organizationId: input.organizationId,
          providerId: input.providerId,
          providerAccountId: input.providerAccountId,
          region: regionEntry.region,
          model: row.model,
          catalogSource: "bedrock-discovery",
          capabilities,
          pricing: row.pricing,
          createdAt: input.now,
          updatedAt: input.now
        })
        .onConflictDoUpdate({
          target: [modelCatalog.organizationId, modelCatalog.providerId, modelCatalog.providerAccountId, modelCatalog.region, modelCatalog.model],
          set: {
            catalogSource: "bedrock-discovery",
            capabilities,
            pricing: row.pricing,
            updatedAt: input.now
          }
        });
      if (existingRow) updated += 1;
      else inserted += 1;
      modelsApplied += 1;
    }
  }

  return { modelsApplied, inserted, updated };
}

async function providerAccount(
  tx: ProxyTransaction,
  organizationId: string,
  providerAccountId: string
): Promise<BedrockProviderAccount | undefined> {
  const [row] = await tx
    .select({
      id: providerAccounts.id,
      organizationId: providerAccounts.organizationId,
      providerId: providerAccounts.providerId,
      provider: providers.slug,
      providerOrganizationId: providers.organizationId,
      baseUrl: providers.baseUrl,
      adapterKind: providers.adapterKind,
      adapterConfig: providers.adapterConfig,
      authStyle: providers.authStyle,
      endpoints: providers.endpoints,
      defaultHeaders: providers.defaultHeaders,
      capabilities: providers.capabilities,
      forwardHarnessHeaders: providers.forwardHarnessHeaders,
      enabled: providers.enabled,
      accountBaseUrl: providerAccounts.baseUrl,
      settings: providerAccounts.settings,
      status: providerAccounts.status
    })
    .from(providerAccounts)
    .innerJoin(providers, eq(providers.id, providerAccounts.providerId))
    .where(and(
      eq(providerAccounts.organizationId, organizationId),
      eq(providerAccounts.id, providerAccountId)
    ))
    .limit(1);
  if (!row) return undefined;
  return {
    ...row,
    settings: jsonObject(row.settings)
  };
}

function providerEntry(account: BedrockProviderAccount): ProviderRegistryEntry {
  return {
    id: account.providerId,
    organizationId: account.providerOrganizationId,
    slug: account.provider,
    baseUrl: account.accountBaseUrl ?? account.baseUrl,
    adapterKind: account.adapterKind,
    adapterConfig: account.adapterConfig,
    authStyle: account.authStyle,
    endpoints: account.endpoints,
    defaultHeaders: account.defaultHeaders,
    capabilities: account.capabilities,
    forwardHarnessHeaders: account.forwardHarnessHeaders,
    enabled: account.enabled,
    builtin: account.providerOrganizationId === null
  };
}

function discoveryRegions(account: BedrockProviderAccount) {
  const configured = stringArray(account.settings.discoveryRegions);
  const fallback = stringValue(account.settings.region) ??
    stringValue(account.adapterConfig.defaultRegion) ??
    "us-east-1";
  const regions = configured.length > 0 ? configured : [fallback];
  return [...new Set(regions)];
}

async function appendDiscoveryAudit(
  tx: ProxyTransaction,
  input: {
    organizationId: string;
    providerAccountId: string;
    actorUserId?: string;
    payload: Record<string, unknown>;
    createdAt: Date;
  }
) {
  const eventId = createId("event");
  await tx.insert(events).values({
    id: eventId,
    sequence: await nextEventSequence(tx, input.organizationId, input.providerAccountId),
    schemaVersion: 1,
    organizationId: input.organizationId,
    scopeType: "provider_account",
    scopeId: input.providerAccountId,
    actorType: input.actorUserId ? "user" : "system",
    actorId: input.actorUserId ?? "bedrock-model-discovery",
    producer: "proxy.jobs.bedrock-model-discovery",
    eventType: input.payload.status === "completed"
      ? "model_catalog.bedrock_discovery_completed"
      : "model_catalog.bedrock_discovery_failed",
    payloadHash: sha256(stableJson(input.payload)),
    sensitivity: "internal",
    redactionState: "redacted",
    payload: input.payload,
    metadata: {},
    createdAt: input.createdAt
  });
  await tx.insert(eventOutbox).values({
    id: createId("outbox"),
    eventId
  });
}

async function nextEventSequence(tx: ProxyTransaction, organizationId: string, providerAccountId: string) {
  const [row] = await tx
    .select({
      sequence: sql<number>`coalesce(max(${events.sequence}), 0) + 1`
    })
    .from(events)
    .where(and(
      eq(events.organizationId, organizationId),
      eq(events.scopeType, "provider_account"),
      eq(events.scopeId, providerAccountId)
    ));
  return Number(row?.sequence ?? 1);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "bedrock_discovery_failed";
}

function jsonObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.map(stringValue).filter((item): item is string => Boolean(item))
    : [];
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "local";
}
