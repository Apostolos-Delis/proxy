import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  accessProfileModelGrants,
  accessProfiles,
  canonicalModels,
  defaultWorkspaceId,
  deploymentWireBindings,
  logicalModels,
  logicalModelTargets,
  modelDeployments,
  providerConnections
} from "@proxy/db";

import { openAIResponsesSurface } from "../src/adapters.js";
import { contextForIdentity, type RequestIdentity } from "../src/auth.js";
import { GatewayRuntime, gatewayRequestBody } from "../src/gatewayRuntime.js";
import type { ResolvedModelTarget } from "../src/persistence/modelResolution.js";

import { captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

describe("logical-model Bedrock runtime", () => {
  let fixture: PromptTestFixture | undefined;

  afterEach(async () => {
    await fixture?.close();
  });

  it("resolves the seeded platform connection through the AWS default chain", async () => {
    const organizationId = "org_gateway_runtime_bedrock";
    const workspaceId = defaultWorkspaceId(organizationId);
    fixture = await captureFixture(organizationId, "hash_only");
    const [connection] = await fixture.db
      .select({ id: providerConnections.id })
      .from(providerConnections)
      .where(eq(providerConnections.slug, "amazon-bedrock"))
      .limit(1);
    const canonicalModelId = `${workspaceId}:canonical:bedrock-test`;
    const deploymentId = `${workspaceId}:deployment:bedrock-test`;
    const bindingId = `${deploymentId}:wire:bedrock-converse`;
    await fixture.db.insert(canonicalModels).values({
      id: canonicalModelId,
      organizationId,
      workspaceId,
      slug: "bedrock-test",
      name: "Bedrock Test",
      vendor: "amazon-bedrock",
      family: "nova",
      capabilities: {},
      status: "active"
    });
    await fixture.db.insert(modelDeployments).values({
      id: deploymentId,
      organizationId,
      workspaceId,
      slug: "bedrock-test",
      name: "Bedrock Test",
      canonicalModelId,
      providerConnectionId: connection!.id,
      upstreamModelId: "amazon.nova-pro-v1:0",
      capabilities: {},
      pricing: {},
      config: {},
      status: "active"
    });
    await fixture.db.insert(deploymentWireBindings).values({
      id: bindingId,
      organizationId,
      workspaceId,
      deploymentId,
      providerConnectionId: connection!.id,
      apiWireId: "bedrock-converse",
      endpointPath: null,
      adapterContractVersion: "1",
      requestConfig: {},
      enabled: true
    });
    const resolution: ResolvedModelTarget = {
      outcome: "resolved",
      accessProfileId: `${workspaceId}:access-profile:opendoor-engineer`,
      logicalModelId: `${workspaceId}:logical-model:bedrock-test`,
      logicalModelSlug: "bedrock-test",
      routerKind: null,
      deploymentId,
      upstreamModelId: "amazon.nova-pro-v1:0",
      providerConnectionId: connection!.id,
      bindingId,
      egressWireId: "bedrock-converse",
      endpointPath: null,
      providerAdapterKind: "aws-bedrock-converse",
      providerAdapterContractVersion: "1",
      wireAdapterId: null,
      wireAdapterVersion: null,
      routerDecisionId: null,
      routerDecision: null,
      parameterCaps: {}
    };

    const target = await fixture.persistence.providerConnectionRuntimeTargets.resolve(
      organizationId,
      workspaceId,
      resolution
    );

    expect(target.providerEntry).toMatchObject({
      slug: "amazon-bedrock",
      authStyle: "aws-sdk",
      builtin: true,
      adapterConfig: {
        defaultRegion: "us-east-1",
        credentialMode: "aws_default_chain",
        region: "us-east-1"
      }
    });
    expect(target.credential).toMatchObject({
      token: "",
      providerConnectionId: connection!.id,
      connectionSettings: {
        defaultRegion: "us-east-1",
        credentialMode: "aws_default_chain",
        region: "us-east-1"
      }
    });

    const [fable] = await fixture.db
      .select({ id: logicalModels.id })
      .from(logicalModels)
      .where(eq(logicalModels.slug, "fable"))
      .limit(1);
    const [profile] = await fixture.db
      .select({ id: accessProfiles.id })
      .from(accessProfiles)
      .where(eq(accessProfiles.slug, "opendoor-engineer"))
      .limit(1);
    await fixture.db
      .update(logicalModelTargets)
      .set({ deploymentId })
      .where(eq(logicalModelTargets.logicalModelId, fable!.id));
    await fixture.db
      .update(accessProfileModelGrants)
      .set({ parameterCaps: { max_output_tokens: 128 } })
      .where(and(
        eq(accessProfileModelGrants.accessProfileId, profile!.id),
        eq(accessProfileModelGrants.logicalModelId, fable!.id)
      ));
    await fixture.db
      .update(modelDeployments)
      .set({
        config: {
          maxOutputTokens: 64,
          metadata: {
            owner: "gateway-runtime-test",
            bedrockConverse: {
              requestMetadata: { request: "bedrock-test", ignored: 42 },
              guardrailIdentifier: "guardrail-test",
              guardrailVersion: "1",
              guardrailTrace: "enabled",
              serviceTier: "optimized",
              additionalModelRequestFields: { top_k: 40 }
            }
          }
        }
      })
      .where(eq(modelDeployments.id, deploymentId));
    await fixture.db
      .update(deploymentWireBindings)
      .set({ requestConfig: { inferenceConfig: { maxTokens: 96 } } })
      .where(eq(deploymentWireBindings.id, bindingId));

    const runtime = new GatewayRuntime(
      fixture.persistence.modelResolution,
      fixture.persistence.providerConnectionRuntimeTargets
    );
    const identity: RequestIdentity = {
      organizationId,
      workspaceId,
      userId: "local-user",
      apiKeyId: `${organizationId}:api-key:default`,
      accessProfileId: profile!.id,
      accessProfileLimits: {},
      source: "api_key"
    };
    const body = { model: "fable", input: "Use Bedrock", max_output_tokens: 32 };
    const context = contextForIdentity(openAIResponsesSurface.buildContext(body, {}), identity);
    const gatewayResolution = await runtime.resolve({
      identity,
      context,
      ingressWireId: "openai-responses",
      operationId: "text.generate",
      body
    });
    expect(gatewayResolution).toMatchObject({ outcome: "resolved" });
    if (gatewayResolution.outcome === "denied") throw new Error(gatewayResolution.code);
    const runtimeTarget = await runtime.materialize(identity, gatewayResolution);
    const allowedBody = gatewayRequestBody({
      body,
      ingressWireId: "openai-responses",
      operationId: "text.generate",
      target: runtimeTarget
    });
    expect(allowedBody).toMatchObject({
      inferenceConfig: { maxTokens: 96 },
      requestMetadata: { request: "bedrock-test" },
      guardrailConfig: {
        guardrailIdentifier: "guardrail-test",
        guardrailVersion: "1",
        trace: "enabled"
      },
      performanceConfig: { latency: "optimized" },
      additionalModelRequestFields: { top_k: 40 }
    });
    expect(allowedBody).not.toHaveProperty("metadata");

    await fixture.db
      .update(deploymentWireBindings)
      .set({ requestConfig: { inferenceConfig: { maxTokens: 256 } } })
      .where(eq(deploymentWireBindings.id, bindingId));
    const denied = await runtime.resolve({
      identity,
      context,
      ingressWireId: "openai-responses",
      operationId: "text.generate",
      body
    });
    expect(denied).toMatchObject({ outcome: "denied", code: "parameter_cap_exceeded" });
  });
});
