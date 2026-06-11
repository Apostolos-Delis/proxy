import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  agentSessions,
  apiKeys,
  events,
  hashApiKey,
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
        model: "claude-pin-v1",
        thinking: { type: "adaptive" },
        output_config: { effort: "high" }
      })
    });

    const first = await sendMessages(activeFixture, "session-pin-token", "pin-session");
    expect(first.status).toBe(200);
    expect(lastAnthropicModel(activeFixture)).toBe("claude-pin-v1");

    await publishVersion(activeFixture, organizationId, assigned.configId, {
      version: 2,
      configHash: "sha256:session-pin-v2",
      configure: (config) => withHardAnthropic(config, {
        model: "claude-pin-v2",
        thinking: { type: "adaptive" },
        output_config: { effort: "max" }
      })
    });

    const second = await sendMessages(activeFixture, "session-pin-token", "pin-session");
    expect(second.status).toBe(200);
    const pinnedCall = activeFixture.anthropic.records.at(-1);
    expect(pinnedCall?.body.model).toBe("claude-pin-v1");
    expect(pinnedCall?.body.output_config.effort).toBe("high");

    const keptDecision = await lastDecisionPayload(activeFixture);
    expect(keptDecision?.guardrailActions).toContain("session_route_kept");
    expect(keptDecision?.guardrailActions).toContain("session_settings_pinned");

    const third = await sendMessages(activeFixture, "session-pin-token", "fresh-session");
    expect(third.status).toBe(200);
    const freshCall = activeFixture.anthropic.records.at(-1);
    expect(freshCall?.body.model).toBe("claude-pin-v2");
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
        output_config: { effort: "high" }
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
        output_config: { effort: "high" }
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
      .where(eq(agentSessions.id, `${organizationId}:anthropic-messages:upgrade-session`));
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
        output_config: { effort: "high" }
      })
    });
    await activeFixture.db.insert(agentSessions).values({
      id: `${organizationId}:anthropic-messages:stale-session`,
      organizationId,
      surface: "anthropic-messages",
      externalSessionId: "stale-session",
      currentRoute: "hard",
      pinnedSettings: {
        provider: "openai",
        model: "gpt-stale-pin",
        openai: { model: "gpt-stale-pin" }
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
});

function routeContext(organizationId: string, sessionId: string): RouteContext {
  return {
    organizationId,
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

function lastAnthropicModel(fixture: PromptTestFixture) {
  return fixture.anthropic.records.at(-1)?.body.model;
}

async function lastDecisionPayload(fixture: PromptTestFixture) {
  const eventRows = await fixture.db.select().from(events);
  const decision = eventRows
    .filter((event) => event.eventType === "routing.decision_recorded")
    .at(-1);
  return decision?.payload as { guardrailActions?: string[] } | undefined;
}

function withHardAnthropic(
  config: RoutingConfig,
  anthropic: NonNullable<RoutingConfig["routes"]["hard"]["anthropic"]>
): RoutingConfig {
  return {
    ...config,
    routes: {
      ...config.routes,
      hard: {
        ...config.routes.hard,
        anthropic
      }
    }
  };
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
    name: "Session pin config",
    slug: input.slug,
    status: "active"
  });
  await fixture.db.insert(routingConfigVersions).values({
    id: versionId,
    organizationId,
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
