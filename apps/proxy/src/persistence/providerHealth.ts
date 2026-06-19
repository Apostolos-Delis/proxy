import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import {
  providerAccountHealth,
  providerModelHealth,
  providers,
  type PromptProxyDbSession,
  type PromptProxyTransaction
} from "@prompt-proxy/db";
import {
  providerHealthClassificationSchema,
  type ProviderHealthClassification,
  type ProviderHealthStatus
} from "@prompt-proxy/schema";

import { classifyProviderTerminalHealth } from "../providerHealth.js";
import type { Provider, ProviderHealthSkip } from "../types.js";
import { createId } from "../util.js";
import { numberValue, providerValue, recordValue, stringValue } from "./values.js";

export type ProviderHealthTarget = {
  provider: Provider;
  providerId: string;
  providerAccountId: string;
  model: string;
};

export class ProviderHealthStore {
  constructor(private readonly db: PromptProxyDbSession) {}

  async skipsForTargets(input: {
    organizationId: string;
    targets: ProviderHealthTarget[];
    now?: Date;
  }) {
    const targets = uniqueTargets(input.targets);
    const result = new Map<string, ProviderHealthSkip>();
    if (targets.length === 0) return result;

    const now = input.now ?? new Date();
    const accountIds = [...new Set(targets.map((target) => target.providerAccountId))];
    const providerIds = [...new Set(targets.map((target) => target.providerId))];
    const models = [...new Set(targets.map((target) => target.model))];

    const accountRows = await this.db
      .select({
        providerAccountId: providerAccountHealth.providerAccountId,
        status: providerAccountHealth.status,
        lastErrorType: providerAccountHealth.lastErrorType,
        cooldownUntil: providerAccountHealth.cooldownUntil
      })
      .from(providerAccountHealth)
      .where(and(
        eq(providerAccountHealth.organizationId, input.organizationId),
        inArray(providerAccountHealth.providerAccountId, accountIds)
      ));
    const accountsById = new Map(accountRows.map((row) => [row.providerAccountId, row]));

    const modelRows = await this.db
      .select({
        providerId: providerModelHealth.providerId,
        providerAccountId: providerModelHealth.providerAccountId,
        model: providerModelHealth.model,
        status: providerModelHealth.status,
        lastErrorType: providerModelHealth.lastErrorType,
        lockoutUntil: providerModelHealth.lockoutUntil
      })
      .from(providerModelHealth)
      .where(and(
        eq(providerModelHealth.organizationId, input.organizationId),
        inArray(providerModelHealth.providerAccountId, accountIds),
        inArray(providerModelHealth.providerId, providerIds),
        inArray(providerModelHealth.model, models)
      ));
    const modelsByKey = new Map(modelRows.map((row) => [healthKey(row), row]));

    for (const target of targets) {
      const account = accountsById.get(target.providerAccountId);
      if (account?.status === "terminal" || (account?.cooldownUntil && account.cooldownUntil > now)) {
        result.set(healthKey(target), healthSkip(target, {
          scope: "provider_account",
          healthStatus: account.status,
          errorType: account.lastErrorType ?? undefined,
          expiresAt: account.cooldownUntil ?? undefined
        }));
        continue;
      }

      const model = modelsByKey.get(healthKey(target));
      if (model?.status === "terminal" || (model?.lockoutUntil && model.lockoutUntil > now)) {
        result.set(healthKey(target), healthSkip(target, {
          scope: "provider_account_model",
          healthStatus: model.status,
          errorType: model.lastErrorType ?? undefined,
          expiresAt: model.lockoutUntil ?? undefined
        }));
      }
    }

    return result;
  }
}

export function providerHealthTargetKey(target: Pick<ProviderHealthTarget, "providerId" | "providerAccountId" | "model">) {
  return healthKey(target);
}

function uniqueTargets(targets: ProviderHealthTarget[]) {
  const seen = new Set<string>();
  const unique: ProviderHealthTarget[] = [];
  for (const target of targets) {
    const key = healthKey(target);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(target);
  }
  return unique;
}

function healthKey(target: Pick<ProviderHealthTarget, "providerId" | "providerAccountId" | "model">) {
  return `${target.providerId}:${target.providerAccountId}:${target.model}`;
}

