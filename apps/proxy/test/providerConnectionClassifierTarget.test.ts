import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createPgliteDatabase,
  defaultWorkspaceId,
  providerConnections
} from "@proxy/db";
import { seedDatabase, seedOptionsFromEnv } from "@proxy/db/seed";
import type { LogicalModelClassifierDeployment } from "../src/classifier.js";
import { ProviderConnectionClassifierTargetResolver } from "../src/persistence/providerConnectionClassifierTarget.js";
import { ProviderConnectionRuntimeTargetResolver } from "../src/persistence/providerConnectionRuntimeTarget.js";
import type { ResolvedModelTarget } from "../src/persistence/modelResolution.js";

describe("provider connection classifier target", () => {
  let client: PGlite | undefined;

  afterEach(async () => {
    await client?.close();
  });

  it("rejects private classifier URLs outside the network allowlist", async () => {
    const fixture = await setup("org_classifier_private");
    client = fixture.client;
    await fixture.db
      .update(providerConnections)
      .set({ baseUrl: "http://10.1.2.3:8000/v1" })
      .where(eq(providerConnections.id, fixture.connectionId));

    await expect(new ProviderConnectionClassifierTargetResolver(fixture.db, {
      allowedPrivateUpstreamCidrs: [],
      resolveSecretReference: () => "classifier-token"
    }).resolve(fixture.deployment)).rejects.toThrow("provider_base_url_private");
  });

  it.each([
    ["unspecified", "http://0.0.0.0:8000/v1", "provider_base_url_blocked"],
    ["mapped-loopback", "http://[::ffff:127.0.0.1]:8000/v1", "provider_base_url_private"],
    ["mapped-metadata", "http://[::ffff:169.254.169.254]:8000/v1", "provider_base_url_blocked"]
  ])("rejects %s classifier addresses before credential resolution", async (name, baseUrl, error) => {
    const fixture = await setup(`org_classifier_${name}`);
    client = fixture.client;
    await fixture.db
      .update(providerConnections)
      .set({ baseUrl })
      .where(eq(providerConnections.id, fixture.connectionId));
    const resolveSecretReference = vi.fn(() => "classifier-token");

    await expect(new ProviderConnectionClassifierTargetResolver(fixture.db, {
      allowedPrivateUpstreamCidrs: [],
      resolveSecretReference
    }).resolve(fixture.deployment)).rejects.toThrow(error);
    expect(resolveSecretReference).not.toHaveBeenCalled();
  });

  it("rejects auth-bearing default headers before classifier I/O", async () => {
    const fixture = await setup("org_classifier_headers");
    client = fixture.client;
    await fixture.db
      .update(providerConnections)
      .set({ defaultHeaders: { authorization: "Bearer injected" } })
      .where(eq(providerConnections.id, fixture.connectionId));

    await expect(new ProviderConnectionClassifierTargetResolver(fixture.db, {
      allowedPrivateUpstreamCidrs: [],
      resolveSecretReference: () => "classifier-token"
    }).resolve(fixture.deployment)).rejects.toMatchObject({
      code: "provider_default_header_forbidden"
    });
  });

  it("rejects malformed persisted adapter config for classifier and runtime targets", async () => {
    const fixture = await setup("org_classifier_adapter_config");
    client = fixture.client;
    await fixture.db
      .update(providerConnections)
      .set({ adapterConfig: { unexpected: true } })
      .where(eq(providerConnections.id, fixture.connectionId));

    await expect(new ProviderConnectionClassifierTargetResolver(fixture.db, {
      allowedPrivateUpstreamCidrs: [],
      resolveSecretReference: () => "classifier-token"
    }).resolve(fixture.deployment)).rejects.toMatchObject({
      code: "provider_adapter_config_invalid"
    });
    await expect(new ProviderConnectionRuntimeTargetResolver(fixture.db, {
      allowedPrivateUpstreamCidrs: [],
      resolveSecretReference: () => "runtime-token"
    }).resolve(
      fixture.deployment.organizationId,
      fixture.deployment.workspaceId,
      runtimeResolution(fixture.deployment)
    )).rejects.toMatchObject({
      code: "provider_adapter_config_invalid"
    });
  });

  it("rejects a malformed persisted region before resolving credentials", async () => {
    const fixture = await setup("org_classifier_region");
    client = fixture.client;
    await fixture.db
      .update(providerConnections)
      .set({ region: "US East 1!" })
      .where(eq(providerConnections.id, fixture.connectionId));
    const classifierSecret = vi.fn(() => "classifier-token");
    const runtimeSecret = vi.fn(() => "runtime-token");

    await expect(new ProviderConnectionClassifierTargetResolver(fixture.db, {
      allowedPrivateUpstreamCidrs: [],
      resolveSecretReference: classifierSecret
    }).resolve(fixture.deployment)).rejects.toMatchObject({
      code: "provider_adapter_config_invalid"
    });
    await expect(new ProviderConnectionRuntimeTargetResolver(fixture.db, {
      allowedPrivateUpstreamCidrs: [],
      resolveSecretReference: runtimeSecret
    }).resolve(
      fixture.deployment.organizationId,
      fixture.deployment.workspaceId,
      runtimeResolution(fixture.deployment)
    )).rejects.toMatchObject({
      code: "provider_adapter_config_invalid"
    });
    expect(classifierSecret).not.toHaveBeenCalled();
    expect(runtimeSecret).not.toHaveBeenCalled();
  });

  it("pins the validated address and resolves the configured secret reference", async () => {
    const fixture = await setup("org_classifier_pinned");
    client = fixture.client;
    await fixture.db
      .update(providerConnections)
      .set({
        slug: "openai-production",
        baseUrl: "http://10.1.2.3:8000/v1/",
        secretRef: "env:CLASSIFIER_TEST_TOKEN",
        capabilities: { efforts: ["low", "medium", "high"] }
      })
      .where(eq(providerConnections.id, fixture.connectionId));

    await expect(new ProviderConnectionClassifierTargetResolver(fixture.db, {
      allowedPrivateUpstreamCidrs: ["10.0.0.0/8"]
    }).resolve(fixture.deployment)).rejects.toThrow("credential is not configured");

    const target = await new ProviderConnectionClassifierTargetResolver(fixture.db, {
      allowedPrivateUpstreamCidrs: ["10.0.0.0/8"],
      resolveSecretReference: (input) => (
        input.reference === "env:CLASSIFIER_TEST_TOKEN" &&
        input.provider === "openai" &&
        input.baseUrl === "http://10.1.2.3:8000/v1"
          ? "classifier-token"
          : undefined
      )
    }).resolve(fixture.deployment);

    expect(target.provider.pinnedAddress).toEqual({
      hostname: "10.1.2.3",
      address: "10.1.2.3",
      family: 4
    });
    expect(target.provider.baseUrl).toBe("http://10.1.2.3:8000/v1");
    expect(target.provider).toMatchObject({
      provider: "openai",
      slug: "openai-production",
      capabilities: {
        efforts: ["low", "medium", "high"],
        promptCaching: expect.objectContaining({ usageShape: "openai" })
      }
    });
    expect(target.credential).toEqual(expect.objectContaining({
      provider: "openai-production",
      token: "classifier-token",
      providerConnectionId: fixture.connectionId,
      baseUrl: "http://10.1.2.3:8000/v1",
      pinnedAddress: target.provider.pinnedAddress
    }));
  });
});

