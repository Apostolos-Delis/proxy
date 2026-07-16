import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";

import {
  defaultWorkspaceId,
  events
} from "@proxy/db";
import type { Dialect } from "@proxy/schema";

import { buildOpenAIContext } from "../src/features.js";
import {
  expectExactJson,
  expectRoutePlanExcerpt,
  loadHarnessFixture
} from "./harnessFixtures.js";
import { assignHarnessGatewayTarget } from "./gatewayHarnessFixture.js";
import { captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

let activeFixture: PromptTestFixture | undefined;

afterEach(async () => {
  await activeFixture?.close();
  activeFixture = undefined;
});

describe("Codex Responses WebSocket native golden fixtures", () => {
  it("matches the native WebSocket session, preconnect, and pinned continuation fixture", async () => {
    const organizationId = "org_harness_codex_ws_native";
    const fixture = loadHarnessFixture("codex-responses-websocket", "native-session");
    activeFixture = await setupCodexWebSocketFixture(organizationId, {
      wsUpgradeHeaders: {
        "x-codex-turn-state": "turn-state-upstream",
        "x-models-etag": "models-etag-upstream",
        "x-reasoning-included": "true",
        "openai-model": "gpt-codex-ws-native"
      }
    });

    const headers = codexWebSocketHeaders("codex-native-token");
    const context = {
      ...buildOpenAIContext(fixture.inboundRequest, headers),
      transport: "websocket" as const
    };
    expectExactJson({
      surface: context.surface,
      harness: context.harness,
      statefulResponses: context.statefulResponses,
      transport: context.transport,
      sessionId: context.sessionId,
      hasPreviousResponseId: context.hasPreviousResponseId,
      hasTools: context.hasTools
    }, fixture.routeContext);

    const ws = new WebSocket(activeFixture.proxyUrl.replace("http://", "ws://") + "/v1/responses", { headers });
    const upgradeHeaders = websocketUpgradeHeaders(ws);
    await websocketOpen(ws);

    const firstEventsPromise = collectWebSocketEvents(ws, 2);
    ws.send(JSON.stringify(fixture.inboundRequest));
    const firstEvents = await firstEventsPromise;
    const secondEventsPromise = collectWebSocketEvents(ws, 2);
    ws.send(JSON.stringify(fixture.continuationRequest));
    const secondEvents = await secondEventsPromise;
    const clientEvents = [...firstEvents, ...secondEvents];
    ws.close();

    const providerCalls = activeFixture.openai.records.filter((record) =>
      record.path === "/responses" && record.body.type === "response.create"
    );
    const decisions = await decisionPayloads(activeFixture);
    const planEvents = await promptCachePlanEvents(activeFixture, 2);

    expectExactJson(clientEvents, fixture.expectedClientEvents);
    expectExactJson(providerCalls.map((record) => record.body), fixture.expectedUpstreamRequests);
    expectExactJson(selectedHeaders(await upgradeHeaders, fixture.preconnectHeaders), fixture.preconnectHeaders);
    expect(providerCalls).toHaveLength(2);
    expect(providerCalls[0]?.headers.authorization).toBe("Bearer openai-upstream-key");
    expect(providerCalls[0]?.headers["openai-beta"]).toBe("responses_websockets=2026-02-06");
    expect(providerCalls[0]?.headers["x-codex-turn-state"]).toBe("golden-ws-turn-state");
    expect(providerCalls[0]?.headers["x-request-id"]).toBe("golden-ws-request-id");
    expect(providerCalls[0]?.headers.session_id).toBeUndefined();
    expect(decisions.map((decision) => decision.requestedModel)).toEqual(["fable", "fable"]);
    expectRoutePlanExcerpt(decisions[0], fixture.routePlanExcerpt);
    expect(planEvents).toHaveLength(2);
    expect(planEvents[0]?.organizationId).toBe(organizationId);
    expect(planEvents[0]?.workspaceId).toBe(defaultWorkspaceId(organizationId));
    expect(planEvents[0]?.payload).toMatchObject({
      surface: "openai-responses",
      provider: "openai",
      model: "gpt-codex-ws-native",
      mode: "implicit",
      appliedControls: expect.arrayContaining(["implicit_prefix_caching"])
    });
  });

  it("rejects binary WebSocket client frames before routing", async () => {
    const organizationId = "org_harness_codex_ws_binary";
    const fixture = loadHarnessFixture("codex-responses-websocket", "reject-binary-frame");
    activeFixture = await setupCodexWebSocketFixture(organizationId);

    const ws = new WebSocket(activeFixture.proxyUrl.replace("http://", "ws://") + "/v1/responses", {
      headers: codexWebSocketHeaders("codex-native-token")
    });
    await websocketOpen(ws);
    const errorEvent = collectWebSocketEvents(ws, 1);
    ws.send(Buffer.from("not-json"));
    const [event] = await errorEvent;
    ws.close();

    expectExactJson(event, fixture.expectedClientResponse);
    expect(activeFixture.openai.records.filter((record) => record.body.type === "response.create")).toHaveLength(0);
    expect(await decisionPayloads(activeFixture)).toHaveLength(0);
  });

  it("rejects WebSocket route targets that only expose translated endpoints", async () => {
    const organizationId = "org_harness_codex_ws_chat_target";
    const fixture = loadHarnessFixture("codex-responses-websocket", "reject-chat-target");
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      envOverrides: {
        ALLOWED_PRIVATE_UPSTREAM_CIDRS: "127.0.0.0/8"
      }
    });
    await assignTarget(activeFixture, organizationId, {
      secret: "codex-ws-chat-only-token",
      slug: "codex-ws-chat-only",
      target: {
        providerId: "chat-only-openai",
        model: "gpt-chat-only-ws"
      },
      wires: [{ dialect: "openai-chat", path: "/chat/completions" }],
      baseUrl: activeFixture.openai.url
    });

    const ws = new WebSocket(activeFixture.proxyUrl.replace("http://", "ws://") + "/v1/responses", {
      headers: codexWebSocketHeaders("codex-ws-chat-only-token")
    });
    await websocketOpen(ws);
    const errorEvent = collectWebSocketEvents(ws, 1);
    ws.send(JSON.stringify(fixture.inboundRequest));
    const [event] = await errorEvent;
    ws.close();

    const decisions = await decisionPayloads(activeFixture);
    const eventRows = await activeFixture.db.select().from(events);

    expectExactJson(event, fixture.expectedClientResponse);
    expectRoutePlanExcerpt(decisions[0], fixture.routePlanExcerpt);
    expect(activeFixture.openai.records.filter((record) => record.body.type === "response.create")).toHaveLength(0);
    expect(eventRows.filter((row) => row.eventType === "provider.request_started")).toHaveLength(0);
  });
});

