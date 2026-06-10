import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  apiKeys,
  events,
  hashApiKey,
  organizationSettings,
  routingConfigs,
  routingConfigVersions
} from "@prompt-proxy/db";
import { seedDatabase, seedOptionsFromEnv } from "@prompt-proxy/db/seed";
import { composeClassifierInstructions, type RoutingConfig } from "@prompt-proxy/schema";

import { captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

describe("routing config runtime resolution", () => {
  let activeFixture: PromptTestFixture | undefined;

  afterEach(async () => {
    await activeFixture?.close();
    activeFixture = undefined;
  });

  it("rejects invalid active configs before classifier spend", async () => {
    const organizationId = "org_invalid_runtime_config";
    activeFixture = await captureFixture(organizationId);
    await seedDatabase(activeFixture.db, seedOptionsFromEnv({
      DEFAULT_ORGANIZATION_ID: organizationId,
      SEED_USER_ID: "local-user",
      PROMPT_PROXY_TOKEN: "proxy-token"
    }));
    await activeFixture.db
      .update(routingConfigVersions)
      .set({ config: { schemaVersion: 1 } as never })
      .where(eq(routingConfigVersions.id, `${organizationId}:routing-config:default:v1`));

    const response = await fetch(`${activeFixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: "debug this failing test",
        stream: true
      })
    });
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).toContain("routing_config_invalid");
    expect(activeFixture.openai.records).toHaveLength(0);
  });

  it("uses API-key routing config classifier settings", async () => {
    const organizationId = "org_config_classifier";
    activeFixture = await captureFixture(organizationId);
    const assigned = await assignClassifierConfig(activeFixture, organizationId, {
      secret: "assigned-classifier-token",
      model: "route-classifier-alt",
      rules: "Custom classifier rules for assigned API keys.",
      maxAttempts: 1,
      allowRedactedExcerpt: true
    });

    const response = await fetch(`${activeFixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer assigned-classifier-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: "debug this failing test",
        stream: true
      })
    });
    await response.text();

    const classifierCall = activeFixture.openai.records.find((record) =>
      record.body.model === "route-classifier-alt"
    );
    const classifierInput = JSON.parse(classifierCall?.body.input ?? "{}");
    const eventRows = await activeFixture.db.select().from(events);
    const classification = eventRows.find((event) => event.eventType === "routing.classification_recorded");
    const decision = eventRows.find((event) => event.eventType === "routing.decision_recorded");

    expect(response.status).toBe(200);
    expect(classifierCall).toBeTruthy();
    expect(classifierCall?.body.instructions).toBe(
      composeClassifierInstructions("Custom classifier rules for assigned API keys.")
    );
    expect(classifierCall?.body.text.format.name).toBe(assigned.config.classifier.structuredOutput.schemaName);
    expect(classifierInput.content_mode).toBe("redacted_excerpt");
    expect(classification?.payload).toEqual(expect.objectContaining({
      model: "route-classifier-alt",
      routingConfig: expect.objectContaining({
        configId: assigned.configId,
        versionId: assigned.versionId,
        configHash: assigned.configHash
      })
    }));
    expect(decision?.payload).toEqual(expect.objectContaining({
      routingConfig: expect.objectContaining({
        configId: assigned.configId,
        versionId: assigned.versionId,
        configHash: assigned.configHash
      }),
      classifier: expect.objectContaining({
        provider: "openai",
        model: "route-classifier-alt",
        routingConfigVersionId: assigned.versionId,
        routingConfigHash: assigned.configHash
      })
    }));
  });

  it("uses API-key routing config classifier retry limits", async () => {
    const organizationId = "org_config_classifier_retry";
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      openAIOptions: { invalidClassifier: true }
    });
    await assignClassifierConfig(activeFixture, organizationId, {
      secret: "retry-classifier-token",
      model: "route-classifier-retry-once",
      rules: "Retry once for assigned API keys.",
      maxAttempts: 1,
      allowRedactedExcerpt: false
    });

    const response = await fetch(`${activeFixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer retry-classifier-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: "debug this failing test",
        stream: false
      })
    });
    await response.text();

    expect(response.status).toBe(500);
    expect(activeFixture.openai.records.filter((record) =>
      record.body.model === "route-classifier-retry-once"
    )).toHaveLength(1);
  });

  it("uses OpenAI route tier settings from the assigned routing config", async () => {
    const organizationId = "org_config_openai_routes";
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      openAIOptions: {
        classifierOutput: {
          complexity: "hard",
          risk: ["debugging"],
          recommended_route: "hard",
          can_use_fast_model: false,
          needs_deep_reasoning: false,
          reason_codes: ["config_route_test"],
          confidence: 0.91
        }
      }
    });
    await assignRouteConfig(activeFixture, organizationId, {
      secret: "assigned-openai-route-token",
      slug: "openai-route",
      configHash: "sha256:openai-route-config",
      configure: (config) => ({
        ...config,
        routes: {
          ...config.routes,
          hard: {
            ...config.routes.hard,
            openai: {
              model: "gpt-config-hard",
              reasoning: { effort: "xhigh" },
              text: { verbosity: "high" },
              maxOutputTokens: 1234
            }
          }
        }
      })
    });

    const response = await fetch(`${activeFixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer assigned-openai-route-token",
        "content-type": "application/json",
        "x-codex-turn-state": "turn-state-config",
        "x-request-id": "request-id-config"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: "debug this failing test",
        tools: [{ type: "function", name: "shell" }],
        previous_response_id: "resp_config_previous",
        stream: true,
        include: ["reasoning.encrypted_content"]
      })
    });
    await response.text();

    const providerCall = activeFixture.openai.records.find((record) =>
      record.body.model === "gpt-config-hard"
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-prompt-proxy-route")).toBe("hard");
    expect(response.headers.get("x-prompt-proxy-reasoning-effort")).toBe("xhigh");
    expect(providerCall).toBeTruthy();
    expect(providerCall?.body.reasoning.effort).toBe("xhigh");
    expect(providerCall?.body.text.verbosity).toBe("high");
    expect(providerCall?.body.max_output_tokens).toBe(1234);
    expect(providerCall?.body.tools).toEqual([{ type: "function", name: "shell" }]);
    expect(providerCall?.body.previous_response_id).toBe("resp_config_previous");
    expect(providerCall?.body.include).toEqual(["reasoning.encrypted_content"]);
    expect(providerCall?.headers["x-codex-turn-state"]).toBe("turn-state-config");
    expect(providerCall?.headers["x-request-id"]).toBe("request-id-config");

    const eventRows = await activeFixture.db.select().from(events);
    const decision = eventRows.find((event) => event.eventType === "routing.decision_recorded");
    expect(decision?.payload).not.toHaveProperty("providerSettings");
  });

  it("uses Anthropic route tier settings from the assigned routing config", async () => {
    const organizationId = "org_config_anthropic_routes";
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      openAIOptions: {
        classifierOutput: {
          complexity: "deep",
          risk: ["architecture"],
          recommended_route: "deep",
          can_use_fast_model: false,
          needs_deep_reasoning: true,
          reason_codes: ["deep_architecture"],
          confidence: 0.94
        }
      }
    });
    await assignRouteConfig(activeFixture, organizationId, {
      secret: "assigned-anthropic-route-token",
      slug: "anthropic-route",
      configHash: "sha256:anthropic-route-config",
      configure: (config) => ({
        ...config,
        routes: {
          ...config.routes,
          deep: {
            ...config.routes.deep,
            anthropic: {
              model: "claude-config-deep",
              thinking: { type: "adaptive", display: "summarized" },
              output_config: { effort: "max" },
              maxTokens: 4096
            }
          }
        }
      })
    });

    const response = await fetch(`${activeFixture.proxyUrl}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer assigned-anthropic-route-token",
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-claude-code-session-id": "claude-session-config"
      },
      body: JSON.stringify({
        model: "claude-router-auto",
        messages: [{ role: "user", content: "scope an event-driven system design" }],
        tools: [{ name: "shell", input_schema: { type: "object", properties: {} } }],
        stream: true
      })
    });
    await response.text();

    const providerCall = activeFixture.anthropic.records.find((record) =>
      record.body.model === "claude-config-deep"
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-prompt-proxy-route")).toBe("deep");
    expect(response.headers.get("x-prompt-proxy-reasoning-effort")).toBe("max");
    expect(providerCall).toBeTruthy();
    expect(providerCall?.body.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(providerCall?.body.output_config.effort).toBe("max");
    expect(providerCall?.body.max_tokens).toBe(4096);
    expect(providerCall?.body.tools).toEqual([
      { name: "shell", input_schema: { type: "object", properties: {} } }
    ]);
    expect(providerCall?.headers["x-claude-code-session-id"]).toBe("claude-session-config");
  });

  it("prepends the organization system prompt to OpenAI Responses instructions", async () => {
    const organizationId = "org_system_prompt_openai";
    activeFixture = await captureFixture(organizationId);
    const sendRequest = (input: string) => fetch(`${activeFixture!.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "router-hard",
        instructions: "You are Codex.",
        input,
        stream: true
      })
    });

    const beforeResponse = await sendRequest("debug this failing test");
    await beforeResponse.text();
    await activeFixture.db
      .update(organizationSettings)
      .set({ systemPrompt: "Follow organization proxy policy." })
      .where(eq(organizationSettings.organizationId, organizationId));
    const response = await sendRequest("debug this other failing test");
    await response.text();

    const providerCalls = activeFixture.openai.records.filter((record) =>
      record.body.model !== "route-classifier-cheap" && record.path === "/responses"
    );

    expect(beforeResponse.status).toBe(200);
    expect(response.status).toBe(200);
    expect(providerCalls[0]?.body.instructions).toBe("You are Codex.");
    expect(providerCalls[1]?.body.instructions).toBe("Follow organization proxy policy.\n\nYou are Codex.");
  });

  it("prepends the organization system prompt to Anthropic Messages system blocks", async () => {
    const organizationId = "org_system_prompt_anthropic";
    activeFixture = await captureFixture(organizationId);
    await activeFixture.db
      .update(organizationSettings)
      .set({ systemPrompt: "Follow organization proxy policy." })
      .where(eq(organizationSettings.organizationId, organizationId));

    const response = await fetch(`${activeFixture.proxyUrl}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json",
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-router-hard",
        system: [{ type: "text", text: "You are Claude Code." }],
        messages: [{ role: "user", content: "debug this failing test" }],
        stream: true,
        max_tokens: 4096
      })
    });
    await response.text();

    const countResponse = await fetch(`${activeFixture.proxyUrl}/v1/messages/count_tokens`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json",
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-router-hard",
        system: "You are Claude Code.",
        messages: [{ role: "user", content: "debug this failing test" }]
      })
    });
    await countResponse.text();

    const providerCall = activeFixture.anthropic.records.find((record) => record.path === "/messages");
    const countCall = activeFixture.anthropic.records.find((record) => record.path === "/messages/count_tokens");

    expect(response.status).toBe(200);
    expect(providerCall?.body.system).toEqual([
      { type: "text", text: "Follow organization proxy policy." },
      { type: "text", text: "You are Claude Code." }
    ]);
    expect(countResponse.status).toBe(200);
    expect(countCall?.body.system).toBe("Follow organization proxy policy.\n\nYou are Claude Code.");
  });

  it("rejects when the selected route is unavailable for the incoming surface", async () => {
    const organizationId = "org_config_missing_surface_route";
    activeFixture = await captureFixture(organizationId);
    await assignRouteConfig(activeFixture, organizationId, {
      secret: "assigned-missing-surface-token",
      slug: "missing-surface",
      configHash: "sha256:missing-surface-config",
      configure: (config) => ({
        ...config,
        routes: {
          ...config.routes,
          hard: {
            ...config.routes.hard,
            openai: undefined
          }
        }
      })
    });

    const response = await fetch(`${activeFixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer assigned-missing-surface-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: "debug this failing test",
        stream: true
      })
    });
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).toContain("route_not_available_for_surface");
    expect(activeFixture.openai.records.filter((record) =>
      record.body.model !== "route-classifier-cheap"
    )).toHaveLength(0);
  });
});

