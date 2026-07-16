import { and, eq, sql } from "drizzle-orm";

import {
  defaultWorkspaceId,
  deploymentHealth,
  providerConnectionHealth,
  type ProxyTransaction
} from "@proxy/db";
import {
  providerHealthClassificationSchema,
  type ProviderHealthClassification,
  type ProviderHealthStatus
} from "@proxy/schema";

import type { ProxyEvent } from "../events.js";
import { gatewayProviderAttemptEvidenceValue } from "../gatewayEvidence.js";
import { createId } from "../util.js";
import { recordValue } from "./values.js";

export async function projectProviderHealthTerminal(tx: ProxyTransaction, event: ProxyEvent) {
  const evidence = gatewayProviderAttemptEvidenceValue(event.payload);
  if (!evidence) return;
  const workspaceId = event.workspaceId ?? defaultWorkspaceId(event.tenantId);
  const occurredAt = new Date(event.createdAt);

  if (event.eventType === "provider.response_completed") {
    await markConnectionHealthy(tx, {
      organizationId: event.tenantId,
      workspaceId,
      providerConnectionId: evidence.providerConnectionId,
      occurredAt
    });
    await markDeploymentHealthy(tx, {
      organizationId: event.tenantId,
      workspaceId,
      deploymentId: evidence.deploymentId,
      providerConnectionId: evidence.providerConnectionId,
      occurredAt,
      stream: event.payload.stream === true
    });
    return;
  }

  const classification = providerHealthClassificationSchema.safeParse(
    recordValue(event.payload.healthClassification)
  );
  if (!classification.success || classification.data.scope === "request_only") return;
  if (classification.data.scope === "provider_connection") {
    await markConnectionFailure(tx, {
      organizationId: event.tenantId,
      workspaceId,
      providerConnectionId: evidence.providerConnectionId,
      classification: classification.data,
      occurredAt
    });
    return;
  }
  await markDeploymentFailure(tx, {
    organizationId: event.tenantId,
    workspaceId,
    deploymentId: evidence.deploymentId,
    providerConnectionId: evidence.providerConnectionId,
    classification: classification.data,
    occurredAt
  });
}

async function markConnectionHealthy(
  tx: ProxyTransaction,
  input: {
    organizationId: string;
    workspaceId: string;
    providerConnectionId: string;
    occurredAt: Date;
  }
) {
  await tx.insert(providerConnectionHealth).values({
    id: createId("provider_connection_health"),
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    providerConnectionId: input.providerConnectionId,
    status: "healthy",
    lastSuccessAt: input.occurredAt,
    lastCheckedAt: input.occurredAt
  }).onConflictDoUpdate({
    target: [
      providerConnectionHealth.organizationId,
      providerConnectionHealth.workspaceId,
      providerConnectionHealth.providerConnectionId
    ],
    set: {
      status: "healthy",
      lastErrorType: null,
      lastErrorMessage: null,
      lastErrorAt: null,
      cooldownUntil: null,
      consecutiveFailures: 0,
      lastSuccessAt: input.occurredAt,
      lastCheckedAt: input.occurredAt,
      metadata: {}
    }
  });
}

async function markDeploymentHealthy(
  tx: ProxyTransaction,
  input: {
    organizationId: string;
    workspaceId: string;
    deploymentId: string;
    providerConnectionId: string;
    occurredAt: Date;
    stream: boolean;
  }
) {
  const [existing] = await tx
    .select({
      lastErrorType: deploymentHealth.lastErrorType,
      metadata: deploymentHealth.metadata
    })
    .from(deploymentHealth)
    .where(and(
      eq(deploymentHealth.organizationId, input.organizationId),
      eq(deploymentHealth.workspaceId, input.workspaceId),
      eq(deploymentHealth.deploymentId, input.deploymentId)
    ))
    .limit(1);
  if (!input.stream && isStreamPermissionHealth(existing?.lastErrorType, recordValue(existing?.metadata))) {
    return;
  }
  await tx.insert(deploymentHealth).values({
    id: createId("deployment_health"),
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    deploymentId: input.deploymentId,
    providerConnectionId: input.providerConnectionId,
    status: "healthy",
    lastSuccessAt: input.occurredAt
  }).onConflictDoUpdate({
    target: [
      deploymentHealth.organizationId,
      deploymentHealth.workspaceId,
      deploymentHealth.deploymentId
    ],
    set: {
      providerConnectionId: input.providerConnectionId,
      status: "healthy",
      lastErrorType: null,
      lastErrorAt: null,
      lockoutUntil: null,
      consecutiveFailures: 0,
      lastSuccessAt: input.occurredAt,
      metadata: {}
    }
  });
}

