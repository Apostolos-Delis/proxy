import { eq } from "drizzle-orm";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";

import {
  apiKeys,
  defaultWorkspaceId,
  events,
  hashApiKey,
  providers,
  routingConfigs,
  routingConfigVersions
} from "@proxy/db";
import type { RoutingConfig } from "@proxy/schema";

import { buildOpenAIContext } from "../src/features.js";
import {
  expectExactJson,
  expectRoutePlanExcerpt,
  loadHarnessFixture
} from "./harnessFixtures.js";
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

    expectExactJson(clientEvents, fixture.expectedClientEvents);
    expectExactJson(providerCalls.map((record) => record.body), fixture.expectedUpstreamRequests);
    expectExactJson(selectedHeaders(await upgradeHeaders, fixture.preconnectHeaders), fixture.preconnectHeaders);
    expect(providerCalls).toHaveLength(2);
    expect(providerCalls[0]?.headers.authorization).toBe("Bearer openai-upstream-key");
    expect(providerCalls[0]?.headers["openai-beta"]).toBe("responses_websockets=2026-02-06");
    expect(providerCalls[0]?.headers["x-codex-turn-state"]).toBe("golden-ws-turn-state");
    expect(providerCalls[0]?.headers["x-request-id"]).toBe("golden-ws-request-id");
    expect(providerCalls[0]?.headers.session_id).toBeUndefined();
    expect(decisions.map((decision) => decision.requestedModel)).toEqual(["router-hard", "router-hard"]);
    expectRoutePlanExcerpt(decisions[0], fixture.routePlanExcerpt);
    expect(decisions.flatMap((decision) => decision.guardrailActions ?? []))
      .not.toContain("translated_request:openai-responses_to_openai-chat");
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
    await activeFixture.db.insert(providers).values({
      id: "00000000-0000-0000-0000-00000000c017",
      organizationId,
      slug: "chat-only-openai",
      displayName: "Chat Only OpenAI",
      baseUrl: activeFixture.openai.url,
      authStyle: "none",
      endpoints: [{ dialect: "openai-chat", path: "/chat/completions" }],
      defaultHeaders: {},
      forwardHarnessHeaders: false,
      enabled: true
    });
    await assignRouteConfig(activeFixture, organizationId, {
      secret: "codex-ws-chat-only-token",
      slug: "codex-ws-chat-only",
      configHash: "sha256:codex-ws-chat-only",
      targets: [{
        providerId: "chat-only-openai",
        model: "gpt-chat-only-ws"
      }]
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
  await assignRouteConfig(fixture, organizationId, {
    secret: "codex-native-token",
    slug: "codex-ws-native",
    configHash: "sha256:codex-ws-native",
    targets: [{
      providerId: "openai",
      model: "gpt-codex-ws-native",
      effort: "high",
      verbosity: "medium",
      maxOutputTokens: 321
    }]
  });
  return fixture;
}

async function assignRouteConfig(
  fixture: PromptTestFixture,
  organizationId: string,
  input: {
    secret: string;
    slug: string;
    configHash: string;
    targets: RoutingConfig["routes"]["hard"]["targets"];
  }
) {
  const configId = `${organizationId}:routing-config:${input.slug}`;
  const versionId = `${configId}:v1`;
  const [defaultVersion] = await fixture.db
    .select()
    .from(routingConfigVersions)
    .where(eq(routingConfigVersions.id, `${organizationId}:routing-config:default:v1`))
    .limit(1);
  const config = structuredClone(defaultVersion.config as RoutingConfig);
  config.routes.hard.targets = input.targets;

  await fixture.db.insert(routingConfigs).values({
    id: configId,
    organizationId,
    workspaceId: defaultWorkspaceId(organizationId),
    name: "Harness compatibility WebSocket route config",
    slug: input.slug,
    status: "active"
  });
  await fixture.db.insert(routingConfigVersions).values({
    id: versionId,
    organizationId,
    workspaceId: defaultWorkspaceId(organizationId),
    routingConfigId: configId,
    version: 1,
    configHash: input.configHash,
    config,
    status: "active",
    createdByUserId: "local-user",
    activatedAt: new Date("2026-06-08T00:00:00.000Z")
  });
  await fixture.db
    .update(routingConfigs)
    .set({ activeVersionId: versionId })
    .where(eq(routingConfigs.id, configId));
  await fixture.db.insert(apiKeys).values({
    id: `api_key_${input.slug}`,
    organizationId,
    workspaceId: defaultWorkspaceId(organizationId),
    keyHash: hashApiKey(input.secret),
    name: "Harness compatibility WebSocket key",
    routingConfigId: configId
  });
}

async function decisionPayloads(fixture: PromptTestFixture) {
  const eventRows = await fixture.db.select().from(events);
  return eventRows
    .filter((event) => event.eventType === "routing.decision_recorded")
    .map((event) => event.payload as {
      guardrailActions?: string[];
      outcome?: string;
      surface?: string;
      provider?: string;
      selectedModel?: string;
      requestedModel?: string;
      reasoningEffort?: string;
      verbosity?: string;
      error?: string;
    });
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