async function setup(organizationId: string) {
  const client = await migratedClient();
  const db = createPgliteDatabase(client);
  await seedDatabase(db, seedOptionsFromEnv({
    DEFAULT_ORGANIZATION_ID: organizationId,
    SEED_USER_ID: `user_${organizationId}`,
    PROXY_TOKEN: `token_${organizationId}`
  }));
  const workspaceId = defaultWorkspaceId(organizationId);
  const connectionId = `${workspaceId}:connection:openai`;
  const deploymentId = `${workspaceId}:deployment:openai:gpt-5-nano-2025-08-07`;
  return {
    client,
    db,
    connectionId,
    deployment: {
      organizationId,
      workspaceId,
      deploymentId,
      provider: "openai",
      providerConnectionId: connectionId,
      bindingId: `${deploymentId}:wire:openai-responses`,
      model: "gpt-5-nano-2025-08-07"
    } satisfies LogicalModelClassifierDeployment
  };
}

function runtimeResolution(deployment: LogicalModelClassifierDeployment): ResolvedModelTarget {
  return {
    outcome: "resolved",
    accessProfileId: "profile_adapter_config",
    logicalModelId: "logical_model_adapter_config",
    logicalModelSlug: "coding-auto",
    routerKind: null,
    deploymentId: deployment.deploymentId,
    upstreamModelId: deployment.model,
    providerConnectionId: deployment.providerConnectionId,
    bindingId: deployment.bindingId,
    egressWireId: "openai-responses",
    endpointPath: "/responses",
    providerAdapterKind: "generic-http-json",
    providerAdapterContractVersion: "1",
    wireAdapterId: null,
    wireAdapterVersion: null,
    routerDecisionId: null,
    routerDecision: null,
    parameterCaps: {}
  };
}

async function migratedClient() {
  const client = new PGlite();
  const migrationsDir = fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url));
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) await client.exec(await readFile(join(migrationsDir, file), "utf8"));
  return client;
}
