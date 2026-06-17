import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  agentSessions,
  apiKeys,
  defaultWorkspaceId,
  events,
  hashApiKey,
  providers,
  routingConfigs,
  routingConfigVersions
} from "@prompt-proxy/db";
import type { RoutingConfig } from "@prompt-proxy/schema";

import { SessionRouteStore } from "../src/policy.js";
import type { RouteContext } from "../src/types.js";
import { captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

const hardClassifierOutput = {
  complexity: "hard",
  risk: ["debugging"],
  recommended_route: "hard",
  can_use_fast_model: false,
  needs_deep_reasoning: false,
  reason_codes: ["session_pin_test"],
  confidence: 0.92
};

const deepClassifierOutput = {
  complexity: "deep",
  risk: ["architecture"],
  recommended_route: "deep",
  can_use_fast_model: false,
  needs_deep_reasoning: true,
  reason_codes: ["session_ceiling_test"],
  confidence: 0.95
};

describe("session pinning", () => {
  let activeFixture: PromptTestFixture | undefined;

  afterEach(async () => {
    await activeFixture?.close();
    activeFixture = undefined;
  });

  it("keeps pinned provider settings when a new routing config version activates mid-session", async () => {
    const organizationId = "org_session_pin_publish";
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      openAIOptions: { classifierOutput: hardClassifierOutput }
    });
    const assigned = await assignRouteConfig(activeFixture, organizationId, {
      secret: "session-pin-token",
      slug: "session-pin",
      configHash: "sha256:session-pin-v1",
      configure: (config) => withHardAnthropic(config, {
        model: "claude-opus-4-8",
        thinking: { type: "adaptive" },
        effort: "high"
      })
    });

    const first = await sendMessages(activeFixture, "session-pin-token", "pin-session");
    expect(first.status).toBe(200);
    expect(lastAnthropicModel(activeFixture)).toBe("claude-opus-4-8");

    await publishVersion(activeFixture, organizationId, assigned.configId, {
      version: 2,
      configHash: "sha256:session-pin-v2",
      configure: (config) => withHardAnthropic(config, {
        model: "claude-opus-4-7",
        thinking: { type: "adaptive" },
        effort: "max"
      })
    });

    const second = await sendMessages(activeFixture, "session-pin-token", "pin-session");
    expect(second.status).toBe(200);
    const pinnedCall = activeFixture.anthropic.records.at(-1);
    expect(pinnedCall?.body.model).toBe("claude-opus-4-8");
    expect(pinnedCall?.body.output_config.effort).toBe("high");

    const keptDecision = await lastDecisionPayload(activeFixture);
    expect(keptDecision?.guardrailActions).toContain("session_route_kept");
    expect(keptDecision?.guardrailActions).toContain("session_settings_pinned");

    const third = await sendMessages(activeFixture, "session-pin-token", "fresh-session");
    expect(third.status).toBe(200);
    const freshCall = activeFixture.anthropic.records.at(-1);
    expect(freshCall?.body.model).toBe("claude-opus-4-7");
    expect(freshCall?.body.output_config.effort).toBe("max");
  });

  it("hydrates the pinned route and settings from the database after a restart", async () => {
    const organizationId = "org_session_pin_restart";
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      openAIOptions: { classifierOutput: hardClassifierOutput }
    });
    await assignRouteConfig(activeFixture, organizationId, {
      secret: "session-restart-token",
      slug: "session-restart",
      configHash: "sha256:session-restart-v1",
      configure: (config) => withHardAnthropic(config, {
        model: "claude-restart-pin",
        thinking: { type: "adaptive" },
        effort: "high"
      })
    });

    const response = await sendMessages(activeFixture, "session-restart-token", "restart-session");
    expect(response.status).toBe(200);

    const rebooted = new SessionRouteStore(activeFixture.persistence.sessionPins);
    const planned = await rebooted.plan(
      routeContext(organizationId, "restart-session"),
      "fast"
    );

    expect(planned?.action).toBe("kept");
    expect(planned?.selectedRoute).toBe("hard");
    expect(planned?.pin?.settings.model).toBe("claude-restart-pin");
  });

  it("re-pins on route upgrade and records the pin in the session event payload", async () => {
    const organizationId = "org_session_pin_upgrade";
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      openAIOptions: { classifierOutput: hardClassifierOutput }
    });
    await assignRouteConfig(activeFixture, organizationId, {
      secret: "session-upgrade-token",
      slug: "session-upgrade",
      configHash: "sha256:session-upgrade-v1",
      configure: (config) => withHardAnthropic(config, {
        model: "claude-upgrade-hard",
        thinking: { type: "adaptive" },
        effort: "high"
      })
    });

    const explicitFast = await sendMessages(
      activeFixture,
      "session-upgrade-token",
      "upgrade-session",
      "claude-router-fast"
    );
    expect(explicitFast.status).toBe(200);

    const upgraded = await sendMessages(activeFixture, "session-upgrade-token", "upgrade-session");
    expect(upgraded.status).toBe(200);
    expect(lastAnthropicModel(activeFixture)).toBe("claude-upgrade-hard");

    const [sessionRow] = await activeFixture.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, `${defaultWorkspaceId(organizationId)}:anthropic-messages:upgrade-session`));
    expect(sessionRow?.currentRoute).toBe("hard");
    expect(sessionRow?.pinnedSettings?.model).toBe("claude-upgrade-hard");
    expect(sessionRow?.routingConfigVersionId).toBe(
      `${organizationId}:routing-config:session-upgrade:v1`
    );

    const eventRows = await activeFixture.db.select().from(events);
    const memory = eventRows
      .filter((event) => event.eventType === "session.route_memory_recorded")
      .at(-1);
    const payload = memory?.payload as { pin?: { settings?: { model?: string } } } | undefined;
    expect(payload?.pin?.settings?.model).toBe("claude-upgrade-hard");
  });

  it("skips classification once a session reaches the deep route", async () => {
    const organizationId = "org_session_deep_skip";
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      openAIOptions: { classifierOutput: deepClassifierOutput }
    });

    const first = await sendMessages(activeFixture, "proxy-token", "ceiling-session");
    expect(first.status).toBe(200);
    expect(classifierCalls(activeFixture)).toBe(1);

    const second = await sendMessages(activeFixture, "proxy-token", "ceiling-session");
    expect(second.status).toBe(200);
    expect(classifierCalls(activeFixture)).toBe(1);

    const decision = await lastDecisionPayload(activeFixture);
    expect(decision?.finalRoute).toBe("deep");
    expect(decision?.reasonCodes).toContain("session_route_ceiling");
    expect(decision?.guardrailActions).toContain("session_route_kept");
  });

  it("skips classification for tool-result-only continuations and rides the session floor", async () => {
    const organizationId = "org_session_tool_turns";
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      openAIOptions: { classifierOutput: hardClassifierOutput }
    });

    const first = await sendMessages(activeFixture, "proxy-token", "tool-turn-session");
    expect(first.status).toBe(200);
    expect(classifierCalls(activeFixture)).toBe(1);

    const second = await sendToolResultMessages(activeFixture, "proxy-token", "tool-turn-session");
    expect(second.status).toBe(200);
    expect(classifierCalls(activeFixture)).toBe(1);

    const decision = await lastDecisionPayload(activeFixture);
    expect(decision?.finalRoute).toBe("hard");
    expect(decision?.reasonCodes).toContain("session_route_no_user_signal");
    expect(decision?.guardrailActions).toContain("session_route_kept");
    expect(decision?.guardrailActions).toContain("session_settings_pinned");
  });

  it("lets only user-signal turns move the session floor", async () => {
    const store = new SessionRouteStore();
    const userContext = routeContext("org_floor_rules", "floor-session");
    const toolContext: RouteContext = { ...userContext, routingInputSource: "full_request" };

    const warmup = await store.plan(toolContext, "deep");
    expect(warmup?.action).toBe("stored");
    expect(warmup?.softFloor).toBe(true);
    store.commit(warmup!);

    const firstUserTurn = await store.plan(userContext, "fast");
    expect(firstUserTurn?.selectedRoute).toBe("fast");
    expect(firstUserTurn?.softFloor).toBe(false);
    store.commit(firstUserTurn!);

    const toolTurn = await store.plan(toolContext, "deep");
    expect(toolTurn?.selectedRoute).toBe("fast");
    expect(toolTurn?.action).toBe("kept");
    store.commit(toolTurn!);

    const upgrade = await store.plan(userContext, "hard");
    expect(upgrade?.selectedRoute).toBe("hard");
    expect(upgrade?.action).toBe("upgraded");
  });

  it("keeps classifying while a session sits below the deep route", async () => {
    const organizationId = "org_session_below_ceiling";
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      openAIOptions: { classifierOutput: hardClassifierOutput }
    });

    const first = await sendMessages(activeFixture, "proxy-token", "hard-session");
    expect(first.status).toBe(200);
    const second = await sendMessages(activeFixture, "proxy-token", "hard-session");
    expect(second.status).toBe(200);

    expect(classifierCalls(activeFixture)).toBe(2);
  });

  it("falls back to fresh resolution when the stored pin does not match the surface", async () => {
    const organizationId = "org_session_pin_stale";
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      openAIOptions: { classifierOutput: hardClassifierOutput }
    });
    await assignRouteConfig(activeFixture, organizationId, {
      secret: "session-stale-token",
      slug: "session-stale",
      configHash: "sha256:session-stale-v1",
      configure: (config) => withHardAnthropic(config, {
        model: "claude-stale-fresh",
        thinking: { type: "adaptive" },
        effort: "high"
      })
    });
    await activeFixture.db.insert(agentSessions).values({
      id: `${defaultWorkspaceId(organizationId)}:anthropic-messages:stale-session`,
      organizationId,
      workspaceId: defaultWorkspaceId(organizationId),
      surface: "anthropic-messages",
      externalSessionId: "stale-session",
      currentRoute: "hard",
      pinnedSettings: {
        providerId: "missing-openai-pin",
        model: "gpt-stale-pin",
        dialect: "openai-responses"
      },
      requestCount: 3,
      metadata: {}
    });

    const response = await sendMessages(activeFixture, "session-stale-token", "stale-session");
    expect(response.status).toBe(200);
    expect(lastAnthropicModel(activeFixture)).toBe("claude-stale-fresh");

    const decision = await lastDecisionPayload(activeFixture);
    expect(decision?.guardrailActions).toContain("session_pin_invalidated");
  });

  it("rebounds a stateless pinned session when its provider is disabled", async () => {
    const organizationId = "org_session_pin_rebound";
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      envOverrides: { ALLOWED_PRIVATE_UPSTREAM_CIDRS: "127.0.0.0/8" },
      openAIOptions: { classifierOutput: hardClassifierOutput }
    });
    await insertOrgProvider(activeFixture, organizationId, {
      id: "10000000-0000-0000-0000-000000000101",
      slug: "anthropic",
      baseUrl: activeFixture.anthropic.url,
      dialect: "anthropic-messages"
    });
    await insertOrgProvider(activeFixture, organizationId, {
      id: "10000000-0000-0000-0000-000000000102",
      slug: "backup-anthropic",
      baseUrl: activeFixture.anthropic.url,
      dialect: "anthropic-messages"
    });
    await assignRouteConfig(activeFixture, organizationId, {
      secret: "session-rebound-token",
      slug: "session-rebound",
      configHash: "sha256:session-rebound-v1",
      configure: (config) => withHardTargets(config, [
        { providerId: "anthropic", model: "claude-primary-pin", effort: "high" },
        { providerId: "backup-anthropic", model: "claude-backup-pin", effort: "high" }
      ])
    });

    const first = await sendMessages(activeFixture, "session-rebound-token", "rebound-session");
    expect(first.status).toBe(200);
    expect(lastAnthropicModel(activeFixture)).toBe("claude-primary-pin");

    await activeFixture.db
      .update(providers)
      .set({ enabled: false })
      .where(eq(providers.id, "10000000-0000-0000-0000-000000000101"));

    const second = await sendMessages(activeFixture, "session-rebound-token", "rebound-session");
    expect(second.status).toBe(200);
    expect(lastAnthropicModel(activeFixture)).toBe("claude-backup-pin");

    const decision = await lastDecisionPayload(activeFixture);
    expect(decision?.guardrailActions).toEqual(expect.arrayContaining([
      "session_pin_invalidated",
      "pin_rebound",
      "target_skipped_provider_disabled:anthropic"
    ]));
  });

  it("fails a stateful pinned Responses session when its provider is disabled", async () => {
    const organizationId = "org_session_pin_stateful_disabled";
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      envOverrides: { ALLOWED_PRIVATE_UPSTREAM_CIDRS: "127.0.0.0/8" },
      openAIOptions: { classifierOutput: hardClassifierOutput }
    });
    await insertOrgProvider(activeFixture, organizationId, {
      id: "10000000-0000-0000-0000-000000000103",
      slug: "openai",
      baseUrl: activeFixture.openai.url,
      dialect: "openai-responses"
    });
    await insertOrgProvider(activeFixture, organizationId, {
      id: "10000000-0000-0000-0000-000000000104",
      slug: "backup-openai",
      baseUrl: activeFixture.openai.url,
      dialect: "openai-responses"
    });
    await assignRouteConfig(activeFixture, organizationId, {
      secret: "session-stateful-disabled-token",
      slug: "session-stateful-disabled",
      configHash: "sha256:session-stateful-disabled-v1",
      configure: (config) => withHardTargets(config, [
        { providerId: "openai", model: "gpt-primary-pin", effort: "high" },
        { providerId: "backup-openai", model: "gpt-backup-pin", effort: "high" }
      ])
    });

    const first = await sendResponses(activeFixture, "session-stateful-disabled-token", "stateful-disabled-session");
    expect(first.status).toBe(200);
    await first.text();
    expect(activeFixture.openai.records.find((record) => record.body.model === "gpt-primary-pin")).toBeTruthy();

    await activeFixture.db
      .update(providers)
      .set({ enabled: false })
      .where(eq(providers.id, "10000000-0000-0000-0000-000000000103"));

    const second = await sendResponses(activeFixture, "session-stateful-disabled-token", "stateful-disabled-session");
    const body = await second.json();
    expect(second.status).toBe(400);
    expect(body.error).toBe("session_pin_unavailable");
    expect(activeFixture.openai.records.find((record) => record.body.model === "gpt-backup-pin")).toBeUndefined();

    const decision = await lastDecisionPayload(activeFixture);
    expect(decision?.guardrailActions).toEqual(expect.arrayContaining([
      "session_pin_invalidated",
      "pin_skipped_provider_disabled:openai"
    ]));
    expect(decision?.guardrailActions).not.toContain("pin_rebound");
  });
});

