import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  apiKeys,
  defaultWorkspaceId,
  events,
  hashApiKey,
  promptArtifacts,
  providerAttempts,
  providers,
  requests,
  routingConfigs,
  routingConfigVersions,
  usageLedger
} from "@proxy/db";
import { harnessCompatibilityForTarget } from "@proxy/schema";
import type {
  Dialect,
  RoutingConfig,
  RoutingConfigAnthropicDeployment,
  RoutingConfigOpenAIDeployment
} from "@proxy/schema";

import { scopedIdempotencyKey } from "../src/auth.js";
import { idempotencyFrom } from "../src/util.js";
import { captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

describe("translated OpenAI routing runtime", () => {
  let activeFixture: PromptTestFixture | undefined;

  afterEach(async () => {
    await activeFixture?.close();
    activeFixture = undefined;
  });

  it("routes OpenAI Responses traffic through a chat-only target and tags the decision", async () => {
    const organizationId = "org_translate_responses_to_chat";
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      envOverrides: { ALLOWED_PRIVATE_UPSTREAM_CIDRS: "127.0.0.0/8" },
      openAIOptions: { outputText: "chat translated" }
    });
    await insertOrgProvider(activeFixture, organizationId, {
      id: "20000000-0000-0000-0000-000000000101",
      slug: "chat-only-openai",
      dialect: "openai-chat"
    });
    await assignRouteConfig(activeFixture, organizationId, {
      secret: "responses-to-chat-token",
      slug: "responses-to-chat",
      configHash: "sha256:responses-to-chat",
      targets: [{ providerId: "chat-only-openai", model: "gpt-chat-only", effort: "high", maxOutputTokens: 321 }]
    });

    const response = await fetch(`${activeFixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer responses-to-chat-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "router-hard",
        instructions: "Use tools carefully.",
        input: "list files",
        tools: [{ type: "function", name: "shell", parameters: { type: "object" } }],
        stream: true
      })
    });
    const body = await response.text();
    const providerCall = activeFixture.openai.records.find((record) =>
      record.path === "/chat/completions" && record.body.model === "gpt-chat-only"
    );
    const decision = await lastDecisionPayload(activeFixture);

    expect(response.status).toBe(200);
    expect(body).toContain("response.output_text.delta");
    expect(body).toContain("response.completed");
    expect(providerCall?.body.messages).toEqual([
      { role: "system", content: "Use tools carefully." },
      { role: "user", content: "list files" }
    ]);
    expect(providerCall?.body.tools).toEqual([
      { type: "function", function: { name: "shell", parameters: { type: "object" } } }
    ]);
    expect(providerCall?.body.reasoning_effort).toBe("high");
    expect(providerCall?.body.max_completion_tokens).toBe(321);
    expect(providerCall?.body.stream_options).toEqual({ include_usage: true });
    expect(decision?.guardrailActions).toContain("translated_request:openai-responses_to_openai-chat");
  });

  it("routes OpenAI Chat traffic through a responses-only target", async () => {
    const organizationId = "org_translate_chat_to_responses";
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      envOverrides: { ALLOWED_PRIVATE_UPSTREAM_CIDRS: "127.0.0.0/8" },
      openAIOptions: { outputText: "responses translated" }
    });
    await insertOrgProvider(activeFixture, organizationId, {
      id: "20000000-0000-0000-0000-000000000102",
      slug: "responses-only-openai",
      dialect: "openai-responses"
    });
    await assignRouteConfig(activeFixture, organizationId, {
      secret: "chat-to-responses-token",
      slug: "chat-to-responses",
      configHash: "sha256:chat-to-responses",
      targets: [{ providerId: "responses-only-openai", model: "gpt-responses-only", effort: "high", maxOutputTokens: 444 }]
    });

    const response = await fetch(`${activeFixture.proxyUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer chat-to-responses-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "router-hard",
        messages: [
          { role: "system", content: "Use tools carefully." },
          { role: "user", content: "list files" }
        ],
        tools: [{ type: "function", function: { name: "shell", parameters: { type: "object" } } }],
        stream: true
      })
    });
    const body = await response.text();
    const providerCall = activeFixture.openai.records.find((record) =>
      record.path === "/responses" && record.body.model === "gpt-responses-only"
    );

    expect(response.status).toBe(200);
    expect(body).toContain("chat.completion.chunk");
    expect(body).toContain("[DONE]");
    expect(providerCall?.body.instructions).toBe("Use tools carefully.");
    expect(providerCall?.body.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "list files" }] }
    ]);
    expect(providerCall?.body.tools).toEqual([
      { type: "function", name: "shell", parameters: { type: "object" } }
    ]);
    expect(providerCall?.body.reasoning.effort).toBe("high");
    expect(providerCall?.body.max_output_tokens).toBe(444);
  });

  it("routes Codex Responses traffic through an Anthropic target", async () => {
    const organizationId = "org_translate_codex_to_anthropic";
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      envOverrides: { ALLOWED_PRIVATE_UPSTREAM_CIDRS: "127.0.0.0/8" },
      anthropicOptions: { outputText: "anthropic translated" }
    });
    await insertOrgProvider(activeFixture, organizationId, {
      id: "20000000-0000-0000-0000-000000000104",
      slug: "anthropic-only",
      dialect: "anthropic-messages"
    });
    await assignRouteConfig(activeFixture, organizationId, {
      secret: "codex-to-anthropic-token",
      slug: "codex-to-anthropic",
      configHash: "sha256:codex-to-anthropic",
      targets: [{
        providerId: "anthropic-only",
        model: "claude-sonnet-4-6",
        effort: "high",
        thinking: { type: "adaptive", display: "omitted" },
        maxOutputTokens: 321
      }]
    });

    const response = await fetch(`${activeFixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer codex-to-anthropic-token",
        "content-type": "application/json",
        "x-codex-session-id": "codex-session"
      },
      body: JSON.stringify({
        model: "router-hard",
        instructions: "Use tools carefully.",
        input: "list files",
        tools: [{ type: "function", name: "shell", parameters: { type: "object" } }],
        stream: true
      })
    });
    const body = await response.text();
    const providerCall = activeFixture.anthropic.records.find((record) =>
      record.path === "/messages" && record.body.model === "claude-sonnet-4-6"
    );
    const decision = await lastDecisionPayload(activeFixture);

    expect(response.status).toBe(200);
    expect(body).toContain("response.output_text.delta");
    expect(body).toContain("response.completed");
    expect(body).toContain("anthropic translated");
    expect(providerCall?.body.system).toEqual([{ type: "text", text: "Use tools carefully." }]);
    expect(providerCall?.body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "list files" }] }
    ]);
    expect(providerCall?.body.tools).toMatchObject([
      { name: "shell", input_schema: { type: "object" } }
    ]);
    expect(providerCall?.body.output_config.effort).toBe("high");
    expect(providerCall?.body.max_tokens).toBe(321);
    expect(decision?.guardrailActions).toContain("translated_request:openai-responses_to_anthropic-messages");
  });

  it("routes Claude Messages traffic through an OpenAI Chat target", async () => {
    const organizationId = "org_translate_claude_to_chat";
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      envOverrides: { ALLOWED_PRIVATE_UPSTREAM_CIDRS: "127.0.0.0/8" },
      openAIOptions: { outputText: "openai chat translated" }
    });
    await insertOrgProvider(activeFixture, organizationId, {
      id: "20000000-0000-0000-0000-000000000105",
      slug: "openai-chat-only",
      dialect: "openai-chat"
    });
    await assignRouteConfig(activeFixture, organizationId, {
      secret: "claude-to-chat-token",
      slug: "claude-to-chat",
      configHash: "sha256:claude-to-chat",
      targets: [{ providerId: "openai-chat-only", model: "gpt-chat-routed", effort: "high", maxOutputTokens: 222 }]
    });

    const response = await fetch(`${activeFixture.proxyUrl}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer claude-to-chat-token",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "x-claude-code-session-id": "claude-session"
      },
      body: JSON.stringify({
        model: "claude-router-hard",
        system: "Use tools carefully.",
        metadata: { user_id: "user_abc_account_def_session_12345678-abcd-1234-abcd-123456789abc" },
        diagnostics: { enabled: true },
        messages: [{ role: "user", content: [{ type: "text", text: "list files" }] }],
        tools: [{ name: "shell", input_schema: { type: "object" } }],
        output_config: { effort: "low" },
        context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
        max_output_tokens: 100,
        stream: true,
        max_tokens: 100
      })
    });
    const body = await response.text();
    const providerCall = activeFixture.openai.records.find((record) =>
      record.path === "/chat/completions" && record.body.model === "gpt-chat-routed"
    );
    const decision = await lastDecisionPayload(activeFixture);

    expect(response.status).toBe(200);
    expect(body).toContain("content_block_delta");
    expect(body).toContain("message_stop");
    expect(body).toContain("openai chat translated");
    expect(providerCall?.body.messages).toEqual([
      { role: "system", content: "Use tools carefully." },
      { role: "user", content: "list files" }
    ]);
    expect(providerCall?.body.tools).toMatchObject([
      { type: "function", function: { name: "shell", parameters: { type: "object" } } }
    ]);
    expect(providerCall?.body.reasoning_effort).toBe("high");
    expect(providerCall?.body.max_completion_tokens).toBe(222);
    expect(providerCall?.body.max_output_tokens).toBeUndefined();
    expect(providerCall?.body.output_config).toBeUndefined();
    expect(providerCall?.body.context_management).toBeUndefined();
    expect(providerCall?.body.diagnostics).toBeUndefined();
    expect(providerCall?.body.stream_options).toEqual({ include_usage: true });
    expect(providerCall?.body.metadata).toBeUndefined();
    expect(decision?.guardrailActions).toContain("translated_request:anthropic-messages_to_openai-chat");
  });

  it("routes Claude Messages traffic through an OpenAI Responses target", async () => {
    const organizationId = "org_translate_claude_to_responses";
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      envOverrides: { ALLOWED_PRIVATE_UPSTREAM_CIDRS: "127.0.0.0/8" },
      openAIOptions: { outputText: "openai responses translated", streamContentType: "text/plain; charset=utf-8" }
    });
    await insertOrgProvider(activeFixture, organizationId, {
      id: "20000000-0000-0000-0000-000000000106",
      slug: "openai-responses-only",
      dialect: "openai-responses"
    });
    await assignRouteConfig(activeFixture, organizationId, {
      secret: "claude-to-responses-token",
      slug: "claude-to-responses",
      configHash: "sha256:claude-to-responses",
      targets: [{ providerId: "openai-responses-only", model: "gpt-responses-routed", effort: "high", maxOutputTokens: 333 }]
    });

    const response = await fetch(`${activeFixture.proxyUrl}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer claude-to-responses-token",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "x-claude-code-session-id": "claude-session"
      },
      body: JSON.stringify({
        model: "claude-router-hard",
        system: "Use tools carefully.",
        metadata: { user_id: "user_abc_account_def_session_12345678-abcd-1234-abcd-123456789abc" },
        diagnostics: { enabled: true },
        messages: [{ role: "user", content: [{ type: "text", text: "list files" }] }],
        tools: [{ name: "shell", input_schema: { type: "object" } }],
        output_config: { effort: "low" },
        context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
        stream: true,
        max_tokens: 100
      })
    });
    const body = await response.text();
    const providerCall = activeFixture.openai.records.find((record) =>
      record.path === "/responses" && record.body.model === "gpt-responses-routed"
    );
    const decision = await lastDecisionPayload(activeFixture);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(body).toMatch(/^event: message_start/);
    expect(body).toContain("content_block_delta");
    expect(body).toContain("message_stop");
    expect(body).toContain("openai responses translated");
    expect(providerCall?.body.instructions).toBe("Use tools carefully.");
    expect(providerCall?.body.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "list files" }] }
    ]);
    expect(providerCall?.body.tools).toMatchObject([
      { type: "function", name: "shell", parameters: { type: "object" } }
    ]);
    expect(providerCall?.body.reasoning.effort).toBe("high");
    expect(providerCall?.body.max_output_tokens).toBe(333);
    expect(providerCall?.body.store).toBe(false);
    expect(providerCall?.body.output_config).toBeUndefined();
    expect(providerCall?.body.context_management).toBeUndefined();
    expect(providerCall?.body.diagnostics).toBeUndefined();
    expect(providerCall?.body.metadata).toBeUndefined();
    expect(decision?.guardrailActions).toContain("translated_request:anthropic-messages_to_openai-responses");
  });

  it("buffers streamed OpenAI Responses for non-stream Claude Messages callers", async () => {
    const organizationId = "org_translate_claude_to_responses_nonstream";
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      envOverrides: { ALLOWED_PRIVATE_UPSTREAM_CIDRS: "127.0.0.0/8" },
      openAIOptions: { outputText: "openai responses buffered", streamContentType: "text/plain; charset=utf-8" }
    });
    await insertOrgProvider(activeFixture, organizationId, {
      id: "20000000-0000-0000-0000-000000000108",
      slug: "openai-responses-buffered",
      dialect: "openai-responses"
    });
    await assignRouteConfig(activeFixture, organizationId, {
      secret: "claude-to-responses-buffered-token",
      slug: "claude-to-responses-buffered",
      configHash: "sha256:claude-to-responses-buffered",
      targets: [{ providerId: "openai-responses-buffered", model: "gpt-responses-buffered", effort: "high" }]
    });

    const response = await fetch(`${activeFixture.proxyUrl}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer claude-to-responses-buffered-token",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "x-claude-code-session-id": "claude-session"
      },
      body: JSON.stringify({
        model: "claude-router-hard",
        system: "Use tools carefully.",
        messages: [{ role: "user", content: [{ type: "text", text: "list files" }] }],
        max_tokens: 100
      })
    });
    const body = await response.json() as any;
    const providerCall = activeFixture.openai.records.find((record) =>
      record.path === "/responses" && record.body.model === "gpt-responses-buffered"
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(body).toMatchObject({
      type: "message",
      role: "assistant",
      model: "gpt-responses-buffered",
      content: [{ type: "text", text: "openai responses buffered" }],
      stop_reason: "end_turn"
    });
    expect(providerCall?.body.stream).toBe(true);
    expect(providerCall?.body.max_output_tokens).toBe(100);
  });

  it("routes OpenAI Chat traffic through an Anthropic target", async () => {
    const organizationId = "org_translate_chat_to_anthropic";
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      envOverrides: { ALLOWED_PRIVATE_UPSTREAM_CIDRS: "127.0.0.0/8" },
      anthropicOptions: { outputText: "anthropic chat translated" }
    });
    await insertOrgProvider(activeFixture, organizationId, {
      id: "20000000-0000-0000-0000-000000000107",
      slug: "anthropic-chat-target",
      dialect: "anthropic-messages"
    });
    await assignRouteConfig(activeFixture, organizationId, {
      secret: "chat-to-anthropic-token",
      slug: "chat-to-anthropic",
      configHash: "sha256:chat-to-anthropic",
      targets: [{
        providerId: "anthropic-chat-target",
        model: "claude-sonnet-4-6",
        effort: "high",
        thinking: { type: "adaptive", display: "omitted" },
        maxOutputTokens: 111
      }]
    });

    const response = await fetch(`${activeFixture.proxyUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer chat-to-anthropic-token",
        "content-type": "application/json",
        "x-opencode-session-id": "opencode-session"
      },
      body: JSON.stringify({
        model: "router-hard",
        messages: [
          { role: "system", content: "Use tools carefully." },
          { role: "user", content: "list files" }
        ],
        tools: [{ type: "function", function: { name: "shell", parameters: { type: "object" } } }],
        stream: true
      })
    });
    const body = await response.text();
    const providerCall = activeFixture.anthropic.records.find((record) =>
      record.path === "/messages" && record.body.model === "claude-sonnet-4-6"
    );
    const decision = await lastDecisionPayload(activeFixture);

    expect(response.status).toBe(200);
    expect(body).toContain("chat.completion.chunk");
    expect(body).toContain("[DONE]");
    expect(body).toContain("anthropic chat translated");
    expect(providerCall?.body.system).toEqual([{ type: "text", text: "Use tools carefully." }]);
    expect(providerCall?.body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "list files" }] }
    ]);
    expect(providerCall?.body.tools).toMatchObject([
      { name: "shell", input_schema: { type: "object" } }
    ]);
    expect(providerCall?.body.output_config.effort).toBe("high");
    expect(providerCall?.body.max_tokens).toBe(111);
    expect(decision?.guardrailActions).toContain("translated_request:openai-chat_to_anthropic-messages");
  });

  it("does not pin a translated chat target for stateful Codex Responses sessions", async () => {
    const organizationId = "org_translate_stateful_codex";
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      envOverrides: { ALLOWED_PRIVATE_UPSTREAM_CIDRS: "127.0.0.0/8" }
    });
    await insertOrgProvider(activeFixture, organizationId, {
      id: "20000000-0000-0000-0000-000000000103",
      slug: "stateful-chat-only-openai",
      dialect: "openai-chat"
    });
    await assignRouteConfig(activeFixture, organizationId, {
      secret: "stateful-chat-token",
      slug: "stateful-chat",
      configHash: "sha256:stateful-chat",
      targets: [{ providerId: "stateful-chat-only-openai", model: "gpt-stateful-chat", effort: "high" }]
    });

    const response = await fetch(`${activeFixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer stateful-chat-token",
        "content-type": "application/json",
        "x-codex-session-id": "codex-session"
      },
      body: JSON.stringify({
        model: "router-hard",
        input: "continue this stateful task",
        stream: true
      })
    });
    const body = await response.json();
    const decision = await lastDecisionPayload(activeFixture);
    const compatibility = harnessCompatibilityForTarget({
      profileId: "codex-responses-http",
      surface: "openai-responses",
      transport: "http",
      statefulResponses: true,
      targetDialects: ["openai-chat"]
    });

    expect(response.status).toBe(400);
    expect(body.error).toBe("route_not_available_for_surface");
    expect(activeFixture.openai.records.find((record) => record.body.model === "gpt-stateful-chat")).toBeUndefined();
    expect(compatibility.reason).toBe("stateful_translation_unavailable");
    expect(decision?.guardrailActions).toContain(`target_skipped_${compatibility.reason}:stateful-chat-only-openai`);
    expect(decision?.guardrailActions).not.toContain("translated_request:openai-responses_to_openai-chat");
  });

  it("handles upstream JSON bodies on streaming requests as JSON responses", async () => {
    const organizationId = "org_stream_json_on_stream_request";
    const idempotencyKey = "idem-stream-json-on-stream-request";
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      openAIOptions: {
        outputText: "json stream body",
        streamJsonProvider: true
      }
    });

    const response = await fetch(`${activeFixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json",
        "idempotency-key": idempotencyKey
      },
      body: JSON.stringify({
        model: "router-hard",
        input: "return json despite stream",
        stream: true
      })
    });
    const body = await response.json() as any;
    const providerCall = activeFixture.openai.records.find((record) =>
      record.path === "/responses" && record.body.model === "gpt-5.5"
    );
    const { requestRow, attemptRow } = await persistedProviderAttempt(activeFixture, organizationId, idempotencyKey);
    const usageRows = await activeFixture.db.select().from(usageLedger);
    const artifacts = await activeFixture.db.select().from(promptArtifacts);
    const assistantArtifact = artifacts.find((artifact) => artifact.kind === "assistant_response");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(body.output[0].content[0].text).toBe("json stream body");
    expect(providerCall?.body.stream).toBe(true);
    expect(requestRow?.status).toBe("completed");
    expect(attemptRow?.terminalStatus).toBe("completed");
    expect(usageRows.find((row) => row.kind === "provider")?.outputTokens).toBe(20);
    expect(assistantArtifact?.rawText).toBe("json stream body");
  });

  it("records provider stream error frames as failed durable status", async () => {
    const organizationId = "org_stream_error_status";
    const idempotencyKey = "idem-stream-error-status";
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      openAIOptions: {
        responsesStreamError: {
          message: "stream failed",
          responseId: "resp_stream_error"
        }
      }
    });

    const response = await fetch(`${activeFixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json",
        "idempotency-key": idempotencyKey
      },
      body: JSON.stringify({
        model: "router-hard",
        input: "surface provider stream error",
        stream: true
      })
    });
    const body = await response.text();
    const { requestRow, attemptRow } = await persistedProviderAttempt(activeFixture, organizationId, idempotencyKey);
    const eventRows = await activeFixture.db.select().from(events);

    expect(response.status).toBe(200);
    expect(body).toContain("\"type\":\"error\"");
    expect(body).toContain("stream failed");
    expect(requestRow?.status).toBe("failed");
    expect(attemptRow?.terminalStatus).toBe("failed");
    expect(attemptRow?.error).toBe("stream failed");
    expect(attemptRow?.upstreamRequestId).toBe("resp_stream_error");
    expect(eventRows.some((event) => event.eventType === "provider.response_failed")).toBe(true);
  });

  it("completes streams that have output text but no terminal usage", async () => {
    const organizationId = "org_stream_missing_usage";
    const idempotencyKey = "idem-stream-missing-usage";
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      openAIOptions: {
        outputText: "missing usage stream",
        omitResponsesUsage: true
      }
    });

    const response = await fetch(`${activeFixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json",
        "idempotency-key": idempotencyKey
      },
      body: JSON.stringify({
        model: "router-hard",
        input: "finish without usage",
        stream: true
      })
    });
    const body = await response.text();
    const { requestRow, attemptRow } = await persistedProviderAttempt(activeFixture, organizationId, idempotencyKey);
    const usageRows = await activeFixture.db.select().from(usageLedger);
    const artifacts = await activeFixture.db.select().from(promptArtifacts);
    const assistantArtifact = artifacts.find((artifact) => artifact.kind === "assistant_response");

    expect(response.status).toBe(200);
    expect(body).toContain("missing usage stream");
    expect(requestRow?.status).toBe("completed");
    expect(attemptRow?.terminalStatus).toBe("completed");
    expect(usageRows).toHaveLength(0);
    expect(assistantArtifact?.rawText).toBe("missing usage stream");
  });

  it("records cancellation when the client disconnects mid-stream", async () => {
    const organizationId = "org_stream_client_disconnect";
    const idempotencyKey = "idem-stream-client-disconnect";
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      openAIOptions: { slowProvider: true }
    });
    const controller = new AbortController();

    const response = await fetch(`${activeFixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json",
        "idempotency-key": idempotencyKey
      },
      body: JSON.stringify({
        model: "router-hard",
        input: "cancel this stream",
        stream: true
      }),
      signal: controller.signal
    });
    const reader = response.body?.getReader();
    expect(reader).toBeTruthy();
    await reader?.read();
    controller.abort();
    await reader?.cancel().catch(() => undefined);
    await activeFixture.openai.providerClosed;
    await new Promise((resolve) => setTimeout(resolve, 25));

    const { requestRow, attemptRow } = await persistedProviderAttempt(activeFixture, organizationId, idempotencyKey);
    const artifacts = await activeFixture.db.select().from(promptArtifacts);

    expect(requestRow?.status).toBe("cancelled");
    expect(attemptRow?.terminalStatus).toBe("cancelled");
    expect(artifacts.find((artifact) => artifact.kind === "assistant_response")).toBeUndefined();
  });
});

