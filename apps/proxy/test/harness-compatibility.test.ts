import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  events,
  usageLedger
} from "@proxy/db";
import type { Dialect } from "@proxy/schema";

import { buildAnthropicContext, buildOpenAIChatContext, buildOpenAIContext } from "../src/features.js";
import { listHarnessFixtureManifests } from "../src/harnessFixtureCounts.js";
import { buildHarnessSmokeStatusArtifact, missingRequiredHarnessFixtures } from "../src/harnessSmokeStatus.js";
import { translators } from "../src/translators/index.js";
import {
  expectExactJson,
  expectExactSse,
  expectRoutePlanExcerpt,
  harnessFixtureRoot,
  listHarnessFixtures,
  loadHarnessFixture
} from "./harnessFixtures.js";
import { assignHarnessGatewayTarget } from "./gatewayHarnessFixture.js";
import { captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

let activeFixture: PromptTestFixture | undefined;

afterEach(async () => {
  await activeFixture?.close();
  activeFixture = undefined;
  vi.restoreAllMocks();
});

describe("harness golden fixtures", () => {
  it("loads complete fixture cases by profile and case id", () => {
    const fixture = loadHarnessFixture("openai-chat-sdk", "sample-complete");

    expect(fixture.manifest).toMatchObject({
      profileId: "openai-chat-sdk",
      caseId: "sample-complete",
      surface: "openai-chat",
      mode: "native"
    });
    expect(fixture.inboundRequest).toMatchObject({ model: "fable" });
    expect(fixture.expectedUpstreamRequest).toMatchObject({ model: "gpt-fixture" });
    expect(fixture.upstreamSse).toContain("chat.completion.chunk");
    expect(fixture.expectedClientSse).toContain("chat.completion.chunk");
  });

  it("lists fixture folders without treating root helper fixtures as cases", () => {
    expect(listHarnessFixtures()).toContainEqual({
      profileId: "openai-chat-sdk",
      caseId: "sample-complete"
    });
  });

  it("keeps promoted native and translated support claims fixture-backed", () => {
    const artifact = buildHarnessSmokeStatusArtifact({
      fixtures: listHarnessFixtureManifests(harnessFixtureRoot),
      generatedAt: "2026-01-01T00:00:00.000Z"
    });

    expect(missingRequiredHarnessFixtures(artifact)).toEqual([]);
    expect(artifact.paths).toEqual(expect.arrayContaining([
      expect.objectContaining({
        profileId: "codex-responses-http",
        targetDialect: "openai-responses",
        support: "native",
        status: "passed"
      }),
      expect.objectContaining({
        surface: "anthropic-messages",
        targetDialect: "openai-chat",
        support: "translated",
        status: "passed"
      }),
      expect.objectContaining({
        surface: "openai-chat",
        targetDialect: "openai-responses",
        support: "translated",
        status: "passed"
      })
    ]));
  });

  it("asserts exact upstream and client JSON with optional volatile fields", () => {
    const fixture = loadHarnessFixture("openai-chat-sdk", "sample-complete");

    expectExactJson(fixture.expectedUpstreamRequest, {
      model: "gpt-fixture",
      messages: [{ role: "user", content: "ping" }],
      stream: true
    });
    expectExactJson(
      { id: "actual-id", model: "gpt-fixture", messages: [{ role: "user", content: "ping" }] },
      { id: "expected-id", model: "gpt-fixture", messages: [{ role: "user", content: "ping" }] },
      { volatilePaths: ["id"] }
    );
    expectExactJson(fixture.expectedClientResponse, fixture.upstreamResponse, {
      volatilePaths: ["id", "created"]
    });
    expect(() => expectExactJson({ model: "wrong" }, fixture.expectedUpstreamRequest)).toThrow();
  });

  it("asserts exact SSE order without sorting events", () => {
    const fixture = loadHarnessFixture("openai-chat-sdk", "sample-complete");

    expectExactSse(fixture.expectedClientSse ?? "", fixture.upstreamSse ?? "");
    expect(() => expectExactSse(
      "data: second\n\ndata: first\n\n",
      "data: first\n\ndata: second\n\n"
    )).toThrow();
  });

  it("asserts route-plan excerpts as partial objects", () => {
    const fixture = loadHarnessFixture("openai-chat-sdk", "sample-complete");

    expectRoutePlanExcerpt(
      {
        profileId: "openai-chat-sdk",
        status: "native",
        selected: { provider: "openai" },
        egressWireId: "openai-chat",
        wireAdapterVersion: null
      },
      fixture.routePlanExcerpt
    );
  });

  it("fails invalid fixture manifests with useful errors", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-fixture-invalid-"));
    const dir = join(root, "openai-chat-sdk", "bad-case");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({
      profileId: "openai-chat-sdk",
      caseId: "wrong-case",
      surface: "openai-chat",
      description: "bad fixture",
      mode: "native"
    }));

    expect(() => loadHarnessFixture("openai-chat-sdk", "bad-case", root)).toThrow(/caseId must match bad-case/);
  });

  it("fails malformed optional JSON fixture files with useful errors", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-fixture-invalid-json-"));
    const dir = join(root, "openai-chat-sdk", "bad-json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({
      profileId: "openai-chat-sdk",
      caseId: "bad-json",
      surface: "openai-chat",
      description: "bad fixture",
      mode: "native"
    }));
    writeFileSync(join(dir, "inbound-request.json"), "[]");

    expect(() => loadHarnessFixture("openai-chat-sdk", "bad-json", root)).toThrow(/inbound-request\.json must be an object/);
  });

  it("fails malformed WebSocket event fixture arrays with useful errors", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-fixture-invalid-events-"));
    const dir = join(root, "codex-responses-websocket", "bad-events");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({
      profileId: "codex-responses-websocket",
      caseId: "bad-events",
      surface: "openai-responses",
      description: "bad websocket fixture",
      mode: "native"
    }));
    writeFileSync(join(dir, "expected-client-events.json"), "{}");

    expect(() => loadHarnessFixture("codex-responses-websocket", "bad-events", root)).toThrow(/expected-client-events\.json must be an array/);
  });
});