function routeContext(organizationId: string, sessionId: string): RouteContext {
  return {
    organizationId,
    workspaceId: defaultWorkspaceId(organizationId),
    surface: "anthropic-messages",
    requestedModel: "claude-router-auto",
    inputChars: 10,
    inputHash: "hash",
    estimatedInputTokens: 10,
    routingInputSource: "latest_user_message",
    routingInputText: "hello",
    routingInputChars: 5,
    routingInputHash: "routing-hash",
    routingEstimatedInputTokens: 5,
    hasTools: false,
    toolCount: 0,
    hasPreviousResponseId: false,
    hasImages: false,
    extractedHints: [],
    routingExtractedHints: [],
    sessionId
  };
}

let requestNonce = 0;

async function sendMessages(
  fixture: PromptTestFixture,
  secret: string,
  sessionId: string,
  model = "claude-router-auto"
) {
  // Unique bodies per request — identical bodies are deduplicated by the
  // idempotency gate and replayed without a fresh routing decision.
  requestNonce += 1;
  const response = await fetch(`${fixture.proxyUrl}/v1/messages`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-claude-code-session-id": sessionId
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "user", content: `debug this failing integration test (${requestNonce})` }
      ],
      stream: true
    })
  });
  await response.text();
  return response;
}

async function sendToolResultMessages(
  fixture: PromptTestFixture,
  secret: string,
  sessionId: string
) {
  requestNonce += 1;
  const response = await fetch(`${fixture.proxyUrl}/v1/messages`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-claude-code-session-id": sessionId
    },
    body: JSON.stringify({
      model: "claude-router-auto",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [{ type: "text", text: `command output (${requestNonce})` }]
            }
          ]
        }
      ],
      stream: true
    })
  });
  await response.text();
  return response;
}

