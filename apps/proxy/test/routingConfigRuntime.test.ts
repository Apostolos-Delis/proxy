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
  organizationSettings,
  promptArtifacts,
  providers,
  providerAccounts,
  routingConfigs,
  routingConfigVersions
} from "@prompt-proxy/db";
import { seedDatabase, seedOptionsFromEnv } from "@prompt-proxy/db/seed";
import { composeClassifierInstructions, type RoutingConfig } from "@prompt-proxy/schema";

import { adminGql, captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

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

    expect(response.status).toBe(200);
    // Classifier failure falls back to the routing config's limits.fallbackRoute
    // (seeded as "hard"), not the no-config "balanced" constant.
    expect(response.headers.get("x-prompt-proxy-route")).toBe("hard");
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
    expect(response.headers.get("x-prompt-proxy-route")).toBe("fast");
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
        config.routes.hard.targets = [{ providerId: "missing-hard-provider", model: "missing-hard-model", effort: "high" }];
        return config;
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
    expect(response.headers.get("x-prompt-proxy-route")).toBe("fast");
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
            targets: config.routes.hard.targets.map((target) => target.providerId === "openai"
              ? {
                  ...target,
                  model: "gpt-config-hard",
                  effort: "max",
                  verbosity: "high",
                  maxOutputTokens: 1234
                }
              : target)
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
          hard: {
            ...config.routes.hard,
            targets: [
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
            ]
          }
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
          hard: {
            ...config.routes.hard,
            targets: [{ providerId: "acme-no-effort", model: "acme-hard", effort: "high" }]
          }
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
    expect(response.headers.get("x-prompt-proxy-reasoning-effort")).toBeNull();
    expect(providerCall).toBeTruthy();
    expect(providerCall?.body.reasoning).toBeUndefined();
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
          hard: {
            ...config.routes.hard,
            targets: [{
              providerId: "custom-responses",
              model: "gpt-custom-ws",
              effort: "high",
              verbosity: "medium"
            }]
          }
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
          hard: {
            ...config.routes.hard,
            targets: [{
              providerId: "custom-responses-byok",
              model: "gpt-custom-ws-byok",
              effort: "high",
              verbosity: "medium"
            }]
          }
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

    expect(providerCall).toBeTruthy();
    expect(providerCall?.headers.authorization).toBe("Bearer sk-custom-ws");
    expect(providerCall?.headers["x-custom-provider"]).toBe("byok");
    expect(providerCall?.headers["openai-beta"]).toBe("responses_websockets=2026-02-06");
    expect(eventRows.filter((event) => event.eventType === "provider.response_completed")).toHaveLength(1);
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
            targets: config.routes.deep.targets.map((target) => target.providerId === "anthropic"
              ? {
                  ...target,
                  model: "claude-opus-4-8",
                  thinking: { type: "adaptive", display: "summarized" },
                  effort: "ultracode",
                  maxOutputTokens: 4096
                }
              : target)
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
    expect(response.headers.get("x-prompt-proxy-route")).toBe("deep");
    expect(response.headers.get("x-prompt-proxy-reasoning-effort")).toBe("xhigh");
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

  it("pins the organization system prompt for active OpenAI sessions", async () => {
    const organizationId = "org_system_prompt_pin";
    activeFixture = await captureFixture(organizationId);
    await activeFixture.db
      .update(organizationSettings)
      .set({ systemPrompt: "Initial proxy policy." })
      .where(eq(organizationSettings.organizationId, organizationId));

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

    const first = await sendRequest("prompt-pin-session", "debug the first failing test");
    await first.text();
    await activeFixture.db
      .update(organizationSettings)
      .set({ systemPrompt: "Updated proxy policy." })
      .where(eq(organizationSettings.organizationId, organizationId));
    const second = await sendRequest("prompt-pin-session", "debug the second failing test");
    await second.text();
    const third = await sendRequest("prompt-pin-session-new", "debug the third failing test");
    await third.text();

    const providerCalls = activeFixture.openai.records.filter((record) =>
      record.body.model !== "route-classifier-cheap" && record.path === "/responses"
    );
    const [sessionRow] = await activeFixture.db
      .select({ metadata: agentSessions.metadata })
      .from(agentSessions)
      .where(eq(agentSessions.externalSessionId, "prompt-pin-session"))
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
            targets: [{ providerId: "missing-hard-provider", model: "missing-hard-model", effort: "high" }]
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
