import { Buffer } from "node:buffer";

import type { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTransactionalDatabase } from "@proxy/db";

import {
  gatewayConfigCliHelp,
  parseGatewayConfigCliArgs,
  runGatewayConfigCli
} from "../src/gatewayConfigCli.js";
import type { ProxyEvent } from "../src/events.js";
import { parseGatewayConfigDocument } from "../src/persistence/gatewayConfigDocument.js";
import { GatewayConfigAdminService } from "../src/persistence/gatewayConfigAdmin.js";
import {
  applyGatewayConfig,
  applyGatewayConfigPlan,
  planGatewayConfig
} from "../src/persistence/gatewayConfigPlan.js";
import { ModelResolutionService } from "../src/persistence/modelResolution.js";
import {
  createGatewayConfig,
  setupGatewayConfig,
  type GatewayConfigFixture
} from "./gatewayConfigTestSupport.js";

describe("gateway configuration CLI", () => {
  let client: PGlite | undefined;

  afterEach(async () => {
    const current = client;
    client = undefined;
    await current?.close();
  });

  it("rejects raw secrets and code-owned IDs before opening the database", async () => {
    let opened = false;
    const output: string[] = [];
    const source = `
version = 1

[scope]
organization_id = "org_cli_invalid"
workspace_id = "workspace_cli_invalid"

[[provider_connections]]
id = "connection_operator_owned"
slug = "unsafe"
name = "Unsafe"
adapter_kind = "generic-http-json"
auth_style = "bearer"
base_url = "https://api.example.com"
secret = "raw-secret"
`;

    await expect(runGatewayConfigCli(["plan", "gateway.toml"], {
      readFile: async () => source,
      openService: async () => {
        opened = true;
        throw new Error("database should not open");
      },
      stdout: (value) => output.push(value)
    })).rejects.toThrow("invalid_gateway_config_document");

    expect(opened).toBe(false);
    expect(output).toEqual([]);

    let syntaxError: unknown;
    try {
      parseGatewayConfigDocument('secret = "must-not-echo');
    } catch (error) {
      syntaxError = error;
    }
    expect(String(syntaxError)).not.toContain("must-not-echo");
    expect(JSON.stringify(syntaxError)).not.toContain("must-not-echo");
    expect(() => parseGatewayConfigDocument(`
version = 1
[scope]
organization_id = "org_cli_invalid"
workspace_id = "workspace_cli_invalid"
[[provider_connections]]
slug = "userinfo"
name = "Userinfo"
adapter_kind = "generic-http-json"
auth_style = "bearer"
base_url = "https://api.example.com"
secret_ref = "https://user:raw-password@secrets.example.com/item"
`)).toThrow("invalid_gateway_config_document");

    await expect(runGatewayConfigCli(["plan", "gateway.toml"], {
      readFile: async () => `
version = 1
[scope]
organization_id = "org_cli_invalid"
workspace_id = "workspace_cli_invalid"
[[provider_connections]]
slug = "unsafe-config"
name = "Unsafe Config"
adapter_kind = "generic-http-json"
auth_style = "none"
base_url = "https://api.example.com"
adapter_config = { api_key = "must-not-enter-the-plan" }
`,
      openService: async () => {
        opened = true;
        throw new Error("database should not open");
      },
      stdout: (value) => output.push(value)
    })).rejects.toThrow("invalid_gateway_config_document");
    expect(opened).toBe(false);
  });

  it("plans without writes, applies through model resolution, and is idempotent", async () => {
    const fixture = await setupGatewayConfig("org_gateway_toml", () => true);
    client = fixture.client;
    const apiKeyId = `${fixture.actor.organizationId}:api-key:default`;
    const source = completeDocument(fixture.actor.organizationId, fixture.actor.workspaceId, apiKeyId);
    const output: string[] = [];
    const observedEvents: ProxyEvent[] = [];
    fixture.eventService.subscribe((event) => observedEvents.push(event));
    const dependencies = {
      readFile: async () => source,
      openService: async () => ({
        service: fixture.service,
        close: async () => undefined
      }),
      stdout: (value: string) => output.push(value)
    };

    await expect(planGatewayConfig(
      fixture.service,
      parseGatewayConfigDocument(invalidReferenceDocument(
        fixture.actor.organizationId,
        fixture.actor.workspaceId
      ))
    )).rejects.toThrow("gateway_config_reference_not_found");
    expect(observedEvents).toEqual([]);

    const unsupportedSecretService = new GatewayConfigAdminService(
      fixture.db,
      createTransactionalDatabase(fixture.db),
      fixture.eventService,
      {
        allowedPrivateUpstreamCidrs: ["10.0.0.0/8"],
        encryptionKey: Buffer.alloc(32, 7).toString("base64"),
        secretReferenceSupported: () => false
      }
    );
    await expect(planGatewayConfig(
      unsupportedSecretService,
      parseGatewayConfigDocument(source)
    )).rejects.toThrow("provider_connection_secret_reference_unsupported");
    expect(observedEvents).toEqual([]);

    await runGatewayConfigCli(["plan", "gateway.toml", "--json"], dependencies);

    const planOutput = JSON.parse(output.shift()!);
    expect(planOutput).toMatchObject({
      scope: {
        organizationId: fixture.actor.organizationId,
        workspaceId: fixture.actor.workspaceId
      },
      changeCount: 12
    });
    expect(JSON.stringify(planOutput)).not.toContain("env:ACME_GATEWAY_KEY");
    expect(await bySlug(fixture.service.providerConnections(fixture.actor), "acme-openai")).toBeUndefined();
    expect(observedEvents).toEqual([]);

    const preflight = vi.spyOn(fixture.service, "preflightCommands");
    preflight.mockClear();
    await runGatewayConfigCli([
      "apply",
      "gateway.toml",
      "--actor-user-id",
      fixture.actor.actorUserId,
      "--json"
    ], dependencies);
    expect(preflight).toHaveBeenCalledTimes(1);

    const applyOutput = JSON.parse(output.shift()!);
    expect(applyOutput.changeCount).toBe(12);
    expect(JSON.stringify(applyOutput)).not.toContain("env:ACME_GATEWAY_KEY");
    expect(observedEvents).toHaveLength(12);
    expect(observedEvents.every((event) => !event.eventType.endsWith(".enabled"))).toBe(true);
    expect(observedEvents.filter((event) => event.eventType.endsWith(".created"))).toHaveLength(11);
    expect(observedEvents.filter((event) => event.eventType.endsWith(".created")).every((event) => (
      !("status" in event.payload) || event.payload.status === "active"
    ))).toBe(true);
    const eventCount = observedEvents.length;
    const connection = await bySlug(fixture.service.providerConnections(fixture.actor), "acme-openai");
    expect(connection).toMatchObject({
      secretRef: "env:ACME_GATEWAY_KEY",
      credentialConfigured: true,
      status: "active"
    });

    const resolution = await new ModelResolutionService(fixture.db, {}).resolve({
      organizationId: fixture.actor.organizationId,
      workspaceId: fixture.actor.workspaceId,
      apiKeyId,
      ingressWireId: "openai-responses",
      operationId: "text.generate",
      requestedModel: "acme-direct",
      parameters: { max_output_tokens: 1_024 }
    });
    expect(resolution).toMatchObject({
      outcome: "resolved",
      logicalModelSlug: "acme-direct",
      upstreamModelId: "acme-model-2026-07",
      egressWireId: "openai-responses"
    });

    await runGatewayConfigCli([
      "apply",
      "gateway.toml",
      "--actor-user-id",
      fixture.actor.actorUserId,
      "--json"
    ], dependencies);

    expect(JSON.parse(output.shift()!)).toMatchObject({ changeCount: 0, changes: [] });
    expect(observedEvents).toHaveLength(eventCount);

    const originChangePlan = await planGatewayConfig(
      fixture.service,
      parseGatewayConfigDocument(source.replace("10.1.2.3", "10.1.2.4"))
    );
    expect(originChangePlan.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({
        resource: "providerConnection",
        action: "update",
        body: expect.objectContaining({ secretRef: "env:ACME_GATEWAY_KEY" })
      })
    ]));
  });

  it("rolls back earlier mutations when a stale plan fails", async () => {
    const fixture = await setupGatewayConfig("org_gateway_toml_rollback", () => true);
    client = fixture.client;
    const connectionId = await createGatewayConfig(fixture, "providerConnection", {
      slug: "rollback-provider",
      name: "Original Name",
      adapterKind: "generic-http-json",
      authStyle: "none",
      baseUrl: "http://10.20.30.40/v1",
      enabled: false
    });
    const document = parseGatewayConfigDocument(minimalRollbackDocument(
      fixture.actor.organizationId,
      fixture.actor.workspaceId
    ));
    const plan = await planGatewayConfig(fixture.service, document);
    expect(plan.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "update", resource: "providerConnection" }),
      expect.objectContaining({ action: "create", resource: "canonicalModel" })
    ]));

    const invalidIdPlan = {
      ...plan,
      commands: plan.commands.map((command) => (
        command.action === "create" && command.resource === "canonicalModel"
          ? { ...command, id: "operator_supplied_id" }
          : command
      ))
    };
    await expect(applyGatewayConfigPlan(
      fixture.service,
      invalidIdPlan,
      fixture.actor.actorUserId
    )).rejects.toThrow("gateway_config_prepared_id_invalid");
    expect(await fixture.service.providerConnection(fixture.actor, connectionId)).toMatchObject({
      name: "Original Name"
    });

    await createGatewayConfig(fixture, "canonicalModel", {
      slug: "rollback-model",
      name: "Competing Model",
      vendor: "acme",
      family: "rollback-1",
      enabled: false
    });

    await expect(applyGatewayConfigPlan(
      fixture.service,
      plan,
      fixture.actor.actorUserId
    )).rejects.toThrow("canonical_model_slug_exists");
    expect(await fixture.service.providerConnection(fixture.actor, connectionId)).toMatchObject({
      name: "Original Name"
    });
  });

  it("stages target priorities for swaps and creates into priorities being freed", async () => {
    const fixture = await configuredFixture("org_gateway_toml_priorities");
    client = fixture.client;
    const secondDeploymentId = await createActiveDeployment(fixture, "acme-secondary");
    const thirdDeploymentId = await createActiveDeployment(fixture, "acme-tertiary");
    const router = await bySlug(fixture.service.logicalModels(fixture.actor), "acme-auto");
    await createGatewayConfig(fixture, "logicalModelTarget", {
      logicalModelId: router!.id,
      deploymentId: secondDeploymentId,
      priority: 1,
      enabled: true
    });

    const swapPlan = await planGatewayConfig(fixture.service, parseGatewayConfigDocument(targetsDocument(
      fixture,
      [
        { model: "acme-auto", deployment: "acme-primary", priority: 1, enabled: true },
        { model: "acme-auto", deployment: "acme-secondary", priority: 0, enabled: true }
      ]
    )));
    const swapCommands = swapPlan.commands.filter((command) => command.resource === "logicalModelTarget");
    expect(swapCommands).toHaveLength(4);
    expect(swapCommands.slice(0, 2).every((command) => (
      command.action === "update" &&
      ![0, 1].includes((command.body as { priority: number }).priority)
    ))).toBe(true);
    expect(swapPlan.commands.some((command) => command.resource === "logicalModel")).toBe(false);
    await applyGatewayConfigPlan(fixture.service, swapPlan, fixture.actor.actorUserId);

    const swapped = await fixture.service.logicalModelTargets(fixture.actor);
    expect(swapped.find((target) => target.deploymentId === secondDeploymentId)?.priority).toBe(0);
    expect(swapped.find((target) => target.deploymentId !== secondDeploymentId && target.logicalModelId === router!.id)?.priority).toBe(1);

    const freedPriorityPlan = await planGatewayConfig(fixture.service, parseGatewayConfigDocument(targetsDocument(
      fixture,
      [
        { model: "acme-auto", deployment: "acme-primary", priority: 2, enabled: true },
        { model: "acme-auto", deployment: "acme-tertiary", priority: 1, enabled: true }
      ]
    )));
    expect(freedPriorityPlan.commands.filter((command) => command.resource === "logicalModelTarget"))
      .toHaveLength(3);
    await applyGatewayConfigPlan(fixture.service, freedPriorityPlan, fixture.actor.actorUserId);
    const finalTargets = await fixture.service.logicalModelTargets(fixture.actor);
    expect(finalTargets.find((target) => target.deploymentId === thirdDeploymentId)?.priority).toBe(1);
  });

  it("disables dependents in reverse dependency order", async () => {
    const fixture = await configuredFixture("org_gateway_toml_disable_order");
    client = fixture.client;
    const apiKeyId = `${fixture.actor.organizationId}:api-key:default`;
    const document = parseGatewayConfigDocument(
      completeDocument(fixture.actor.organizationId, fixture.actor.workspaceId, apiKeyId)
        .replaceAll("enabled = true", "enabled = false")
        .replace(/\n\[\[api_key_assignments\]\][\s\S]*$/, "\n")
    );
    const plan = await planGatewayConfig(fixture.service, document);

    expect(plan.commands.map((command) => `${command.resource}:${command.action}`)).toEqual([
      "modelGrant:setEnabled",
      "modelGrant:setEnabled",
      "logicalModel:setEnabled",
      "logicalModel:setEnabled",
      "logicalModelTarget:setEnabled",
      "logicalModelTarget:setEnabled",
      "wireBinding:setEnabled",
      "modelDeployment:setEnabled",
      "accessProfile:setEnabled",
      "canonicalModel:setEnabled",
      "providerConnection:setEnabled"
    ]);
    await applyGatewayConfigPlan(fixture.service, plan, fixture.actor.actorUserId);
    const logicalModels = (await fixture.service.logicalModels(fixture.actor))
      .filter((row) => row.slug.startsWith("acme-"));
    const logicalModelIds = new Set(logicalModels.map((row) => row.id));
    const accessProfile = await bySlug(fixture.service.accessProfiles(fixture.actor), "acme-services");
    expect(logicalModels.every((row) => row.status === "disabled")).toBe(true);
    expect((await fixture.service.logicalModelTargets(fixture.actor))
      .filter((row) => logicalModelIds.has(row.logicalModelId))
      .every((row) => !row.enabled)).toBe(true);
    expect((await fixture.service.modelGrants(fixture.actor))
      .filter((row) => row.accessProfileId === accessProfile!.id)
      .every((row) => !row.enabled)).toBe(true);
  });

  it("brackets direct target replacement with a hidden model disable and re-enable", async () => {
    const fixture = await configuredFixture("org_gateway_toml_direct_retarget");
    client = fixture.client;
    const secondDeploymentId = await createActiveDeployment(fixture, "acme-secondary");
    const direct = await bySlug(fixture.service.logicalModels(fixture.actor), "acme-direct");
    await createGatewayConfig(fixture, "logicalModelTarget", {
      logicalModelId: direct!.id,
      deploymentId: secondDeploymentId,
      priority: 1,
      enabled: false
    });
    const plan = await planGatewayConfig(fixture.service, parseGatewayConfigDocument(targetsDocument(
      fixture,
      [
        { model: "acme-direct", deployment: "acme-primary", priority: 0, enabled: false },
        { model: "acme-direct", deployment: "acme-secondary", priority: 1, enabled: true }
      ]
    )));

    expect(plan.changes).toEqual([
      expect.objectContaining({ action: "disable", resource: "logicalModelTarget" }),
      expect.objectContaining({ action: "enable", resource: "logicalModelTarget" })
    ]);
    expect(plan.commands.map((command) => (
      command.action === "setEnabled" ? `${command.resource}:${command.enabled}` : command.action
    ))).toEqual([
      "logicalModel:false",
      "logicalModelTarget:false",
      "logicalModelTarget:true",
      "logicalModel:true"
    ]);
    await applyGatewayConfigPlan(fixture.service, plan, fixture.actor.actorUserId);
    const targets = (await fixture.service.logicalModelTargets(fixture.actor))
      .filter((target) => target.logicalModelId === direct!.id);
    expect(targets.filter((target) => target.enabled)).toEqual([
      expect.objectContaining({ deploymentId: secondDeploymentId })
    ]);
    expect(await fixture.service.logicalModel(fixture.actor, direct!.id)).toMatchObject({ status: "active" });
  });

  it("validates a new direct model from final state regardless of target document order", async () => {
    const fixture = await configuredFixture("org_gateway_toml_target_order");
    client = fixture.client;
    await createActiveDeployment(fixture, "acme-secondary");
    const document = parseGatewayConfigDocument(`
version = 1
[scope]
organization_id = "${fixture.actor.organizationId}"
workspace_id = "${fixture.actor.workspaceId}"
[[logical_models]]
slug = "order-safe-direct"
name = "Order Safe Direct"
resolution_kind = "direct"
enabled = true
[[logical_model_targets]]
logical_model = "order-safe-direct"
deployment = "acme-secondary"
priority = 1
enabled = false
[[logical_model_targets]]
logical_model = "order-safe-direct"
deployment = "acme-primary"
priority = 0
enabled = true
`);

    await expect(applyGatewayConfig(
      fixture.service,
      document,
      fixture.actor.actorUserId
    )).resolves.toMatchObject({ changes: expect.any(Array) });
    const model = await bySlug(fixture.service.logicalModels(fixture.actor), "order-safe-direct");
    const targets = (await fixture.service.logicalModelTargets(fixture.actor))
      .filter((target) => target.logicalModelId === model!.id);
    expect(model).toMatchObject({ status: "active" });
    expect(targets.filter((target) => target.enabled)).toHaveLength(1);
  });

  it("defines strict, non-interactive command arguments", () => {
    expect(parseGatewayConfigCliArgs(["plan", "config.toml", "--json"])).toEqual({
      command: "plan",
      file: "config.toml",
      actorUserId: undefined,
      json: true
    });
    expect(() => parseGatewayConfigCliArgs(["apply", "config.toml"])).toThrow("invalid_gateway_config_command");
    expect(() => parseGatewayConfigCliArgs(["plan", "config.toml", "--actor-user-id", "user_1"]))
      .toThrow("invalid_gateway_config_command");
    expect(gatewayConfigCliHelp()).toContain("plan <file>");
  });
});