async function persistedProviderAttempt(fixture: PromptTestFixture, organizationId: string, idempotencyKey: string) {
  const operationKey = idempotencyFrom("openai-responses:create", {}, { "idempotency-key": idempotencyKey });
  const scopedKey = scopedIdempotencyKey(organizationId, defaultWorkspaceId(organizationId), operationKey);
  const [requestRow] = await fixture.db
    .select()
    .from(requests)
    .where(eq(requests.idempotencyKey, scopedKey))
    .limit(1);
  if (!requestRow) return { requestRow: undefined, attemptRow: undefined };
  const [attemptRow] = await fixture.db
    .select()
    .from(providerAttempts)
    .where(eq(providerAttempts.requestId, requestRow.id))
    .limit(1);
  return { requestRow, attemptRow };
}

async function insertOrgProvider(
  fixture: PromptTestFixture,
  organizationId: string,
  input: {
    id: string;
    slug: string;
    dialect: Dialect;
  }
) {
  const baseUrl = input.dialect === "anthropic-messages" ? fixture.anthropic.url : fixture.openai.url;
  let path = "/responses";
  if (input.dialect === "openai-chat") path = "/chat/completions";
  if (input.dialect === "anthropic-messages") path = "/messages";
  await fixture.db.insert(providers).values({
    id: input.id,
    organizationId,
    slug: input.slug,
    displayName: input.slug,
    baseUrl,
    authStyle: "none",
    endpoints: [{ dialect: input.dialect, path }],
    defaultHeaders: {},
    capabilities: { efforts: providerEfforts(input.dialect) },
    forwardHarnessHeaders: false,
    enabled: true
  });
}

