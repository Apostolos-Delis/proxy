import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import {
  agentSessions,
  apiKeyProviderAccounts,
  apiKeys,
  defaultWorkspaceId,
  encryptSecret,
  events,
  hashApiKey,
  modelCatalog,
  promptArtifacts,
  providers,
  providerAttempts,
  providerAccounts,
  providerAccountHealth,
  providerModelHealth,
  routingConfigs,
  routingConfigVersions
} from "@proxy/db";
import { seedDatabase, seedOptionsFromEnv } from "@proxy/db/seed";
import {
  composeClassifierInstructions,
  type RoutingConfig,
  type RoutingConfigAnthropicDeployment,
  type RoutingConfigOpenAIDeployment
} from "@proxy/schema";

import { startOpenAIMock } from "./helpers.js";
import { adminGql, captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
const OPENAI_PROVIDER_ID = "00000000-0000-0000-0000-000000000001";

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
      PROXY_TOKEN: "proxy-token"
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

    expect(response.status).toBe(200);
    // Classifier failure falls back to the routing config's limits.fallbackRoute
    // (seeded as "hard"), not the no-config "balanced" constant.
    expect(response.headers.get("x-proxy-route")).toBe("hard");
    expect(activeFixture.openai.records.filter((record) =>
      record.body.model === "route-classifier-retry-once"
    )).toHaveLength(1);
  });

  it("uses the routing config fallback route when the classifier fails", async () => {
    const organizationId = "org_config_fallback_route";
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      openAIOptions: { invalidClassifier: true }
    });
    await assignRouteConfig(activeFixture, organizationId, {
      secret: "fallback-route-token",
      slug: "fallback-route",
      configHash: "sha256:fallback-route-config",
      configure: (config) => {
        config.limits = { ...config.limits, fallbackRoute: "fast" };
        return config;
      }
    });

    const response = await fetch(`${activeFixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer fallback-route-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: "debug this failing test",
        stream: false
      })
    });
    await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-proxy-route")).toBe("fast");
  });

  it("escalates past fallback-route surface gaps when the classifier fails", async () => {
    const organizationId = "org_config_fallback_gap";
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      openAIOptions: { invalidClassifier: true }
    });
    await assignRouteConfig(activeFixture, organizationId, {
      secret: "fallback-gap-token",
      slug: "fallback-gap",
      configHash: "sha256:fallback-gap-config",
      configure: (config) => {
        return withHardTargets(config, [
          { providerId: "missing-hard-provider", model: "missing-hard-model", effort: "high" }
        ]);
      }
    });

    const response = await fetch(`${activeFixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer fallback-gap-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: "debug this failing test",
        stream: false
      })
    });
    await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-proxy-route")).toBe("fast");
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
              deployments: [{
                ...config.routes.hard.openai!.deployments[0],
                model: "gpt-config-hard",
                reasoning: { effort: "xhigh" },
                text: { verbosity: "high" },
                maxOutputTokens: 1234
              }]
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
    const body = await response.text();

    const providerCall = activeFixture.openai.records.find((record) =>
      record.body.model === "gpt-config-hard"
    );

    expect(response.status, body).toBe(200);
    expect(response.headers.get("x-proxy-route")).toBe("hard");
    expect(response.headers.get("x-proxy-reasoning-effort")).toBe("xhigh");
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
    const eventTypes = eventRows
      .filter((event) => event.scopeType === "request")
      .sort((left, right) => left.sequence - right.sequence)
      .map((event) => event.eventType);
    const planIndex = eventTypes.indexOf("routing.plan_recorded");
    expect(planIndex).toBeGreaterThan(-1);
    expect(planIndex).toBeLessThan(eventTypes.indexOf("routing.decision_recorded"));
    expect(planIndex).toBeLessThan(eventTypes.indexOf("provider.request_started"));
    const providerStarted = eventRows.find((event) => event.eventType === "provider.request_started");
    expect(providerStarted?.payload).toMatchObject({
      routeCandidateId: "candidate_1",
      attemptIndex: 0,
      fallbackIndex: 0
    });
    const plan = eventRows.find((event) => event.eventType === "routing.plan_recorded");
    const decision = eventRows.find((event) => event.eventType === "routing.decision_recorded");
    expect(decision?.payload).not.toHaveProperty("providerSettings");
    expect(decision?.payload).not.toHaveProperty("routeExecutionPlan");
    const routeExecutionPlan = plan?.payload.routeExecutionPlan as Record<string, any> | undefined;
    expect(routeExecutionPlan).toMatchObject({
      schemaVersion: 1,
      requestId: plan?.scopeId,
      organizationId,
      workspaceId: `${organizationId}:workspace:default`,
      surface: "openai-responses",
      dialect: "openai-responses",
      routingConfig: {
        hash: "sha256:openai-route-config"
      },
      selected: {
        candidateId: "candidate_1",
        providerId: "openai",
        model: "gpt-config-hard",
        dialect: "openai-responses",
        translated: false
      }
    });
    expect(routeExecutionPlan?.candidates).toEqual([
      expect.objectContaining({
        id: "candidate_0",
        order: 0,
        providerId: "anthropic",
        translated: true,
        compatible: false,
        eligible: false,
        skipReasons: ["target_unavailable_previous_response_id"]
      }),
      expect.objectContaining({
        id: "candidate_1",
        order: 1,
        providerId: "openai",
        model: "gpt-config-hard",
        endpointDialect: "openai-responses",
        translated: false,
        compatible: true,
        eligible: true,
        factors: expect.objectContaining({
          nativeDialect: true,
          capabilityMatch: true,
          budgetAllowed: true
        })
      })
    ]);
    expect(routeExecutionPlan?.policyResults).toEqual([
      expect.objectContaining({
        policy: "budget_route_route_limit",
        status: "allowed",
        skipReason: null,
        current: "hard",
        limit: "deep"
      })
    ]);
    expect(routeExecutionPlan?.candidates?.[1]).not.toHaveProperty("providerSettings");
  });

  it("records missing credential and budget evidence in route plan candidates", async () => {
    const organizationId = "org_config_route_plan_missing_credential";
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      envOverrides: { ALLOWED_PRIVATE_UPSTREAM_CIDRS: "127.0.0.0/8" },
      openAIOptions: {
        classifierOutput: {
          complexity: "hard",
          risk: ["debugging"],
          recommended_route: "hard",
          can_use_fast_model: false,
          needs_deep_reasoning: false,
          reason_codes: ["missing_credential_plan"],
          confidence: 0.91
        }
      }
    });
    await activeFixture.db.insert(providers).values({
      id: "00000000-0000-0000-0000-00000000e019",
      organizationId,
      slug: "acme-needs-key",
      displayName: "Acme needs key",
      baseUrl: activeFixture.openai.url,
      authStyle: "bearer",
      endpoints: [{ dialect: "openai-responses", path: "/responses" }],
      defaultHeaders: {},
      forwardHarnessHeaders: false,
      enabled: true
    });
    await assignRouteConfig(activeFixture, organizationId, {
      secret: "missing-credential-plan-token",
      slug: "missing-credential-plan",
      configHash: "sha256:missing-credential-plan-config",
      configure: (config) => ({
        ...config,
        routes: {
          ...config.routes,
          hard: withHardTargets(config, [
            {
              providerId: "acme-needs-key",
              model: "acme-hard",
              effort: "high",
              verbosity: "medium"
            },
            {
              providerId: "openai",
              model: "gpt-credential-plan",
              effort: "high",
              verbosity: "medium"
            }
          ]).routes.hard
        }
      })
    });

    const response = await fetch(`${activeFixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer missing-credential-plan-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: "debug this route plan",
        stream: true
      })
    });
    const body = await response.text();

    const providerCall = activeFixture.openai.records.find((record) =>
      record.body.model === "gpt-credential-plan"
    );
    const eventRows = await activeFixture.db.select().from(events);
    const decision = eventRows.find((event) => event.eventType === "routing.decision_recorded");
    const plan = eventRows.find((event) => event.eventType === "routing.plan_recorded");
    expect(decision?.payload).not.toHaveProperty("routeExecutionPlan");
    const routeExecutionPlan = plan?.payload.routeExecutionPlan as Record<string, any> | undefined;

    expect(response.status, body).toBe(200);
    expect(providerCall).toBeTruthy();
    expect(routeExecutionPlan?.selected).toEqual(expect.objectContaining({
      candidateId: "candidate_1",
      providerId: "openai",
      model: "gpt-credential-plan",
      providerAccountId: null
    }));
    expect(routeExecutionPlan?.candidates).toEqual([
      expect.objectContaining({
        id: "candidate_0",
        providerId: "acme-needs-key",
        eligible: false,
        skipReasons: ["target_skipped_missing_credential"],
        factors: expect.objectContaining({
          accountAvailable: false,
          budgetAllowed: true,
          rateLimitAllowed: null
        })
      }),
      expect.objectContaining({
        id: "candidate_1",
        providerId: "openai",
        eligible: true,
        skipReasons: [],
        factors: expect.objectContaining({
          accountAvailable: true,
          budgetAllowed: true,
          rateLimitAllowed: null
        })
      })
    ]);
    expect(routeExecutionPlan?.policyResults).toEqual([
      expect.objectContaining({
        policy: "budget_route_route_limit",
        status: "allowed",
        current: "hard",
        limit: "deep"
      })
    ]);
  });

  it("omits effort for custom providers without effort capabilities", async () => {
    const organizationId = "org_config_custom_no_effort_capability";
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      envOverrides: { ALLOWED_PRIVATE_UPSTREAM_CIDRS: "127.0.0.0/8" },
      openAIOptions: {
        classifierOutput: {
          complexity: "hard",
          risk: ["debugging"],
          recommended_route: "hard",
          can_use_fast_model: false,
          needs_deep_reasoning: false,
          reason_codes: ["custom_provider_no_effort_capability"],
          confidence: 0.91
        }
      }
    });
    await activeFixture.db.insert(providers).values({
      id: "00000000-0000-0000-0000-00000000e017",
      organizationId,
      slug: "acme-no-effort",
      displayName: "Acme no effort",
      baseUrl: activeFixture.openai.url,
      authStyle: "none",
      endpoints: [{ dialect: "openai-responses", path: "/responses" }],
      defaultHeaders: {},
      forwardHarnessHeaders: false,
      enabled: true
    });
    await assignRouteConfig(activeFixture, organizationId, {
      secret: "custom-no-effort-token",
      slug: "custom-no-effort",
      configHash: "sha256:custom-no-effort-config",
      configure: (config) => ({
        ...config,
        routes: {
          ...config.routes,
          hard: withHardTargets(config, [
            { providerId: "acme-no-effort", model: "acme-hard" }
          ]).routes.hard
        }
      })
    });

    const response = await fetch(`${activeFixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer custom-no-effort-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: "debug this failing test",
        stream: false
      })
    });
    await response.text();

    const providerCall = activeFixture.openai.records.find((record) =>
      record.body.model === "acme-hard"
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-proxy-reasoning-effort")).toBeNull();
    expect(providerCall).toBeTruthy();
    expect(providerCall?.body.reasoning).toBeUndefined();
  });

  it("routes OpenAI Chat traffic to an org-scoped OpenAI-compatible provider", async () => {
    const organizationId = "org_config_custom_chat_provider";
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      envOverrides: { ALLOWED_PRIVATE_UPSTREAM_CIDRS: "127.0.0.0/8" }
    });
    await activeFixture.db.insert(providers).values({
      id: "00000000-0000-0000-0000-00000000c017",
      organizationId,
      slug: "custom-chat",
      displayName: "Custom Chat",
      baseUrl: activeFixture.openai.url,
      authStyle: "none",
      endpoints: [{ dialect: "openai-chat", path: "/chat/completions" }],
      defaultHeaders: {},
      forwardHarnessHeaders: false,
      enabled: true
    });
    await assignRouteConfig(activeFixture, organizationId, {
      secret: "custom-chat-route-token",
      slug: "custom-chat-route",
      configHash: "sha256:custom-chat-route-config",
      configure: (config) => withHardTargets(config, [
        { providerId: "custom-chat", model: "llama-custom-chat" }
      ])
    });

    const response = await fetch(`${activeFixture.proxyUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer custom-chat-route-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "router-hard",
        messages: [{ role: "user", content: "debug this chat route" }],
        stream: false
      })
    });
    const body = await response.text();

    const providerCall = activeFixture.openai.records.find((record) =>
      record.path === "/chat/completions" && record.body.model === "llama-custom-chat"
    );
    const eventRows = await activeFixture.db.select().from(events);
    const plan = eventRows.find((event) => event.eventType === "routing.plan_recorded");
    const routeExecutionPlan = plan?.payload.routeExecutionPlan as Record<string, any> | undefined;

    expect(response.status, body).toBe(200);
    expect(response.headers.get("x-proxy-route")).toBe("hard");
    expect(providerCall).toBeTruthy();
    expect(providerCall?.body.messages).toEqual([{ role: "user", content: "debug this chat route" }]);
    expect(routeExecutionPlan?.selected).toEqual(expect.objectContaining({
      providerId: "custom-chat",
      model: "llama-custom-chat",
      dialect: "openai-chat",
      translated: false
    }));
    expect(routeExecutionPlan?.candidates).toEqual([
      expect.objectContaining({
        providerId: "custom-chat",
        model: "llama-custom-chat",
        endpointDialect: "openai-chat",
        translated: false,
        compatible: true,
        eligible: true,
        factors: expect.objectContaining({
          nativeDialect: true,
          capabilityMatch: true
        })
      })
    ]);
  });

  it("records explicit skip evidence for unsupported custom model capabilities", async () => {
    const organizationId = "org_config_custom_model_capability_skip";
    const customProviderId = "00000000-0000-0000-0000-00000000c018";
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      envOverrides: { ALLOWED_PRIVATE_UPSTREAM_CIDRS: "127.0.0.0/8" }
    });
    await activeFixture.db.insert(providers).values({
      id: customProviderId,
      organizationId,
      slug: "custom-chat-no-tools",
      displayName: "Custom Chat No Tools",
      baseUrl: activeFixture.openai.url,
      authStyle: "none",
      endpoints: [{ dialect: "openai-chat", path: "/chat/completions" }],
      defaultHeaders: {},
      forwardHarnessHeaders: false,
      enabled: true
    });
    await activeFixture.db.insert(modelCatalog).values({
      id: "model:custom-chat-no-tools",
      organizationId,
      providerId: customProviderId,
      model: "llama-no-tools",
      catalogSource: "manual",
      capabilities: { source: "manual", toolCall: false, contextWindow: 128000 },
      pricing: { source: "manual" }
    });
    await assignRouteConfig(activeFixture, organizationId, {
      secret: "custom-chat-capability-route-token",
      slug: "custom-chat-capability-route",
      configHash: "sha256:custom-chat-capability-route-config",
      configure: (config) => withHardTargets(config, [
        { providerId: "custom-chat-no-tools", model: "llama-no-tools" },
        { providerId: "openai", model: "gpt-chat-fallback" }
      ])
    });

    const response = await fetch(`${activeFixture.proxyUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer custom-chat-capability-route-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "router-hard",
        messages: [{ role: "user", content: "use a tool" }],
        tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }],
        stream: false
      })
    });
    const body = await response.text();

    const eventRows = await activeFixture.db.select().from(events);
    const plan = eventRows.find((event) => event.eventType === "routing.plan_recorded");
    const routeExecutionPlan = plan?.payload.routeExecutionPlan as Record<string, any> | undefined;
    const providerCall = activeFixture.openai.records.find((record) =>
      record.path === "/chat/completions" && record.body.model === "gpt-chat-fallback"
    );

    expect(response.status, body).toBe(200);
    expect(providerCall).toBeTruthy();
    expect(routeExecutionPlan?.selected).toEqual(expect.objectContaining({
      candidateId: "candidate_1",
      providerId: "openai",
      model: "gpt-chat-fallback",
      translated: false
    }));
    expect(routeExecutionPlan?.candidates).toEqual([
      expect.objectContaining({
        id: "candidate_0",
        providerId: "custom-chat-no-tools",
        model: "llama-no-tools",
        endpointDialect: "openai-chat",
        translated: false,
        compatible: false,
        eligible: false,
        skipReasons: ["target_unavailable_tool_capability"],
        factors: expect.objectContaining({
          nativeDialect: true,
          capabilityMatch: false,
          contextWindowOk: true
        })
      }),
      expect.objectContaining({
        id: "candidate_1",
        providerId: "openai",
        model: "gpt-chat-fallback",
        endpointDialect: "openai-chat",
        eligible: true
      })
    ]);
  });

  it("records Bedrock target compatibility without making AWS calls", async () => {
    const organizationId = "org_config_bedrock_translator_skip";
    activeFixture = await captureFixture(organizationId, "raw_text", false);
    await assignRouteConfig(activeFixture, organizationId, {
      secret: "bedrock-translator-skip-token",
      slug: "bedrock-translator-skip-route",
      configHash: "sha256:bedrock-translator-skip-route-config",
      configure: (config) => withHardTargets(config, [
        { providerId: "amazon-bedrock", model: "amazon.nova-pro-v1:0" },
        { providerId: "openai", model: "gpt-chat-fallback" }
      ])
    });

    const response = await fetch(`${activeFixture.proxyUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer bedrock-translator-skip-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "router-hard",
        messages: [{ role: "user", content: "debug this chat route" }],
        stream: false
      })
    });
    const body = await response.text();

    const eventRows = await activeFixture.db.select().from(events);
    const plan = eventRows.find((event) => event.eventType === "routing.plan_recorded");
    const routeExecutionPlan = plan?.payload.routeExecutionPlan as Record<string, any> | undefined;

    expect(response.status, body).toBe(200);
    expect(activeFixture.openai.records.some((record) => record.body.model === "gpt-chat-fallback")).toBe(true);
    expect(routeExecutionPlan?.selected).toEqual(expect.objectContaining({
      candidateId: "candidate_1",
      providerId: "openai",
      model: "gpt-chat-fallback",
      dialect: "openai-chat"
    }));
    expect(routeExecutionPlan?.candidates?.[0]).toMatchObject({
      providerId: "amazon-bedrock",
      model: "amazon.nova-pro-v1:0",
      endpointDialect: "bedrock-converse",
      translated: true,
      compatible: false,
      eligible: false,
      skipReasons: ["target_skipped_missing_credential"],
      factors: expect.objectContaining({
        nativeDialect: false
      })
    });
  });

  it("routes WebSocket requests to custom responses providers", async () => {
    const organizationId = "org_config_custom_ws_provider";
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      envOverrides: {
        ALLOWED_PRIVATE_UPSTREAM_CIDRS: "127.0.0.0/8"
      }
    });
    await activeFixture.db.insert(providers).values({
      id: "00000000-0000-0000-0000-00000000c015",
      organizationId,
      slug: "custom-responses",
      displayName: "Custom Responses",
      baseUrl: activeFixture.openai.url,
      authStyle: "none",
      endpoints: [{ dialect: "openai-responses", path: "/responses" }],
      defaultHeaders: {},
      forwardHarnessHeaders: false,
      enabled: true
    });
    await assignRouteConfig(activeFixture, organizationId, {
      secret: "custom-ws-route-token",
      slug: "custom-ws",
      configHash: "sha256:custom-ws-route-config",
      configure: (config) => ({
        ...config,
        routes: {
          ...config.routes,
          hard: withHardTargets(config, [{
            providerId: "custom-responses",
            model: "gpt-custom-ws",
            effort: "high",
            verbosity: "medium"
          }]).routes.hard
        }
      })
    });

    const ws = new WebSocket(activeFixture.proxyUrl.replace("http://", "ws://") + "/v1/responses", {
      headers: {
        authorization: "Bearer custom-ws-route-token",
        "openai-beta": "responses_websockets=2026-02-06",
        session_id: "custom-ws-session"
      }
    });
    await websocketOpen(ws);
    ws.send(JSON.stringify({
      type: "response.create",
      model: "router-hard",
      input: "debug this failing websocket route",
      stream: true
    }));
    await nextWebSocketCompletion(ws);
    ws.close();

    const eventRows = await activeFixture.db.select().from(events);
    const decision = eventRows.find((event) => event.eventType === "routing.decision_recorded");
    const providerCalls = activeFixture.openai.records.filter((record) => record.body.type === "response.create");

    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0]?.path).toBe("/responses");
    expect(providerCalls[0]?.body.model).toBe("gpt-custom-ws");
    expect(providerCalls[0]?.headers["openai-beta"]).toBe("responses_websockets=2026-02-06");
    expect(decision?.payload).toEqual(expect.objectContaining({
      outcome: "route",
      provider: "custom-responses",
      selectedModel: "gpt-custom-ws"
    }));
    expect(eventRows.filter((event) => event.eventType === "provider.response_completed")).toHaveLength(1);
  });

  it("routes WebSocket requests with bound custom provider credentials", async () => {
    const organizationId = "org_config_custom_ws_byok";
    const providerId = "00000000-0000-0000-0000-00000000c016";
    const providerAccountId = `${organizationId}:provider-account:custom-ws`;
    const routeSlug = "custom-ws-byok";
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      envOverrides: {
        ALLOWED_PRIVATE_UPSTREAM_CIDRS: "127.0.0.0/8",
        PROVIDER_SECRET_ENCRYPTION_KEY: ENCRYPTION_KEY
      }
    });
    await activeFixture.db.insert(providers).values({
      id: providerId,
      organizationId,
      slug: "custom-responses-byok",
      displayName: "Custom Responses BYOK",
      baseUrl: activeFixture.openai.url,
      authStyle: "bearer",
      endpoints: [{ dialect: "openai-responses", path: "/responses" }],
      defaultHeaders: { "x-custom-provider": "byok" },
      forwardHarnessHeaders: false,
      enabled: true
    });
    await activeFixture.db.insert(providerAccounts).values({
      id: providerAccountId,
      organizationId,
      providerId,
      name: "Custom WS key",
      authType: "api_key",
      secretCiphertext: encryptSecret("sk-custom-ws", ENCRYPTION_KEY),
      secretHint: "••••m-ws",
      settings: {}
    });
    await assignRouteConfig(activeFixture, organizationId, {
      secret: "custom-ws-byok-route-token",
      slug: routeSlug,
      configHash: "sha256:custom-ws-byok-route-config",
      configure: (config) => ({
        ...config,
        routes: {
          ...config.routes,
          hard: withHardTargets(config, [{
            providerId: "custom-responses-byok",
            model: "gpt-custom-ws-byok",
            effort: "high",
            verbosity: "medium"
          }]).routes.hard
        }
      })
    });
    await activeFixture.db.insert(apiKeyProviderAccounts).values({
      organizationId,
      workspaceId: defaultWorkspaceId(organizationId),
      apiKeyId: `api_key_${routeSlug}`,
      providerId,
      providerAccountId
    });

    const ws = new WebSocket(activeFixture.proxyUrl.replace("http://", "ws://") + "/v1/responses", {
      headers: {
        authorization: "Bearer custom-ws-byok-route-token",
        "openai-beta": "responses_websockets=2026-02-06",
        session_id: "custom-ws-byok-session"
      }
    });
    await websocketOpen(ws);
    ws.send(JSON.stringify({
      type: "response.create",
      model: "router-hard",
      input: "debug this credentialed websocket route",
      stream: true
    }));
    await nextWebSocketCompletion(ws);
    ws.close();

    const providerCall = activeFixture.openai.records.find((record) =>
      record.body.type === "response.create" && record.body.model === "gpt-custom-ws-byok"
    );
    const eventRows = await activeFixture.db.select().from(events);
    const started = eventRows.find((event) => event.eventType === "provider.request_started");
    const terminal = eventRows.find((event) => event.eventType === "provider.response_completed");

    expect(providerCall).toBeTruthy();
    expect(providerCall?.headers.authorization).toBe("Bearer sk-custom-ws");
    expect(providerCall?.headers["x-custom-provider"]).toBe("byok");
    expect(providerCall?.headers["openai-beta"]).toBe("responses_websockets=2026-02-06");
    expect(started?.payload).toEqual(expect.objectContaining({ providerAccountId }));
    expect(terminal?.payload).toEqual(expect.objectContaining({ providerAccountId }));
    expect(eventRows.filter((event) => event.eventType === "provider.response_completed")).toHaveLength(1);
  });

  it("prefers the lowest-order available deployment", async () => {
    const organizationId = "org_config_deployment_order";
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      openAIOptions: {
        classifierOutput: {
          complexity: "hard",
          risk: ["debugging"],
          recommended_route: "hard",
          can_use_fast_model: false,
          needs_deep_reasoning: false,
          reason_codes: ["deployment_order"],
          confidence: 0.91
        }
      }
    });
    await assignRouteConfig(activeFixture, organizationId, {
      secret: "deployment-order-token",
      slug: "deployment-order",
      configHash: "sha256:deployment-order-config",
      configure: (config) => ({
        ...config,
        routes: {
          ...config.routes,
          hard: {
            ...config.routes.hard,
            openai: {
              deployments: [
                {
                  ...config.routes.hard.openai!.deployments[0],
                  model: "gpt-primary-order",
                  order: 0,
                  weight: 1
                },
                {
                  ...config.routes.hard.openai!.deployments[0],
                  model: "gpt-secondary-order",
                  order: 1,
                  weight: 100
                }
              ]
            }
          }
        }
      })
    });

    const response = await fetch(`${activeFixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer deployment-order-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: "debug this failing test",
        stream: true
      })
    });
    await response.text();

    const providerCall = activeFixture.openai.records.find((record) =>
      record.body.model === "gpt-primary-order" || record.body.model === "gpt-secondary-order"
    );

    expect(response.status).toBe(200);
    expect(providerCall?.body.model).toBe("gpt-primary-order");
  });

  it("uses deployment weights within an order group", async () => {
    const organizationId = "org_config_deployment_weight";
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      openAIOptions: {
        classifierOutput: {
          complexity: "hard",
          risk: ["debugging"],
          recommended_route: "hard",
          can_use_fast_model: false,
          needs_deep_reasoning: false,
          reason_codes: ["deployment_weight"],
          confidence: 0.91
        }
      }
    });
    await assignRouteConfig(activeFixture, organizationId, {
      secret: "deployment-weight-token",
      slug: "deployment-weight",
      configHash: "sha256:deployment-weight-config",
      configure: (config) => ({
        ...config,
        routes: {
          ...config.routes,
          hard: {
            ...config.routes.hard,
            openai: {
              deployments: [
                {
                  ...config.routes.hard.openai!.deployments[0],
                  model: "gpt-zero-weight",
                  order: 0,
                  weight: 0
                },
                {
                  ...config.routes.hard.openai!.deployments[0],
                  model: "gpt-positive-weight",
                  order: 0,
                  weight: 1
                }
              ]
            }
          }
        }
      })
    });

    const response = await fetch(`${activeFixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer deployment-weight-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: "debug this weighted route",
        stream: true
      })
    });
    await response.text();

    const providerCall = activeFixture.openai.records.find((record) =>
      record.body.model === "gpt-zero-weight" || record.body.model === "gpt-positive-weight"
    );

    expect(response.status).toBe(200);
    expect(providerCall?.body.model).toBe("gpt-positive-weight");
  });

  it("fails closed when a deployment provider account cannot resolve", async () => {
    const organizationId = "org_config_deployment_account_missing";
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      openAIOptions: {
        classifierOutput: {
          complexity: "hard",
          risk: ["debugging"],
          recommended_route: "hard",
          can_use_fast_model: false,
          needs_deep_reasoning: false,
          reason_codes: ["deployment_account"],
          confidence: 0.91
        }
      }
    });
    await assignRouteConfig(activeFixture, organizationId, {
      secret: "deployment-account-token",
      slug: "deployment-account",
      configHash: "sha256:deployment-account-config",
      configure: (config) => ({
        ...config,
        routes: {
          ...config.routes,
          hard: {
            ...config.routes.hard,
            anthropic: undefined,
            openai: {
              deployments: [{
                ...config.routes.hard.openai!.deployments[0],
                model: "gpt-missing-account",
                providerAccountId: "missing_provider_account"
              }]
            }
          }
        }
      })
    });

    const response = await fetch(`${activeFixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer deployment-account-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: "debug this account route",
        stream: true
      })
    });
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).toContain("deployment_provider_account_unavailable");
    expect(activeFixture.openai.records.filter((record) =>
      record.body.model === "gpt-missing-account"
    )).toHaveLength(0);
  });

  it("retries a provider 429 on the next ordered deployment and keeps the failed deployment in cooldown", async () => {
    const organizationId = "org_config_deployment_cooldown";
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      openAIOptions: {
        failProviderOnce: true,
        failProviderOnceStatus: 429,
        classifierOutput: {
          complexity: "hard",
          risk: ["debugging"],
          recommended_route: "hard",
          can_use_fast_model: false,
          needs_deep_reasoning: false,
          reason_codes: ["deployment_cooldown"],
          confidence: 0.91
        }
      }
    });
    await assignRouteConfig(activeFixture, organizationId, {
      secret: "deployment-cooldown-token",
      slug: "deployment-cooldown",
      configHash: "sha256:deployment-cooldown-config",
      configure: (config) => ({
        ...config,
        routes: {
          ...config.routes,
          hard: {
            ...config.routes.hard,
            openai: {
              deployments: [
                {
                  ...config.routes.hard.openai!.deployments[0],
                  model: "gpt-cooldown-primary",
                  order: 0,
                  weight: 1
                },
                {
                  ...config.routes.hard.openai!.deployments[0],
                  model: "gpt-cooldown-secondary",
                  order: 1,
                  weight: 1
                }
              ]
            }
          }
        }
      })
    });

    const first = await fetch(`${activeFixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer deployment-cooldown-token",
        "content-type": "application/json",
        "x-codex-session-id": "deployment-cooldown-session"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: "debug this cooldown route",
        stream: true
      })
    });
    await first.text();
    const second = await fetch(`${activeFixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer deployment-cooldown-token",
        "content-type": "application/json",
        "x-codex-session-id": "deployment-cooldown-session"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: "debug this cooldown route again",
        stream: true
      })
    });
    await second.text();

    const providerCalls = activeFixture.openai.records.filter((record) =>
      record.body.model === "gpt-cooldown-primary" || record.body.model === "gpt-cooldown-secondary"
    );

    const eventRows = await activeFixture.db.select().from(events);
    const started = eventRows.filter((event) => event.eventType === "provider.request_started");
    const forwarded = eventRows.filter((event) => event.eventType === "provider.request_forwarded");
    const failedTerminal = eventRows.find((event) => event.eventType === "provider.response_failed");
    const attemptRows = await activeFixture.db
      .select()
      .from(providerAttempts)
      .where(eq(providerAttempts.organizationId, organizationId));
    const failedAttempt = attemptRows.find((attempt) => attempt.model === "gpt-cooldown-primary");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(providerCalls.map((record) => record.body.model)).toEqual([
      "gpt-cooldown-primary",
      "gpt-cooldown-secondary",
      "gpt-cooldown-secondary"
    ]);
    expect(first.headers.get("x-proxy-model")).toBe("gpt-cooldown-secondary");
    expect(first.headers.get("x-proxy-route")).toBe("hard");
    expect(first.headers.get("x-proxy-deployment")).toBe(
      (started[1]?.payload as { deployment?: { key?: string } } | undefined)?.deployment?.key
    );
    expect(forwarded[0]?.payload).toEqual(expect.objectContaining({
      adapterKind: "generic-http-json"
    }));
    expect(failedTerminal?.payload).toEqual(expect.objectContaining({
      adapterKind: "generic-http-json",
      adapterClassification: expect.objectContaining({
        category: "rate_limited",
        errorType: "rate_limited"
      })
    }));
    expect(failedAttempt?.adapterKind).toBe("generic-http-json");
    expect(failedAttempt?.adapterClassification).toEqual(expect.objectContaining({
      category: "rate_limited",
      errorType: "rate_limited",
      retryable: true,
      fatal: false
    }));
    const decision = await lastDecisionPayload(activeFixture);
    expect(decision?.selectedAdapterKind).toBe("generic-http-json");
    expect(decision?.providerAttempts?.[0]).toEqual(expect.objectContaining({
      adapterKind: "generic-http-json"
    }));
    expect(decision?.guardrailActions).toContain("session_pin_cooldown_invalidated");
  });

  it("applies provider-model limits to fallback deployment attempts", async () => {
    const organizationId = "org_config_fallback_provider_limit";
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      envOverrides: {
        GATEWAY_PROVIDER_MODEL_CONCURRENCY_LIMIT: "1"
      },
      openAIOptions: {
        failProviderOnce: true,
        failProviderOnceStatus: 429,
        slowProvider: true,
        classifierOutput: {
          complexity: "hard",
          risk: ["debugging"],
          recommended_route: "hard",
          can_use_fast_model: false,
          needs_deep_reasoning: false,
          reason_codes: ["fallback_provider_limit"],
          confidence: 0.91
        }
      }
    });
    await assignRouteConfig(activeFixture, organizationId, {
      secret: "fallback-provider-limit-token",
      slug: "fallback-provider-limit",
      configHash: "sha256:fallback-provider-limit-config",
      configure: (config) => ({
        ...config,
        routes: {
          ...config.routes,
          hard: {
            ...config.routes.hard,
            openai: {
              deployments: [
                {
                  ...config.routes.hard.openai!.deployments[0],
                  model: "gpt-provider-limit-primary",
                  order: 0,
                  weight: 1
                },
                {
                  ...config.routes.hard.openai!.deployments[0],
                  model: "gpt-provider-limit-fallback",
                  order: 1,
                  weight: 1
                }
              ]
            }
          }
        }
      })
    });
    const firstController = new AbortController();

    const first = await fetch(`${activeFixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer fallback-provider-limit-token",
        "content-type": "application/json",
        "x-codex-session-id": "fallback-provider-limit-session"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: "debug this provider limit fallback route",
        stream: true
      }),
      signal: firstController.signal
    });
    const second = await fetch(`${activeFixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer fallback-provider-limit-token",
        "content-type": "application/json",
        "x-codex-session-id": "fallback-provider-limit-session"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: "debug this provider limit fallback route again",
        stream: true
      })
    });
    const secondBody = await second.json() as { error: string; scope: string };
    firstController.abort();
    await first.text().catch(() => "");

    const providerCalls = activeFixture.openai.records.filter((record) =>
      record.body.model === "gpt-provider-limit-primary" ||
      record.body.model === "gpt-provider-limit-fallback"
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(secondBody).toMatchObject({
      error: "traffic_limit_exceeded:provider_model:concurrency",
      scope: "provider_model"
    });
    expect(providerCalls.map((record) => record.body.model)).toEqual([
      "gpt-provider-limit-primary",
      "gpt-provider-limit-fallback"
    ]);
  });

  it("retries configured provider 5xx responses before first byte", async () => {
    const organizationId = "org_config_deployment_5xx_retry";
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      openAIOptions: {
        failProviderOnce: true,
        failProviderOnceStatus: 503,
        classifierOutput: {
          complexity: "hard",
          risk: ["debugging"],
          recommended_route: "hard",
          can_use_fast_model: false,
          needs_deep_reasoning: false,
          reason_codes: ["deployment_5xx_retry"],
          confidence: 0.91
        }
      }
    });
    await assignRouteConfig(activeFixture, organizationId, {
      secret: "deployment-5xx-retry-token",
      slug: "deployment-5xx-retry",
      configHash: "sha256:deployment-5xx-retry-config",
      configure: (config) => ({
        ...config,
        routes: {
          ...config.routes,
          hard: {
            ...config.routes.hard,
            openai: {
              deployments: [
                {
                  ...config.routes.hard.openai!.deployments[0],
                  model: "gpt-5xx-primary",
                  order: 0,
                  weight: 1
                },
                {
                  ...config.routes.hard.openai!.deployments[0],
                  model: "gpt-5xx-secondary",
                  order: 1,
                  weight: 1
                }
              ]
            }
          }
        }
      })
    });

    const response = await fetch(`${activeFixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer deployment-5xx-retry-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: "debug this 5xx retry route",
        stream: true
      })
    });
    await response.text();

    const providerCalls = activeFixture.openai.records.filter((record) =>
      record.body.model === "gpt-5xx-primary" || record.body.model === "gpt-5xx-secondary"
    );
    const started = (await activeFixture.db.select().from(events))
      .filter((event) => event.eventType === "provider.request_started")
      .sort((left, right) => left.sequence - right.sequence);

    expect(response.status).toBe(200);
    expect(response.headers.get("x-proxy-model")).toBe("gpt-5xx-secondary");
    expect(providerCalls.map((record) => record.body.model)).toEqual([
      "gpt-5xx-primary",
      "gpt-5xx-secondary"
    ]);
    expect(started.map((event) => (event.payload as { routeCandidateId?: string }).routeCandidateId)).toEqual([
      "candidate_1",
      "candidate_2"
    ]);
  });

  it("does not cool down deployments for non-retryable provider 5xx responses", async () => {
    const organizationId = "org_config_deployment_nonretryable_5xx";
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      openAIOptions: {
        failProviderModels: {
          "gpt-nonretryable-primary": 501
        },
        classifierOutput: {
          complexity: "hard",
          risk: ["debugging"],
          recommended_route: "hard",
          can_use_fast_model: false,
          needs_deep_reasoning: false,
          reason_codes: ["deployment_nonretryable_5xx"],
          confidence: 0.91
        }
      }
    });
    await assignRouteConfig(activeFixture, organizationId, {
      secret: "deployment-nonretryable-5xx-token",
      slug: "deployment-nonretryable-5xx",
      configHash: "sha256:deployment-nonretryable-5xx-config",
      configure: (config) => ({
        ...config,
        routes: {
          ...config.routes,
          hard: {
            ...config.routes.hard,
            retry: {
              ...config.routes.hard.retry,
              maxAttempts: 2,
              retryableStatusCodes: [429, 503]
            },
            openai: {
              deployments: [
                {
                  ...config.routes.hard.openai!.deployments[0],
                  model: "gpt-nonretryable-primary",
                  order: 0,
                  weight: 1
                },
                {
                  ...config.routes.hard.openai!.deployments[0],
                  model: "gpt-nonretryable-secondary",
                  order: 1,
                  weight: 1
                }
              ]
            }
          }
        }
      })
    });

    for (const input of ["first", "second"]) {
      const response = await fetch(`${activeFixture.proxyUrl}/v1/responses`, {
        method: "POST",
        headers: {
          authorization: "Bearer deployment-nonretryable-5xx-token",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: "router-auto",
          input: `debug this non-retryable 5xx route ${input}`,
          stream: true
        })
      });
      await response.text();
      expect(response.status).toBe(501);
    }

    const providerCalls = activeFixture.openai.records.filter((record) =>
      record.body.model === "gpt-nonretryable-primary" ||
      record.body.model === "gpt-nonretryable-secondary"
    );

    expect(providerCalls.map((record) => record.body.model)).toEqual([
      "gpt-nonretryable-primary",
      "gpt-nonretryable-primary"
    ]);
  });

  it("falls back to the configured model route when the selected route is exhausted", async () => {
    const organizationId = "org_config_model_route_fallback";
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      openAIOptions: {
        failProviderOnce: true,
        failProviderOnceStatus: 503,
        classifierOutput: {
          complexity: "simple",
          risk: [],
          recommended_route: "fast",
          can_use_fast_model: true,
          needs_deep_reasoning: false,
          reason_codes: ["model_route_fallback"],
          confidence: 0.91
        }
      }
    });
    await assignRouteConfig(activeFixture, organizationId, {
      secret: "model-route-fallback-token",
      slug: "model-route-fallback",
      configHash: "sha256:model-route-fallback-config",
      configure: (config) => ({
        ...config,
        routes: {
          ...config.routes,
          fast: {
            ...config.routes.fast,
            anthropic: undefined,
            retry: {
              ...config.routes.fast.retry,
              maxAttempts: 2
            },
            openai: {
              deployments: [{
                ...config.routes.fast.openai!.deployments[0],
                model: "gpt-fast-fallback-primary",
                order: 0,
                weight: 1
              }]
            }
          },
          hard: {
            ...config.routes.hard,
            anthropic: undefined,
            openai: {
              deployments: [{
                ...config.routes.hard.openai!.deployments[0],
                model: "gpt-hard-model-fallback",
                order: 0,
                weight: 1
              }]
            }
          }
        },
        limits: {
          ...config.limits,
          fallbackRoute: "hard"
        }
      })
    });

    const response = await fetch(`${activeFixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer model-route-fallback-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: "read this small file",
        stream: true
      })
    });
    await response.text();

    const providerCalls = activeFixture.openai.records.filter((record) =>
      record.body.model === "gpt-fast-fallback-primary" || record.body.model === "gpt-hard-model-fallback"
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-proxy-route")).toBe("hard");
    expect(response.headers.get("x-proxy-model")).toBe("gpt-hard-model-fallback");
    expect(providerCalls.map((record) => record.body.model)).toEqual([
      "gpt-fast-fallback-primary",
      "gpt-hard-model-fallback"
    ]);
  });

  it("retries provider timeout before first byte", async () => {
    const organizationId = "org_config_deployment_timeout_retry";
    const stalledOpenAI = await startOpenAIMock({ stallProviderBeforeFirstByte: true });
    try {
      activeFixture = await captureFixture(organizationId, "raw_text", false, {
        openAIOptions: {
          classifierOutput: {
            complexity: "hard",
            risk: ["debugging"],
            recommended_route: "hard",
            can_use_fast_model: false,
            needs_deep_reasoning: false,
            reason_codes: ["deployment_timeout_retry"],
            confidence: 0.91
          }
        }
      });
      await assignRouteConfig(activeFixture, organizationId, {
        secret: "deployment-timeout-retry-token",
        slug: "deployment-timeout-retry",
        configHash: "sha256:deployment-timeout-retry-config",
        configure: (config) => ({
          ...config,
          routes: {
            ...config.routes,
            hard: {
              ...config.routes.hard,
              anthropic: undefined,
              openai: {
                deployments: [
                  {
                    ...config.routes.hard.openai!.deployments[0],
                    model: "gpt-timeout-primary",
                    baseUrl: stalledOpenAI.url,
                    order: 0,
                    weight: 1,
                    timeoutMs: 250
                  },
                  {
                    ...config.routes.hard.openai!.deployments[0],
                    model: "gpt-timeout-secondary",
                    order: 1,
                    weight: 1
                  }
                ]
              }
            }
          }
        })
      });

      const response = await fetch(`${activeFixture.proxyUrl}/v1/responses`, {
        method: "POST",
        headers: {
          authorization: "Bearer deployment-timeout-retry-token",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: "router-auto",
          input: "debug this timeout retry route",
          stream: true
        })
      });
      await response.text();

      const fallbackCalls = activeFixture.openai.records.filter((record) =>
        record.body.model === "gpt-timeout-secondary"
      );
      const stalledCalls = stalledOpenAI.records.filter((record) =>
        record.body.model === "gpt-timeout-primary"
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("x-proxy-model")).toBe("gpt-timeout-secondary");
      expect(stalledCalls).toHaveLength(1);
      expect(fallbackCalls).toHaveLength(1);
    } finally {
      await stalledOpenAI.close();
    }
  });

  it("does not retry invisibly after stream bytes are sent", async () => {
    const organizationId = "org_config_deployment_stream_failure";
    const failingOpenAI = await startOpenAIMock({ failStreamAfterFirstByte: true });
    try {
      activeFixture = await captureFixture(organizationId, "raw_text", false, {
        openAIOptions: {
          classifierOutput: {
            complexity: "hard",
            risk: ["debugging"],
            recommended_route: "hard",
            can_use_fast_model: false,
            needs_deep_reasoning: false,
            reason_codes: ["deployment_stream_failure"],
            confidence: 0.91
          }
        }
      });
      await assignRouteConfig(activeFixture, organizationId, {
        secret: "deployment-stream-failure-token",
        slug: "deployment-stream-failure",
        configHash: "sha256:deployment-stream-failure-config",
        configure: (config) => ({
          ...config,
          routes: {
            ...config.routes,
            hard: {
              ...config.routes.hard,
              anthropic: undefined,
              openai: {
                deployments: [
                  {
                    ...config.routes.hard.openai!.deployments[0],
                    model: "gpt-stream-primary",
                    baseUrl: failingOpenAI.url,
                    order: 0,
                    weight: 1
                  },
                  {
                    ...config.routes.hard.openai!.deployments[0],
                    model: "gpt-stream-secondary",
                    order: 1,
                    weight: 1
                  }
                ]
              }
            }
          }
        })
      });

      const response = await fetch(`${activeFixture.proxyUrl}/v1/responses`, {
        method: "POST",
        headers: {
          authorization: "Bearer deployment-stream-failure-token",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: "router-auto",
          input: "debug this stream failure route",
          stream: true
        })
      });
      await response.text().catch(() => "");

      const failedCalls = failingOpenAI.records.filter((record) =>
        record.body.model === "gpt-stream-primary"
      );
      const fallbackCalls = activeFixture.openai.records.filter((record) =>
        record.body.model === "gpt-stream-secondary"
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("x-proxy-model")).toBe("gpt-stream-primary");
      expect(failedCalls).toHaveLength(1);
      expect(fallbackCalls).toHaveLength(0);
    } finally {
      await failingOpenAI.close();
    }
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
              deployments: [{
                ...config.routes.deep.anthropic!.deployments[0],
                model: "claude-opus-4-8",
                thinking: { type: "adaptive", display: "summarized" },
                output_config: { effort: "xhigh" },
                maxTokens: 4096
              }]
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
      record.body.model === "claude-opus-4-8"
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-proxy-route")).toBe("deep");
    expect(response.headers.get("x-proxy-reasoning-effort")).toBe("xhigh");
    expect(providerCall).toBeTruthy();
    expect(providerCall?.body.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(providerCall?.body.output_config.effort).toBe("xhigh");
    expect(providerCall?.body.max_tokens).toBe(4096);
    expect(providerCall?.body.tools).toEqual([
      { name: "shell", input_schema: { type: "object", properties: {} } }
    ]);
    expect(providerCall?.headers["x-claude-code-session-id"]).toBe("claude-session-config");

    const eventRows = await activeFixture.db.select().from(events);
    const decision = eventRows.find((event) => event.eventType === "routing.decision_recorded");
    const plan = eventRows.find((event) => event.eventType === "routing.plan_recorded");
    expect(decision?.payload).not.toHaveProperty("routeExecutionPlan");
    const routeExecutionPlan = plan?.payload.routeExecutionPlan as Record<string, any> | undefined;
    expect(routeExecutionPlan).toMatchObject({
      schemaVersion: 1,
      surface: "anthropic-messages",
      dialect: "anthropic-messages",
      routingConfig: {
        hash: "sha256:anthropic-route-config"
      },
      selected: {
        candidateId: "candidate_0",
        providerId: "anthropic",
        model: "claude-opus-4-8",
        dialect: "anthropic-messages",
        translated: false
      }
    });
    expect(routeExecutionPlan?.candidates?.[0]).toMatchObject({
      providerId: "anthropic",
      model: "claude-opus-4-8",
      endpointDialect: "anthropic-messages",
      translated: false,
      factors: expect.objectContaining({
        nativeDialect: true,
        capabilityMatch: true
      })
    });
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
    await activeFixture.persistence.organizationSettings.setSystemPrompt(
      organizationId,
      "Follow organization proxy policy."
    );
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

  it("pins the organization system prompt for active OpenAI sessions", async () => {
    const organizationId = "org_system_prompt_pin";
    activeFixture = await captureFixture(organizationId);
    await activeFixture.persistence.organizationSettings.setSystemPrompt(
      organizationId,
      "Initial proxy policy."
    );

    const sendRequest = (sessionId: string, input: string) => fetch(`${activeFixture!.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json",
        "x-codex-session-id": sessionId
      },
      body: JSON.stringify({
        model: "router-hard",
        instructions: "You are Codex.",
        input,
        stream: true
      })
    });

    const first = await sendRequest("proxy-pin-session", "debug the first failing test");
    await first.text();
    await activeFixture.persistence.organizationSettings.setSystemPrompt(
      organizationId,
      "Updated proxy policy."
    );
    const second = await sendRequest("proxy-pin-session", "debug the second failing test");
    await second.text();
    const third = await sendRequest("proxy-pin-session-new", "debug the third failing test");
    await third.text();

    const providerCalls = activeFixture.openai.records.filter((record) =>
      record.body.model !== "route-classifier-cheap" && record.path === "/responses"
    );
    const [sessionRow] = await activeFixture.db
      .select({ metadata: agentSessions.metadata })
      .from(agentSessions)
      .where(eq(agentSessions.externalSessionId, "proxy-pin-session"))
      .limit(1);
    const artifactId = sessionRow?.metadata.pinnedSystemPromptArtifactId;
    const [pinnedArtifact] = typeof artifactId === "string"
      ? await activeFixture.db
        .select({ kind: promptArtifacts.kind, rawText: promptArtifacts.rawText })
        .from(promptArtifacts)
        .where(eq(promptArtifacts.id, artifactId))
        .limit(1)
      : [];
    const eventRows = await activeFixture.db
      .select({ eventType: events.eventType, payload: events.payload, metadata: events.metadata })
      .from(events);
    const normalRouteEvents = JSON.stringify(eventRows.filter((event) =>
      event.eventType === "session.route_memory_recorded" || event.eventType === "routing.decision_recorded"
    ));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(200);
    expect(providerCalls.map((record) => record.body.instructions)).toEqual([
      "Initial proxy policy.\n\nYou are Codex.",
      "Initial proxy policy.\n\nYou are Codex.",
      "Updated proxy policy.\n\nYou are Codex."
    ]);
    expect(sessionRow?.metadata.pinnedSystemPrompt).toBeUndefined();
    expect(sessionRow?.metadata.pinnedSystemPromptHash).toBe("sha256:3db3af6a5f7c0d28e75c87f9566d4ccf51d5fe400447f98d8cdb933eb0616ffc");
    expect(pinnedArtifact).toEqual({
      kind: "organization_system_prompt",
      rawText: "Initial proxy policy."
    });
    expect(JSON.stringify(sessionRow?.metadata)).not.toContain("Initial proxy policy.");
    expect(normalRouteEvents).not.toContain("Initial proxy policy.");
    expect(normalRouteEvents).not.toContain("Updated proxy policy.");
  });

  it("prepends the organization system prompt to Anthropic Messages system blocks", async () => {
    const organizationId = "org_system_prompt_anthropic";
    activeFixture = await captureFixture(organizationId);
    await activeFixture.persistence.organizationSettings.setSystemPrompt(
      organizationId,
      "Follow organization proxy policy."
    );

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
          hard: withHardTargets(config, [
            { providerId: "missing-hard-provider", model: "missing-hard-model", effort: "high" }
          ]).routes.hard
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

  it("skips provider accounts under active cooldown", async () => {
    const organizationId = "org_health_account_cooldown_skip";
    const providerId = "00000000-0000-0000-0000-00000000c017";
    const providerAccountId = `${organizationId}:provider-account:cooldown`;
    const cooldownUntil = new Date(Date.now() + 60_000);
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      envOverrides: {
        ALLOWED_PRIVATE_UPSTREAM_CIDRS: "127.0.0.0/8",
        PROVIDER_SECRET_ENCRYPTION_KEY: ENCRYPTION_KEY
      }
    });
    await setupHealthRoute(activeFixture, organizationId, {
      routeSlug: "account-cooldown-skip",
      secret: "account-cooldown-token",
      providerId,
      providerSlug: "custom-account-cooldown",
      providerAccountId,
      targets: [
        { providerId: "custom-account-cooldown", model: "gpt-account-cooldown", effort: "high", verbosity: "medium" },
        { providerId: "openai", model: "gpt-account-fallback", effort: "high", verbosity: "medium" }
      ]
    });
    await activeFixture.db.insert(providerAccountHealth).values({
      id: `${organizationId}:account-health`,
      organizationId,
      workspaceId: defaultWorkspaceId(organizationId),
      providerAccountId,
      providerId,
      status: "cooldown",
      lastErrorType: "rate_limited",
      lastErrorMessage: "rate limited",
      cooldownUntil,
      consecutiveFailures: 1,
      metadata: {}
    });

    const response = await sendHardResponse(activeFixture, "account-cooldown-token");
    await response.text();
    const decision = await routeDecisionPayload(activeFixture);
    const providerCalls = activeFixture.openai.records.filter((record) =>
      record.path === "/responses" && record.body.model !== "route-classifier-cheap"
    );

    expect(response.status).toBe(200);
    expect(providerCalls.map((record) => record.body.model)).toEqual(["gpt-account-fallback"]);
    expect(decision?.guardrailActions).toContain("target_skipped_provider_account_cooldown:custom-account-cooldown");
    expect(decision?.healthSkips).toEqual([
      expect.objectContaining({
        scope: "provider_account",
        provider: "custom-account-cooldown",
        providerId,
        providerAccountId,
        model: "gpt-account-cooldown",
        healthStatus: "cooldown",
        errorType: "rate_limited",
        expiresAt: cooldownUntil.toISOString()
      })
    ]);
  });

  it("skips builtin provider accounts under active cooldown", async () => {
    const organizationId = "org_health_builtin_account_cooldown_skip";
    const providerAccountId = `${organizationId}:provider-account:builtin-cooldown`;
    const cooldownUntil = new Date(Date.now() + 60_000);
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      envOverrides: {
        PROVIDER_SECRET_ENCRYPTION_KEY: ENCRYPTION_KEY
      }
    });
    await assignRouteConfig(activeFixture, organizationId, {
      secret: "builtin-account-cooldown-token",
      slug: "builtin-account-cooldown",
      configHash: "sha256:builtin-account-cooldown",
      configure: (config) => ({
        ...config,
        routes: {
          ...config.routes,
          hard: withHardTargets(config, [
            { providerId: "openai", model: "gpt-builtin-cooldown", effort: "high", verbosity: "medium" },
            { providerId: "anthropic", model: "claude-builtin-fallback", effort: "high" }
          ]).routes.hard
        }
      })
    });
    await activeFixture.db.insert(providerAccounts).values({
      id: providerAccountId,
      organizationId,
      providerId: OPENAI_PROVIDER_ID,
      name: "Builtin health test key",
      authType: "api_key",
      secretCiphertext: encryptSecret("sk-builtin-health-route", ENCRYPTION_KEY),
      secretHint: "••••oute",
      settings: {}
    });
    await activeFixture.db.insert(apiKeyProviderAccounts).values({
      organizationId,
      workspaceId: defaultWorkspaceId(organizationId),
      apiKeyId: "api_key_builtin-account-cooldown",
      providerId: OPENAI_PROVIDER_ID,
      providerAccountId
    });
    await activeFixture.db.insert(providerAccountHealth).values({
      id: `${organizationId}:account-health`,
      organizationId,
      workspaceId: defaultWorkspaceId(organizationId),
      providerAccountId,
      providerId: OPENAI_PROVIDER_ID,
      status: "cooldown",
      lastErrorType: "rate_limited",
      lastErrorMessage: "rate limited",
      cooldownUntil,
      consecutiveFailures: 1,
      metadata: {}
    });

    const response = await sendHardResponse(activeFixture, "builtin-account-cooldown-token");
    await response.text();
    const decision = await routeDecisionPayload(activeFixture);
    const openAICalls = activeFixture.openai.records.filter((record) =>
      record.path === "/responses" && record.body.model !== "route-classifier-cheap"
    );
    const anthropicCall = activeFixture.anthropic.records.find((record) => record.path === "/messages");

    expect(response.status).toBe(200);
    expect(openAICalls.map((record) => record.body.model)).toEqual([]);
    expect(anthropicCall?.body.model).toBe("claude-builtin-fallback");
    expect(decision?.guardrailActions).toContain("target_skipped_provider_account_cooldown:openai");
    expect(decision?.healthSkips).toEqual([
      expect.objectContaining({
        scope: "provider_account",
        provider: "openai",
        providerId: OPENAI_PROVIDER_ID,
        providerAccountId,
        model: "gpt-builtin-cooldown",
        healthStatus: "cooldown",
        errorType: "rate_limited",
        expiresAt: cooldownUntil.toISOString()
      })
    ]);
  });

  it("skips provider accounts with terminal health", async () => {
    const organizationId = "org_health_account_terminal_skip";
    const providerId = "00000000-0000-0000-0000-00000000c021";
    const providerAccountId = `${organizationId}:provider-account:terminal`;
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      envOverrides: {
        ALLOWED_PRIVATE_UPSTREAM_CIDRS: "127.0.0.0/8",
        PROVIDER_SECRET_ENCRYPTION_KEY: ENCRYPTION_KEY
      }
    });
    await setupHealthRoute(activeFixture, organizationId, {
      routeSlug: "account-terminal-skip",
      secret: "account-terminal-token",
      providerId,
      providerSlug: "custom-account-terminal",
      providerAccountId,
      targets: [
        { providerId: "custom-account-terminal", model: "gpt-account-terminal", effort: "high", verbosity: "medium" },
        { providerId: "openai", model: "gpt-account-terminal-fallback", effort: "high", verbosity: "medium" }
      ]
    });
    await activeFixture.db.insert(providerAccountHealth).values({
      id: `${organizationId}:account-health`,
      organizationId,
      workspaceId: defaultWorkspaceId(organizationId),
      providerAccountId,
      providerId,
      status: "terminal",
      lastErrorType: "auth_invalid",
      lastErrorMessage: "Probe classified as auth_invalid.",
      consecutiveFailures: 1,
      metadata: {}
    });

    const response = await sendHardResponse(activeFixture, "account-terminal-token");
    await response.text();
    const decision = await routeDecisionPayload(activeFixture);
    const providerCalls = activeFixture.openai.records.filter((record) =>
      record.path === "/responses" && record.body.model !== "route-classifier-cheap"
    );

    expect(response.status).toBe(200);
    expect(providerCalls.map((record) => record.body.model)).toEqual(["gpt-account-terminal-fallback"]);
    expect(decision?.guardrailActions).toContain("target_skipped_provider_account_terminal:custom-account-terminal");
    expect(decision?.healthSkips).toEqual([
      expect.objectContaining({
        scope: "provider_account",
        provider: "custom-account-terminal",
        providerId,
        providerAccountId,
        model: "gpt-account-terminal",
        healthStatus: "terminal",
        errorType: "auth_invalid"
      })
    ]);
    expect(decision?.healthSkips?.[0]).not.toHaveProperty("expiresAt");
  });

  it("skips provider account models under active lockout", async () => {
    const organizationId = "org_health_model_lockout_skip";
    const providerId = "00000000-0000-0000-0000-00000000c018";
    const providerAccountId = `${organizationId}:provider-account:model-lockout`;
    const lockoutUntil = new Date(Date.now() + 60_000);
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      envOverrides: {
        ALLOWED_PRIVATE_UPSTREAM_CIDRS: "127.0.0.0/8",
        PROVIDER_SECRET_ENCRYPTION_KEY: ENCRYPTION_KEY
      }
    });
    await setupHealthRoute(activeFixture, organizationId, {
      routeSlug: "model-lockout-skip",
      secret: "model-lockout-token",
      providerId,
      providerSlug: "custom-model-lockout",
      providerAccountId,
      targets: [
        { providerId: "custom-model-lockout", model: "gpt-model-lockout", effort: "high", verbosity: "medium" },
        { providerId: "openai", model: "gpt-model-fallback", effort: "high", verbosity: "medium" }
      ]
    });
    await activeFixture.db.insert(providerModelHealth).values({
      id: `${organizationId}:model-health`,
      organizationId,
      workspaceId: defaultWorkspaceId(organizationId),
      providerId,
      providerAccountId,
      model: "gpt-model-lockout",
      status: "locked_out",
      lastErrorType: "model_unavailable",
      lastErrorAt: new Date(),
      lockoutUntil,
      consecutiveFailures: 1,
      metadata: {
        bedrockErrorKind: "region_unavailable",
        bedrockOperation: "Converse",
        region: "us-west-2"
      }
    });

    const response = await sendHardResponse(activeFixture, "model-lockout-token");
    await response.text();
    const decision = await routeDecisionPayload(activeFixture);
    const providerCalls = activeFixture.openai.records.filter((record) =>
      record.path === "/responses" && record.body.model !== "route-classifier-cheap"
    );

    expect(response.status).toBe(200);
    expect(providerCalls.map((record) => record.body.model)).toEqual(["gpt-model-fallback"]);
    expect(decision?.guardrailActions).toContain("target_skipped_provider_model_lockout:custom-model-lockout");
    expect(decision?.healthSkips).toEqual([
      expect.objectContaining({
        scope: "provider_account_model",
        provider: "custom-model-lockout",
        providerId,
        providerAccountId,
        model: "gpt-model-lockout",
        healthStatus: "locked_out",
        errorType: "model_unavailable",
        expiresAt: lockoutUntil.toISOString(),
        metadata: expect.objectContaining({
          bedrockErrorKind: "region_unavailable",
          bedrockOperation: "Converse",
          region: "us-west-2"
        })
      })
    ]);
  });

  it("only applies Bedrock stream permission health to streaming requests", async () => {
    const organizationId = "org_health_stream_permission_skip";
    const providerId = "00000000-0000-0000-0000-00000000c023";
    const providerAccountId = `${organizationId}:provider-account:stream-permission`;
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      envOverrides: {
        ALLOWED_PRIVATE_UPSTREAM_CIDRS: "127.0.0.0/8",
        PROVIDER_SECRET_ENCRYPTION_KEY: ENCRYPTION_KEY
      }
    });
    await setupHealthRoute(activeFixture, organizationId, {
      routeSlug: "stream-permission-skip",
      secret: "stream-permission-token",
      providerId,
      providerSlug: "custom-stream-permission",
      providerAccountId,
      targets: [
        { providerId: "custom-stream-permission", model: "gpt-stream-permission", effort: "high", verbosity: "medium" },
        { providerId: "openai", model: "gpt-stream-permission-fallback", effort: "high", verbosity: "medium" }
      ]
    });
    await activeFixture.db.insert(providerModelHealth).values({
      id: `${organizationId}:model-health`,
      organizationId,
      workspaceId: defaultWorkspaceId(organizationId),
      providerId,
      providerAccountId,
      model: "gpt-stream-permission",
      status: "terminal",
      lastErrorType: "model_access_denied",
      lastErrorAt: new Date(),
      consecutiveFailures: 1,
      metadata: {
        bedrockErrorKind: "stream_permission_denied",
        bedrockOperation: "ConverseStream",
        region: "us-east-1"
      }
    });

    const nonStreamingResponse = await sendHardResponse(activeFixture, "stream-permission-token", false);
    await nonStreamingResponse.text();
    const nonStreamingDecision = await routeDecisionPayload(activeFixture);
    const firstProviderCalls = activeFixture.openai.records.filter((record) =>
      record.path === "/responses" && record.body.model !== "route-classifier-cheap"
    );

    expect(nonStreamingResponse.status).toBe(200);
    expect(firstProviderCalls.map((record) => record.body.model)).toEqual(["gpt-stream-permission"]);
    expect(nonStreamingDecision?.healthSkips ?? []).toEqual([]);

    const streamingResponse = await sendHardResponse(activeFixture, "stream-permission-token");
    await streamingResponse.text();
    const streamingDecision = await routeDecisionPayload(activeFixture);
    const providerCalls = activeFixture.openai.records.filter((record) =>
      record.path === "/responses" && record.body.model !== "route-classifier-cheap"
    );

    expect(streamingResponse.status).toBe(200);
    expect(providerCalls.map((record) => record.body.model)).toEqual(["gpt-stream-permission", "gpt-stream-permission-fallback"]);
    expect(streamingDecision?.guardrailActions).toContain("target_skipped_provider_model_terminal:custom-stream-permission");
    expect(streamingDecision?.healthSkips).toEqual([
      expect.objectContaining({
        scope: "provider_account_model",
        provider: "custom-stream-permission",
        providerId,
        providerAccountId,
        model: "gpt-stream-permission",
        healthStatus: "terminal",
        errorType: "model_access_denied",
        metadata: expect.objectContaining({
          bedrockErrorKind: "stream_permission_denied",
          bedrockOperation: "ConverseStream",
          region: "us-east-1"
        })
      })
    ]);
  });

  it("skips provider account models with terminal health", async () => {
    const organizationId = "org_health_model_terminal_skip";
    const providerId = "00000000-0000-0000-0000-00000000c022";
    const providerAccountId = `${organizationId}:provider-account:model-terminal`;
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      envOverrides: {
        ALLOWED_PRIVATE_UPSTREAM_CIDRS: "127.0.0.0/8",
        PROVIDER_SECRET_ENCRYPTION_KEY: ENCRYPTION_KEY
      }
    });
    await setupHealthRoute(activeFixture, organizationId, {
      routeSlug: "model-terminal-skip",
      secret: "model-terminal-token",
      providerId,
      providerSlug: "custom-model-terminal",
      providerAccountId,
      targets: [
        { providerId: "custom-model-terminal", model: "gpt-model-terminal", effort: "high", verbosity: "medium" },
        { providerId: "openai", model: "gpt-model-terminal-fallback", effort: "high", verbosity: "medium" }
      ]
    });
    await activeFixture.db.insert(providerModelHealth).values({
      id: `${organizationId}:model-health`,
      organizationId,
      workspaceId: defaultWorkspaceId(organizationId),
      providerId,
      providerAccountId,
      model: "gpt-model-terminal",
      status: "terminal",
      lastErrorType: "model_access_denied",
      lastErrorAt: new Date(),
      consecutiveFailures: 1,
      metadata: {}
    });

    const response = await sendHardResponse(activeFixture, "model-terminal-token");
    await response.text();
    const decision = await routeDecisionPayload(activeFixture);
    const providerCalls = activeFixture.openai.records.filter((record) =>
      record.path === "/responses" && record.body.model !== "route-classifier-cheap"
    );

    expect(response.status).toBe(200);
    expect(providerCalls.map((record) => record.body.model)).toEqual(["gpt-model-terminal-fallback"]);
    expect(decision?.guardrailActions).toContain("target_skipped_provider_model_terminal:custom-model-terminal");
    expect(decision?.healthSkips).toEqual([
      expect.objectContaining({
        scope: "provider_account_model",
        provider: "custom-model-terminal",
        providerId,
        providerAccountId,
        model: "gpt-model-terminal",
        healthStatus: "terminal",
        errorType: "model_access_denied"
      })
    ]);
    expect(decision?.healthSkips?.[0]).not.toHaveProperty("expiresAt");
  });

  it("treats expired provider account cooldowns as eligible", async () => {
    const organizationId = "org_health_expired_cooldown";
    const providerId = "00000000-0000-0000-0000-00000000c019";
    const providerAccountId = `${organizationId}:provider-account:expired-cooldown`;
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      envOverrides: {
        ALLOWED_PRIVATE_UPSTREAM_CIDRS: "127.0.0.0/8",
        PROVIDER_SECRET_ENCRYPTION_KEY: ENCRYPTION_KEY
      }
    });
    await setupHealthRoute(activeFixture, organizationId, {
      routeSlug: "expired-cooldown",
      secret: "expired-cooldown-token",
      providerId,
      providerSlug: "custom-expired-cooldown",
      providerAccountId,
      targets: [
        { providerId: "custom-expired-cooldown", model: "gpt-expired-cooldown", effort: "high", verbosity: "medium" }
      ]
    });
    await activeFixture.db.insert(providerAccountHealth).values({
      id: `${organizationId}:account-health`,
      organizationId,
      workspaceId: defaultWorkspaceId(organizationId),
      providerAccountId,
      providerId,
      status: "cooldown",
      lastErrorType: "rate_limited",
      lastErrorMessage: "rate limited",
      cooldownUntil: new Date(Date.now() - 60_000),
      consecutiveFailures: 1,
      metadata: {}
    });

    const response = await sendHardResponse(activeFixture, "expired-cooldown-token");
    await response.text();
    const decision = await routeDecisionPayload(activeFixture);
    const providerCall = activeFixture.openai.records.find((record) =>
      record.path === "/responses" && record.body.model === "gpt-expired-cooldown"
    );

    expect(response.status).toBe(200);
    expect(providerCall?.headers.authorization).toBe("Bearer sk-health-route");
    expect(decision?.provider).toBe("custom-expired-cooldown");
    expect(decision?.healthSkips ?? []).toEqual([]);
  });

  it("rejects before provider spend when all targets are unhealthy", async () => {
    const organizationId = "org_health_all_unavailable";
    const providerId = "00000000-0000-0000-0000-00000000c020";
    const providerAccountId = `${organizationId}:provider-account:all-unavailable`;
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      envOverrides: {
        ALLOWED_PRIVATE_UPSTREAM_CIDRS: "127.0.0.0/8",
        PROVIDER_SECRET_ENCRYPTION_KEY: ENCRYPTION_KEY
      }
    });
    await setupHealthRoute(activeFixture, organizationId, {
      routeSlug: "all-unavailable",
      secret: "all-unavailable-token",
      providerId,
      providerSlug: "custom-all-unavailable",
      providerAccountId,
      targets: [
        { providerId: "custom-all-unavailable", model: "gpt-all-unavailable", effort: "high", verbosity: "medium" }
      ]
    });
    await activeFixture.db.insert(providerAccountHealth).values({
      id: `${organizationId}:account-health`,
      organizationId,
      workspaceId: defaultWorkspaceId(organizationId),
      providerAccountId,
      providerId,
      status: "cooldown",
      lastErrorType: "rate_limited",
      lastErrorMessage: "rate limited",
      cooldownUntil: new Date(Date.now() + 60_000),
      consecutiveFailures: 1,
      metadata: {}
    });

    const response = await sendHardResponse(activeFixture, "all-unavailable-token");
    const body = await response.json() as { error?: string; message?: string };
    const decision = await routeDecisionPayload(activeFixture);
    const eventRows = await activeFixture.db.select().from(events);
    const decisionEvent = eventRows.find((event) => event.eventType === "routing.decision_recorded");
    const detail = await adminGql(
      activeFixture.proxyUrl,
      activeFixture.adminHeaders,
      `query($requestId: ID!) { request(requestId: $requestId) { healthSkips } }`,
      { requestId: decisionEvent?.scopeId }
    );
    const providerCalls = activeFixture.openai.records.filter((record) =>
      record.path === "/responses" && record.body.model !== "route-classifier-cheap"
    );

    expect(response.status).toBe(503);
    expect(body.error).toBe("provider_health_unavailable");
    expect(body.message).toContain("provider target");
    expect(providerCalls).toHaveLength(0);
    expect(decision).toEqual(expect.objectContaining({
      outcome: "reject",
      error: "provider_health_unavailable",
      healthSkips: [
        expect.objectContaining({
          scope: "provider_account",
          provider: "custom-all-unavailable",
          providerId,
          providerAccountId,
          model: "gpt-all-unavailable",
          healthStatus: "cooldown",
          errorType: "rate_limited"
        })
      ]
    }));
    expect(detail.errors).toBeUndefined();
    expect(detail.data?.request.healthSkips).toEqual(decision?.healthSkips);
  });

  it("rejects requests over the routing config input-token cap before classifier spend", async () => {
    const organizationId = "org_config_input_cap";
    activeFixture = await captureFixture(organizationId);
    await assignRouteConfig(activeFixture, organizationId, {
      secret: "input-cap-token",
      slug: "input-cap",
      configHash: "sha256:input-cap-config",
      configure: (config) => {
        config.limits = { ...config.limits, maxEstimatedInputTokens: 1 };
        return config;
      }
    });

    const response = await fetch(`${activeFixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer input-cap-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: "this request is intentionally too large for the tiny budget",
        stream: true
      })
    });
    const body = await response.json() as {
      error?: string;
      message?: string;
      details?: { reasonCode?: string; current?: number; limit?: number };
    };

    const eventRows = await activeFixture.db.select().from(events);
    const decision = eventRows.find((event) => event.eventType === "routing.decision_recorded");
    const payload = (decision?.payload ?? {}) as { budgetChecks?: Array<{ status: string }> };

    expect(response.status).toBe(429);
    expect(body.error).toBe("request_estimated_input_limit");
    expect(body.message).toContain("full request is estimated");
    expect(body.message).toContain("full session envelope and history");
    expect(body.details).toEqual(expect.objectContaining({
      reasonCode: "request_estimated_input_limit",
      limit: 1
    }));
    expect(activeFixture.openai.records).toHaveLength(0);
    expect(payload.budgetChecks?.[0]?.status).toBe("reject");
  });

  it("clamps auto-routed requests above the routing config max route", async () => {
    const organizationId = "org_config_max_route";
    activeFixture = await captureFixture(organizationId);
    await assignRouteConfig(activeFixture, organizationId, {
      secret: "max-route-token",
      slug: "max-route",
      configHash: "sha256:max-route-config",
      configure: (config) => {
        config.limits = { ...config.limits, maxRoute: "balanced", fallbackRoute: "balanced" };
        return config;
      }
    });

    // The mock classifier recommends "hard", which is above the balanced cap.
    const response = await fetch(`${activeFixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer max-route-token",
        "content-type": "application/json",
        "x-codex-session-id": "max-route-session"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: "debug auth regression",
        stream: true
      })
    });
    await response.text();

    const sessions = await fetch(`${activeFixture.proxyUrl}/_debug/sessions`, {
      headers: { authorization: "Bearer proxy-token" }
    }).then((item) => item.json());
    const eventRows = await activeFixture.db.select().from(events);
    const decision = eventRows.find((event) => event.eventType === "routing.decision_recorded");
    const payload = (decision?.payload ?? {}) as { finalRoute?: string; guardrailActions?: string[] };

    expect(response.status).toBe(200);
    expect(payload.finalRoute).toBe("balanced");
    expect(payload.guardrailActions).toContain("route_limit_clamped");
    expect(activeFixture.openai.records
      .filter((record) => record.body.model !== "route-classifier-cheap")
      .map((record) => record.body.model)
    ).toEqual(["gpt-5.4"]);
    expect(sessions).toEqual([expect.objectContaining({ currentRoute: "balanced" })]);
  });

  it("recovers sessions memorized above a newly lowered max route", async () => {
    const organizationId = "org_config_lowered_cap";
    activeFixture = await captureFixture(organizationId);
    const assigned = await assignRouteConfig(activeFixture, organizationId, {
      secret: "lowered-cap-token",
      slug: "lowered-cap",
      configHash: "sha256:lowered-cap-config",
      configure: (config) => config
    });
    const send = () => fetch(`${activeFixture!.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer lowered-cap-token",
        "content-type": "application/json",
        "x-codex-session-id": "lowered-cap-session"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: "debug auth regression",
        stream: true
      })
    });

    // First request memorizes the session at the classifier's "hard" route.
    await (await send()).text();

    const config = structuredClone(assigned.config);
    config.limits = { ...config.limits, maxRoute: "balanced", fallbackRoute: "balanced" };
    await activeFixture.db
      .update(routingConfigVersions)
      .set({ config })
      .where(eq(routingConfigVersions.id, assigned.versionId));
    activeFixture.persistence.routingConfigs.clearCache();

    const response = await send();
    await response.text();

    const sessions = await fetch(`${activeFixture.proxyUrl}/_debug/sessions`, {
      headers: { authorization: "Bearer proxy-token" }
    }).then((item) => item.json());
    const eventRows = await activeFixture.db.select().from(events);
    const capped = eventRows
      .filter((event) => event.eventType === "routing.decision_recorded")
      .map((event) => (event.payload ?? {}) as {
        finalRoute?: string;
        guardrailActions?: string[];
        reasonCodes?: string[];
      })
      .find((payload) => payload.guardrailActions?.includes("session_route_capped"));
    const [sessionRow] = await activeFixture.db
      .select({ pinnedSettings: agentSessions.pinnedSettings })
      .from(agentSessions);

    expect(response.status).toBe(200);
    expect(capped?.finalRoute).toBe("balanced");
    // Memory at or above the lowered ceiling fixes the decision, so the
    // second request skips the classifier.
    expect(capped?.reasonCodes).toEqual(["session_route_ceiling"]);
    expect(activeFixture.openai.records
      .filter((record) => record.body.model === "route-classifier-cheap")
    ).toHaveLength(1);
    expect(activeFixture.openai.records
      .filter((record) => record.body.model !== "route-classifier-cheap")
      .map((record) => record.body.model)
    ).toEqual(["gpt-5.5", "gpt-5.4"]);
    expect(sessions).toEqual([expect.objectContaining({ currentRoute: "balanced" })]);
    // The persisted pin is rewritten to the capped route's settings, so a
    // rehydrated session cannot route above the cap.
    expect((sessionRow?.pinnedSettings as { model?: string })?.model).toBe("gpt-5.4");
  });

  it("rejects explicit aliases above the routing config max route before classifier spend", async () => {
    const organizationId = "org_config_alias_cap";
    activeFixture = await captureFixture(organizationId);
    await assignRouteConfig(activeFixture, organizationId, {
      secret: "alias-cap-token",
      slug: "alias-cap",
      configHash: "sha256:alias-cap-config",
      configure: (config) => {
        config.limits = { ...config.limits, maxRoute: "balanced", fallbackRoute: "balanced" };
        return config;
      }
    });

    const response = await fetch(`${activeFixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer alias-cap-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "router-deep",
        input: "explicitly requesting the deep tier",
        stream: true
      })
    });
    await response.text();

    expect(response.status).toBe(429);
    expect(activeFixture.openai.records).toHaveLength(0);
  });

  it("rejects requests over a per-route input-token limit", async () => {
    const organizationId = "org_config_route_input_cap";
    activeFixture = await captureFixture(organizationId);
    await assignRouteConfig(activeFixture, organizationId, {
      secret: "route-input-cap-token",
      slug: "route-input-cap",
      configHash: "sha256:route-input-cap-config",
      configure: (config) => {
        // The mock classifier recommends "hard".
        config.limits = { ...config.limits, routeEstimatedInputLimits: { hard: 1 } };
        return config;
      }
    });

    const response = await fetch(`${activeFixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer route-input-cap-token",
        "content-type": "application/json",
        "x-codex-session-id": "route-input-cap-session"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: "this request exceeds the hard route's tiny input cap",
        stream: true
      })
    });
    await response.text();

    const eventRows = await activeFixture.db.select().from(events);
    const decision = eventRows.find((event) => event.eventType === "routing.decision_recorded");
    const payload = (decision?.payload ?? {}) as { reasonCodes?: string[] };
    const sessions = (await adminGql(
      activeFixture.proxyUrl,
      activeFixture.adminHeaders,
      "query { sessions { sessionId modelMix } }"
    )).data?.sessions;

    expect(response.status).toBe(429);
    expect(activeFixture.openai.records.filter((record) =>
      record.body.model !== "route-classifier-cheap"
    )).toHaveLength(0);
    expect(payload.reasonCodes).toEqual(["route_estimated_input_limit"]);
    // The persisted rejection shape is what the sessions table labels "rejected".
    expect(sessions).toEqual([expect.objectContaining({ modelMix: { rejected: 1 } })]);
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
    workspaceId: defaultWorkspaceId(organizationId),
    name: "Assigned classifier config",
    slug: "classifier",
    status: "active"
  });
  await fixture.db.insert(routingConfigVersions).values({
    id: versionId,
    organizationId,
    workspaceId: defaultWorkspaceId(organizationId),
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
    workspaceId: defaultWorkspaceId(organizationId),
    keyHash: hashApiKey(input.secret),
    name: "Assigned classifier key",
    routingConfigId: configId
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
    workspaceId: defaultWorkspaceId(organizationId),
    name: "Assigned route config",
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
    name: "Assigned route key",
    routingConfigId: configId
  });

  return {
    configId,
    versionId,
    configHash: input.configHash,
    config
  };
}