async function bySlug<T extends { slug: string }>(rows: Promise<T[]>, slug: string) {
  return (await rows).find((row) => row.slug === slug);
}

async function configuredFixture(organizationId: string) {
  const fixture = await setupGatewayConfig(organizationId, () => true);
  const apiKeyId = `${fixture.actor.organizationId}:api-key:default`;
  await applyGatewayConfig(
    fixture.service,
    parseGatewayConfigDocument(completeDocument(
      fixture.actor.organizationId,
      fixture.actor.workspaceId,
      apiKeyId
    )),
    fixture.actor.actorUserId
  );
  return fixture;
}

async function createActiveDeployment(fixture: GatewayConfigFixture, slug: string) {
  const canonical = await bySlug(fixture.service.canonicalModels(fixture.actor), "acme-model");
  const connection = await bySlug(fixture.service.providerConnections(fixture.actor), "acme-openai");
  return createGatewayConfig(fixture, "modelDeployment", {
    slug,
    name: slug,
    canonicalModelId: canonical!.id,
    providerConnectionId: connection!.id,
    upstreamModelId: slug,
    enabled: true
  });
}

function targetsDocument(
  fixture: GatewayConfigFixture,
  targets: Array<{ model: string; deployment: string; priority: number; enabled: boolean }>
) {
  return `
version = 1
[scope]
organization_id = "${fixture.actor.organizationId}"
workspace_id = "${fixture.actor.workspaceId}"
${targets.map((target) => `
[[logical_model_targets]]
logical_model = "${target.model}"
deployment = "${target.deployment}"
priority = ${target.priority}
enabled = ${target.enabled}
`).join("")}
`;
}

