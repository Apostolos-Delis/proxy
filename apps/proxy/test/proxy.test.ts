import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { ROUTING_CLASSIFIER_BASE_INSTRUCTIONS } from "@prompt-proxy/schema";

import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { listen, startAnthropicMock, startOpenAIMock, type MockServer } from "./helpers.js";

function testEnv(overrides: NodeJS.ProcessEnv = {}) {
  return {
    ...process.env,
    DATABASE_URL: "",
    EVENT_STORE_PATH: "",
    PROMPT_PROXY_TOKEN: "proxy-token",
    OPENAI_API_KEY: "openai-upstream-key",
    OPENAI_BASE_URL: "http://127.0.0.1",
    OPENAI_FAST_MODEL: "gpt-5.4-mini",
    OPENAI_BALANCED_MODEL: "gpt-5.4",
    OPENAI_HARD_MODEL: "gpt-5.5",
    OPENAI_DEEP_MODEL: "gpt-5.5-pro",
    ANTHROPIC_API_KEY: "anthropic-upstream-key",
    ANTHROPIC_BASE_URL: "http://127.0.0.1",
    ANTHROPIC_FAST_MODEL: "claude-haiku-4-5",
    ANTHROPIC_BALANCED_MODEL: "claude-sonnet-4-5",
    ANTHROPIC_HARD_MODEL: "claude-sonnet-4-5",
    ANTHROPIC_DEEP_MODEL: "claude-opus-4-5",
    CLASSIFIER_PROVIDER: "openai",
    CLASSIFIER_MODEL: "route-classifier-cheap",
    CLASSIFIER_ALLOW_REDACTED_EXCERPT: "false",
    MODEL_COSTS_JSON: "",
    ...overrides
  };
}

