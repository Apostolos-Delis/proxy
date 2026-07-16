import WebSocket from "ws";

import { and, eq } from "drizzle-orm";

import {
  deploymentWireBindings,
  logicalModels,
  logicalModelTargets,
  modelDeployments,
  providerConnections
} from "@proxy/db";

import type { PromptTestFixture } from "./promptTestFixture.js";

export function gatewayHeaders(token: string) {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json"
  };
}

export function postJson(url: string, headers: Record<string, string>, body: unknown) {
  return fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
}

export async function logicalTarget(
  fixture: PromptTestFixture,
  logicalSlug: string,
  providerSlug: string
) {
  const [target] = await fixture.db
    .select({
      targetId: logicalModelTargets.id,
      deploymentId: modelDeployments.id,
      providerConnectionId: providerConnections.id,
      upstreamModelId: modelDeployments.upstreamModelId,
      bindingId: deploymentWireBindings.id
    })
    .from(logicalModelTargets)
    .innerJoin(logicalModels, and(
      eq(logicalModels.id, logicalModelTargets.logicalModelId),
      eq(logicalModels.workspaceId, logicalModelTargets.workspaceId)
    ))
    .innerJoin(modelDeployments, and(
      eq(modelDeployments.id, logicalModelTargets.deploymentId),
      eq(modelDeployments.workspaceId, logicalModelTargets.workspaceId)
    ))
    .innerJoin(providerConnections, and(
      eq(providerConnections.id, modelDeployments.providerConnectionId),
      eq(providerConnections.workspaceId, modelDeployments.workspaceId)
    ))
    .innerJoin(deploymentWireBindings, and(
      eq(deploymentWireBindings.deploymentId, modelDeployments.id),
      eq(deploymentWireBindings.workspaceId, modelDeployments.workspaceId)
    ))
    .where(and(
      eq(logicalModels.slug, logicalSlug),
      eq(providerConnections.slug, providerSlug)
    ))
    .limit(1);
  if (!target) throw new Error("logical target fixture unavailable");
  return target;
}

export function opened(socket: WebSocket) {
  return new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
}

export function nextMessage(socket: WebSocket, predicate: (message: string) => boolean) {
  return new Promise<string>((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData) => {
      const message = String(data);
      if (!predicate(message)) return;
      socket.off("error", onError);
      socket.off("message", onMessage);
      resolve(message);
    };
    const onError = (error: Error) => {
      socket.off("message", onMessage);
      reject(error);
    };
    socket.on("message", onMessage);
    socket.once("error", onError);
  });
}

export function dropLegacyRuntimeTables(fixture: PromptTestFixture) {
  return fixture.client.exec(`
    drop table if exists api_key_provider_accounts cascade;
    drop table if exists model_catalog cascade;
    drop table if exists provider_accounts cascade;
    drop table if exists providers cascade;
    drop table if exists routing_config_versions cascade;
    drop table if exists routing_configs cascade;
  `);
}