function codexWebSocketHeaders(token: string) {
  return {
    authorization: `Bearer ${token}`,
    "openai-beta": "responses_websockets=2026-02-06",
    session_id: "codex-golden-ws-session",
    "x-codex-turn-state": "golden-ws-turn-state",
    "x-request-id": "golden-ws-request-id"
  };
}

async function setupCodexWebSocketFixture(
  organizationId: string,
  openAIOptions: { wsUpgradeHeaders?: Record<string, string> } = {}
) {
  const fixture = await captureFixture(organizationId, "raw_text", false, { openAIOptions });
  await assignTarget(fixture, organizationId, {
    secret: "codex-native-token",
    slug: "codex-ws-native",
    target: {
      providerId: "openai",
      model: "gpt-codex-ws-native",
      effort: "high",
      verbosity: "medium",
      maxOutputTokens: 321
    },
    wires: [{ dialect: "openai-responses", path: "/responses" }]
  });
  return fixture;
}

async function assignTarget(
  fixture: PromptTestFixture,
  organizationId: string,
  input: {
    secret: string;
    slug: string;
    target: TargetFixture;
    wires: { dialect: Dialect; path: string }[];
    baseUrl?: string;
  }
) {
  await assignHarnessGatewayTarget(fixture, organizationId, {
    secret: input.secret,
    slug: input.slug,
    provider: input.target.providerId.includes("anthropic") ? "anthropic" : "openai",
    connectionSlug: input.target.providerId,
    model: input.target.model,
    config: targetConfig(input.target),
    wires: input.wires,
    ...(input.baseUrl ? {
      connection: { baseUrl: input.baseUrl, forwardHarnessHeaders: false }
    } : {})
  });
}

type TargetFixture = {
  providerId: string;
  model: string;
  effort?: string;
  verbosity?: string;
  thinking?: Record<string, unknown>;
  maxOutputTokens?: number;
};

function targetConfig(target: TargetFixture) {
  if (target.providerId.includes("anthropic")) {
    return {
      timeoutMs: 60000,
      ...(target.effort ? { output_config: { effort: target.effort } } : {}),
      ...(target.thinking ? { thinking: target.thinking } : {}),
      ...(target.maxOutputTokens ? { maxTokens: target.maxOutputTokens } : {})
    };
  }
  return {
    timeoutMs: 60000,
    ...(target.effort ? { reasoning: { effort: target.effort } } : {}),
    ...(target.verbosity ? { text: { verbosity: target.verbosity } } : {}),
    ...(target.maxOutputTokens ? { maxOutputTokens: target.maxOutputTokens } : {})
  };
}

async function decisionPayloads(fixture: PromptTestFixture) {
  const eventRows = await fixture.db.select().from(events);
  return eventRows
    .filter((event) => event.eventType === "routing.decision_recorded")
    .map((event) => event.payload as {
      outcome?: string;
      surface?: string;
      provider?: string;
      selectedModel?: string;
      requestedModel?: string;
      egressWireId?: string;
      wireAdapterVersion?: string | null;
      reasoningEffort?: string;
      verbosity?: string;
      error?: string;
    });
}

async function promptCachePlanEvents(fixture: PromptTestFixture, expectedCount: number) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const rows = (await fixture.db.select().from(events))
      .filter((event) => event.eventType === "prompt_cache.plan_applied");
    if (rows.length >= expectedCount) return rows;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return (await fixture.db.select().from(events))
    .filter((event) => event.eventType === "prompt_cache.plan_applied");
}

function websocketOpen(ws: WebSocket) {
  return new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

function websocketUpgradeHeaders(ws: WebSocket) {
  return new Promise<Record<string, string | string[] | undefined>>((resolve) => {
    ws.once("upgrade", (response) => resolve(response.headers));
  });
}

function collectWebSocketEvents(ws: WebSocket, count: number) {
  return new Promise<unknown[]>((resolve, reject) => {
    const events: unknown[] = [];
    function cleanup() {
      ws.off("message", onMessage);
      ws.off("error", onError);
    }
    function onMessage(data: WebSocket.RawData) {
      events.push(JSON.parse(String(data)));
      if (events.length === count) {
        cleanup();
        resolve(events);
      }
    }
    function onError(error: Error) {
      cleanup();
      reject(error);
    }
    ws.on("message", onMessage);
    ws.once("error", onError);
  });
}

function selectedHeaders(
  actual: Record<string, string | string[] | undefined>,
  expected: unknown
) {
  const result: Record<string, string | string[] | undefined> = {};
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) return result;
  for (const key of Object.keys(expected)) result[key] = actual[key];
  return result;
}
