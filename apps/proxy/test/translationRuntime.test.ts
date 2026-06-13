import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  apiKeys,
  defaultWorkspaceId,
  events,
  hashApiKey,
  providers,
  routingConfigs,
  routingConfigVersions
} from "@prompt-proxy/db";
import type { Dialect, RoutingConfig } from "@prompt-proxy/schema";

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

    expect(response.status).toBe(400);
    expect(body.error).toBe("route_not_available_for_surface");
    expect(activeFixture.openai.records.find((record) => record.body.model === "gpt-stateful-chat")).toBeUndefined();
    expect(decision?.guardrailActions).toContain("target_skipped_stateful_translation_unavailable:stateful-chat-only-openai");
    expect(decision?.guardrailActions).not.toContain("translated_request:openai-responses_to_openai-chat");
  });
});

async function insertOrgProvider(
  fixture: PromptTestFixture,
  organizationId: string,
  input: {
    id: string;
    slug: string;
    dialect: Extract<Dialect, "openai-responses" | "openai-chat">;
  }
) {
  await fixture.db.insert(providers).values({
    id: input.id,
    organizationId,
    slug: input.slug,
    displayName: input.slug,
    baseUrl: fixture.openai.url,
    authStyle: "none",
    endpoints: [{ dialect: input.dialect, path: input.dialect === "openai-chat" ? "/chat/completions" : "/responses" }],
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
    routingConfigId: configId,
    scopes: ["proxy"]
  });
}

async function lastDecisionPayload(fixture: PromptTestFixture) {
  const eventRows = await fixture.db.select().from(events);
  const decision = eventRows
    .filter((event) => event.eventType === "routing.decision_recorded")
    .at(-1);
  return decision?.payload as { guardrailActions?: string[] } | undefined;
}