type AnthropicEffort = NonNullable<RoutingConfigAnthropicDeployment["output_config"]>["effort"];
type OpenAIEffort = NonNullable<RoutingConfigOpenAIDeployment["reasoning"]>["effort"];
type OpenAIVerbosity = NonNullable<RoutingConfigOpenAIDeployment["text"]>["verbosity"];

type TargetFixture = {
  providerId: string;
  model: string;
  effort?: AnthropicEffort | OpenAIEffort;
  verbosity?: OpenAIVerbosity;
};

function withHardTargets(config: RoutingConfig, targets: TargetFixture[]): RoutingConfig {
  const openai = targets
    .filter((target) => !target.providerId.includes("anthropic"))
    .map((target, index): RoutingConfigOpenAIDeployment => ({
      provider: target.providerId,
      model: target.model,
      order: index,
      weight: 1,
      timeoutMs: 60000,
      ...(target.effort ? { reasoning: { effort: target.effort as OpenAIEffort } } : {}),
      ...(target.verbosity ? { text: { verbosity: target.verbosity } } : {})
    }));
  const anthropic = targets
    .filter((target) => target.providerId.includes("anthropic"))
    .map((target, index): RoutingConfigAnthropicDeployment => ({
      provider: target.providerId,
      model: target.model,
      order: index,
      weight: 1,
      timeoutMs: 60000,
      ...(target.effort ? { output_config: { effort: target.effort as AnthropicEffort } } : {})
    }));

  return {
    ...config,
    routes: {
      ...config.routes,
      hard: {
        ...config.routes.hard,
        ...(openai.length > 0 ? { openai: { deployments: openai } } : { openai: undefined }),
        ...(anthropic.length > 0 ? { anthropic: { deployments: anthropic } } : { anthropic: undefined })
      }
    }
  };
}

