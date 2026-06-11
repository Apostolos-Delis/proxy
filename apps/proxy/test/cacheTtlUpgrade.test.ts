import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { organizationSettings } from "@prompt-proxy/db";

import { rewriteSurfaceRequest, rewriteTokenCountRequest } from "../src/adapters.js";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { captureFixture, type PromptTestFixture } from "./promptTestFixture.js";
import { listen, startAnthropicMock, startOpenAIMock, type MockServer } from "./helpers.js";

// A minimal RouteDecision shape that satisfies rewriteSurfaceRequest
function anthropicDecision(model = "claude-opus-4-8") {
  return {
    outcome: "forward" as const,
    finalRoute: "hard" as const,
    selectedModel: model,
    surface: "anthropic-messages" as const,
    provider: "anthropic" as const,
    providerSettings: {
      provider: "anthropic" as const,
      model,
      anthropic: {}
    }
  };
}

describe("upgradeCacheControlTtl transform", () => {
  it("upgrades ephemeral breakpoints in system array to 1h TTL", () => {
    const body = {
      model: "claude-router-hard",
      system: [
        { type: "text", text: "You are helpful.", cache_control: { type: "ephemeral" } },
        { type: "text", text: "More instructions." }
      ],
      messages: [{ role: "user", content: "hi" }]
    };

    const result = rewriteSurfaceRequest(body, anthropicDecision(), undefined, { upgradeCacheTtl: true }) as any;

    expect(result.system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(result.system[1].cache_control).toBeUndefined();
  });

  it("upgrades breakpoints in every message's content (byte-stable across turns)", () => {
    const body = {
      model: "claude-router-hard",
      messages: [
        { role: "user", content: [{ type: "text", text: "first", cache_control: { type: "ephemeral" } }] },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "output", cache_control: { type: "ephemeral" } }
          ]
        }
      ]
    };

    const result = rewriteSurfaceRequest(body, anthropicDecision(), undefined, { upgradeCacheTtl: true }) as any;

    // Every breakpoint upgraded — a block keeps ttl:1h once it becomes history,
    // so the cached prefix bytes do not shift turn over turn.
    expect(result.messages[0].content[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(result.messages[1].content[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("does not touch blocks that already have a TTL", () => {
    const body = {
      model: "claude-router-hard",
      system: [{ type: "text", text: "stable", cache_control: { type: "ephemeral", ttl: "1h" } }],
      messages: [{ role: "user", content: "hi" }]
    };

    const result = rewriteSurfaceRequest(body, anthropicDecision(), undefined, { upgradeCacheTtl: true }) as any;
    expect(result.system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("is a no-op when upgradeCacheTtl is false", () => {
    const body = {
      model: "claude-router-hard",
      system: [{ type: "text", text: "stable", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "hi" }]
    };

    const result = rewriteSurfaceRequest(body, anthropicDecision(), undefined, { upgradeCacheTtl: false }) as any;
    expect(result.system[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("also applies to rewriteTokenCountRequest", () => {
    const body = {
      model: "claude-router-hard",
      system: [{ type: "text", text: "stable", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "hi" }]
    };

    const result = rewriteTokenCountRequest(body, anthropicDecision(), undefined, { upgradeCacheTtl: true }) as any;
    expect(result.system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });
});

describe("cacheTtlUpgrade in proxy request flow (no-persistence path)", () => {
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

  it("does not mutate cache_control when cacheTtlUpgrade is not set (default off)", async () => {
    const app = buildServer(
      loadConfig({
        ...process.env,
        DATABASE_URL: "",
        EVENT_STORE_PATH: "",
        PROMPT_PROXY_TOKEN: "proxy-token",
        ANTHROPIC_API_KEY: "anthropic-upstream-key",
        ANTHROPIC_BASE_URL: anthropic.url,
        OPENAI_API_KEY: "openai-key",
        OPENAI_BASE_URL: openai.url,
        LOG_LEVEL: "fatal"
      })
    );
    const proxyUrl = await listen(app);

    await fetch(`${proxyUrl}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": "proxy-token", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-router-hard",
        max_tokens: 256,
        system: [{ type: "text", text: "You are helpful.", cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: "hi" }]
      })
    });
    await app.close();

    const providerCall = anthropic.records.find((rec) => rec.path === "/messages");
    expect(providerCall?.body.system[0].cache_control).toEqual({ type: "ephemeral" });
  });
});

describe("cacheTtlUpgrade end to end (DB-backed)", () => {
  let fixture: PromptTestFixture | undefined;

  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  });

  it("rewrites the outbound Anthropic body to ttl:1h when the org flag is on", async () => {
    fixture = await captureFixture("org_cache_ttl");
    await fixture.persistence.organizationSettings.setCacheTtlUpgrade("org_cache_ttl", true);

    await fetch(`${fixture.proxyUrl}/v1/messages`, {
      method: "POST",
      headers: { authorization: "Bearer proxy-token", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-router-hard",
        max_tokens: 256,
        system: [{ type: "text", text: "Stable preamble.", cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: "hello" }]
      })
    });

    const providerCall = fixture.anthropic.records.find((rec) => rec.path === "/messages");
    expect(providerCall?.body.system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("setCacheTtlUpgrade merges into settings without clobbering other keys", async () => {
    fixture = await captureFixture("org_cache_merge");
    await fixture.db
      .update(organizationSettings)
      .set({ settings: { existingKey: "keep-me" } })
      .where(eq(organizationSettings.organizationId, "org_cache_merge"));

    await fixture.persistence.organizationSettings.setCacheTtlUpgrade("org_cache_merge", true);

    const [row] = await fixture.db
      .select({ settings: organizationSettings.settings })
      .from(organizationSettings)
      .where(eq(organizationSettings.organizationId, "org_cache_merge"))
      .limit(1);
    expect(row?.settings).toEqual({ existingKey: "keep-me", cacheTtlUpgrade: true });
    expect(await fixture.persistence.organizationSettings.cacheTtlUpgrade("org_cache_merge")).toBe(true);
  });
});