async function markConnectionFailure(
  tx: ProxyTransaction,
  input: {
    organizationId: string;
    workspaceId: string;
    providerConnectionId: string;
    classification: ProviderHealthClassification;
    occurredAt: Date;
  }
) {
  const status = healthStatus(input.classification, "cooldown");
  const cooldownUntil = dateValue(input.classification.cooldownUntil);
  await tx.insert(providerConnectionHealth).values({
    id: createId("provider_connection_health"),
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    providerConnectionId: input.providerConnectionId,
    status,
    lastErrorType: input.classification.errorType,
    lastErrorMessage: input.classification.message,
    lastErrorAt: input.occurredAt,
    cooldownUntil,
    consecutiveFailures: 1,
    lastCheckedAt: input.occurredAt,
    metadata: input.classification.metadata
  }).onConflictDoUpdate({
    target: [
      providerConnectionHealth.organizationId,
      providerConnectionHealth.workspaceId,
      providerConnectionHealth.providerConnectionId
    ],
    set: {
      status,
      lastErrorType: input.classification.errorType,
      lastErrorMessage: input.classification.message,
      lastErrorAt: input.occurredAt,
      cooldownUntil,
      consecutiveFailures: sql`${providerConnectionHealth.consecutiveFailures} + 1`,
      lastCheckedAt: input.occurredAt,
      metadata: input.classification.metadata
    }
  });
}

async function markDeploymentFailure(
  tx: ProxyTransaction,
  input: {
    organizationId: string;
    workspaceId: string;
    deploymentId: string;
    providerConnectionId: string;
    classification: ProviderHealthClassification;
    occurredAt: Date;
  }
) {
  const status = healthStatus(input.classification, "locked_out");
  const lockoutUntil = dateValue(input.classification.cooldownUntil);
  await tx.insert(deploymentHealth).values({
    id: createId("deployment_health"),
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    deploymentId: input.deploymentId,
    providerConnectionId: input.providerConnectionId,
    status,
    lastErrorType: input.classification.errorType,
    lastErrorAt: input.occurredAt,
    lockoutUntil,
    consecutiveFailures: 1,
    metadata: input.classification.metadata
  }).onConflictDoUpdate({
    target: [
      deploymentHealth.organizationId,
      deploymentHealth.workspaceId,
      deploymentHealth.deploymentId
    ],
    set: {
      providerConnectionId: input.providerConnectionId,
      status,
      lastErrorType: input.classification.errorType,
      lastErrorAt: input.occurredAt,
      lockoutUntil,
      consecutiveFailures: sql`${deploymentHealth.consecutiveFailures} + 1`,
      metadata: input.classification.metadata
    }
  });
}

function healthStatus(
  classification: ProviderHealthClassification,
  cooldownStatus: Extract<ProviderHealthStatus, "cooldown" | "locked_out">
): ProviderHealthStatus {
  return classification.cooldownUntil ? cooldownStatus : "terminal";
}

function dateValue(value: string | null) {
  return value ? new Date(value) : null;
}

export function isStreamPermissionHealth(
  errorType: string | null | undefined,
  metadata: Record<string, unknown> | null | undefined
) {
  return errorType === "stream_permission_denied" || metadata?.bedrockErrorKind === "stream_permission_denied";
}