async function assignClassifierConfig(
  fixture: PromptTestFixture,
  organizationId: string,
  input: {
    secret: string;
    model: string;
    rules: string;
    maxAttempts: number;
    allowRedactedExcerpt: boolean;
  }
) {
  const configId = `${organizationId}:routing-config:classifier`;
  const versionId = `${configId}:v1`;
  const configHash = "sha256:classifier-config";
  const defaultVersion = await activeVersion(fixture, `${organizationId}:routing-config:default:v1`);
  const config = {
    ...defaultVersion.config,
    displayName: "Assigned classifier router",
    classifier: {
      ...defaultVersion.config.classifier,
      model: input.model,
      rules: input.rules,
      maxAttempts: input.maxAttempts,
      allowRedactedExcerpt: input.allowRedactedExcerpt
    }
  };

  await fixture.db.insert(routingConfigs).values({
    id: configId,
    organizationId,
    name: "Assigned classifier config",
    slug: "classifier",
    status: "active"
  });
  await fixture.db.insert(routingConfigVersions).values({
    id: versionId,
    organizationId,
    routingConfigId: configId,
    version: 1,
    configHash,
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
    id: "api_key_classifier",
    organizationId,
    keyHash: hashApiKey(input.secret),
    name: "Assigned classifier key",
    routingConfigId: configId,
    scopes: ["proxy"]
  });

  return {
    configId,
    versionId,
    configHash,
    config
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
  const defaultVersion = await activeVersion(fixture, `${organizationId}:routing-config:default:v1`);
  const config = input.configure(structuredClone(defaultVersion.config as RoutingConfig));

  await fixture.db.insert(routingConfigs).values({
    id: configId,
    organizationId,
    name: "Assigned route config",
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
    name: "Assigned route key",
    routingConfigId: configId,
    scopes: ["proxy"]
  });

  return {
    configId,
    versionId,
    configHash: input.configHash,
    config
  };
}

async function activeVersion(
  fixture: PromptTestFixture,
  versionId: string
) {
  const [version] = await fixture.db
    .select()
    .from(routingConfigVersions)
    .where(eq(routingConfigVersions.id, versionId))
    .limit(1);
  expect(version).toBeTruthy();
  return version!;
}
