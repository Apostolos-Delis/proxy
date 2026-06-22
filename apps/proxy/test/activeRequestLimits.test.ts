import { and, eq, isNull } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import {
  activeRequestLimits,
  apiKeyLimitPolicies,
  defaultWorkspaceId,
  events,
  workspaceLimitPolicies
} from "@prompt-proxy/db";

import { captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

describe("active request limits", () => {
  let activeFixture: PromptTestFixture | undefined;

  afterEach(async () => {
    await activeFixture?.close();
    activeFixture = undefined;
  });

  it("reserves, rejects over-cap requests, releases, and prunes expired rows", async () => {
    const organizationId = "org_active_limits_store";
    const workspaceId = defaultWorkspaceId(organizationId);
    const apiKeyId = `${organizationId}:api-key:default`;
    const now = new Date("2026-06-19T12:00:00.000Z");
    activeFixture = await captureFixture(organizationId);
    await activeFixture.db.insert(apiKeyLimitPolicies).values({
      id: "api_key_policy_active_store",
      organizationId,
      workspaceId,
      apiKeyId,
      policy: {
        parallelRequests: 1
      }
    });
    await activeFixture.db.insert(activeRequestLimits).values({
      id: "active_limit_expired",
      organizationId,
      workspaceId,
      apiKeyId,
      requestId: "request_expired",
      startedAt: new Date("2026-06-19T11:00:00.000Z"),
      expiresAt: new Date("2026-06-19T11:59:59.000Z")
    });

    const first = await activeFixture.persistence.activeRequestLimits.reserve({
      organizationId,
      workspaceId,
      apiKeyId,
      requestId: "request_first",
      now
    });
    expect(first.status).toBe("reserved");
    if (first.status !== "reserved") throw new Error("expected first reservation");

    const rowsAfterFirst = await activeRows(organizationId, workspaceId, apiKeyId);
    expect(rowsAfterFirst.map((row) => row.requestId)).toEqual(["request_first"]);

    const second = await activeFixture.persistence.activeRequestLimits.reserve({
      organizationId,
      workspaceId,
      apiKeyId,
      requestId: "request_second",
      now: new Date("2026-06-19T12:00:01.000Z")
    });
    expect(second).toMatchObject({
      status: "rejected",
      scope: "api_key",
      reason: "parallel_request_limit",
      current: 1,
      limit: 1,
      resetAt: first.expiresAt.toISOString()
    });

    await first.release();
    const third = await activeFixture.persistence.activeRequestLimits.reserve({
      organizationId,
      workspaceId,
      apiKeyId,
      requestId: "request_third",
      now: new Date("2026-06-19T12:00:02.000Z")
    });
    expect(third.status).toBe("reserved");
    if (third.status !== "reserved") throw new Error("expected third reservation");
    await third.release();

    await expect(activeRows(organizationId, workspaceId, apiKeyId)).resolves.toEqual([]);
  });

  it("reserves workspace caps for traffic without an API key", async () => {
    const organizationId = "org_active_limits_workspace_only";
    const workspaceId = defaultWorkspaceId(organizationId);
    const now = new Date("2026-06-19T12:00:00.000Z");
    activeFixture = await captureFixture(organizationId);
    await activeFixture.db.insert(workspaceLimitPolicies).values({
      id: "workspace_policy_active_store",
      organizationId,
      workspaceId,
      policy: {
        parallelRequests: 1
      }
    });
    const first = await activeFixture.persistence.activeRequestLimits.reserve({
      organizationId,
      workspaceId,
      requestId: "request_workspace_first",
      now
    });
    expect(first.status).toBe("reserved");
    if (first.status !== "reserved") throw new Error("expected first workspace reservation");

    const second = await activeFixture.persistence.activeRequestLimits.reserve({
      organizationId,
      workspaceId,
      requestId: "request_workspace_second",
      now: new Date("2026-06-19T12:00:01.000Z")
    });
    expect(second).toMatchObject({
      status: "rejected",
      scope: "workspace",
      reason: "parallel_request_limit",
      current: 1,
      limit: 1,
      resetAt: first.expiresAt.toISOString()
    });

    const rows = await activeFixture.db
      .select()
      .from(activeRequestLimits)
      .where(and(
        eq(activeRequestLimits.organizationId, organizationId),
        eq(activeRequestLimits.workspaceId, workspaceId),
        isNull(activeRequestLimits.apiKeyId)
      ));
    expect(rows).toHaveLength(1);
    await first.release();
  });

  it("rejects capped HTTP requests before routing or provider forwarding", async () => {
    const organizationId = "org_active_limits_http";
    const workspaceId = defaultWorkspaceId(organizationId);
    const apiKeyId = `${organizationId}:api-key:default`;
    const expiresAt = new Date(Date.now() + 60_000);
    activeFixture = await captureFixture(organizationId);
    await activeFixture.db.insert(apiKeyLimitPolicies).values({
      id: "api_key_policy_active_http",
      organizationId,
      workspaceId,
      apiKeyId,
      policy: {
        parallelRequests: 1
      }
    });
    await activeFixture.db.insert(activeRequestLimits).values({
      id: "active_limit_existing_http",
      organizationId,
      workspaceId,
      apiKeyId,
      requestId: "request_existing_http",
      startedAt: new Date(),
      expiresAt
    });
    const openAIRecordsBefore = activeFixture.openai.records.length;
    const anthropicRecordsBefore = activeFixture.anthropic.records.length;

    const response = await fetch(`${activeFixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: "explain active request limits"
      })
    });
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(429);
    expect(body).toMatchObject({
      error: "parallel_request_limit",
      message: "Active parallel request limit exceeded.",
      scope: "api_key",
      current: 1,
      limit: 1,
      resetAt: expiresAt.toISOString()
    });
    expect(activeFixture.openai.records).toHaveLength(openAIRecordsBefore);
    expect(activeFixture.anthropic.records).toHaveLength(anthropicRecordsBefore);
    await expect(activeRows(organizationId, workspaceId, apiKeyId)).resolves.toHaveLength(1);
    await expect(limitRejectionEvents()).resolves.toMatchObject([{
      organizationId,
      workspaceId,
      scopeType: "request",
      eventType: "limit.parallel_rejected",
      producer: "prompt-proxy.limits",
      payload: {
        reason: "parallel_request_limit",
        limitType: "parallel_requests",
        scope: "api_key",
        current: 1,
        limit: 1,
        resetAt: expiresAt.toISOString()
      }
    }]);
  });

  it("rejects capped WebSocket requests before routing or provider forwarding", async () => {
    const organizationId = "org_active_limits_ws";
    const workspaceId = defaultWorkspaceId(organizationId);
    const apiKeyId = `${organizationId}:api-key:default`;
    const expiresAt = new Date(Date.now() + 60_000);
    activeFixture = await captureFixture(organizationId);
    await activeFixture.db.insert(apiKeyLimitPolicies).values({
      id: "api_key_policy_active_ws",
      organizationId,
      workspaceId,
      apiKeyId,
      policy: {
        parallelRequests: 1
      }
    });
    await activeFixture.db.insert(activeRequestLimits).values({
      id: "active_limit_existing_ws",
      organizationId,
      workspaceId,
      apiKeyId,
      requestId: "request_existing_ws",
      startedAt: new Date(),
      expiresAt
    });

    const ws = new WebSocket(activeFixture.proxyUrl.replace("http://", "ws://") + "/v1/responses", {
      headers: {
        authorization: "Bearer proxy-token",
        "openai-beta": "responses_websockets=2026-02-06",
        session_id: "active-limit-ws-session"
      }
    });
    await websocketOpen(ws);
    ws.send(JSON.stringify({
      type: "response.create",
      model: "router-hard",
      input: "explain active request limits over websocket",
      stream: true
    }));
    const error = await nextWebSocketError(ws);
    ws.close();

    expect(error).toMatchObject({
      type: "error",
      status: 429,
      error: {
        code: "prompt_proxy_error",
        message: "parallel_request_limit"
      }
    });
    expect(activeFixture.openai.records.filter((record) => record.body.type === "response.create")).toHaveLength(0);
    expect(activeFixture.anthropic.records).toHaveLength(0);
    await expect(activeRows(organizationId, workspaceId, apiKeyId)).resolves.toHaveLength(1);
    await expect(limitRejectionEvents()).resolves.toMatchObject([{
      organizationId,
      workspaceId,
      scopeType: "request",
      eventType: "limit.parallel_rejected",
      producer: "prompt-proxy.limits",
      payload: {
        reason: "parallel_request_limit",
        limitType: "parallel_requests",
        scope: "api_key",
        current: 1,
        limit: 1,
        resetAt: expiresAt.toISOString()
      }
    }]);
  });

  async function activeRows(organizationId: string, workspaceId: string, apiKeyId: string) {
    if (!activeFixture) throw new Error("missing fixture");
    return activeFixture.db
      .select()
      .from(activeRequestLimits)
      .where(and(
        eq(activeRequestLimits.organizationId, organizationId),
        eq(activeRequestLimits.workspaceId, workspaceId),
        eq(activeRequestLimits.apiKeyId, apiKeyId)
      ));
  }

  async function limitRejectionEvents() {
    if (!activeFixture) throw new Error("missing fixture");
    return activeFixture.db
      .select()
      .from(events)
      .where(eq(events.eventType, "limit.parallel_rejected"));
  }

  function websocketOpen(ws: WebSocket) {
    return new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
  }

  function nextWebSocketError(ws: WebSocket) {
    return new Promise<Record<string, any>>((resolve, reject) => {
      ws.on("message", (data) => {
        const event = JSON.parse(String(data));
        if (event.type === "error") resolve(event);
      });
      ws.once("error", reject);
    });
  }
});
