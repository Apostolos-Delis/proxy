import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { listen } from "./helpers.js";

function testEnv(overrides: NodeJS.ProcessEnv = {}) {
  return {
    ...process.env,
    DATABASE_URL: "",
    EVENT_STORE_PATH: "",
    PROXY_TOKEN: "proxy-token",
    OPENAI_API_KEY: "openai-upstream-key",
    ANTHROPIC_API_KEY: "anthropic-upstream-key",
    ALLOW_DEV_PROXY_TOKEN_FALLBACK: "false",
    ...overrides
  };
}

describe("proxy transport boundaries", () => {
  it("keeps debug endpoints and GraphiQL off by default in production", async () => {
    const config = loadConfig({
      ...testEnv(),
      NODE_ENV: "production",
      PROXY_TOKEN: "prod-token",
      LOG_LEVEL: "fatal"
    });
    const app = buildServer(config);
    const proxyUrl = await listen(app);

    const response = await fetch(`${proxyUrl}/_debug/events`, {
      headers: { authorization: "Bearer prod-token" }
    });
    await response.text();
    await app.close();

    expect(config.debugEndpointsEnabled).toBe(false);
    expect(config.adminGraphiqlEnabled).toBe(false);
    expect(config.allowDevProxyTokenFallback).toBe(false);
    expect(response.status).toBe(404);
  });

  it("rejects oversized request bodies with a clear 413", async () => {
    const app = buildServer(loadConfig({
      ...testEnv(),
      REQUEST_BODY_LIMIT_BYTES: "256",
      LOG_LEVEL: "fatal"
    }));
    const proxyUrl = await listen(app);

    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({ model: "coding-auto", input: "x".repeat(512) })
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "request_body_too_large",
        message: "Request body exceeds gateway limit.",
        type: "invalid_request_error"
      },
      limitBytes: 256
    });
    await app.close();
  });

  it("does not expose token counting on OpenAI Chat Completions", async () => {
    const app = buildServer(loadConfig({ ...testEnv(), LOG_LEVEL: "fatal" }));
    const proxyUrl = await listen(app);

    const response = await fetch(`${proxyUrl}/v1/chat/completions/count_tokens`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "coding-auto",
        messages: [{ role: "user", content: "hi" }]
      })
    });
    await app.close();

    expect(response.status).toBe(404);
  });
});