async function setupHealthRoute(
  fixture: PromptTestFixture,
  organizationId: string,
  input: {
    routeSlug: string;
    secret: string;
    providerId: string;
    providerSlug: string;
    providerAccountId: string;
    targets: TargetFixture[];
  }
) {
  await fixture.db.insert(providers).values({
    id: input.providerId,
    organizationId,
    slug: input.providerSlug,
    displayName: "Health test provider",
    baseUrl: fixture.openai.url,
    authStyle: "bearer",
    endpoints: [{ dialect: "openai-responses", path: "/responses" }],
    defaultHeaders: {},
    forwardHarnessHeaders: false,
    enabled: true
  });
  await fixture.db.insert(providerAccounts).values({
    id: input.providerAccountId,
    organizationId,
    providerId: input.providerId,
    name: "Health test key",
    authType: "api_key",
    secretCiphertext: encryptSecret("sk-health-route", ENCRYPTION_KEY),
    secretHint: "••••oute",
    settings: {}
  });
  await assignRouteConfig(fixture, organizationId, {
    secret: input.secret,
    slug: input.routeSlug,
    configHash: `sha256:${input.routeSlug}`,
    configure: (config) => ({
      ...config,
      routes: {
        ...config.routes,
        hard: withHardTargets(config, input.targets).routes.hard
      }
    })
  });
  await fixture.db.insert(apiKeyProviderAccounts).values({
    organizationId,
    workspaceId: defaultWorkspaceId(organizationId),
    apiKeyId: `api_key_${input.routeSlug}`,
    providerId: input.providerId,
    providerAccountId: input.providerAccountId
  });
}

function sendHardResponse(fixture: PromptTestFixture, token: string, stream = true) {
  return fetch(`${fixture.proxyUrl}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "router-hard",
      input: "debug this provider health route",
      stream
    })
  });
}

async function routeDecisionPayload(fixture: PromptTestFixture) {
  const eventRows = await fixture.db.select().from(events);
  const decision = eventRows.filter((event) => event.eventType === "routing.decision_recorded").at(-1);
  return decision?.payload as Record<string, any> | undefined;
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

function websocketOpen(ws: WebSocket) {
  return new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

function nextWebSocketCompletion(ws: WebSocket) {
  return new Promise<any>((resolve, reject) => {
    ws.on("message", (data) => {
      const event = JSON.parse(String(data));
      if (event.type === "response.completed" || event.type === "response.incomplete") resolve(event);
    });
    ws.once("error", reject);
  });
}

async function lastDecisionPayload(fixture: PromptTestFixture) {
  const eventRows = await fixture.db.select().from(events);
  const decision = eventRows
    .filter((event) => event.eventType === "routing.decision_recorded")
    .at(-1);
  return decision?.payload as { guardrailActions?: string[] } | undefined;
}