describe("Codex Responses HTTP native golden fixtures", () => {
  it("matches the non-streaming OpenAI Responses native fixture", async () => {
    const organizationId = "org_harness_codex_native_nonstream";
    const fixture = loadHarnessFixture("codex-responses-http", "native-nonstream");
    activeFixture = await setupCodexNativeFixture(organizationId, {
      outputText: "codex nonstream",
      responsesJsonProvider: true
    });

    const headers = codexHeaders();
    const context = buildOpenAIContext(fixture.inboundRequest, headers);
    expectExactJson({
      surface: context.surface,
      harness: context.harness,
      statefulResponses: context.statefulResponses,
      hasPreviousResponseId: context.hasPreviousResponseId,
      hasTools: context.hasTools
    }, fixture.routeContext);

    const response = await fetch(`${activeFixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify(fixture.inboundRequest)
    });
    const body = await response.json();
    const providerCall = activeFixture.openai.records.find((record) =>
      record.path === "/responses" && record.body.model === "gpt-codex-native"
    );
    const decision = await lastDecisionPayload(activeFixture);

    expect(response.status).toBe(200);
    expectExactJson(providerCall?.body, fixture.expectedUpstreamRequest);
    expectExactJson(body, fixture.expectedClientResponse);
    expect(providerCall?.headers["x-codex-turn-state"]).toBe("golden-turn-state");
    expect(providerCall?.headers["x-request-id"]).toBe("golden-request-id");
    expect(providerCall?.headers["openai-beta"]).toBe("responses_http=golden");
    expect(providerCall?.headers["x-codex-session-id"]).toBeUndefined();
    expectRoutePlanExcerpt(decision, fixture.routePlanExcerpt);
    await expectProviderUsage(activeFixture, fixture.usage);
  });

  it("matches the streaming OpenAI Responses native fixture", async () => {
    const organizationId = "org_harness_codex_native_stream";
    const fixture = loadHarnessFixture("codex-responses-http", "native-stream");
    activeFixture = await setupCodexNativeFixture(organizationId, {
      outputText: "codex stream"
    });

    const headers = codexHeaders();
    const context = buildOpenAIContext(fixture.inboundRequest, headers);
    expectExactJson({
      surface: context.surface,
      harness: context.harness,
      statefulResponses: context.statefulResponses,
      hasPreviousResponseId: context.hasPreviousResponseId,
      hasTools: context.hasTools
    }, fixture.routeContext);

    const response = await fetch(`${activeFixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify(fixture.inboundRequest)
    });
    const body = await response.text();
    const providerCall = activeFixture.openai.records.find((record) =>
      record.path === "/responses" && record.body.model === "gpt-codex-native"
    );
    const decision = await lastDecisionPayload(activeFixture);

    expect(response.status).toBe(200);
    expectExactJson(providerCall?.body, fixture.expectedUpstreamRequest);
    expectExactSse(body, fixture.expectedClientSse ?? "");
    expect(providerCall?.headers["x-codex-turn-state"]).toBe("golden-turn-state");
    expect(providerCall?.headers["x-request-id"]).toBe("golden-request-id");
    expect(providerCall?.headers["openai-beta"]).toBe("responses_http=golden");
    expect(providerCall?.headers["x-codex-session-id"]).toBeUndefined();
    expectRoutePlanExcerpt(decision, fixture.routePlanExcerpt);
    await expectProviderUsage(activeFixture, fixture.usage);
  });
});