function completeDocument(organizationId: string, workspaceId: string, apiKeyId: string) {
  return `
version = 1

[scope]
organization_id = "${organizationId}"
workspace_id = "${workspaceId}"

[[provider_connections]]
slug = "acme-openai"
name = "Acme OpenAI"
adapter_kind = "generic-http-json"
auth_style = "bearer"
base_url = "http://10.1.2.3:8000/v1/"
secret_ref = "env:ACME_GATEWAY_KEY"
default_headers = { x-region = "iad" }
enabled = true

[[canonical_models]]
slug = "acme-model"
name = "Acme Model"
vendor = "acme"
family = "acme-1"
release = "2026-07"
capabilities = { tools = true, contextWindow = 200000, modalities = ["text"] }
enabled = true

[[model_deployments]]
slug = "acme-primary"
name = "Acme Primary"
canonical_model = "acme-model"
provider_connection = "acme-openai"
upstream_model_id = "acme-model-2026-07"
capabilities = { tools = false, contextWindow = 128000, modalities = ["text"] }
pricing = { inputCostPerMtok = 1 }
enabled = true

[[wire_bindings]]
deployment = "acme-primary"
api_wire = "openai-responses"
endpoint_path = "/responses"
request_config = { store = false }
enabled = true

[[logical_models]]
slug = "acme-direct"
name = "Acme Direct"
description = "Stable application model"
resolution_kind = "direct"
enabled = true

[[logical_model_targets]]
logical_model = "acme-direct"
deployment = "acme-primary"
priority = 0
enabled = true

[[logical_models]]
slug = "acme-auto"
name = "Acme Auto"
description = "Classifier-routed application model"
resolution_kind = "router"
enabled = true

[logical_models.router]
classifier_deployment = "acme-primary"
instructions = "Select exactly one eligible target."
timeout_ms = 10000
max_attempts = 2

[[logical_model_targets]]
logical_model = "acme-auto"
deployment = "acme-primary"
priority = 0
enabled = true

[[access_profiles]]
slug = "acme-services"
name = "Acme Services"
description = "Application access"
limits = { requests_per_minute = 120 }
enabled = true

[[model_grants]]
access_profile = "acme-services"
logical_model = "acme-direct"
allowed_operations = ["text.generate", "model.list"]
parameter_caps = { max_output_tokens = 8192 }
enabled = true

[[model_grants]]
access_profile = "acme-services"
logical_model = "acme-auto"
allowed_operations = ["text.generate", "model.list"]
parameter_caps = { max_output_tokens = 8192 }
enabled = true

[[api_key_assignments]]
api_key_id = "${apiKeyId}"
access_profile = "acme-services"
`;
}

function minimalRollbackDocument(organizationId: string, workspaceId: string) {
  return `
version = 1

[scope]
organization_id = "${organizationId}"
workspace_id = "${workspaceId}"

[[provider_connections]]
slug = "rollback-provider"
name = "Updated Name"
adapter_kind = "generic-http-json"
auth_style = "none"
base_url = "http://10.20.30.40/v1"
enabled = false

[[canonical_models]]
slug = "rollback-model"
name = "Rollback Model"
vendor = "acme"
family = "rollback-1"
enabled = false
`;
}

function invalidReferenceDocument(organizationId: string, workspaceId: string) {
  return `
version = 1

[scope]
organization_id = "${organizationId}"
workspace_id = "${workspaceId}"

[[model_deployments]]
slug = "missing-dependencies"
name = "Missing Dependencies"
canonical_model = "does-not-exist"
provider_connection = "also-missing"
upstream_model_id = "missing"
enabled = false
`;
}