function healthSkip(
  target: ProviderHealthTarget,
  input: {
    scope: ProviderHealthSkip["scope"];
    healthStatus: string;
    errorType?: string;
    expiresAt?: Date;
  }
): ProviderHealthSkip {
  return {
    scope: input.scope,
    provider: target.provider,
    providerId: target.providerId,
    providerAccountId: target.providerAccountId,
    model: target.model,
    healthStatus: input.healthStatus,
    ...(input.errorType ? { errorType: input.errorType } : {}),
    ...(input.expiresAt ? { expiresAt: input.expiresAt.toISOString() } : {})
  };
}

export async function projectProviderHealthTerminal(tx: PromptProxyTransaction, event: {
  tenantId: string;
  workspaceId?: string;
  createdAt: string;
  payload: Record<string, unknown>;
}) {
  const providerAccountId = stringValue(event.payload.providerAccountId);
  if (!providerAccountId) return;

  const provider = providerValue(event.payload.provider);
  const model = stringValue(event.payload.selectedModel) ?? stringValue(event.payload.model);
  if (!provider || !model) return;

  const providerRow = await providerForSlug(tx, event.tenantId, provider);
  if (!providerRow) return;

  const status = stringValue(event.payload.terminalStatus);
  if (status === "completed") {
    await recordHealthSuccess(tx, {
      organizationId: event.tenantId,
      workspaceId: event.workspaceId,
      providerAccountId,
      providerId: providerRow.id,
      model,
      at: new Date(event.createdAt)
    });
    return;
  }

  const classification = classifyProviderTerminalHealth({
    provider,
    model,
    terminalStatus: status === "cancelled" ? "cancelled" : "failed",
    statusCode: numberValue(event.payload.upstreamStatus),
    error: stringValue(event.payload.error),
    now: new Date(event.createdAt)
  });
  if (!classification || classification.scope === "request_only" || classification.scope === "provider") return;

  if (classification.scope === "provider_account") {
    await recordAccountFailure(tx, {
      organizationId: event.tenantId,
      workspaceId: event.workspaceId,
      providerAccountId,
      providerId: providerRow.id,
      classification,
      at: new Date(event.createdAt)
    });
    return;
  }

  await recordModelFailure(tx, {
    organizationId: event.tenantId,
    workspaceId: event.workspaceId,
    providerAccountId,
    providerId: providerRow.id,
    model,
    classification,
    at: new Date(event.createdAt)
  });
}

export async function projectProviderHealthProbe(tx: PromptProxyTransaction, event: {
  tenantId: string;
  workspaceId?: string;
  createdAt: string;
  payload: Record<string, unknown>;
}) {
  const providerAccountId = stringValue(event.payload.providerAccountId);
  const providerId = stringValue(event.payload.providerId);
  const model = stringValue(event.payload.model);
  const status = stringValue(event.payload.status);
  if (!providerAccountId || !providerId || !model || event.payload.stateUpdated !== true) return;

  if (status === "success") {
    await recordHealthSuccess(tx, {
      organizationId: event.tenantId,
      workspaceId: event.workspaceId,
      providerAccountId,
      providerId,
      model,
      at: new Date(event.createdAt)
    });
    return;
  }

  const classification = providerHealthClassificationSchema.safeParse(recordValue(event.payload.classification));
  if (!classification.success) return;
  if (classification.data.scope === "provider_account") {
    await recordAccountFailure(tx, {
      organizationId: event.tenantId,
      workspaceId: event.workspaceId,
      providerAccountId,
      providerId,
      classification: classification.data,
      at: new Date(event.createdAt)
    });
    return;
  }
  if (classification.data.scope === "provider_account_model") {
    await recordModelFailure(tx, {
      organizationId: event.tenantId,
      workspaceId: event.workspaceId,
      providerAccountId,
      providerId,
      model,
      classification: classification.data,
      at: new Date(event.createdAt)
    });
  }
}

async function recordHealthSuccess(tx: PromptProxyTransaction, input: {
  organizationId: string;
  workspaceId?: string;
  providerAccountId: string;
  providerId: string;
  model: string;
  at: Date;
}) {
  await tx.insert(providerAccountHealth).values({
    id: createId("provider_account_health"),
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    providerAccountId: input.providerAccountId,
    providerId: input.providerId,
    status: "healthy",
    consecutiveFailures: 0,
    lastSuccessAt: input.at,
    lastCheckedAt: input.at,
    metadata: {}
  }).onConflictDoUpdate({
    target: [providerAccountHealth.organizationId, providerAccountHealth.providerAccountId],
    set: {
      status: "healthy",
      lastErrorType: null,
      lastErrorMessage: null,
      lastErrorAt: null,
      cooldownUntil: null,
      consecutiveFailures: 0,
      lastSuccessAt: input.at,
      lastCheckedAt: input.at,
      metadata: {}
    }
  });

  await tx.insert(providerModelHealth).values({
    id: createId("provider_model_health"),
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    providerId: input.providerId,
    providerAccountId: input.providerAccountId,
    model: input.model,
    status: "healthy",
    consecutiveFailures: 0,
    lastSuccessAt: input.at,
    metadata: {}
  }).onConflictDoUpdate({
    target: [
      providerModelHealth.organizationId,
      providerModelHealth.providerId,
      providerModelHealth.providerAccountId,
      providerModelHealth.model
    ],
    set: {
      status: "healthy",
      lastErrorType: null,
      lastErrorAt: null,
      lockoutUntil: null,
      consecutiveFailures: 0,
      lastSuccessAt: input.at,
      metadata: {}
    }
  });
}