async function sendResponses(
  fixture: PromptTestFixture,
  secret: string,
  sessionId: string
) {
  requestNonce += 1;
  return fetch(`${fixture.proxyUrl}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
      "x-codex-session-id": sessionId
    },
    body: JSON.stringify({
      model: "router-auto",
      input: `debug this failing integration test (${requestNonce})`,
      stream: true
    })
  });
}

function lastAnthropicModel(fixture: PromptTestFixture) {
  return fixture.anthropic.records.at(-1)?.body.model;
}

function classifierCalls(fixture: PromptTestFixture) {
  return fixture.openai.records.filter(
    (record) => record.body.model === "route-classifier-cheap"
  ).length;
}

async function lastDecisionPayload(fixture: PromptTestFixture) {
  const eventRows = await fixture.db.select().from(events);
  const decision = eventRows
    .filter((event) => event.eventType === "routing.decision_recorded")
    .at(-1);
  return decision?.payload as
    | { guardrailActions?: string[]; reasonCodes?: string[]; finalRoute?: string }
    | undefined;
}

function withHardAnthropic(
  config: RoutingConfig,
  anthropic: Omit<RoutingConfig["routes"]["hard"]["targets"][number], "providerId">
): RoutingConfig {
  return {
    ...config,
    routes: {
      ...config.routes,
      hard: {
        ...config.routes.hard,
        targets: config.routes.hard.targets.map((target) =>
          target.providerId === "anthropic" ? { ...target, ...anthropic } : target
        )
      }
    }
  };
}

function withHardTargets(
  config: RoutingConfig,
  targets: RoutingConfig["routes"]["hard"]["targets"]
): RoutingConfig {
  return {
    ...config,
    routes: {
      ...config.routes,
      hard: {
        ...config.routes.hard,
        targets
      }
    }
  };
}

async function insertOrgProvider(
  fixture: PromptTestFixture,
  organizationId: string,
  input: {
    id: string;
    slug: string;
    baseUrl: string;
    dialect: "anthropic-messages" | "openai-responses";
  }
) {
  await fixture.db.insert(providers).values({
    id: input.id,
    organizationId,
    slug: input.slug,
    displayName: input.slug,
    baseUrl: input.baseUrl,
    authStyle: "none",
    endpoints: [{ dialect: input.dialect, path: input.dialect === "anthropic-messages" ? "/messages" : "/responses" }],
    defaultHeaders: {},
    forwardHarnessHeaders: false,
    enabled: true
  });
}

async function assignRouteConfig(
  fixture: PromptTestFixture,
  organizationId: string,
  input: {
    secret: string;
    slug: string;
    configHash: string;
    configure: (config: RoutingConfig) => RoutingConfig;
  }
) {
  const configId = `${organizationId}:routing-config:${input.slug}`;
  const versionId = `${configId}:v1`;
  const [defaultVersion] = await fixture.db
    .select()
    .from(routingConfigVersions)
    .where(eq(routingConfigVersions.id, `${organizationId}:routing-config:default:v1`))
    .limit(1);
  const config = input.configure(structuredClone(defaultVersion.config as RoutingConfig));

  await fixture.db.insert(routingConfigs).values({
    id: configId,
    organizationId,
    workspaceId: defaultWorkspaceId(organizationId),
    name: "Session pin config",
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
    name: "Session pin key",
    routingConfigId: configId,
    scopes: ["proxy"]
  });

  return { configId, versionId };
}

async function publishVersion(
  fixture: PromptTestFixture,
  organizationId: string,
  configId: string,
  input: {
    version: number;
    configHash: string;
    configure: (config: RoutingConfig) => RoutingConfig;
  }
) {
  const [previous] = await fixture.db
    .select()
    .from(routingConfigVersions)
    .where(eq(routingConfigVersions.id, `${configId}:v${input.version - 1}`))
    .limit(1);
  const versionId = `${configId}:v${input.version}`;
  const config = input.configure(structuredClone(previous.config as RoutingConfig));

  await fixture.db.insert(routingConfigVersions).values({
    id: versionId,
    organizationId,
    workspaceId: defaultWorkspaceId(organizationId),
    routingConfigId: configId,
    version: input.version,
    configHash: input.configHash,
    config,
    status: "active",
    createdByUserId: "local-user",
    activatedAt: new Date()
  });
  await fixture.db
    .update(routingConfigVersions)
    .set({ status: "archived" })
    .where(eq(routingConfigVersions.id, previous.id));
  await fixture.db
    .update(routingConfigs)
    .set({ activeVersionId: versionId })
    .where(eq(routingConfigs.id, configId));
}
