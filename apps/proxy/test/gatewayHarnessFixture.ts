import { and, eq } from "drizzle-orm";

import {
  accessProfiles,
  apiKeys,
  canonicalModels,
  defaultWorkspaceId,
  deploymentWireBindings,
  hashApiKey,
  logicalModels,
  logicalModelTargets,
  modelDeployments,
  providerConnections
} from "@proxy/db";
import type { Dialect } from "@proxy/schema";

import type { PromptTestFixture } from "./promptTestFixture.js";

export type HarnessGatewayTarget = {
  secret: string;
  slug: string;
  provider: string;
  model: string;
  config: Record<string, unknown>;
  wires: { dialect: Dialect; path: string }[];
  connection?: {
    baseUrl: string;
    forwardHarnessHeaders?: boolean;
  };
};

export async function assignHarnessGatewayTarget(
  fixture: PromptTestFixture,
  organizationId: string,
  input: HarnessGatewayTarget
) {
  const workspaceId = defaultWorkspaceId(organizationId);
  let [connection] = await fixture.db
    .select({ id: providerConnections.id })
    .from(providerConnections)
    .where(and(
      eq(providerConnections.organizationId, organizationId),
      eq(providerConnections.workspaceId, workspaceId),
      eq(providerConnections.slug, input.provider)
    ))
    .limit(1);
  if (!connection) {
    if (!input.connection) throw new Error(`Missing fixture provider connection: ${input.provider}`);
    const id = `${workspaceId}:connection:${input.provider}`;
    await fixture.db.insert(providerConnections).values({
      id,
      organizationId,
      workspaceId,
      slug: input.provider,
      name: input.provider,
      adapterKind: "generic-http-json",
      authStyle: "none",
      baseUrl: input.connection.baseUrl,
      adapterConfig: {},
      forwardHarnessHeaders: input.connection.forwardHarnessHeaders ?? false,
      defaultHeaders: {},
      status: "active"
    });
    connection = { id };
  }

  const canonicalModelId = `${workspaceId}:harness:${input.slug}:canonical`;
  const deploymentId = `${workspaceId}:harness:${input.slug}:deployment`;
  await fixture.db.insert(canonicalModels).values({
    id: canonicalModelId,
    organizationId,
    workspaceId,
    slug: `harness-${input.slug}`,
    name: input.model,
    vendor: input.provider,
    family: input.model,
    capabilities: {},
    status: "active"
  });
  await fixture.db.insert(modelDeployments).values({
    id: deploymentId,
    organizationId,
    workspaceId,
    slug: `harness-${input.slug}`,
    name: input.model,
    canonicalModelId,
    providerConnectionId: connection.id,
    upstreamModelId: input.model,
    config: input.config,
    capabilities: {},
    pricing: {},
    status: "active"
  });
  if (input.wires.length > 0) {
    await fixture.db.insert(deploymentWireBindings).values(input.wires.map((wire) => ({
      id: `${deploymentId}:wire:${wire.dialect}`,
      organizationId,
      workspaceId,
      deploymentId,
      providerConnectionId: connection.id,
      apiWireId: wire.dialect,
      endpointPath: wire.path,
      requestConfig: {},
      adapterContractVersion: "1" as const,
      enabled: true
    })));
  }

  const [logicalModel] = await fixture.db
    .select({ id: logicalModels.id })
    .from(logicalModels)
    .where(and(
      eq(logicalModels.organizationId, organizationId),
      eq(logicalModels.workspaceId, workspaceId),
      eq(logicalModels.slug, "fable")
    ))
    .limit(1);
  const [accessProfile] = await fixture.db
    .select({ id: accessProfiles.id })
    .from(accessProfiles)
    .where(and(
      eq(accessProfiles.organizationId, organizationId),
      eq(accessProfiles.workspaceId, workspaceId),
      eq(accessProfiles.slug, "opendoor-engineer")
    ))
    .limit(1);
  if (!logicalModel || !accessProfile) throw new Error("Missing seeded gateway fixture resources");

  await fixture.db.delete(logicalModelTargets).where(and(
    eq(logicalModelTargets.organizationId, organizationId),
    eq(logicalModelTargets.workspaceId, workspaceId),
    eq(logicalModelTargets.logicalModelId, logicalModel.id)
  ));
  await fixture.db.insert(logicalModelTargets).values({
    id: `${logicalModel.id}:target:${input.slug}`,
    organizationId,
    workspaceId,
    logicalModelId: logicalModel.id,
    deploymentId,
    priority: 0,
    enabled: true
  });
  await fixture.db.insert(apiKeys).values({
    id: `api_key_${input.slug}`,
    organizationId,
    workspaceId,
    keyHash: hashApiKey(input.secret),
    name: "Harness compatibility key",
    accessProfileId: accessProfile.id
  });
}
