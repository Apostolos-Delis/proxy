import WebSocket from "ws";

import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  accessProfileModelGrants,
  accessProfiles,
  defaultWorkspaceId,
  deploymentWireBindings,
  events as eventRows,
  logicalModels,
  logicalModelTargets,
  modelDeployments,
  requests,
  routeDecisions,
  usageLedger
} from "@proxy/db";

import {
  gatewayHeaders,
  logicalTarget,
  nextMessage,
  opened,
  postJson
} from "./gatewayRuntimeTestHelpers.js";
import { adminGql, captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

describe("logical-model gateway runtime", () => {
  let fixture: PromptTestFixture | undefined;

  afterEach(async () => {
    await fixture?.close();
  });

  it("uses one direct resolver path for Responses, Chat, Messages, streaming, and token counting", async () => {
    fixture = await captureFixture("org_gateway_runtime_direct", "hash_only", false, {
      anthropicOptions: { outputText: "gateway answer" }
    });
    const headers = gatewayHeaders("proxy-token");

    const modelsResponse = await fetch(`${fixture.proxyUrl}/v1/models`, { headers });
    expect(modelsResponse.status).toBe(200);
    const models = await modelsResponse.json() as { data: { id: string }[] };
    expect(models.data.map((model) => model.id)).toEqual([
      "coding-auto",
      "economy-auto",
      "fable"
    ]);

    const responses = await postJson(`${fixture.proxyUrl}/v1/responses`, headers, {
      model: "fable",
      input: "Explain the result",
      stream: true
    });
    expect(responses.status).toBe(200);
    expect(await responses.text()).toContain("response.completed");

    const chat = await postJson(`${fixture.proxyUrl}/v1/chat/completions`, headers, {
      model: "fable",
      messages: [{ role: "user", content: "Explain the result" }],
      stream: true
    });
    expect(chat.status).toBe(200);
    expect(await chat.text()).toContain("[DONE]");

    const messages = await postJson(`${fixture.proxyUrl}/v1/messages`, headers, {
      model: "fable",
      max_tokens: 256,
      messages: [{ role: "user", content: "Explain the result" }],
      stream: true
    });
    const messagesText = await messages.text();
    expect(messages.status, messagesText).toBe(200);
    expect(messagesText).toContain("message_stop");

    const count = await postJson(`${fixture.proxyUrl}/v1/messages/count_tokens`, headers, {
      model: "fable",
      messages: [{ role: "user", content: "Count this" }]
    });
    expect(count.status).toBe(200);
    await expect(count.json()).resolves.toEqual({ input_tokens: 42 });

    expect(fixture.anthropic.records).toHaveLength(4);
    expect(fixture.anthropic.records.map((record) => record.body.model)).toEqual([
      "claude-fable-5",
      "claude-fable-5",
      "claude-fable-5",
      "claude-fable-5"
    ]);
    expect(fixture.anthropic.records.map((record) => record.body.max_tokens)).toEqual([
      4096,
      4096,
      256,
      undefined
    ]);
    const persisted = await fixture.db
      .select({
        requestedLogicalModel: requests.requestedLogicalModel,
        resolvedLogicalModelId: requests.resolvedLogicalModelId,
        deploymentId: requests.deploymentId,
        providerConnectionId: requests.providerConnectionId,
        egressWireId: requests.egressWireId,
        wireAdapterVersion: requests.wireAdapterVersion
      })
      .from(requests)
      .where(eq(requests.requestedLogicalModel, "fable"));
    expect(persisted).toHaveLength(4);
    expect(persisted.every((row) => (
      row.resolvedLogicalModelId?.endsWith(":logical-model:fable") &&
      row.deploymentId?.includes(":deployment:anthropic:claude-fable-5") &&
      row.providerConnectionId?.endsWith(":connection:anthropic") &&
      row.egressWireId === "anthropic-messages"
    ))).toBe(true);
    expect(persisted.filter((row) => row.wireAdapterVersion === "1")).toHaveLength(2);
  });

  it("routes coding-auto through the bounded classifier for HTTP and WebSocket", async () => {
    const classifierOutput: Record<string, unknown> = {
      target_id: "pending",
      reason_codes: ["capability_match"],
      confidence: 0.91
    };
    fixture = await captureFixture("org_gateway_runtime_classifier", "hash_only", false, {
      openAIOptions: {
        classifierOutput,
        classifierResponsesShape: true,
        classifierUsage: {
          input_tokens: 17,
          output_tokens: 3,
          total_tokens: 20
        },
        outputText: "classified answer"
      }
    });
    await fixture.db
      .update(modelDeployments)
      .set({ pricing: { inputCostPerMtok: 2, outputCostPerMtok: 10 } })
      .where(eq(
        modelDeployments.id,
        `${defaultWorkspaceId("org_gateway_runtime_classifier")}:deployment:openai:route-classifier-cheap`
      ));
    const target = await logicalTarget(fixture, "coding-auto", "openai");
    classifierOutput.target_id = target.targetId;

    const response = await postJson(
      `${fixture.proxyUrl}/v1/responses`,
      gatewayHeaders("proxy-token"),
      { model: "coding-auto", input: "Fix the failing auth test", stream: true }
    );
    const responseText = await response.text();
    expect(response.status, responseText).toBe(200);
    expect(responseText).toContain("response.completed");

    const socket = new WebSocket(
      fixture.proxyUrl.replace("http://", "ws://") + "/v1/responses",
      { headers: { authorization: "Bearer proxy-token" } }
    );
    await opened(socket);
    const completed = nextMessage(socket, (message) => message.includes("response.completed"));
    socket.send(JSON.stringify({
      type: "response.create",
      model: "coding-auto",
      input: "Continue fixing the auth test",
      stream: true
    }));
    expect(await completed).toContain("response.completed");
    socket.close();

    await fixture.db
      .update(modelDeployments)
      .set({
        config: {
          reasoning: { effort: "high" },
          text: { verbosity: "low" },
          maxOutputTokens: 777
        }
      })
      .where(eq(modelDeployments.id, target.deploymentId));
    const chat = await postJson(
      `${fixture.proxyUrl}/v1/chat/completions`,
      gatewayHeaders("proxy-token"),
      {
        model: "coding-auto",
        messages: [{ role: "user", content: "Finish the auth fix" }]
      }
    );
    expect(chat.status).toBe(200);
    const chatCall = fixture.openai.records.find((record) => (
      record.path === "/chat/completions" && record.body.model === target.upstreamModelId
    ));
    expect(chatCall?.body).toMatchObject({
      reasoning_effort: "high",
      max_completion_tokens: 777
    });
    expect(chatCall?.body).not.toHaveProperty("reasoning");
    expect(chatCall?.body).not.toHaveProperty("text");
    expect(chatCall?.body).not.toHaveProperty("max_output_tokens");

    const decisions = await fixture.db
      .select({
        requestId: routeDecisions.requestId,
        routerKind: routeDecisions.routerKind,
        deploymentId: routeDecisions.deploymentId,
        providerConnectionId: routeDecisions.providerConnectionId
      })
      .from(routeDecisions)
      .where(eq(routeDecisions.requestedLogicalModel, "coding-auto"));
    expect(decisions).toHaveLength(3);
    expect(decisions.every((decision) => (
      decision.routerKind === "classifier" &&
      decision.deploymentId === target.deploymentId &&
      decision.providerConnectionId === target.providerConnectionId
    ))).toBe(true);
    expect(fixture.openai.records.filter((record) => record.body.model === "route-classifier-cheap"))
      .toHaveLength(3);
    const classifierUsage = await fixture.db
      .select({
        provider: usageLedger.provider,
        model: usageLedger.model,
        inputTokens: usageLedger.inputTokens,
        outputTokens: usageLedger.outputTokens,
        totalTokens: usageLedger.totalTokens,
        totalCostMicros: usageLedger.totalCostMicros
      })
      .from(usageLedger)
      .where(eq(usageLedger.kind, "classifier"));
    expect(classifierUsage).toHaveLength(3);
    expect(classifierUsage).toEqual(expect.arrayContaining(Array.from({ length: 3 }, () => ({
      provider: "openai",
      model: "route-classifier-cheap",
      inputTokens: 17,
      outputTokens: 3,
      totalTokens: 20,
      totalCostMicros: 64
    }))));
  });

  it("persists aggregate billed usage when every classifier attempt fails", async () => {
    const organizationId = "org_gateway_runtime_classifier_failure";
    fixture = await captureFixture(organizationId, "hash_only", false, {
      openAIOptions: {
        classifierOutput: {
          target_id: "target_outside_eligible_set",
          reason_codes: ["invalid_selection"],
          confidence: 1
        },
        classifierResponsesShape: true,
        classifierUsage: {
          input_tokens: 5,
          output_tokens: 1,
          total_tokens: 6
        }
      }
    });
    const classifierDeploymentId = `${defaultWorkspaceId(organizationId)}:deployment:openai:route-classifier-cheap`;
    await fixture.db
      .update(modelDeployments)
      .set({ pricing: { inputCostPerMtok: 2, outputCostPerMtok: 10 } })
      .where(eq(modelDeployments.id, classifierDeploymentId));

    const response = await postJson(
      `${fixture.proxyUrl}/v1/responses`,
      gatewayHeaders("proxy-token"),
      { model: "coding-auto", input: "Force an invalid classifier selection" }
    );
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: "classifier_failed" }
    });

    const [usage] = await fixture.db
      .select({
        inputTokens: usageLedger.inputTokens,
        outputTokens: usageLedger.outputTokens,
        totalTokens: usageLedger.totalTokens,
        totalCostMicros: usageLedger.totalCostMicros
      })
      .from(usageLedger)
      .where(eq(usageLedger.kind, "classifier"));
    const [classification] = await fixture.db
      .select({ payload: eventRows.payload })
      .from(eventRows)
      .where(eq(eventRows.eventType, "routing.classification_recorded"));
    expect(usage).toEqual({
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      totalCostMicros: 40
    });
    expect(classification?.payload).toMatchObject({
      outcome: "failed",
      attempts: 2,
      classifierDeploymentId,
      error: "Classifier returned an invalid logical model target."
    });
  });

  it("applies deployment settings before binding overrides on the provider request", async () => {
    fixture = await captureFixture("org_gateway_runtime_settings", "hash_only", false, {
      anthropicOptions: { outputText: "configured answer" }
    });
    const target = await logicalTarget(fixture, "fable", "anthropic");
    await fixture.db
      .update(modelDeployments)
      .set({
        config: {
          thinking: { type: "enabled", budget_tokens: 256 },
          output_config: { effort: "high" },
          maxTokens: 384,
          metadata: { source: "deployment" }
        }
      })
      .where(eq(modelDeployments.id, target.deploymentId));
    await fixture.db
      .update(deploymentWireBindings)
      .set({
        requestConfig: {
          max_tokens: 512,
          metadata: { source: "binding" },
          stream: true
        }
      })
      .where(eq(deploymentWireBindings.id, target.bindingId));

    const response = await postJson(
      `${fixture.proxyUrl}/v1/messages`,
      gatewayHeaders("proxy-token"),
      {
        model: "fable",
        max_tokens: 64,
        metadata: { source: "request" },
        messages: [{ role: "user", content: "Use the configured deployment" }]
      }
    );

    expect(response.status).toBe(200);
    expect(fixture.anthropic.records.at(-1)?.body).toMatchObject({
      model: target.upstreamModelId,
      max_tokens: 512,
      thinking: { type: "enabled", budget_tokens: 256 },
      output_config: { effort: "high" },
      metadata: { source: "binding" }
    });
    expect(fixture.anthropic.records.at(-1)?.body).not.toHaveProperty("stream");
  });

  it("keeps OpenAI privacy and streaming usage defaults unless explicitly overridden", async () => {
    fixture = await captureFixture("org_gateway_runtime_openai_defaults", "hash_only", false, {
      openAIOptions: { respectChatIncludeUsage: true }
    });
    const openAITarget = await logicalTarget(fixture, "coding-auto", "openai");
    const [fable] = await fixture.db
      .select({ id: logicalModels.id })
      .from(logicalModels)
      .where(eq(logicalModels.slug, "fable"))
      .limit(1);
    await fixture.db
      .update(logicalModelTargets)
      .set({ deploymentId: openAITarget.deploymentId })
      .where(eq(logicalModelTargets.logicalModelId, fable!.id));

    const omittedStore = await postJson(`${fixture.proxyUrl}/v1/responses`, gatewayHeaders("proxy-token"), {
      model: "fable",
      input: "Do not retain this response"
    });
    expect(omittedStore.status).toBe(200);
    await omittedStore.text();
    const explicitStore = await postJson(`${fixture.proxyUrl}/v1/responses`, gatewayHeaders("proxy-token"), {
      model: "fable",
      input: "The caller explicitly opted in",
      store: true
    });
    expect(explicitStore.status).toBe(200);
    await explicitStore.text();
    const chat = await postJson(`${fixture.proxyUrl}/v1/chat/completions`, gatewayHeaders("proxy-token"), {
      model: "fable",
      messages: [{ role: "user", content: "Stream with usage" }],
      stream: true
    });
    expect(chat.status).toBe(200);
    await chat.text();

    const responseCalls = fixture.openai.records.filter((record) => record.path === "/responses");
    expect(responseCalls.map((record) => record.body.store)).toEqual([false, true]);
    const chatCall = fixture.openai.records.find((record) => record.path === "/chat/completions");
    expect(chatCall?.body.stream_options).toEqual({ include_usage: true });
    const chatUsage = await fixture.db
      .select({ inputTokens: usageLedger.inputTokens, outputTokens: usageLedger.outputTokens })
      .from(usageLedger)
      .innerJoin(requests, eq(requests.id, usageLedger.requestId))
      .where(eq(requests.surface, "openai-chat"));
    expect(chatUsage).toEqual([{ inputTokens: 100, outputTokens: 20 }]);
  });

  it("validates deployment and binding token overrides against the granted cap", async () => {
    fixture = await captureFixture("org_gateway_runtime_effective_caps", "hash_only", false, {
      anthropicOptions: { outputText: "should not be called" }
    });
    const target = await logicalTarget(fixture, "fable", "anthropic");
    const [profile] = await fixture.db
      .select({ id: accessProfiles.id })
      .from(accessProfiles)
      .where(eq(accessProfiles.slug, "opendoor-engineer"))
      .limit(1);
    const [model] = await fixture.db
      .select({ id: logicalModels.id })
      .from(logicalModels)
      .where(eq(logicalModels.slug, "fable"))
      .limit(1);
    await fixture.db
      .update(accessProfileModelGrants)
      .set({ parameterCaps: { max_tokens: 128 } })
      .where(and(
        eq(accessProfileModelGrants.accessProfileId, profile!.id),
        eq(accessProfileModelGrants.logicalModelId, model!.id)
      ));
    await fixture.db
      .update(modelDeployments)
      .set({ config: { maxTokens: 256 } })
      .where(eq(modelDeployments.id, target.deploymentId));

    const deploymentDenied = await postJson(
      `${fixture.proxyUrl}/v1/messages`,
      gatewayHeaders("proxy-token"),
      {
        model: "fable",
        max_tokens: 64,
        messages: [{ role: "user", content: "Deployment override must remain capped" }]
      }
    );
    expect(deploymentDenied.status).toBe(400);
    await expect(deploymentDenied.json()).resolves.toMatchObject({
      error: { message: "parameter_cap_exceeded" }
    });

    await fixture.db
      .update(modelDeployments)
      .set({ config: { maxTokens: 64 } })
      .where(eq(modelDeployments.id, target.deploymentId));
    await fixture.db
      .update(deploymentWireBindings)
      .set({ requestConfig: { max_tokens: 512 } })
      .where(eq(deploymentWireBindings.id, target.bindingId));
    const bindingDenied = await postJson(
      `${fixture.proxyUrl}/v1/messages`,
      gatewayHeaders("proxy-token"),
      {
        model: "fable",
        max_tokens: 64,
        messages: [{ role: "user", content: "Binding override must remain capped" }]
      }
    );
    expect(bindingDenied.status).toBe(400);
    await expect(bindingDenied.json()).resolves.toMatchObject({
      error: { message: "parameter_cap_exceeded" }
    });
    expect(fixture.anthropic.records).toHaveLength(0);
  });

  it("filters capped router targets before classifier spend", async () => {
    fixture = await captureFixture("org_gateway_runtime_router_caps", "hash_only");
    const [profile] = await fixture.db
      .select({ id: accessProfiles.id })
      .from(accessProfiles)
      .where(eq(accessProfiles.slug, "opendoor-engineer"))
      .limit(1);
    const [model] = await fixture.db
      .select({ id: logicalModels.id })
      .from(logicalModels)
      .where(eq(logicalModels.slug, "coding-auto"))
      .limit(1);
    await fixture.db
      .update(accessProfileModelGrants)
      .set({ parameterCaps: { max_output_tokens: 128 } })
      .where(and(
        eq(accessProfileModelGrants.accessProfileId, profile!.id),
        eq(accessProfileModelGrants.logicalModelId, model!.id)
      ));
    const targets = await fixture.db
      .select({ deploymentId: logicalModelTargets.deploymentId })
      .from(logicalModelTargets)
      .where(eq(logicalModelTargets.logicalModelId, model!.id));
    for (const target of targets) {
      await fixture.db
        .update(modelDeployments)
        .set({ config: { maxOutputTokens: 256, maxTokens: 256 } })
        .where(eq(modelDeployments.id, target.deploymentId));
    }

    const response = await postJson(
      `${fixture.proxyUrl}/v1/responses`,
      gatewayHeaders("proxy-token"),
      {
        model: "coding-auto",
        input: "Do not spend on a classifier",
        max_output_tokens: 64
      }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: "parameter_cap_exceeded" }
    });
    expect(fixture.openai.records).toHaveLength(0);
    expect(fixture.anthropic.records).toHaveLength(0);
  });

  it("limits a key to one direct model and one two-target router", async () => {
    const classifierOutput: Record<string, unknown> = {
      target_id: "pending",
      reason_codes: ["complexity_policy"],
      confidence: 0.96
    };
    fixture = await captureFixture("org_gateway_runtime_two_model_key", "hash_only", false, {
      openAIOptions: { classifierOutput, classifierResponsesShape: true }
    });
    const deployments = await fixture.db.select({
      id: modelDeployments.id,
      upstreamModelId: modelDeployments.upstreamModelId
    }).from(modelDeployments);
    const deploymentId = (upstreamModelId: string) => deployments.find(
      (deployment) => deployment.upstreamModelId === upstreamModelId
    )!.id;
    const [seedRouter] = await fixture.db.select({ routerConfig: logicalModels.routerConfig })
      .from(logicalModels)
      .where(eq(logicalModels.slug, "coding-auto"))
      .limit(1);

    const frontier = await createLogicalModelViaGraphql(fixture, {
      slug: "chat-frontier",
      name: "Chat Frontier",
      resolutionKind: "direct",
      enabled: true,
      initialTargets: [{
        deploymentId: deploymentId("claude-fable-5"),
        priority: 0,
        enabled: true
      }]
    });
    const auto = await createLogicalModelViaGraphql(fixture, {
      slug: "chat-auto",
      name: "Chat Auto",
      resolutionKind: "router",
      routerConfig: seedRouter!.routerConfig,
      enabled: true,
      initialTargets: [
        { deploymentId: deploymentId("claude-opus-4-5"), priority: 0, enabled: true },
        { deploymentId: deploymentId("gpt-5.5"), priority: 1, enabled: true }
      ]
    });
    const created = await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `mutation CreateKey($input: CreateGatewayApiKeyWithModelsInput!) {
        createGatewayApiKeyWithModels(input: $input) { secret apiKey { id name } }
      }`,
      { input: { name: "Scoped application key", logicalModelIds: [frontier.id, auto.id] } }
    );
    expect(created.errors).toBeUndefined();
    const headers = gatewayHeaders(created.data!.createGatewayApiKeyWithModels.secret as string);

    const models = await fetch(`${fixture.proxyUrl}/v1/models`, { headers });
    expect(models.status).toBe(200);
    await expect(models.json()).resolves.toMatchObject({
      data: [{ id: "chat-auto" }, { id: "chat-frontier" }]
    });

    const direct = await postJson(`${fixture.proxyUrl}/v1/messages`, headers, {
      model: "chat-frontier",
      max_tokens: 64,
      messages: [{ role: "user", content: "Use the direct frontier model" }]
    });
    expect(direct.status).toBe(200);
    expect(fixture.anthropic.records.some((record) => record.body.model === "claude-fable-5")).toBe(true);

    const selectedTarget = await logicalTarget(fixture, "chat-auto", "openai");
    classifierOutput.target_id = selectedTarget.targetId;
    const routed = await postJson(`${fixture.proxyUrl}/v1/responses`, headers, {
      model: "chat-auto",
      input: "Solve a complex multi-step task"
    });
    expect(routed.status).toBe(200);
    expect(fixture.openai.records.some((record) => record.body.model === selectedTarget.upstreamModelId)).toBe(true);

    const callsBefore = fixture.openai.records.length + fixture.anthropic.records.length;
    const denied = await postJson(`${fixture.proxyUrl}/v1/responses`, headers, {
      model: "economy-auto",
      input: "This model is not granted"
    });
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({ error: { message: "model_access_denied" } });
    expect(fixture.openai.records.length + fixture.anthropic.records.length).toBe(callsBefore);
  });

  it("lists only granted models and denies fable before provider spend for an external key", async () => {
    const classifierOutput: Record<string, unknown> = {
      target_id: "pending",
      reason_codes: ["economy_policy"],
      confidence: 0.97
    };
    fixture = await captureFixture("org_gateway_runtime_access", "hash_only", false, {
      openAIOptions: { classifierOutput, classifierResponsesShape: true }
    });
    const target = await logicalTarget(fixture, "economy-auto", "openai");
    classifierOutput.target_id = target.targetId;
    const [profile] = await fixture.db
      .select({ id: accessProfiles.id })
      .from(accessProfiles)
      .where(eq(accessProfiles.slug, "external-economy"))
      .limit(1);
    const created = await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `mutation CreateKey($input: CreateApiKeyInput!) {
        createApiKey(input: $input) { secret apiKey { id name } }
      }`,
      { input: { name: "External active key", accessProfileId: profile!.id } }
    );
    expect(created.errors).toBeUndefined();
    const token = created.data?.createApiKey.secret as string;

    const headers = gatewayHeaders(token);
    const list = await fetch(`${fixture.proxyUrl}/v1/models`, { headers });
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({
      data: [{ id: "economy-auto" }]
    });

    const economy = await postJson(`${fixture.proxyUrl}/v1/responses`, headers, {
      model: "economy-auto",
      input: "Complete this inexpensive coding task"
    });
    expect(economy.status).toBe(200);
    expect(fixture.openai.records.some((record) => record.body.model === target.upstreamModelId))
      .toBe(true);

    const callsBefore = fixture.openai.records.length + fixture.anthropic.records.length;
    const denied = await postJson(`${fixture.proxyUrl}/v1/messages`, headers, {
      model: "fable",
      max_tokens: 64,
      messages: [{ role: "user", content: "Use the frontier model" }]
    });
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toEqual({
      type: "error",
      error: {
        type: "permission_error",
        message: "model_access_denied"
      }
    });
    expect(fixture.openai.records.length + fixture.anthropic.records.length).toBe(callsBefore);
  });


});

async function createLogicalModelViaGraphql(fixture: PromptTestFixture, input: Record<string, unknown>) {
  const result = await adminGql(
    fixture.proxyUrl,
    fixture.adminHeaders,
    `mutation CreateModel($input: CreateGatewayLogicalModelInput!) {
      createGatewayLogicalModel(input: $input) { id slug }
    }`,
    { input }
  );
  expect(result.errors).toBeUndefined();
  return result.data!.createGatewayLogicalModel as { id: string; slug: string };
}