function providerEfforts(dialect: Dialect) {
  if (dialect === "anthropic-messages") return ["low", "medium", "high", "xhigh", "max", "ultracode"];
  return ["low", "medium", "high", "xhigh"];
}

async function assignRouteConfig(
  fixture: PromptTestFixture,
  organizationId: string,
  input: {
    secret: string;
    slug: string;
    configHash: string;
    targets: TargetFixture[];
  }
) {
  const configId = `${organizationId}:routing-config:${input.slug}`;
  const versionId = `${configId}:v1`;
  const [defaultVersion] = await fixture.db
    .select()
    .from(routingConfigVersions)
    .where(eq(routingConfigVersions.id, `${organizationId}:routing-config:default:v1`))
    .limit(1);
  const config = withHardTargets(structuredClone(defaultVersion.config as RoutingConfig), input.targets);

  await fixture.db.insert(routingConfigs).values({
    id: configId,
    organizationId,
    workspaceId: defaultWorkspaceId(organizationId),
    name: "Translated route config",
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
    name: "Translated route key",
    routingConfigId: configId
  });
}

type AnthropicEffort = NonNullable<RoutingConfigAnthropicDeployment["output_config"]>["effort"];
type OpenAIEffort = NonNullable<RoutingConfigOpenAIDeployment["reasoning"]>["effort"];
type OpenAIVerbosity = NonNullable<RoutingConfigOpenAIDeployment["text"]>["verbosity"];