describe("prompt proxy", () => {
  let openai: MockServer;
  let anthropic: MockServer;

  beforeEach(async () => {
    openai = await startOpenAIMock();
    anthropic = await startAnthropicMock();
  });

  afterEach(async () => {
    await openai.close();
    await anthropic.close();
  });

  it("routes Codex-style OpenAI Responses requests through the classifier", async () => {
    const app = buildServer(
      loadConfig({
        ...testEnv(),
        PROMPT_PROXY_TOKEN: "proxy-token",
        OPENAI_API_KEY: "openai-upstream-key",
        ANTHROPIC_API_KEY: "anthropic-upstream-key",
        OPENAI_BASE_URL: openai.url,
        ANTHROPIC_BASE_URL: anthropic.url,
        OPENAI_HARD_MODEL: "gpt-routed-hard-test",
        CLASSIFIER_PROVIDER: "openai",
        CLASSIFIER_MODEL: "route-classifier-cheap",
        CLASSIFIER_ALLOW_REDACTED_EXCERPT: "false",
        LOG_LEVEL: "fatal"
      })
    );
    const proxyUrl = await listen(app);

    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json",
        "x-codex-turn-state": "turn-state-1",
        "x-codex-turn-metadata": "turn-metadata-1",
        "x-openai-subagent": "reviewer",
        "x-request-id": "request-id-1",
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00"
      },
      body: JSON.stringify({
        model: "gpt-5.5",
        input: "fix the failing auth test and find root cause",
        tools: [{ type: "function", name: "shell" }],
        previous_response_id: "resp_previous",
        stream: true,
        include: ["reasoning.encrypted_content"]
      })
    });

    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-prompt-proxy-route")).toBe("hard");
    expect(response.headers.get("x-prompt-proxy-reasoning-effort")).toBe("high");
    expect(body).toContain("response.completed");

    const classifierCall = openai.records.find((record) => record.body.model === "route-classifier-cheap");
    const providerCall = openai.records.find((record) => record.body.model === "gpt-routed-hard-test");

    expect(classifierCall).toBeTruthy();
    expect(classifierCall?.body.input).toContain('"content_mode":"features_only"');
    expect(classifierCall?.body.input).toContain('"input_excerpt":null');
    expect(providerCall).toBeTruthy();
    expect(providerCall?.headers.authorization).toBe("Bearer openai-upstream-key");
    expect(providerCall?.headers["x-codex-turn-state"]).toBe("turn-state-1");
    expect(providerCall?.headers["x-codex-turn-metadata"]).toBe("turn-metadata-1");
    expect(providerCall?.headers["x-openai-subagent"]).toBe("reviewer");
    expect(providerCall?.headers["x-request-id"]).toBe("request-id-1");
    expect(providerCall?.headers.traceparent).toBe("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00");
    expect(providerCall?.body.reasoning.effort).toBe("high");
    expect(providerCall?.body.text.verbosity).toBe("medium");
    expect(providerCall?.body.model).not.toBe("gpt-5.5");
    expect(providerCall?.body.previous_response_id).toBe("resp_previous");
    expect(providerCall?.body.include).toEqual(["reasoning.encrypted_content"]);

    const events = await fetch(`${proxyUrl}/_debug/events`, {
      headers: { authorization: "Bearer proxy-token" }
    }).then((item) => item.json());
    const sessions = await fetch(`${proxyUrl}/_debug/sessions`, {
      headers: { authorization: "Bearer proxy-token" }
    }).then((item) => item.json());
    await app.close();

    expect(events.map((event: any) => event.eventType)).toContain("routing.classification_recorded");
    expect(events.map((event: any) => event.eventType)).toContain("routing.decision_recorded");
    expect(events.map((event: any) => event.eventType)).toContain("usage.recorded");
    expect(sessions).toHaveLength(0);
  });

  it("routes Codex WebSocket requests and pins continuations via session memory", async () => {
    const app = buildServer(
      loadConfig({
        ...testEnv(),
        PROMPT_PROXY_TOKEN: "proxy-token",
        OPENAI_API_KEY: "openai-upstream-key",
        ANTHROPIC_API_KEY: "anthropic-upstream-key",
        OPENAI_BASE_URL: openai.url,
        ANTHROPIC_BASE_URL: anthropic.url,
        OPENAI_HARD_MODEL: "gpt-ws-hard-test",
        CLASSIFIER_PROVIDER: "openai",
        CLASSIFIER_MODEL: "route-classifier-cheap",
        LOG_LEVEL: "fatal"
      })
    );
    const proxyUrl = await listen(app);
    const ws = new WebSocket(proxyUrl.replace("http://", "ws://") + "/v1/responses", {
      headers: {
        authorization: "Bearer proxy-token",
        "openai-beta": "responses_websockets=2026-02-06",
        session_id: "codex-ws-session"
      }
    });
    await websocketOpen(ws);

    ws.send(JSON.stringify({
      type: "response.create",
      model: "gpt-5.5",
      input: "fix the failing auth test and find root cause",
      tools: [{ type: "function", name: "shell" }],
      stream: true
    }));
    const firstResponseId = await nextCompletedResponseId(ws);

    ws.send(JSON.stringify({
      type: "response.create",
      model: "gpt-5.5",
      previous_response_id: firstResponseId,
      input: "git status",
      tools: [{ type: "function", name: "shell" }],
      stream: true
    }));
    const secondResponseId = await nextCompletedResponseId(ws);

    ws.send(JSON.stringify({
      type: "response.create",
      model: "gpt-5.5",
      previous_response_id: secondResponseId,
      input: [{ type: "function_call_output", call_id: "call_1", output: "ok" }],
      tools: [{ type: "function", name: "shell" }],
      stream: true
    }));
    await nextCompletedResponseId(ws);
    ws.close();

    const events = await fetch(`${proxyUrl}/_debug/events`, {
      headers: { authorization: "Bearer proxy-token" }
    }).then((item) => item.json());
    await app.close();

    const classifierCalls = openai.records.filter((record) => record.body.model === "route-classifier-cheap");
    const providerCalls = openai.records.filter((record) => record.body.model === "gpt-ws-hard-test");

    expect(classifierCalls).toHaveLength(2);
    expect(providerCalls).toHaveLength(3);
    expect(providerCalls[0].headers.authorization).toBe("Bearer openai-upstream-key");
    expect(providerCalls[0].headers["openai-beta"]).toBe("responses_websockets=2026-02-06");
    expect(providerCalls[0].body.type).toBe("response.create");
    expect(providerCalls[1].body.previous_response_id).toBe(firstResponseId);
    expect(providerCalls[1].body.reasoning.effort).toBe("high");
    expect(providerCalls[2].body.previous_response_id).toBe(secondResponseId);
    expect(providerCalls[2].body.reasoning.effort).toBe("high");

    const decisions = events.filter((event: any) => event.eventType === "routing.decision_recorded");
    expect(decisions.map((event: any) => event.payload.requestedModel)).toEqual([
      "gpt-5.5",
      "gpt-5.5",
      "gpt-5.5"
    ]);
    expect(decisions[2].payload.reasonCodes).toContain("session_route_no_user_signal");
    expect(decisions[2].payload.guardrailActions).toContain("session_route_kept");
    expect(decisions[2].payload.guardrailActions).toContain("session_settings_pinned");
    expect(events.filter((event: any) => event.eventType === "provider.response_completed")).toHaveLength(3);
  });

  it("pins sessionless WebSocket connections through a connection-scoped session id", async () => {
    await openai.close();
    openai = await startOpenAIMock({
      classifierOutputs: [
        {
          complexity: "hard",
          risk: ["failing_test"],
          recommended_route: "hard",
          can_use_fast_model: false,
          needs_deep_reasoning: false,
          reason_codes: ["failing_test"],
          confidence: 0.85
        },
        {
          complexity: "simple",
          risk: [],
          recommended_route: "fast",
          can_use_fast_model: true,
          needs_deep_reasoning: false,
          reason_codes: ["simple_request"],
          confidence: 0.9
        }
      ]
    });
    const app = buildServer(
      loadConfig({
        ...testEnv(),
        OPENAI_BASE_URL: openai.url,
        ANTHROPIC_BASE_URL: anthropic.url,
        OPENAI_HARD_MODEL: "gpt-ws-hard-test",
        LOG_LEVEL: "fatal"
      })
    );
    const proxyUrl = await listen(app);
    const ws = new WebSocket(proxyUrl.replace("http://", "ws://") + "/v1/responses", {
      headers: {
        authorization: "Bearer proxy-token",
        "openai-beta": "responses_websockets=2026-02-06"
      }
    });
    await websocketOpen(ws);

    ws.send(JSON.stringify({
      type: "response.create",
      model: "router-auto",
      input: "fix the failing auth test and find root cause",
      stream: true
    }));
    const firstResponseId = await nextCompletedResponseId(ws);

    ws.send(JSON.stringify({
      type: "response.create",
      model: "router-auto",
      previous_response_id: firstResponseId,
      input: "thanks",
      stream: true
    }));
    await nextCompletedResponseId(ws);
    ws.close();

    const events = await fetch(`${proxyUrl}/_debug/events`, {
      headers: { authorization: "Bearer proxy-token" }
    }).then((item) => item.json());
    const sessions = await fetch(`${proxyUrl}/_debug/sessions`, {
      headers: { authorization: "Bearer proxy-token" }
    }).then((item) => item.json());
    await app.close();

    const classifierCalls = openai.records.filter((record) => record.body.model === "route-classifier-cheap");
    const providerCalls = openai.records.filter((record) => record.body.model === "gpt-ws-hard-test");
    const decisions = events.filter((event: any) => event.eventType === "routing.decision_recorded");

    expect(classifierCalls).toHaveLength(2);
    expect(providerCalls).toHaveLength(2);
    expect(providerCalls[1].body.previous_response_id).toBe(firstResponseId);
    expect(providerCalls[1].body.reasoning.effort).toBe("high");
    expect(decisions.map((event: any) => event.payload.requestedModel)).toEqual([
      "router-auto",
      "router-auto"
    ]);
    expect(sessions).toEqual([
      expect.objectContaining({
        currentRoute: "hard",
        requestCount: 2,
        softFloor: false
      })
    ]);
  });

  it("treats OpenAI WebSocket response.incomplete as terminal usage", async () => {
    await openai.close();
    openai = await startOpenAIMock({ wsTerminalEvent: "response.incomplete" });
    const app = buildServer(
      loadConfig({
        ...testEnv(),
        PROMPT_PROXY_TOKEN: "proxy-token",
        OPENAI_API_KEY: "openai-upstream-key",
        ANTHROPIC_API_KEY: "anthropic-upstream-key",
        OPENAI_BASE_URL: openai.url,
        ANTHROPIC_BASE_URL: anthropic.url,
        CLASSIFIER_PROVIDER: "openai",
        CLASSIFIER_MODEL: "route-classifier-cheap",
        LOG_LEVEL: "fatal"
      })
    );
    const proxyUrl = await listen(app);
    const ws = new WebSocket(proxyUrl.replace("http://", "ws://") + "/v1/responses", {
      headers: {
        authorization: "Bearer proxy-token",
        "openai-beta": "responses_websockets=2026-02-06",
        session_id: "codex-ws-incomplete-session"
      }
    });
    await websocketOpen(ws);

    ws.send(JSON.stringify({
      type: "response.create",
      model: "router-auto",
      input: "reply briefly",
      stream: true,
      max_output_tokens: 16
    }));
    await nextTerminalResponseId(ws, "response.incomplete");
    ws.close();

    const events = await fetch(`${proxyUrl}/_debug/events`, {
      headers: { authorization: "Bearer proxy-token" }
    }).then((item) => item.json());
    await app.close();

    expect(events.filter((event: any) => event.eventType === "provider.response_completed")).toHaveLength(1);
    expect(events.filter((event: any) => event.eventType === "usage.recorded")).toHaveLength(1);
  });

  it("parses classifier output from Responses content items", async () => {
    await openai.close();
    openai = await startOpenAIMock({
      classifierResponsesShape: true,
      classifierOutput: {
        complexity: "simple",
        risk: [],
        recommended_route: "fast",
        can_use_fast_model: true,
        needs_deep_reasoning: false,
        reason_codes: ["simple_request"],
        confidence: 0.8
      }
    });
    const app = buildServer(
      loadConfig({
        ...testEnv(),
        PROMPT_PROXY_TOKEN: "proxy-token",
        OPENAI_API_KEY: "openai-upstream-key",
        ANTHROPIC_API_KEY: "anthropic-upstream-key",
        OPENAI_BASE_URL: openai.url,
        ANTHROPIC_BASE_URL: anthropic.url,
        CLASSIFIER_PROVIDER: "openai",
        CLASSIFIER_MODEL: "route-classifier-cheap",
        LOG_LEVEL: "fatal"
      })
    );
    const proxyUrl = await listen(app);

    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: "format the answer",
        stream: true
      })
    });
    await response.text();

    const providerCall = openai.records.find((record) => record.body.model === "gpt-5.4-mini");
    await app.close();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-prompt-proxy-route")).toBe("fast");
    expect(response.headers.get("x-prompt-proxy-reasoning-effort")).toBe("low");
    expect(providerCall).toBeTruthy();
  });

  it("classifies the latest user message instead of the full Codex envelope", async () => {
    await openai.close();
    openai = await startOpenAIMock({
      classifierOutput: {
        complexity: "simple",
        risk: [],
        recommended_route: "fast",
        can_use_fast_model: true,
        needs_deep_reasoning: false,
        reason_codes: ["latest_user_intent_simple"],
        confidence: 0.86
      }
    });
    const app = buildServer(
      loadConfig({
        ...testEnv(),
        PROMPT_PROXY_TOKEN: "proxy-token",
        OPENAI_API_KEY: "openai-upstream-key",
        ANTHROPIC_API_KEY: "anthropic-upstream-key",
        OPENAI_BASE_URL: openai.url,
        ANTHROPIC_BASE_URL: anthropic.url,
        CLASSIFIER_PROVIDER: "openai",
        CLASSIFIER_MODEL: "route-classifier-cheap",
        CLASSIFIER_ALLOW_REDACTED_EXCERPT: "true",
        LOG_LEVEL: "fatal"
      })
    );
    const proxyUrl = await listen(app);

    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "router-auto",
        instructions: "security migration concurrency failing test production ".repeat(200),
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "debug the production auth migration" }]
          },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "I will inspect it." }]
          },
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "git status" }]
          }
        ],
        tools: [{ type: "function", name: "shell" }],
        stream: true
      })
    });
    await response.text();

    const classifierCall = openai.records.find((record) => record.body.model === "route-classifier-cheap");
    const classifierInput = JSON.parse(classifierCall?.body.input);
    const providerCall = openai.records.find((record) => record.body.model === "gpt-5.4-mini");
    const events = await fetch(`${proxyUrl}/_debug/events`, {
      headers: { authorization: "Bearer proxy-token" }
    }).then((item) => item.json());
    const contextEvent = events.find((event: any) => event.eventType === "routing.context_built");
    await app.close();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-prompt-proxy-route")).toBe("fast");
    expect(providerCall).toBeTruthy();
    expect(classifierInput.routing_basis).toBe("latest_user_message");
    expect(classifierInput.content_mode).toBe("redacted_excerpt");
    expect(classifierInput.input_excerpt).toBe("git status");
    expect(classifierInput.input_chars).toBe("git status".length);
    expect(classifierInput.full_input_chars).toBeGreaterThan(10_000);
    expect(classifierInput.extracted_hints).toEqual([]);
    expect(classifierCall?.body.instructions).toBe(ROUTING_CLASSIFIER_BASE_INSTRUCTIONS);
    expect(contextEvent.payload.routingInputChars).toBe("git status".length);
    expect(contextEvent.payload.inputChars).toBeGreaterThan(10_000);
  });

  it("does not forward decoded upstream content encoding", async () => {
    await openai.close();
    openai = await startOpenAIMock({ compressedJsonProvider: true });
    const app = buildServer(
      loadConfig({
        ...testEnv(),
        PROMPT_PROXY_TOKEN: "proxy-token",
        OPENAI_API_KEY: "openai-upstream-key",
        ANTHROPIC_API_KEY: "anthropic-upstream-key",
        OPENAI_BASE_URL: openai.url,
        ANTHROPIC_BASE_URL: anthropic.url,
        CLASSIFIER_PROVIDER: "openai",
        CLASSIFIER_MODEL: "route-classifier-cheap",
        LOG_LEVEL: "fatal"
      })
    );
    const proxyUrl = await listen(app);

    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "router-fast",
        input: "format the answer",
        stream: false
      })
    });
    const body = await response.json();
    await app.close();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("x-prompt-proxy-reasoning-effort")).toBe("low");
    expect(body.id).toBe("resp_mock");
  });

  it("routes Claude Code-style Anthropic Messages requests through the classifier", async () => {
    const config = loadConfig({
        ...testEnv(),
        PROMPT_PROXY_TOKEN: "proxy-token",
        OPENAI_API_KEY: "openai-upstream-key",
        ANTHROPIC_API_KEY: "anthropic-upstream-key",
        OPENAI_BASE_URL: openai.url,
        ANTHROPIC_BASE_URL: anthropic.url,
        CLASSIFIER_PROVIDER: "openai",
        CLASSIFIER_MODEL: "route-classifier-cheap",
        LOG_LEVEL: "fatal"
      });
    const app = buildServer(config);
    const proxyUrl = await listen(app);

    const response = await fetch(`${proxyUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": "proxy-token",
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-claude-code-session-id": "claude-session-1",
        "x-claude-code-agent-id": "claude-agent-1",
        "x-claude-code-parent-agent-id": "claude-parent-1"
      },
      body: JSON.stringify({
        model: "claude-router-auto",
        system: "You are Claude Code.",
        messages: [
          {
            role: "user",
            content: "debug this flaky auth regression and find root cause"
          }
        ],
        tools: [{ name: "bash", input_schema: { type: "object" } }],
        stream: true,
        max_tokens: 4096
      })
    });

    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-prompt-proxy-route")).toBe("hard");
    expect(response.headers.get("x-prompt-proxy-reasoning-effort")).toBe("high");
    expect(body).toContain("message_stop");

    const providerCall = anthropic.records.find((record) => record.path === "/messages");
    expect(providerCall).toBeTruthy();
    expect(providerCall?.headers["x-api-key"]).toBe("anthropic-upstream-key");
    expect(providerCall?.headers["x-claude-code-session-id"]).toBe("claude-session-1");
    expect(providerCall?.headers["x-claude-code-agent-id"]).toBe("claude-agent-1");
    expect(providerCall?.headers["x-claude-code-parent-agent-id"]).toBe("claude-parent-1");
    expect(providerCall?.body.model).toBe(config.anthropicHardModel);
    expect(providerCall?.body.output_config.effort).toBe("high");
    expect(providerCall?.body.thinking.type).toBe("adaptive");
    expect(providerCall?.body.max_tokens).toBe(4096);
    expect(providerCall?.body.tools).toHaveLength(1);

    const events = await fetch(`${proxyUrl}/_debug/events`, {
      headers: { "x-api-key": "proxy-token" }
    }).then((item) => item.json());
    await app.close();

    const usageEvent = events.find((event: any) => event.eventType === "usage.recorded");
    expect(usageEvent.payload.usage.input_tokens).toBe(120);
    expect(usageEvent.payload.usage.output_tokens).toBe(30);
  });

  it("rewrites Claude Code token counting aliases before forwarding upstream", async () => {
    const config = loadConfig({
        ...testEnv(),
        PROMPT_PROXY_TOKEN: "proxy-token",
        OPENAI_API_KEY: "openai-upstream-key",
        ANTHROPIC_API_KEY: "anthropic-upstream-key",
        OPENAI_BASE_URL: openai.url,
        ANTHROPIC_BASE_URL: anthropic.url,
        ANTHROPIC_BALANCED_MODEL: "claude-balanced-count-test",
        ANTHROPIC_HARD_MODEL: "claude-hard-count-test",
        CLASSIFIER_PROVIDER: "openai",
        CLASSIFIER_MODEL: "route-classifier-cheap",
        LOG_LEVEL: "fatal"
      });
    const app = buildServer(config);
    const proxyUrl = await listen(app);

    const response = await fetch(`${proxyUrl}/v1/messages/count_tokens`, {
      method: "POST",
      headers: {
        "x-api-key": "proxy-token",
        "content-type": "application/json",
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-router-auto",
        messages: [{ role: "user", content: "debug auth" }]
      })
    });

    await app.close();

    expect(response.status).toBe(200);
    const providerCall = anthropic.records.find((record) => record.path === "/messages/count_tokens");
    expect(providerCall?.body.model).toBe(config.anthropicHardModel);
    expect(providerCall?.body.model).toBe("claude-hard-count-test");
    expect(providerCall?.body.model).not.toBe("claude-router-auto");
    expect(providerCall?.body.output_config).toBeUndefined();
    expect(openai.records).toHaveLength(0);
  });

  it("routes non-router token counting models without classifier spend", async () => {
    const config = loadConfig({
        ...testEnv(),
        PROMPT_PROXY_TOKEN: "proxy-token",
        OPENAI_API_KEY: "openai-upstream-key",
        ANTHROPIC_API_KEY: "anthropic-upstream-key",
        OPENAI_BASE_URL: openai.url,
        ANTHROPIC_BASE_URL: anthropic.url,
        ANTHROPIC_HARD_MODEL: "claude-routed-hard-test",
        CLASSIFIER_PROVIDER: "openai",
        CLASSIFIER_MODEL: "route-classifier-cheap",
        LOG_LEVEL: "fatal"
      });
    const app = buildServer(config);
    const proxyUrl = await listen(app);

    const response = await fetch(`${proxyUrl}/v1/messages/count_tokens`, {
      method: "POST",
      headers: {
        "x-api-key": "proxy-token",
        "content-type": "application/json",
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        messages: [{ role: "user", content: "debug auth" }]
      })
    });
    await response.json();
    await app.close();

    const providerCall = anthropic.records.find((record) => record.path === "/messages/count_tokens");
    expect(response.status).toBe(200);
    expect(providerCall?.body.model).toBe("claude-routed-hard-test");
    expect(providerCall?.body.model).not.toBe("claude-sonnet-4-5");
    expect(openai.records).toHaveLength(0);
    expect(anthropic.records).toHaveLength(1);
  });


  it("uses configured Anthropic upstream model IDs", async () => {
    const config = loadConfig({
      ...testEnv(),
      PROMPT_PROXY_TOKEN: "proxy-token",
      OPENAI_API_KEY: "openai-upstream-key",
      ANTHROPIC_API_KEY: "anthropic-upstream-key",
      OPENAI_BASE_URL: openai.url,
      ANTHROPIC_BASE_URL: anthropic.url,
      ANTHROPIC_HARD_MODEL: "claude-custom-hard-test",
      CLASSIFIER_PROVIDER: "openai",
      CLASSIFIER_MODEL: "route-classifier-cheap",
      LOG_LEVEL: "fatal"
    });
    const app = buildServer(config);
    const proxyUrl = await listen(app);

    const response = await fetch(`${proxyUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": "proxy-token",
        "content-type": "application/json",
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-router-auto",
        messages: [{ role: "user", content: "debug auth" }],
        stream: true,
        max_tokens: 1024
      })
    });

    await response.text();
    await app.close();

    const providerCall = anthropic.records.find((record) => record.path === "/messages");
    expect(providerCall?.body.model).toBe("claude-custom-hard-test");
  });

  it("enforces classifier safety fields before selecting the final route", async () => {
    const safetyOpenAI = await startOpenAIMock({
      classifierOutput: {
        complexity: "simple",
        risk: [],
        recommended_route: "fast",
        can_use_fast_model: false,
        needs_deep_reasoning: true,
        reason_codes: ["contradictory_classifier"],
        confidence: 0.9
      }
    });
    const app = buildServer(
      loadConfig({
        ...testEnv(),
        PROMPT_PROXY_TOKEN: "proxy-token",
        OPENAI_API_KEY: "openai-upstream-key",
        ANTHROPIC_API_KEY: "anthropic-upstream-key",
        OPENAI_BASE_URL: safetyOpenAI.url,
        ANTHROPIC_BASE_URL: anthropic.url,
        CLASSIFIER_PROVIDER: "openai",
        CLASSIFIER_MODEL: "route-classifier-cheap",
        LOG_LEVEL: "fatal"
      })
    );
    const proxyUrl = await listen(app);

    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: "simple but contradictory classifier output",
        stream: true
      })
    });

    await response.text();
    await app.close();
    await safetyOpenAI.close();

    const providerCall = safetyOpenAI.records.find((record) => record.body.model === "gpt-5.5-pro");
    expect(providerCall).toBeTruthy();
  });

  it("falls back to the balanced route when the classifier fails", async () => {
    const failingOpenAI = await startOpenAIMock({ invalidClassifier: true });
    const app = buildServer(
      loadConfig({
        ...testEnv(),
        PROMPT_PROXY_TOKEN: "proxy-token",
        OPENAI_API_KEY: "openai-upstream-key",
        ANTHROPIC_API_KEY: "anthropic-upstream-key",
        OPENAI_BASE_URL: failingOpenAI.url,
        ANTHROPIC_BASE_URL: anthropic.url,
        CLASSIFIER_PROVIDER: "openai",
        CLASSIFIER_MODEL: "route-classifier-cheap",
        CLASSIFIER_MAX_ATTEMPTS: "2",
        LOG_LEVEL: "fatal"
      })
    );
    const proxyUrl = await listen(app);

    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: "fix this",
        stream: false
      })
    });
    await response.text();
    const eventRows = await fetch(`${proxyUrl}/_debug/events`, {
      headers: { authorization: "Bearer proxy-token" }
    }).then((item) => item.json());

    await app.close();
    await failingOpenAI.close();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-prompt-proxy-route")).toBe("balanced");
    const decision = eventRows.find((event: { eventType: string }) => event.eventType === "routing.decision_recorded");
    expect(decision?.payload?.reasonCodes).toEqual(["classifier_failure_fallback"]);
    expect(decision?.payload?.guardrailActions).toContain("classifier_failure_fallback");
    const classifierCalls = failingOpenAI.records.filter(
      (record) => record.body.model === "route-classifier-cheap"
    );
    const providerCalls = failingOpenAI.records.filter(
      (record) => record.body.model !== "route-classifier-cheap"
    );
    expect(classifierCalls).toHaveLength(2);
    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0].body.model).toBe("gpt-5.4");
  });

  it("reprocesses failed requests instead of replaying the failure", async () => {
    const flakyOpenAI = await startOpenAIMock({ failProviderOnce: true });
    const app = buildServer(
      loadConfig({
        ...testEnv(),
        PROMPT_PROXY_TOKEN: "proxy-token",
        OPENAI_API_KEY: "openai-upstream-key",
        ANTHROPIC_API_KEY: "anthropic-upstream-key",
        OPENAI_BASE_URL: flakyOpenAI.url,
        ANTHROPIC_BASE_URL: anthropic.url,
        CLASSIFIER_PROVIDER: "openai",
        CLASSIFIER_MODEL: "route-classifier-cheap",
        LOG_LEVEL: "fatal"
      })
    );
    const proxyUrl = await listen(app);
    const request = () =>
      fetch(`${proxyUrl}/v1/responses`, {
        method: "POST",
        headers: {
          authorization: "Bearer proxy-token",
          "content-type": "application/json",
          "idempotency-key": "idem-retry-1"
        },
        body: JSON.stringify({
          model: "router-auto",
          input: "retry after provider failure",
          stream: true
        })
      });

    const first = await request();
    await first.text();
    const second = await request();
    const secondBody = await second.text();

    await app.close();
    await flakyOpenAI.close();

    expect(first.status).toBe(500);
    expect(second.status).toBe(200);
    expect(second.headers.get("x-prompt-proxy-route")).toBe("hard");
    expect(secondBody).toContain("response.completed");
    const providerCalls = flakyOpenAI.records.filter(
      (record) => record.body.model !== "route-classifier-cheap"
    );
    expect(providerCalls).toHaveLength(2);
  });

  it("retries OpenAI provider rate limits before streaming the final response", async () => {
    await openai.close();
    openai = await startOpenAIMock({
      rateLimitProviderOnce: {
        headers: {
          "x-ratelimit-remaining-requests": "0",
          "x-ratelimit-reset-requests": "1ms"
        }
      }
    });
    const app = buildServer(
      loadConfig({
        ...testEnv(),
        PROMPT_PROXY_TOKEN: "proxy-token",
        OPENAI_API_KEY: "openai-upstream-key",
        ANTHROPIC_API_KEY: "anthropic-upstream-key",
        OPENAI_BASE_URL: openai.url,
        ANTHROPIC_BASE_URL: anthropic.url,
        CLASSIFIER_PROVIDER: "openai",
        CLASSIFIER_MODEL: "route-classifier-cheap",
        PROVIDER_RATE_LIMIT_MAX_ATTEMPTS: "2",
        PROVIDER_RATE_LIMIT_BASE_DELAY_MS: "1",
        PROVIDER_RATE_LIMIT_MAX_DELAY_MS: "10",
        LOG_LEVEL: "fatal"
      })
    );
    const proxyUrl = await listen(app);

    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json",
        "idempotency-key": "idem-openai-rate-limit"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: "retry after rate limit",
        stream: true
      })
    });
    const body = await response.text();
    const events = await fetch(`${proxyUrl}/_debug/events`, {
      headers: { authorization: "Bearer proxy-token" }
    }).then((item) => item.json());

    await app.close();

    expect(response.status).toBe(200);
    expect(body).toContain("response.completed");
    const providerCalls = openai.records.filter(
      (record) => record.body.model !== "route-classifier-cheap"
    );
    expect(providerCalls).toHaveLength(2);
    const retryEvent = events.find((event: any) => event.eventType === "provider.rate_limit_retry_scheduled");
    expect(retryEvent?.payload.provider).toBe("openai");
    expect(retryEvent?.payload.retryDelayMs).toBe(1);
    expect(retryEvent?.payload.rateLimit["x-ratelimit-reset-requests"]).toBe("1ms");
  });

  it("retries Anthropic provider rate limits using retry-after", async () => {
    await anthropic.close();
    anthropic = await startAnthropicMock({
      rateLimitProviderOnce: {
        headers: { "retry-after": "0" }
      }
    });
    const app = buildServer(
      loadConfig({
        ...testEnv(),
        PROMPT_PROXY_TOKEN: "proxy-token",
        OPENAI_API_KEY: "openai-upstream-key",
        ANTHROPIC_API_KEY: "anthropic-upstream-key",
        OPENAI_BASE_URL: openai.url,
        ANTHROPIC_BASE_URL: anthropic.url,
        PROVIDER_RATE_LIMIT_MAX_ATTEMPTS: "2",
        PROVIDER_RATE_LIMIT_BASE_DELAY_MS: "1",
        PROVIDER_RATE_LIMIT_MAX_DELAY_MS: "10",
        LOG_LEVEL: "fatal"
      })
    );
    const proxyUrl = await listen(app);

    const response = await fetch(`${proxyUrl}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "idempotency-key": "idem-anthropic-rate-limit"
      },
      body: JSON.stringify({
        model: "claude-router-hard",
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "retry after rate limit" }]
      })
    });
    const body = await response.text();
    const events = await fetch(`${proxyUrl}/_debug/events`, {
      headers: { authorization: "Bearer proxy-token" }
    }).then((item) => item.json());

    await app.close();

    expect(response.status).toBe(200);
    expect(body).toContain("message_stop");
    expect(anthropic.records.filter((record) => record.path === "/messages")).toHaveLength(2);
    const retryEvent = events.find((event: any) => event.eventType === "provider.rate_limit_retry_scheduled");
    expect(retryEvent?.payload.provider).toBe("anthropic");
    expect(retryEvent?.payload.retryDelayMs).toBe(0);
    expect(retryEvent?.payload.rateLimit["retry-after"]).toBe("0");
  });

  it("returns provider rate limits when retry-after exceeds the local wait cap", async () => {
    await openai.close();
    openai = await startOpenAIMock({
      rateLimitProviderOnce: {
        headers: { "retry-after": "2" }
      }
    });
    const app = buildServer(
      loadConfig({
        ...testEnv(),
        PROMPT_PROXY_TOKEN: "proxy-token",
        OPENAI_API_KEY: "openai-upstream-key",
        ANTHROPIC_API_KEY: "anthropic-upstream-key",
        OPENAI_BASE_URL: openai.url,
        ANTHROPIC_BASE_URL: anthropic.url,
        CLASSIFIER_PROVIDER: "openai",
        CLASSIFIER_MODEL: "route-classifier-cheap",
        PROVIDER_RATE_LIMIT_MAX_ATTEMPTS: "3",
        PROVIDER_RATE_LIMIT_BASE_DELAY_MS: "1",
        PROVIDER_RATE_LIMIT_MAX_DELAY_MS: "1",
        LOG_LEVEL: "fatal"
      })
    );
    const proxyUrl = await listen(app);

    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json",
        "idempotency-key": "idem-openai-rate-limit-cap"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: "do not wait too long",
        stream: true
      })
    });
    const body = await response.text();
    const events = await fetch(`${proxyUrl}/_debug/events`, {
      headers: { authorization: "Bearer proxy-token" }
    }).then((item) => item.json());

    await app.close();

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("2");
    expect(body).toContain("mock rate limit");
    const providerCalls = openai.records.filter(
      (record) => record.body.model !== "route-classifier-cheap"
    );
    expect(providerCalls).toHaveLength(1);
    expect(events.some((event: any) => event.eventType === "provider.rate_limit_retry_scheduled")).toBe(false);
  });

  it("aborts upstream streaming when the client cancels", async () => {
    const slowOpenAI = await startOpenAIMock({ slowProvider: true });
    const app = buildServer(
      loadConfig({
        ...testEnv(),
        PROMPT_PROXY_TOKEN: "proxy-token",
        OPENAI_API_KEY: "openai-upstream-key",
        ANTHROPIC_API_KEY: "anthropic-upstream-key",
        OPENAI_BASE_URL: slowOpenAI.url,
        ANTHROPIC_BASE_URL: anthropic.url,
        CLASSIFIER_PROVIDER: "openai",
        CLASSIFIER_MODEL: "route-classifier-cheap",
        LOG_LEVEL: "fatal"
      })
    );
    const proxyUrl = await listen(app);
    const controller = new AbortController();

    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: "debug auth",
        stream: true
      }),
      signal: controller.signal
    });

    const reader = response.body?.getReader();
    expect(reader).toBeTruthy();
    await reader?.read();
    controller.abort();
    await slowOpenAI.providerClosed;
    await new Promise((resolve) => setTimeout(resolve, 25));

    const attempts = await fetch(`${proxyUrl}/_debug/provider-attempts`, {
      headers: { authorization: "Bearer proxy-token" }
    }).then((item) => item.json());

    await app.close();
    await slowOpenAI.close();

    expect(attempts[0].terminalStatus).toBe("cancelled");
  });

  it("re-forwards completed duplicate requests upstream", async () => {
    const app = buildServer(
      loadConfig({
        ...testEnv(),
        PROMPT_PROXY_TOKEN: "proxy-token",
        OPENAI_API_KEY: "openai-upstream-key",
        ANTHROPIC_API_KEY: "anthropic-upstream-key",
        OPENAI_BASE_URL: openai.url,
        ANTHROPIC_BASE_URL: anthropic.url,
        CLASSIFIER_PROVIDER: "openai",
        CLASSIFIER_MODEL: "route-classifier-cheap",
        LOG_LEVEL: "fatal"
      })
    );
    const proxyUrl = await listen(app);
    const requestBody = {
      model: "router-auto",
      input: "fix duplicate request",
      stream: true
    };

    const first = await fetch(`${proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json",
        "idempotency-key": "idem-1"
      },
      body: JSON.stringify(requestBody)
    });
    await first.text();

    const second = await fetch(`${proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json",
        "idempotency-key": "idem-1"
      },
      body: JSON.stringify(requestBody)
    });
    const body = await second.text();
    await app.close();

    expect(second.status).toBe(200);
    expect(body).toContain("response.completed");
    expect(openai.records.filter((record) => record.body.model !== "route-classifier-cheap")).toHaveLength(2);
  });

  it("does not collide idempotency between Anthropic messages and token counting", async () => {
    const config = loadConfig({
      ...testEnv(),
      PROMPT_PROXY_TOKEN: "proxy-token",
      OPENAI_API_KEY: "openai-upstream-key",
      ANTHROPIC_API_KEY: "anthropic-upstream-key",
      OPENAI_BASE_URL: openai.url,
      ANTHROPIC_BASE_URL: anthropic.url,
      CLASSIFIER_PROVIDER: "openai",
      CLASSIFIER_MODEL: "route-classifier-cheap",
      LOG_LEVEL: "fatal"
    });
    const app = buildServer(config);
    const proxyUrl = await listen(app);
    const body = {
      model: "claude-router-auto",
      messages: [{ role: "user", content: "debug auth" }],
      stream: true,
      max_tokens: 1024
    };

    const countTokens = await fetch(`${proxyUrl}/v1/messages/count_tokens`, {
      method: "POST",
      headers: {
        "x-api-key": "proxy-token",
        "content-type": "application/json",
        "idempotency-key": "same-explicit-key"
      },
      body: JSON.stringify(body)
    });
    await countTokens.text();

    const messages = await fetch(`${proxyUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": "proxy-token",
        "content-type": "application/json",
        "idempotency-key": "same-explicit-key"
      },
      body: JSON.stringify(body)
    });
    await messages.text();
    await app.close();

    expect(anthropic.records.some((record) => record.path === "/messages/count_tokens")).toBe(true);
    expect(anthropic.records.some((record) => record.path === "/messages")).toBe(true);
  });

  it("keeps configured model catalogs isolated between live servers", async () => {
    const firstConfig = loadConfig({
      ...testEnv(),
      PROMPT_PROXY_TOKEN: "proxy-token",
      OPENAI_API_KEY: "openai-upstream-key",
      ANTHROPIC_API_KEY: "anthropic-upstream-key",
      OPENAI_BASE_URL: openai.url,
      ANTHROPIC_BASE_URL: anthropic.url,
      ANTHROPIC_HARD_MODEL: "claude-hard-first-test",
      CLASSIFIER_PROVIDER: "openai",
      CLASSIFIER_MODEL: "route-classifier-cheap",
      LOG_LEVEL: "fatal"
    });
    const secondConfig = loadConfig({
      ...testEnv(),
      PROMPT_PROXY_TOKEN: "proxy-token",
      OPENAI_API_KEY: "openai-upstream-key",
      ANTHROPIC_API_KEY: "anthropic-upstream-key",
      OPENAI_BASE_URL: openai.url,
      ANTHROPIC_BASE_URL: anthropic.url,
      ANTHROPIC_HARD_MODEL: "claude-hard-second-test",
      CLASSIFIER_PROVIDER: "openai",
      CLASSIFIER_MODEL: "route-classifier-cheap",
      LOG_LEVEL: "fatal"
    });
    const firstApp = buildServer(firstConfig);
    const secondApp = buildServer(secondConfig);
    const firstUrl = await listen(firstApp);
    const secondUrl = await listen(secondApp);

    const secondResponse = await fetch(`${secondUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": "proxy-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "claude-router-auto",
        messages: [{ role: "user", content: "debug auth" }],
        stream: true,
        max_tokens: 1024
      })
    });
    await secondResponse.text();

    const firstResponse = await fetch(`${firstUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": "proxy-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "claude-router-auto",
        messages: [{ role: "user", content: "debug auth" }],
        stream: true,
        max_tokens: 1024
      })
    });
    await firstResponse.text();

    await firstApp.close();
    await secondApp.close();

    expect(secondResponse.headers.get("x-prompt-proxy-model")).toBe("claude-hard-second-test");
    expect(firstResponse.headers.get("x-prompt-proxy-model")).toBe("claude-hard-first-test");
    expect(anthropic.records.some((record) => record.body.model === "claude-hard-first-test")).toBe(true);
    expect(anthropic.records.some((record) => record.body.model === "claude-hard-second-test")).toBe(true);
  });

  it("keeps a stronger session route instead of downgrading on later auto requests", async () => {
    const sessionOpenAI = await startOpenAIMock({
      classifierOutputs: [
        {
          complexity: "hard",
          risk: ["auth"],
          recommended_route: "hard",
          can_use_fast_model: false,
          needs_deep_reasoning: false,
          reason_codes: ["auth_risk"],
          confidence: 0.9
        },
        {
          complexity: "simple",
          risk: [],
          recommended_route: "fast",
          can_use_fast_model: true,
          needs_deep_reasoning: false,
          reason_codes: ["simple_followup"],
          confidence: 0.95
        }
      ]
    });
    const app = buildServer(
      loadConfig({
        ...testEnv(),
        PROMPT_PROXY_TOKEN: "proxy-token",
        OPENAI_API_KEY: "openai-upstream-key",
        ANTHROPIC_API_KEY: "anthropic-upstream-key",
        OPENAI_BASE_URL: sessionOpenAI.url,
        ANTHROPIC_BASE_URL: anthropic.url,
        CLASSIFIER_PROVIDER: "openai",
        CLASSIFIER_MODEL: "route-classifier-cheap",
        LOG_LEVEL: "fatal"
      })
    );
    const proxyUrl = await listen(app);

    const first = await fetch(`${proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json",
        "x-codex-session-id": "session-route-1"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: "debug auth regression",
        stream: true
      })
    });
    await first.text();

    const second = await fetch(`${proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json",
        "x-codex-session-id": "session-route-1"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: "format the answer",
        stream: true
      })
    });
    await second.text();

    const sessions = await fetch(`${proxyUrl}/_debug/sessions`, {
      headers: { authorization: "Bearer proxy-token" }
    }).then((item) => item.json());
    const events = await fetch(`${proxyUrl}/_debug/events`, {
      headers: { authorization: "Bearer proxy-token" }
    }).then((item) => item.json());
    await app.close();
    await sessionOpenAI.close();

    expect(first.headers.get("x-prompt-proxy-route")).toBe("hard");
    expect(second.headers.get("x-prompt-proxy-route")).toBe("hard");
    expect(sessions[0].currentRoute).toBe("hard");
    expect(events.map((event: any) => event.eventType)).toContain("session.route_memory_recorded");
  });

  it("scopes session route memory by user and team", async () => {
    const scopedOpenAI = await startOpenAIMock({
      classifierOutputs: [
        {
          complexity: "hard",
          risk: ["auth"],
          recommended_route: "hard",
          can_use_fast_model: false,
          needs_deep_reasoning: false,
          reason_codes: ["auth_risk"],
          confidence: 0.9
        },
        {
          complexity: "simple",
          risk: [],
          recommended_route: "fast",
          can_use_fast_model: true,
          needs_deep_reasoning: false,
          reason_codes: ["simple_followup"],
          confidence: 0.95
        }
      ]
    });
    const app = buildServer(
      loadConfig({
        ...testEnv(),
        PROMPT_PROXY_TOKEN: "proxy-token",
        OPENAI_API_KEY: "openai-upstream-key",
        ANTHROPIC_API_KEY: "anthropic-upstream-key",
        OPENAI_BASE_URL: scopedOpenAI.url,
        ANTHROPIC_BASE_URL: anthropic.url,
        CLASSIFIER_PROVIDER: "openai",
        CLASSIFIER_MODEL: "route-classifier-cheap",
        LOG_LEVEL: "fatal"
      })
    );
    const proxyUrl = await listen(app);

    const first = await fetch(`${proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json",
        "x-codex-session-id": "shared-session-id",
        "x-prompt-proxy-user-id": "c",
        "x-prompt-proxy-team-id": "a:b"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: "debug auth regression",
        stream: true
      })
    });
    await first.text();

    const second = await fetch(`${proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json",
        "x-codex-session-id": "shared-session-id",
        "x-prompt-proxy-user-id": "b:c",
        "x-prompt-proxy-team-id": "a"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: "format the answer",
        stream: true
      })
    });
    await second.text();

    const sessions = await fetch(`${proxyUrl}/_debug/sessions`, {
      headers: { authorization: "Bearer proxy-token" }
    }).then((item) => item.json());
    const events = await fetch(`${proxyUrl}/_debug/events`, {
      headers: { authorization: "Bearer proxy-token" }
    }).then((item) => item.json());
    await app.close();
    await scopedOpenAI.close();

    expect(first.headers.get("x-prompt-proxy-route")).toBe("hard");
    expect(second.headers.get("x-prompt-proxy-route")).toBe("fast");
    expect(sessions).toHaveLength(2);
    const sessionEvents = events.filter((event: any) => event.eventType === "session.route_memory_recorded");
    expect(new Set(sessionEvents.map((event: any) => event.scopeId)).size).toBe(2);
  });

  it("builds usage, cost, savings, and route-quality projections from events", async () => {
    const qualityOpenAI = await startOpenAIMock({
      classifierOutput: {
        complexity: "hard",
        risk: [],
        recommended_route: "deep",
        can_use_fast_model: true,
        needs_deep_reasoning: false,
        reason_codes: ["low_confidence"],
        confidence: 0.4
      }
    });
    const app = buildServer(
      loadConfig({
        ...testEnv(),
        PROMPT_PROXY_TOKEN: "proxy-token",
        OPENAI_API_KEY: "openai-upstream-key",
        ANTHROPIC_API_KEY: "anthropic-upstream-key",
        OPENAI_BASE_URL: qualityOpenAI.url,
        ANTHROPIC_BASE_URL: anthropic.url,
        CLASSIFIER_PROVIDER: "openai",
        CLASSIFIER_MODEL: "route-classifier-cheap",
        MODEL_COSTS_JSON: JSON.stringify({
          "gpt-5.4": { inputCostPerMtok: 1, outputCostPerMtok: 2 },
          "gpt-5.5": { inputCostPerMtok: 3, outputCostPerMtok: 4 }
        }),
        ROUTE_QUALITY_LOW_CONFIDENCE_THRESHOLD: "0.55",
        LOG_LEVEL: "fatal"
      })
    );
    const proxyUrl = await listen(app);

    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: "small request with uncertain route",
        stream: true
      })
    });
    await response.text();

    const projections = await fetch(`${proxyUrl}/_debug/projections`, {
      headers: { authorization: "Bearer proxy-token" }
    }).then((item) => item.json());
    const routeQuality = await fetch(`${proxyUrl}/_debug/route-quality`, {
      headers: { authorization: "Bearer proxy-token" }
    }).then((item) => item.json());
    await app.close();
    await qualityOpenAI.close();

    expect(projections.totals.inputTokens).toBe(100);
    expect(projections.totals.outputTokens).toBe(20);
    expect(projections.cost.selected).toBeGreaterThan(0);
    // Routed to the deep model (gpt-5.5-pro), priced above the gpt-5.5
    // default baseline, so this request books negative savings.
    expect(projections.requests[0].savings).toBeLessThan(0);
    expect(routeQuality.lowConfidence).toHaveLength(1);
  });

  it("parses boolean env values without enabling excerpts accidentally", () => {
    expect(loadConfig({ CLASSIFIER_ALLOW_REDACTED_EXCERPT: "false" }).classifierAllowRedactedExcerpt).toBe(false);
    expect(loadConfig({ CLASSIFIER_ALLOW_REDACTED_EXCERPT: "0" }).classifierAllowRedactedExcerpt).toBe(false);
    expect(loadConfig({}).classifierAllowRedactedExcerpt).toBe(false);
    expect(loadConfig({ CLASSIFIER_ALLOW_REDACTED_EXCERPT: "true" }).classifierAllowRedactedExcerpt).toBe(true);
  });
});

function websocketOpen(ws: WebSocket) {
  return new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

function nextCompletedResponseId(ws: WebSocket) {
  return nextTerminalResponseId(ws, "response.completed");
}

function nextTerminalResponseId(ws: WebSocket, terminalType: "response.completed" | "response.incomplete") {
  return new Promise<string>((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData) => {
      const event = JSON.parse(String(data));
      if (event.type !== terminalType) return;
      cleanup();
      resolve(event.response.id);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      ws.off("message", onMessage);
      ws.off("error", onError);
    };
    ws.on("message", onMessage);
    ws.once("error", onError);
  });
}