async function recordAccountFailure(tx: PromptProxyTransaction, input: {
  organizationId: string;
  workspaceId?: string;
  providerAccountId: string;
  providerId: string;
  classification: ProviderHealthClassification;
  at: Date;
}) {
  await tx.insert(providerAccountHealth).values({
    id: createId("provider_account_health"),
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    providerAccountId: input.providerAccountId,
    providerId: input.providerId,
    status: accountStatus(input.classification),
    lastErrorType: input.classification.errorType,
    lastErrorMessage: input.classification.message,
    lastErrorAt: input.at,
    cooldownUntil: timestamp(input.classification.cooldownUntil),
    consecutiveFailures: 1,
    lastCheckedAt: input.at,
    metadata: input.classification.metadata
  }).onConflictDoUpdate({
    target: [providerAccountHealth.organizationId, providerAccountHealth.providerAccountId],
    set: {
      status: accountStatus(input.classification),
      lastErrorType: input.classification.errorType,
      lastErrorMessage: input.classification.message,
      lastErrorAt: input.at,
      cooldownUntil: timestamp(input.classification.cooldownUntil),
      consecutiveFailures: sql`${providerAccountHealth.consecutiveFailures} + 1`,
      lastCheckedAt: input.at,
      metadata: input.classification.metadata
    }
  });
}

async function recordModelFailure(tx: PromptProxyTransaction, input: {
  organizationId: string;
  workspaceId?: string;
  providerAccountId: string;
  providerId: string;
  model: string;
  classification: ProviderHealthClassification;
  at: Date;
}) {
  await tx.insert(providerModelHealth).values({
    id: createId("provider_model_health"),
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    providerId: input.providerId,
    providerAccountId: input.providerAccountId,
    model: input.model,
    status: modelStatus(input.classification),
    lastErrorType: input.classification.errorType,
    lastErrorAt: input.at,
    lockoutUntil: timestamp(input.classification.cooldownUntil),
    consecutiveFailures: 1,
    metadata: input.classification.metadata
  }).onConflictDoUpdate({
    target: [
      providerModelHealth.organizationId,
      providerModelHealth.providerId,
      providerModelHealth.providerAccountId,
      providerModelHealth.model
    ],
    set: {
      status: modelStatus(input.classification),
      lastErrorType: input.classification.errorType,
      lastErrorAt: input.at,
      lockoutUntil: timestamp(input.classification.cooldownUntil),
      consecutiveFailures: sql`${providerModelHealth.consecutiveFailures} + 1`,
      metadata: input.classification.metadata
    }
  });
}

function accountStatus(classification: ProviderHealthClassification): ProviderHealthStatus {
  if (classification.errorType === "auth_invalid") return "terminal";
  if (classification.cooldownUntil) return "cooldown";
  return "unknown";
}

function modelStatus(classification: ProviderHealthClassification): ProviderHealthStatus {
  if (classification.errorType === "model_access_denied") return "terminal";
  if (classification.cooldownUntil) return "locked_out";
  return "unknown";
}

function timestamp(value: string | null) {
  return value ? new Date(value) : null;
}

async function providerForSlug(tx: PromptProxyTransaction, organizationId: string, slug: string) {
  const [orgProvider] = await tx
    .select({ id: providers.id })
    .from(providers)
    .where(and(
      eq(providers.organizationId, organizationId),
      eq(providers.slug, slug)
    ))
    .limit(1);
  if (orgProvider) return orgProvider;
  const [builtinProvider] = await tx
    .select({ id: providers.id })
    .from(providers)
    .where(and(
      isNull(providers.organizationId),
      eq(providers.slug, slug)
    ))
    .limit(1);
  return builtinProvider;
}
