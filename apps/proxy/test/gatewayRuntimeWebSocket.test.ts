import WebSocket from "ws";

import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  accessProfileModelGrants,
  accessProfiles,
  defaultWorkspaceId,
  deploymentHealth,
  events,
  logicalModels,
  requests
} from "@proxy/db";

import {
  logicalTarget,
  nextMessage,
  opened
} from "./gatewayRuntimeTestHelpers.js";
import { captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

describe("logical-model WebSocket runtime", () => {
  let fixture: PromptTestFixture | undefined;

  afterEach(async () => {
    await fixture?.close();
  });

  it("enforces parameter caps on WebSocket requests and terminalizes denial state", async () => {
    fixture = await captureFixture("org_gateway_runtime_ws_caps", "hash_only");
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
      .set({ parameterCaps: { max_output_tokens: 32 } })
      .where(and(
        eq(accessProfileModelGrants.accessProfileId, profile!.id),
        eq(accessProfileModelGrants.logicalModelId, model!.id)
      ));
    const providerCallsBefore = fixture.openai.records.length + fixture.anthropic.records.length;

    const socket = new WebSocket(
      fixture.proxyUrl.replace("http://", "ws://") + "/v1/responses",
      { headers: { authorization: "Bearer proxy-token" } }
    );
    await opened(socket);
    const errorMessage = nextMessage(socket, (message) => message.includes("parameter_cap_exceeded"));
    socket.send(JSON.stringify({
      type: "response.create",
      model: "coding-auto",
      input: "Exceed the configured cap",
      max_output_tokens: 64
    }));
    const error = JSON.parse(await errorMessage);
    expect(error).toMatchObject({
      type: "error",
      status: 400,
      error: { message: "parameter_cap_exceeded" }
    });
    expect(fixture.openai.records.length + fixture.anthropic.records.length)
      .toBe(providerCallsBefore);
    const [request] = await fixture.db
      .select({ status: requests.status })
      .from(requests)
      .where(eq(requests.requestedLogicalModel, "coding-auto"))
      .limit(1);
    expect(request?.status).toBe("failed");
    socket.close();
  });

  it("rejects overlapping WebSocket requests without corrupting the active request", async () => {
    const classifierOutput: Record<string, unknown> = {
      target_id: "pending",
      reason_codes: ["capability_match"],
      confidence: 0.91
    };
    fixture = await captureFixture("org_gateway_runtime_ws_overlap", "hash_only", false, {
      openAIOptions: {
        classifierOutput,
        classifierResponsesShape: true,
        wsResponseDelayMs: 100
      }
    });
    const target = await logicalTarget(fixture, "coding-auto", "openai");
    classifierOutput.target_id = target.targetId;
    const socket = new WebSocket(
      fixture.proxyUrl.replace("http://", "ws://") + "/v1/responses",
      { headers: { authorization: "Bearer proxy-token" } }
    );
    await opened(socket);

    const created = nextMessage(socket, (message) => message.includes("response.created"));
    socket.send(JSON.stringify({
      type: "response.create",
      model: "coding-auto",
      input: "First request"
    }));
    await created;
    const rejected = nextMessage(socket, (message) => message.includes("websocket_request_already_active"));
    const completed = nextMessage(socket, (message) => message.includes("response.completed"));
    socket.send(JSON.stringify({
      type: "response.create",
      model: "coding-auto",
      input: "Overlapping request"
    }));

    expect(JSON.parse(await rejected)).toMatchObject({
      type: "error",
      status: 409,
      error: { message: "websocket_request_already_active" }
    });
    expect(await completed).toContain("response.completed");
    const providerCalls = fixture.openai.records.filter((record) => (
      record.path === "/responses" && record.body.type === "response.create"
    ));
    expect(providerCalls).toHaveLength(1);
    expect(fixture.openai.records.filter((record) => record.body.model === "route-classifier-cheap"))
      .toHaveLength(1);
    const requestRows = await fixture.db.select({ status: requests.status }).from(requests);
    expect(requestRows).toEqual([{ status: "completed" }]);
    socket.close();
  });

  it.each([
    [
      "request",
      { GATEWAY_GLOBAL_CONCURRENCY_LIMIT: "1" },
      "traffic_limit_exceeded:global:concurrency"
    ],
    [
      "provider/model",
      { GATEWAY_PROVIDER_MODEL_CONCURRENCY_LIMIT: "1" },
      "traffic_limit_exceeded:provider_model:concurrency"
    ]
  ])("enforces %s concurrency limits and releases them after terminal events", async (
    _stage,
    envOverrides,
    expectedError
  ) => {
    const classifierOutput: Record<string, unknown> = {
      target_id: "pending",
      reason_codes: ["capability_match"],
      confidence: 0.91
    };
    fixture = await captureFixture(`org_gateway_runtime_ws_${_stage.replace("/", "_")}`, "hash_only", false, {
      envOverrides,
      openAIOptions: {
        classifierOutput,
        classifierResponsesShape: true,
        wsResponseDelayMs: 150
      }
    });
    const target = await logicalTarget(fixture, "coding-auto", "openai");
    classifierOutput.target_id = target.targetId;
    const first = new WebSocket(
      fixture.proxyUrl.replace("http://", "ws://") + "/v1/responses",
      { headers: { authorization: "Bearer proxy-token" } }
    );
    const second = new WebSocket(
      fixture.proxyUrl.replace("http://", "ws://") + "/v1/responses",
      { headers: { authorization: "Bearer proxy-token" } }
    );
    await Promise.all([opened(first), opened(second)]);

    const firstCreated = nextMessage(first, (message) => message.includes("response.created"));
    const firstCompleted = nextMessage(first, (message) => message.includes("response.completed"));
    first.send(JSON.stringify({
      type: "response.create",
      model: "coding-auto",
      input: "Hold the first limited request"
    }));
    await firstCreated;

    const rejected = nextMessage(second, (message) => message.includes(expectedError));
    second.send(JSON.stringify({
      type: "response.create",
      model: "coding-auto",
      input: "Reject this concurrent request"
    }));
    expect(JSON.parse(await rejected)).toMatchObject({
      type: "error",
      status: 429,
      error: { message: expectedError }
    });

    await firstCompleted;
    const recovered = nextMessage(second, (message) => message.includes("response.completed"));
    second.send(JSON.stringify({
      type: "response.create",
      model: "coding-auto",
      input: "Run after the first request releases its leases"
    }));
    expect(await recovered).toContain("response.completed");

    expect(fixture.openai.records.filter((record) => (
      record.path === "/responses" && record.body.type === "response.create"
    ))).toHaveLength(2);
    first.close();
    second.close();
  }, 60_000);

  it("projects WebSocket failures into deployment health", async () => {
    const classifierOutput: Record<string, unknown> = {
      target_id: "pending",
      reason_codes: ["capability_match"],
      confidence: 0.91
    };
    fixture = await captureFixture("org_gateway_runtime_ws_health_failure", "hash_only", false, {
      openAIOptions: {
        classifierOutput,
        classifierResponsesShape: true,
        wsTerminalEvent: "response.failed"
      }
    });
    const target = await logicalTarget(fixture, "coding-auto", "openai");
    classifierOutput.target_id = target.targetId;
    const socket = new WebSocket(
      fixture.proxyUrl.replace("http://", "ws://") + "/v1/responses",
      { headers: { authorization: "Bearer proxy-token" } }
    );
    await opened(socket);
    const failed = nextMessage(socket, (message) => message.includes("response.failed"));
    socket.send(JSON.stringify({
      type: "response.create",
      model: "coding-auto",
      input: "Fail the selected deployment"
    }));
    await failed;

    await vi.waitFor(async () => {
      const [health] = await fixture!.db.select().from(deploymentHealth)
        .where(eq(deploymentHealth.deploymentId, target.deploymentId));
      expect(health).toMatchObject({ lastErrorType: "model_unavailable" });
    });
    socket.close();
  });

  it("persists only bounded provider error fields from WebSocket failures", async () => {
    const organizationId = "org_gateway_runtime_ws_safe_failure";
    const classifierOutput: Record<string, unknown> = {
      target_id: "pending",
      reason_codes: ["capability_match"],
      confidence: 0.91
    };
    const promptSentinel = "SYSTEM_PROMPT_MUST_NOT_REACH_EVENTS";
    const secretSentinel = "PROVIDER_SECRET_MUST_NOT_REACH_EVENTS";
    fixture = await captureFixture(organizationId, "hash_only", false, {
      openAIOptions: {
        classifierOutput,
        classifierResponsesShape: true,
        wsTerminalEvent: "response.failed",
        wsFailureEventFields: { instructions: promptSentinel },
        wsFailureErrorFields: { debug_secret: secretSentinel }
      }
    });
    const target = await logicalTarget(fixture, "coding-auto", "openai");
    classifierOutput.target_id = target.targetId;
    const socket = new WebSocket(
      fixture.proxyUrl.replace("http://", "ws://") + "/v1/responses",
      { headers: { authorization: "Bearer proxy-token" } }
    );
    await opened(socket);
    const failed = nextMessage(socket, (message) => message.includes("response.failed"));
    socket.send(JSON.stringify({
      type: "response.create",
      model: "coding-auto",
      input: "Fail without persisting provider-controlled fields"
    }));
    await failed;

    await vi.waitFor(async () => {
      const [terminal] = await fixture!.db
        .select({ payload: events.payload, metadata: events.metadata })
        .from(events)
        .where(eq(events.eventType, "provider.response_failed"));
      expect(terminal).toBeDefined();
      expect(terminal!.payload).toMatchObject({ error: "model unavailable" });
      expect(terminal!.metadata).toEqual({
        error: "model unavailable",
        providerErrorCode: "model_not_found"
      });
      const serialized = JSON.stringify(terminal);
      expect(serialized).not.toContain(promptSentinel);
      expect(serialized).not.toContain(secretSentinel);
    });
    socket.close();
  });

  it("clears stream-specific deployment health after a WebSocket success", async () => {
    const classifierOutput: Record<string, unknown> = {
      target_id: "pending",
      reason_codes: ["capability_match"],
      confidence: 0.91
    };
    fixture = await captureFixture("org_gateway_runtime_ws_health_recovery", "hash_only", false, {
      openAIOptions: { classifierOutput, classifierResponsesShape: true }
    });
    const target = await logicalTarget(fixture, "coding-auto", "openai");
    classifierOutput.target_id = target.targetId;
    await fixture.db.insert(deploymentHealth).values({
      id: "deployment_health_ws_recovery",
      organizationId: fixture.config.defaultOrganizationId,
      workspaceId: defaultWorkspaceId(fixture.config.defaultOrganizationId),
      deploymentId: target.deploymentId,
      providerConnectionId: target.providerConnectionId,
      status: "healthy",
      lastErrorType: "stream_permission_denied",
      lastErrorAt: new Date(),
      metadata: { bedrockErrorKind: "stream_permission_denied" }
    });
    const socket = new WebSocket(
      fixture.proxyUrl.replace("http://", "ws://") + "/v1/responses",
      { headers: { authorization: "Bearer proxy-token" } }
    );
    await opened(socket);
    const completed = nextMessage(socket, (message) => message.includes("response.completed"));
    socket.send(JSON.stringify({
      type: "response.create",
      model: "coding-auto",
      input: "Recover the stream path"
    }));
    await completed;

    await vi.waitFor(async () => {
      const [health] = await fixture!.db.select().from(deploymentHealth)
        .where(eq(deploymentHealth.deploymentId, target.deploymentId));
      expect(health).toMatchObject({ status: "healthy", lastErrorType: null, metadata: {} });
    });
    socket.close();
  });
});
