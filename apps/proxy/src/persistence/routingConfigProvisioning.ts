import { createHash } from "node:crypto";

import { and, eq } from "drizzle-orm";

import {
  routingConfigs,
  routingConfigVersions,
  workspaces,
  type ProxyTransaction
} from "@proxy/db";
import { routingConfigSchema, type RoutingConfig } from "@proxy/schema";

import { createId } from "../util.js";
import { appendAdminAuditEvent } from "./adminAudit.js";

// New workspaces clone the organization's seeded default config so they start
// with the same models/tiers/classifier instead of an empty routing surface
// that traffic and the create-config UI both dead-end on.
function seededDefaultRoutingConfigId(organizationId: string) {
  return `${organizationId}:routing-config:default`;
}

// Shared by workspace creation and the self-heal access path so both provision
// identically. Returns null when there is nothing to do (workspace already has
// a config) or nothing to clone from (organization was never seeded).
export async function ensureWorkspaceDefaultRoutingConfig(
  tx: ProxyTransaction,
  input: { organizationId: string; workspaceId: string; actorUserId: string }
): Promise<{ configId: string; versionId: string } | null> {
  const [existing] = await tx
    .select({ id: routingConfigs.id })
    .from(routingConfigs)
    .where(and(
      eq(routingConfigs.organizationId, input.organizationId),
      eq(routingConfigs.workspaceId, input.workspaceId)
    ))
    .limit(1);
  if (existing) return null;

  const source = await sourceConfig(tx, input.organizationId);
  if (!source) return null;

  const now = new Date();
  const configId = createId("routing_config");
  const versionId = createId("routing_config_version");
  const hash = configHash(source);

  await tx.insert(routingConfigs).values({
    id: configId,
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    name: "Default routing config",
    slug: "default",
    description: "Cloned from the organization default routing config.",
    status: "active",
    createdAt: now,
    updatedAt: now
  });
  await tx.insert(routingConfigVersions).values({
    id: versionId,
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    routingConfigId: configId,
    version: 1,
    configHash: hash,
    config: source,
    status: "active",
    createdByUserId: input.actorUserId,
    createdAt: now,
    activatedAt: now
  });
  await tx
    .update(routingConfigs)
    .set({ activeVersionId: versionId, updatedAt: now })
    .where(and(
      eq(routingConfigs.organizationId, input.organizationId),
      eq(routingConfigs.workspaceId, input.workspaceId),
      eq(routingConfigs.id, configId)
    ));
  await tx
    .update(workspaces)
    .set({ defaultRoutingConfigId: configId, updatedAt: now })
    .where(eq(workspaces.id, input.workspaceId));

  await appendAdminAuditEvent(tx, {
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    scopeType: "routing_config",
    scopeId: configId,
    correlationId: versionId,
    actorUserId: input.actorUserId,
    producer: "proxy.admin.routing-configs",
    eventType: "routing_config.created",
    payload: { configId, versionId, version: 1, configHash: hash, slug: "default", status: "active" },
    createdAt: now
  });
  await appendAdminAuditEvent(tx, {
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    scopeType: "routing_config",
    scopeId: configId,
    correlationId: versionId,
    actorUserId: input.actorUserId,
    producer: "proxy.admin.routing-configs",
    eventType: "routing_config.version_created",
    payload: { configId, versionId, version: 1, configHash: hash, status: "active" },
    createdAt: now
  });

  return { configId, versionId };
}

async function sourceConfig(tx: ProxyTransaction, organizationId: string): Promise<RoutingConfig | null> {
  const [row] = await tx
    .select({ config: routingConfigVersions.config })
    .from(routingConfigs)
    .innerJoin(routingConfigVersions, and(
      eq(routingConfigVersions.organizationId, routingConfigs.organizationId),
      eq(routingConfigVersions.routingConfigId, routingConfigs.id),
      eq(routingConfigVersions.id, routingConfigs.activeVersionId)
    ))
    .where(and(
      eq(routingConfigs.organizationId, organizationId),
      eq(routingConfigs.id, seededDefaultRoutingConfigId(organizationId)),
      eq(routingConfigs.status, "active")
    ))
    .limit(1);
  if (!row) return null;
  const parsed = routingConfigSchema.safeParse(row.config);
  return parsed.success ? parsed.data : null;
}

function configHash(config: RoutingConfig) {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}