describe("Claude Code Messages native golden fixtures", () => {
  it("matches the non-streaming Anthropic Messages native fixture", async () => {
    const organizationId = "org_harness_claude_native_nonstream";
    const fixture = loadHarnessFixture("claude-code-messages", "native-nonstream");
    activeFixture = await setupClaudeNativeFixture(organizationId, {
      outputText: "claude nonstream"
    });

    const headers = claudeCodeHeaders();
    const context = buildAnthropicContext(fixture.inboundRequest, headers);
    expectExactJson({
      surface: context.surface,
      harness: context.harness,
      statefulResponses: context.statefulResponses,
      sessionId: context.sessionId,
      hasTools: context.hasTools,
      hasImages: context.hasImages
    }, fixture.routeContext);

    const response = await fetch(`${activeFixture.proxyUrl}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(fixture.inboundRequest)
    });
    const body = await response.json();
    const providerCall = activeFixture.anthropic.records.find((record) =>
      record.path === "/messages" && record.body.model === "claude-code-native"
    );
    const decision = await lastDecisionPayload(activeFixture);

    expect(response.status).toBe(200);
    expectExactJson(providerCall?.body, fixture.expectedUpstreamRequest);
    expectExactJson(body, fixture.expectedClientResponse);
    expect(providerCall?.headers["x-api-key"]).toBe("anthropic-upstream-key");
    expect(providerCall?.headers.authorization).toBeUndefined();
    expect(providerCall?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(providerCall?.headers["anthropic-beta"]).toBe("fine-grained-tool-streaming-2025-05-14");
    expect(providerCall?.headers["x-claude-code-agent-id"]).toBe("claude-agent-golden");
    expect(providerCall?.headers["x-claude-code-parent-agent-id"]).toBe("claude-parent-golden");
    expect(providerCall?.headers["x-request-id"]).toBe("claude-request-golden");
    expect(providerCall?.headers["x-not-forwarded"]).toBeUndefined();
    expect(providerCall?.headers["x-claude-code-session-id"]).toBeUndefined();
    expectRoutePlanExcerpt(decision, fixture.routePlanExcerpt);
    await expectProviderUsage(activeFixture, fixture.usage, "claude-code-native");
  });

  it("matches the streaming Anthropic Messages native fixture", async () => {
    const organizationId = "org_harness_claude_native_stream";
    const fixture = loadHarnessFixture("claude-code-messages", "native-stream");
    activeFixture = await setupClaudeNativeFixture(organizationId, {
      outputText: "claude stream"
    });

    const headers = claudeCodeHeaders();
    const context = buildAnthropicContext(fixture.inboundRequest, headers);
    expectExactJson({
      surface: context.surface,
      harness: context.harness,
      statefulResponses: context.statefulResponses,
      sessionId: context.sessionId,
      hasTools: context.hasTools,
      hasImages: context.hasImages
    }, fixture.routeContext);

    const response = await fetch(`${activeFixture.proxyUrl}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(fixture.inboundRequest)
    });
    const body = await response.text();
    const providerCall = activeFixture.anthropic.records.find((record) =>
      record.path === "/messages" && record.body.model === "claude-code-native"
    );
    const decision = await lastDecisionPayload(activeFixture);

    expect(response.status).toBe(200);
    expectExactJson(providerCall?.body, fixture.expectedUpstreamRequest);
    expectExactSse(body, fixture.expectedClientSse ?? "");
    expectExactSse(body, fixture.upstreamSse ?? "");
    expect(providerCall?.headers["x-api-key"]).toBe("anthropic-upstream-key");
    expect(providerCall?.headers.authorization).toBeUndefined();
    expect(providerCall?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(providerCall?.headers["anthropic-beta"]).toBe("fine-grained-tool-streaming-2025-05-14");
    expect(providerCall?.headers["x-claude-code-agent-id"]).toBe("claude-agent-golden");
    expect(providerCall?.headers["x-claude-code-parent-agent-id"]).toBe("claude-parent-golden");
    expect(providerCall?.headers["x-request-id"]).toBe("claude-request-golden");
    expect(providerCall?.headers["x-not-forwarded"]).toBeUndefined();
    expect(providerCall?.headers["x-claude-code-session-id"]).toBeUndefined();
    expectRoutePlanExcerpt(decision, fixture.routePlanExcerpt);
    await expectProviderUsage(activeFixture, fixture.usage, "claude-code-native");
  });
});