type TargetFixture = {
  providerId: string;
  model: string;
  effort?: AnthropicEffort | OpenAIEffort;
  verbosity?: OpenAIVerbosity;
  thinking?: RoutingConfigAnthropicDeployment["thinking"];
  maxOutputTokens?: number;
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
      ...(target.verbosity ? { text: { verbosity: target.verbosity } } : {}),
      ...(target.maxOutputTokens ? { maxOutputTokens: target.maxOutputTokens } : {})
    }));
  const anthropic = targets
    .filter((target) => target.providerId.includes("anthropic"))
    .map((target, index): RoutingConfigAnthropicDeployment => ({
      provider: target.providerId,
      model: target.model,
      order: index,
      weight: 1,
      timeoutMs: 60000,
      ...(target.effort ? { output_config: { effort: target.effort as AnthropicEffort } } : {}),
      ...(target.thinking ? { thinking: target.thinking } : {}),
      ...(target.maxOutputTokens ? { maxTokens: target.maxOutputTokens } : {})
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

async function lastDecisionPayload(fixture: PromptTestFixture) {
  const eventRows = await fixture.db.select().from(events);
  const decision = eventRows
    .filter((event) => event.eventType === "routing.decision_recorded")
    .at(-1);
  return decision?.payload as { guardrailActions?: string[] } | undefined;
}