describe("OpenAI Chat native golden fixtures", () => {
  it("matches the generic Chat SDK non-streaming native fixture", async () => {
    const organizationId = "org_harness_chat_sdk_native";
    const fixture = loadHarnessFixture("openai-chat-sdk", "native-nonstream-rich");
    activeFixture = await setupChatNativeFixture(organizationId, {
      secret: "chat-sdk-native-token",
      slug: "chat-sdk-native",
      outputText: "generic chat nonstream"
    });

    const headers = chatHeaders("chat-sdk-native-token");
    const context = buildOpenAIChatContext(fixture.inboundRequest, headers);
    expectExactJson({
      surface: context.surface,
      harness: context.harness,
      statefulResponses: context.statefulResponses,
      hasTools: context.hasTools,
      hasImages: context.hasImages
    }, fixture.routeContext);

    const response = await fetch(`${activeFixture.proxyUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(fixture.inboundRequest)
    });
    const body = await response.json();
    const providerCall = activeFixture.openai.records.find((record) =>
      record.path === "/chat/completions" && record.body.model === "gpt-chat-native"
    );
    const decision = await lastDecisionPayload(activeFixture);

    expect(response.status).toBe(200);
    expectExactJson(providerCall?.body, fixture.expectedUpstreamRequest);
    expectExactJson(body, fixture.expectedClientResponse);
    expect(providerCall?.headers.authorization).toBe("Bearer openai-upstream-key");
    expect(providerCall?.headers["x-opencode-session-id"]).toBeUndefined();
    expect(providerCall?.headers["x-cursor-session-id"]).toBeUndefined();
    expectRoutePlanExcerpt(decision, fixture.routePlanExcerpt);
    await expectProviderUsage(activeFixture, fixture.usage, "gpt-chat-native");
  });

  it("matches the opencode streaming native fixture", async () => {
    const organizationId = "org_harness_opencode_chat_native";
    const fixture = loadHarnessFixture("opencode-chat", "native-stream");
    activeFixture = await setupChatNativeFixture(organizationId, {
      secret: "opencode-chat-native-token",
      slug: "opencode-chat-native",
      outputText: "opencode chat stream"
    });

    const headers = chatHeaders("opencode-chat-native-token", {
      "x-opencode-session-id": "opencode-session-golden",
      "user-agent": "opencode/1.0"
    });
    const context = buildOpenAIChatContext(fixture.inboundRequest, headers);
    expectExactJson({
      surface: context.surface,
      harness: context.harness,
      statefulResponses: context.statefulResponses,
      sessionId: context.sessionId,
      hasTools: context.hasTools,
      hasImages: context.hasImages
    }, fixture.routeContext);

    const response = await fetch(`${activeFixture.proxyUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(fixture.inboundRequest)
    });
    const body = await response.text();
    const providerCall = activeFixture.openai.records.find((record) =>
      record.path === "/chat/completions" && record.body.model === "gpt-chat-native"
    );
    const decision = await lastDecisionPayload(activeFixture);

    expect(response.status).toBe(200);
    expectExactJson(providerCall?.body, fixture.expectedUpstreamRequest);
    expectExactSse(body, fixture.expectedClientSse ?? "");
    expect(providerCall?.headers.authorization).toBe("Bearer openai-upstream-key");
    expect(providerCall?.headers["x-opencode-session-id"]).toBe("opencode-session-golden");
    expectRoutePlanExcerpt(decision, fixture.routePlanExcerpt);
    await expectProviderUsage(activeFixture, fixture.usage, "gpt-chat-native");
  });

  it("matches the Cursor BYOK streaming native fixture", async () => {
    const organizationId = "org_harness_cursor_chat_native";
    const fixture = loadHarnessFixture("cursor-byok-chat", "native-stream");
    activeFixture = await setupChatNativeFixture(organizationId, {
      secret: "cursor-chat-native-token",
      slug: "cursor-chat-native",
      outputText: "cursor chat stream"
    });

    const headers = chatHeaders("cursor-chat-native-token", {
      "x-cursor-request-id": "cursor-request-golden",
      "user-agent": "cursor/1.0"
    });
    const context = buildOpenAIChatContext(fixture.inboundRequest, headers);
    expectExactJson({
      surface: context.surface,
      harness: context.harness,
      statefulResponses: context.statefulResponses,
      sessionId: context.sessionId,
      hasTools: context.hasTools,
      hasImages: context.hasImages
    }, fixture.routeContext);

    const response = await fetch(`${activeFixture.proxyUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(fixture.inboundRequest)
    });
    const body = await response.text();
    const providerCall = activeFixture.openai.records.find((record) =>
      record.path === "/chat/completions" && record.body.model === "gpt-chat-native"
    );
    const decision = await lastDecisionPayload(activeFixture);

    expect(response.status).toBe(200);
    expectExactJson(providerCall?.body, fixture.expectedUpstreamRequest);
    expectExactSse(body, fixture.expectedClientSse ?? "");
    expect(providerCall?.headers.authorization).toBe("Bearer openai-upstream-key");
    expect(providerCall?.headers["x-cursor-request-id"]).toBe("cursor-request-golden");
    expect(providerCall?.headers["x-cursor-session-id"]).toBeUndefined();
    expectRoutePlanExcerpt(decision, fixture.routePlanExcerpt);
    await expectProviderUsage(activeFixture, fixture.usage, "gpt-chat-native");
  });
});

describe("Same-family OpenAI translated golden fixtures", () => {
  it("matches the OpenAI Responses to Chat streaming fixture", async () => {
    const organizationId = "org_harness_responses_to_chat";
    const fixture = loadHarnessFixture("generic-openai-responses", "translated-chat-stream");
    activeFixture = await setupTranslatedOpenAIFixture(organizationId, {
      secret: "responses-to-chat-golden-token",
      slug: "responses-to-chat-golden",
      providerSlug: "chat-only-openai",
      providerDialect: "openai-chat",
      model: "gpt-chat-only",
      maxOutputTokens: 321,
      outputText: "chat translated stream"
    });

    const headers = chatHeaders("responses-to-chat-golden-token");
    const context = buildOpenAIContext(fixture.inboundRequest, headers);
    expectExactJson({
      surface: context.surface,
      harness: context.harness,
      statefulResponses: context.statefulResponses,
      hasPreviousResponseId: context.hasPreviousResponseId,
      hasTools: context.hasTools
    }, fixture.routeContext);

    const response = await fetch(`${activeFixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify(fixture.inboundRequest)
    });
    const body = await response.text();
    const providerCall = activeFixture.openai.records.find((record) =>
      record.path === "/chat/completions" && record.body.model === "gpt-chat-only"
    );
    const decision = await lastDecisionPayload(activeFixture);

    expect(response.status).toBe(200);
    expectExactJson(providerCall?.body, fixture.expectedUpstreamRequest);
    expectExactSse(body, fixture.expectedClientSse ?? "");
    expectRoutePlanExcerpt(decision, fixture.routePlanExcerpt);
    await expectProviderUsage(activeFixture, fixture.usage, "gpt-chat-only");
  });

  it("matches the OpenAI Chat to Responses streaming fixture", async () => {
    const organizationId = "org_harness_chat_to_responses";
    const fixture = loadHarnessFixture("openai-chat-sdk", "translated-responses-stream");
    activeFixture = await setupTranslatedOpenAIFixture(organizationId, {
      secret: "chat-to-responses-golden-token",
      slug: "chat-to-responses-golden",
      providerSlug: "responses-only-openai",
      providerDialect: "openai-responses",
      model: "gpt-responses-only",
      maxOutputTokens: 444,
      outputText: "responses translated stream"
    });

    const headers = chatHeaders("chat-to-responses-golden-token");
    const context = buildOpenAIChatContext(fixture.inboundRequest, headers);
    expectExactJson({
      surface: context.surface,
      harness: context.harness,
      statefulResponses: context.statefulResponses,
      hasTools: context.hasTools,
      hasImages: context.hasImages
    }, fixture.routeContext);

    const response = await fetch(`${activeFixture.proxyUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(fixture.inboundRequest)
    });
    const body = await response.text();
    const providerCall = activeFixture.openai.records.find((record) =>
      record.path === "/responses" && record.body.model === "gpt-responses-only"
    );
    const decision = await lastDecisionPayload(activeFixture);

    expect(response.status).toBe(200);
    expectExactJson(providerCall?.body, fixture.expectedUpstreamRequest);
    expectExactSse(body, fixture.expectedClientSse ?? "");
    expectRoutePlanExcerpt(decision, fixture.routePlanExcerpt);
    await expectProviderUsage(activeFixture, fixture.usage, "gpt-responses-only");
  });
});

describe("Cross-family translated golden fixtures", () => {
  it("matches the Anthropic Messages to OpenAI Chat streaming fixture", async () => {
    const organizationId = "org_harness_claude_to_chat";
    const fixture = loadHarnessFixture("claude-code-messages", "translated-chat-stream");
    activeFixture = await setupTranslatedOpenAIFixture(organizationId, {
      secret: "claude-to-chat-golden-token",
      slug: "claude-to-chat-golden",
      providerSlug: "cross-chat-openai",
      providerDialect: "openai-chat",
      model: "gpt-cross-chat",
      maxOutputTokens: 222,
      outputText: "openai chat cross",
      chatStreamToolCall: {
        id: "call_cross_chat_stream",
        name: "shell",
        arguments: "{\"cmd\":\"pwd\"}"
      }
    });

    const headers = claudeCodeHeaders("claude-to-chat-golden-token");
    const context = buildAnthropicContext(fixture.inboundRequest, headers);
    expectExactJson({
      surface: context.surface,
      harness: context.harness,
      statefulResponses: context.statefulResponses,
      sessionId: context.sessionId,
      hasTools: context.hasTools,
      hasImages: context.hasImages
    }, fixture.routeContext);

    const response = await fetch(`${activeFixture.proxyUrl}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(fixture.inboundRequest)
    });
    const body = await response.text();
    const providerCall = activeFixture.openai.records.find((record) =>
      record.path === "/chat/completions" && record.body.model === "gpt-cross-chat"
    );
    const decision = await lastDecisionPayload(activeFixture);

    expect(response.status).toBe(200);
    expectExactJson(providerCall?.body, fixture.expectedUpstreamRequest);
    expectExactSse(body, fixture.expectedClientSse ?? "");
    expectRoutePlanExcerpt(decision, fixture.routePlanExcerpt);
    await expectProviderUsage(activeFixture, fixture.usage, "gpt-cross-chat");
  });

  it("matches the Anthropic Messages to OpenAI Responses streaming fixture", async () => {
    const organizationId = "org_harness_claude_to_responses";
    const fixture = loadHarnessFixture("claude-code-messages", "translated-responses-stream");
    activeFixture = await setupTranslatedOpenAIFixture(organizationId, {
      secret: "claude-to-responses-golden-token",
      slug: "claude-to-responses-golden",
      providerSlug: "cross-responses-openai",
      providerDialect: "openai-responses",
      model: "gpt-cross-responses",
      maxOutputTokens: 222,
      outputText: "responses cross"
    });

    const headers = claudeCodeHeaders("claude-to-responses-golden-token");
    const context = buildAnthropicContext(fixture.inboundRequest, headers);
    expectExactJson({
      surface: context.surface,
      harness: context.harness,
      statefulResponses: context.statefulResponses,
      sessionId: context.sessionId,
      hasTools: context.hasTools,
      hasImages: context.hasImages
    }, fixture.routeContext);

    const response = await fetch(`${activeFixture.proxyUrl}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(fixture.inboundRequest)
    });
    const body = await response.text();
    const providerCall = activeFixture.openai.records.find((record) =>
      record.path === "/responses" && record.body.model === "gpt-cross-responses"
    );
    const decision = await lastDecisionPayload(activeFixture);

    expect(response.status).toBe(200);
    expectExactJson(providerCall?.body, fixture.expectedUpstreamRequest);
    expectExactSse(body, fixture.expectedClientSse ?? "");
    expectRoutePlanExcerpt(decision, fixture.routePlanExcerpt);
    await expectProviderUsage(activeFixture, fixture.usage, "gpt-cross-responses");
  });

  it("matches the OpenAI Chat to Anthropic Messages streaming fixture", async () => {
    const organizationId = "org_harness_chat_to_anthropic";
    const fixture = loadHarnessFixture("openai-chat-sdk", "translated-anthropic-stream");
    activeFixture = await setupTranslatedAnthropicFixture(organizationId, {
      secret: "chat-to-anthropic-golden-token",
      slug: "chat-to-anthropic-golden",
      providerSlug: "cross-anthropic-chat",
      model: "claude-opus-4-8-cross-family",
      maxOutputTokens: 111,
      outputText: "anthropic chat cross"
    });

    const headers = chatHeaders("chat-to-anthropic-golden-token");
    const context = buildOpenAIChatContext(fixture.inboundRequest, headers);
    expectExactJson({
      surface: context.surface,
      harness: context.harness,
      statefulResponses: context.statefulResponses,
      hasTools: context.hasTools,
      hasImages: context.hasImages
    }, fixture.routeContext);

    const response = await fetch(`${activeFixture.proxyUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(fixture.inboundRequest)
    });
    const body = await response.text();
    const providerCall = activeFixture.anthropic.records.find((record) =>
      record.path === "/messages" && record.body.model === "claude-opus-4-8-cross-family"
    );
    const decision = await lastDecisionPayload(activeFixture);

    expect(response.status).toBe(200);
    expectExactJson(providerCall?.body, fixture.expectedUpstreamRequest);
    expectExactSse(body, fixture.expectedClientSse ?? "");
    expectRoutePlanExcerpt(decision, fixture.routePlanExcerpt);
    await expectProviderUsage(activeFixture, fixture.usage, "claude-opus-4-8-cross-family");
  });

  it("matches the OpenAI Responses to Anthropic Messages streaming fixture", async () => {
    const organizationId = "org_harness_responses_to_anthropic";
    const fixture = loadHarnessFixture("generic-openai-responses", "translated-anthropic-stream");
    activeFixture = await setupTranslatedAnthropicFixture(organizationId, {
      secret: "responses-to-anthropic-golden-token",
      slug: "responses-to-anthropic-golden",
      providerSlug: "cross-anthropic-responses",
      model: "claude-opus-4-8-responses-cross",
      maxOutputTokens: 321,
      outputText: "anthropic responses cross",
      toolUse: {
        id: "toolu_response_stream",
        name: "shell",
        partialJson: "{\"cmd\":\"pwd\"}"
      }
    });

    const headers = chatHeaders("responses-to-anthropic-golden-token");
    const context = buildOpenAIContext(fixture.inboundRequest, headers);
    expectExactJson({
      surface: context.surface,
      harness: context.harness,
      statefulResponses: context.statefulResponses,
      hasPreviousResponseId: context.hasPreviousResponseId,
      hasTools: context.hasTools,
      hasImages: context.hasImages
    }, fixture.routeContext);

    const response = await fetch(`${activeFixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify(fixture.inboundRequest)
    });
    const body = await response.text();
    const providerCall = activeFixture.anthropic.records.find((record) =>
      record.path === "/messages" && record.body.model === "claude-opus-4-8-responses-cross"
    );
    const decision = await lastDecisionPayload(activeFixture);

    expect(response.status).toBe(200);
    expectExactJson(providerCall?.body, fixture.expectedUpstreamRequest);
    expectExactSse(body, fixture.expectedClientSse ?? "");
    expectRoutePlanExcerpt(decision, fixture.routePlanExcerpt);
    await expectProviderUsage(activeFixture, fixture.usage, "claude-opus-4-8-responses-cross");
  });
});

describe("Unsupported and stateful rejection fixtures", () => {
  it("rejects Responses previous_response_id translation before provider selection", async () => {
    const organizationId = "org_harness_reject_previous_response";
    const fixture = loadHarnessFixture("codex-responses-http", "reject-previous-response-translation");
    activeFixture = await setupTranslatedOpenAIFixture(organizationId, {
      secret: "previous-response-reject-token",
      slug: "previous-response-reject",
      providerSlug: "previous-response-chat-only",
      providerDialect: "openai-chat",
      model: "gpt-previous-response-chat",
      maxOutputTokens: 222,
      outputText: "should not be called"
    });

    const headers = codexHeaders("previous-response-reject-token");
    const context = buildOpenAIContext(fixture.inboundRequest, headers);
    expectExactJson({
      surface: context.surface,
      harness: context.harness,
      statefulResponses: context.statefulResponses,
      hasPreviousResponseId: context.hasPreviousResponseId,
      hasTools: context.hasTools
    }, fixture.routeContext);

    const response = await fetch(`${activeFixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify(fixture.inboundRequest)
    });
    const body = await response.json();
    const decision = await lastDecisionPayload(activeFixture);

    expect(response.status).toBe(400);
    expectExactJson(body, fixture.expectedClientResponse);
    expect(activeFixture.openai.records).toHaveLength(0);
    expectRoutePlanExcerpt(decision, fixture.routePlanExcerpt);
  });

  it("rejects encrypted reasoning includes on translated Responses routes", async () => {
    const organizationId = "org_harness_reject_encrypted_include";
    const fixture = loadHarnessFixture("generic-openai-responses", "reject-unsupported-encrypted-include");
    activeFixture = await setupTranslatedAnthropicFixture(organizationId, {
      secret: "encrypted-include-reject-token",
      slug: "encrypted-include-reject",
      providerSlug: "encrypted-include-anthropic",
      model: "claude-opus-4-8-encrypted-include",
      maxOutputTokens: 222,
      outputText: "should not be called"
    });

    const headers = chatHeaders("encrypted-include-reject-token");
    const context = buildOpenAIContext(fixture.inboundRequest, headers);
    expectExactJson({
      surface: context.surface,
      harness: context.harness,
      statefulResponses: context.statefulResponses,
      hasPreviousResponseId: context.hasPreviousResponseId,
      hasTools: context.hasTools,
      unsupportedFields: context.unsupportedFields
    }, fixture.routeContext);

    const response = await fetch(`${activeFixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify(fixture.inboundRequest)
    });
    const body = await response.json();
    const decision = await lastDecisionPayload(activeFixture);

    expect(response.status).toBe(400);
    expectExactJson(body, fixture.expectedClientResponse);
    expect(activeFixture.anthropic.records).toHaveLength(0);
    expectRoutePlanExcerpt(decision, fixture.routePlanExcerpt);
  });

  it("rejects providers with no native or translatable endpoint dialect", async () => {
    const organizationId = "org_harness_reject_missing_endpoint";
    const fixture = loadHarnessFixture("openai-chat-sdk", "reject-missing-provider-endpoint");
    activeFixture = await setupUnavailableTargetFixture(organizationId, {
      secret: "missing-endpoint-reject-token",
      slug: "missing-endpoint-reject",
      providerSlug: "no-endpoint-provider",
      model: "missing-endpoint-model",
      endpoints: []
    });

    const headers = chatHeaders("missing-endpoint-reject-token");
    const context = buildOpenAIChatContext(fixture.inboundRequest, headers);
    expectExactJson({
      surface: context.surface,
      harness: context.harness,
      statefulResponses: context.statefulResponses,
      hasTools: context.hasTools,
      hasImages: context.hasImages
    }, fixture.routeContext);

    const response = await fetch(`${activeFixture.proxyUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(fixture.inboundRequest)
    });
    const body = await response.json();
    const decision = await lastDecisionPayload(activeFixture);

    expect(response.status).toBe(400);
    expectExactJson(body, fixture.expectedClientResponse);
    expect(activeFixture.openai.records).toHaveLength(0);
    expectRoutePlanExcerpt(decision, fixture.routePlanExcerpt);
  });

  it("distinguishes missing translator pairs from missing endpoints", async () => {
    const organizationId = "org_harness_reject_missing_translator";
    const fixture = loadHarnessFixture("openai-chat-sdk", "reject-missing-translator");
    const originalGet = translators.get.bind(translators);
    vi.spyOn(translators, "get").mockImplementation((from, to) => {
      if (from === "openai-chat" && to === "anthropic-messages") return undefined;
      return originalGet(from, to);
    });
    activeFixture = await setupUnavailableTargetFixture(organizationId, {
      secret: "missing-translator-reject-token",
      slug: "missing-translator-reject",
      providerSlug: "missing-translator-provider",
      model: "missing-translator-model",
      endpoints: [{ dialect: "anthropic-messages", path: "/messages" }]
    });

    const headers = chatHeaders("missing-translator-reject-token");
    const context = buildOpenAIChatContext(fixture.inboundRequest, headers);
    expectExactJson({
      surface: context.surface,
      harness: context.harness,
      statefulResponses: context.statefulResponses,
      hasTools: context.hasTools,
      hasImages: context.hasImages
    }, fixture.routeContext);

    const response = await fetch(`${activeFixture.proxyUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(fixture.inboundRequest)
    });
    const body = await response.json();
    const decision = await lastDecisionPayload(activeFixture);

    expect(response.status).toBe(400);
    expectExactJson(body, fixture.expectedClientResponse);
    expect(activeFixture.anthropic.records).toHaveLength(0);
    expectRoutePlanExcerpt(decision, fixture.routePlanExcerpt);
  });
});

function codexHeaders(token = "codex-native-token") {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "x-codex-session-id": "codex-golden-session",
    "x-codex-turn-state": "golden-turn-state",
    "x-request-id": "golden-request-id",
    "openai-beta": "responses_http=golden"
  };
}

function claudeCodeHeaders(token = "claude-native-token") {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "fine-grained-tool-streaming-2025-05-14",
    "x-claude-code-agent-id": "claude-agent-golden",
    "x-claude-code-parent-agent-id": "claude-parent-golden",
    "x-request-id": "claude-request-golden",
    "x-not-forwarded": "drop-me"
  };
}

function chatHeaders(token: string, extra: Record<string, string> = {}) {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    ...extra
  };
}

async function setupCodexNativeFixture(
  organizationId: string,
  openAIOptions: { outputText: string; responsesJsonProvider?: boolean }
) {
  const fixture = await captureFixture(organizationId, "raw_text", false, { openAIOptions });
  await assignTarget(fixture, organizationId, {
    secret: "codex-native-token",
    slug: "codex-native",
    target: {
      providerId: "openai",
      model: "gpt-codex-native",
      effort: "high",
      verbosity: "medium",
      maxOutputTokens: 321
    },
    wires: [{ dialect: "openai-responses", path: "/responses" }]
  });
  return fixture;
}

async function setupClaudeNativeFixture(
  organizationId: string,
  anthropicOptions: { outputText: string }
) {
  const fixture = await captureFixture(organizationId, "raw_text", false, { anthropicOptions });
  await assignTarget(fixture, organizationId, {
    secret: "claude-native-token",
    slug: "claude-native",
    target: {
      providerId: "anthropic",
      model: "claude-code-native",
      maxOutputTokens: 333
    },
    wires: [{ dialect: "anthropic-messages", path: "/messages" }]
  });
  return fixture;
}

async function setupChatNativeFixture(
  organizationId: string,
  input: {
    secret: string;
    slug: string;
    outputText: string;
  }
) {
  const fixture = await captureFixture(organizationId, "raw_text", false, {
    openAIOptions: { outputText: input.outputText }
  });
  await assignTarget(fixture, organizationId, {
    secret: input.secret,
    slug: input.slug,
    target: {
      providerId: "openai",
      model: "gpt-chat-native",
      effort: "high",
      maxOutputTokens: 222
    },
    wires: [{ dialect: "openai-chat", path: "/chat/completions" }]
  });
  return fixture;
}

async function setupTranslatedOpenAIFixture(
  organizationId: string,
  input: {
    secret: string;
    slug: string;
    providerSlug: string;
    providerDialect: "openai-chat" | "openai-responses";
    model: string;
    maxOutputTokens: number;
    outputText: string;
    chatStreamToolCall?: {
      id: string;
      name: string;
      arguments: string;
    };
  }
) {
  const fixture = await captureFixture(organizationId, "raw_text", false, {
    envOverrides: { ALLOWED_PRIVATE_UPSTREAM_CIDRS: "127.0.0.0/8" },
    openAIOptions: {
      outputText: input.outputText,
      chatStreamToolCall: input.chatStreamToolCall
    }
  });
  const path = input.providerDialect === "openai-chat" ? "/chat/completions" : "/responses";
  await assignTarget(fixture, organizationId, {
    secret: input.secret,
    slug: input.slug,
    target: {
      providerId: input.providerSlug,
      model: input.model,
      effort: "high",
      maxOutputTokens: input.maxOutputTokens
    },
    wires: [{ dialect: input.providerDialect, path }],
    baseUrl: fixture.openai.url
  });
  return fixture;
}

async function setupUnavailableTargetFixture(
  organizationId: string,
  input: {
    secret: string;
    slug: string;
    providerSlug: string;
    model: string;
    endpoints: { dialect: Dialect; path: string }[];
  }
) {
  const fixture = await captureFixture(organizationId, "raw_text", false, {
    envOverrides: { ALLOWED_PRIVATE_UPSTREAM_CIDRS: "127.0.0.0/8" }
  });
  await assignTarget(fixture, organizationId, {
    secret: input.secret,
    slug: input.slug,
    target: {
      providerId: input.providerSlug,
      model: input.model,
      effort: "high",
      maxOutputTokens: 222
    },
    wires: input.endpoints,
    baseUrl: fixture.openai.url
  });
  return fixture;
}

async function setupTranslatedAnthropicFixture(
  organizationId: string,
  input: {
    secret: string;
    slug: string;
    providerSlug: string;
    model: string;
    maxOutputTokens: number;
    outputText: string;
    toolUse?: {
      id: string;
      name: string;
      partialJson: string;
    };
  }
) {
  const fixture = await captureFixture(organizationId, "raw_text", false, {
    envOverrides: { ALLOWED_PRIVATE_UPSTREAM_CIDRS: "127.0.0.0/8" },
    anthropicOptions: {
      outputText: input.outputText,
      toolUse: input.toolUse
    }
  });
  await assignTarget(fixture, organizationId, {
    secret: input.secret,
    slug: input.slug,
    target: {
      providerId: input.providerSlug,
      model: input.model,
      effort: "high",
      thinking: { type: "adaptive", display: "omitted" },
      maxOutputTokens: input.maxOutputTokens
    },
    wires: [{ dialect: "anthropic-messages", path: "/messages" }],
    baseUrl: fixture.anthropic.url
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
    provider: input.target.providerId,
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

async function lastDecisionPayload(fixture: PromptTestFixture) {
  const eventRows = await fixture.db.select().from(events);
  const decision = eventRows
    .filter((event) => event.eventType === "routing.decision_recorded")
    .at(-1);
  return decision?.payload as {
    outcome?: string;
    surface?: string;
    provider?: string;
    selectedModel?: string;
    egressWireId?: string;
    wireAdapterVersion?: string | null;
    reasoningEffort?: string;
    verbosity?: string;
  } | undefined;
}

async function expectProviderUsage(fixture: PromptTestFixture, expected: unknown, model = "gpt-codex-native") {
  const rows = await fixture.db.select().from(usageLedger);
  const providerUsage = rows.find((row) => row.kind === "provider" && row.model === model);
  expect(providerUsage).toBeTruthy();
  const actual = {
    inputTokens: providerUsage?.inputTokens,
    outputTokens: providerUsage?.outputTokens,
    reasoningTokens: providerUsage?.reasoningTokens,
    cachedInputTokens: providerUsage?.cachedInputTokens,
    cacheCreationInputTokens: providerUsage?.cacheCreationInputTokens
  };
  expectExactJson(pickExpectedUsageFields(actual, expected), expected);
}

function pickExpectedUsageFields(
  actual: Record<string, number | undefined>,
  expected: unknown
) {
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) return actual;
  const picked: Record<string, number | undefined> = {};
  for (const key of Object.keys(expected)) picked[key] = actual[key];
  return picked;
}
