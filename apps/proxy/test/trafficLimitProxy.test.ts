import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { listen, startAnthropicMock, startOpenAIMock, type MockServer } from "./helpers.js";
import { captureFixture, testEnv } from "./promptTestFixture.js";

describe("proxy traffic limits", () => {
  let openai: MockServer | undefined;
  let anthropic: MockServer | undefined;

  afterEach(async () => {
    await openai?.close();
    await anthropic?.close();
    openai = undefined;
    anthropic = undefined;
  });

  it("rejects overlapping global concurrency and releases after cancellation", async () => {
    openai = await startOpenAIMock({ slowProvider: true });
    anthropic = await startAnthropicMock();
    const app = buildServer(loadConfig({
      ...testEnv(),
      OPENAI_BASE_URL: openai.url,
      ANTHROPIC_BASE_URL: anthropic.url,
      GATEWAY_GLOBAL_CONCURRENCY_LIMIT: "1",
      LOG_LEVEL: "fatal"
    }));
    const proxyUrl = await listen(app);
    const firstController = new AbortController();
    const thirdController = new AbortController();

    const first = await fetch(`${proxyUrl}/v1/responses`, requestInit(firstController.signal, "global concurrency first"));
    const second = await fetch(`${proxyUrl}/v1/responses`, requestInit(undefined, "global concurrency second"));
    const secondBody = await second.json() as { error: string; scope: string };
    firstController.abort();
    await first.text().catch(() => "");
    await new Promise((resolve) => setTimeout(resolve, 25));
    const third = await fetch(`${proxyUrl}/v1/responses`, requestInit(thirdController.signal, "global concurrency third"));
    thirdController.abort();
    await third.text().catch(() => "");
    await app.close();

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBeNull();
    expect(secondBody).toMatchObject({
      error: "traffic_limit_exceeded:global:concurrency",
      scope: "global"
    });
    expect(third.status).toBe(200);
  });

  it("releases concurrency after success and provider failure", async () => {
    openai = await startOpenAIMock({ failProviderOnce: true });
    anthropic = await startAnthropicMock();
    const app = buildServer(loadConfig({
      ...testEnv(),
      OPENAI_BASE_URL: openai.url,
      ANTHROPIC_BASE_URL: anthropic.url,
      GATEWAY_GLOBAL_CONCURRENCY_LIMIT: "1",
      LOG_LEVEL: "fatal"
    }));
    const proxyUrl = await listen(app);

    const first = await fetch(`${proxyUrl}/v1/responses`, requestInit(undefined, "provider failure releases first"));
    await first.text();
    const second = await fetch(`${proxyUrl}/v1/responses`, requestInit(undefined, "provider failure releases second"));
    await second.text();
    const third = await fetch(`${proxyUrl}/v1/responses`, requestInit(undefined, "provider failure releases third"));
    await third.text();
    await app.close();

    expect(first.status).toBe(500);
    expect(second.status).toBe(200);
    expect(third.status).toBe(200);
  });

  it("applies api-key rpm limits with retry-after", async () => {
    const fixture = await captureFixture("org_traffic_api_key_rpm", "hash_only", false, {
      envOverrides: {
        GATEWAY_API_KEY_RPM_LIMIT: "1"
      }
    });
    let firstStatus = 0;
    let secondStatus = 0;
    let retryAfter: string | null = null;
    let body: { error: string; scope: string } | undefined;
    try {
      const first = await fetch(`${fixture.proxyUrl}/v1/responses`, requestInit(undefined, "api key rpm first"));
      await first.text();
      const second = await fetch(`${fixture.proxyUrl}/v1/responses`, requestInit(undefined, "api key rpm second"));
      firstStatus = first.status;
      secondStatus = second.status;
      retryAfter = second.headers.get("retry-after");
      body = await second.json() as { error: string; scope: string };
    } finally {
      await fixture.close();
    }

    expect(firstStatus).toBe(200);
    expect(secondStatus).toBe(429);
    expect(retryAfter).toBe("60");
    expect(body).toMatchObject({
      error: "traffic_limit_exceeded:api_key:rpm",
      scope: "api_key"
    });
  });

  it("applies token and provider-model limits", async () => {
    openai = await startOpenAIMock({ slowProvider: true });
    anthropic = await startAnthropicMock();
    const app = buildServer(loadConfig({
      ...testEnv(),
      OPENAI_BASE_URL: openai.url,
      ANTHROPIC_BASE_URL: anthropic.url,
      GATEWAY_GLOBAL_TPM_LIMIT: "1",
      GATEWAY_PROVIDER_MODEL_CONCURRENCY_LIMIT: "1",
      LOG_LEVEL: "fatal"
    }));
    const proxyUrl = await listen(app);

    const tokenLimited = await fetch(`${proxyUrl}/v1/responses`, requestInit(undefined, "this request exceeds one estimated token"));
    const tokenBody = await tokenLimited.json() as { error: string; scope: string };

    await app.close();

    expect(tokenLimited.status).toBe(429);
    expect(tokenLimited.headers.get("retry-after")).toBe("60");
    expect(tokenBody).toMatchObject({
      error: "traffic_limit_exceeded:global:tpm",
      scope: "global"
    });
  });

  it("applies provider-model concurrency limits", async () => {
    openai = await startOpenAIMock({ slowProvider: true });
    anthropic = await startAnthropicMock();
    const app = buildServer(loadConfig({
      ...testEnv(),
      OPENAI_BASE_URL: openai.url,
      ANTHROPIC_BASE_URL: anthropic.url,
      GATEWAY_PROVIDER_MODEL_CONCURRENCY_LIMIT: "1",
      LOG_LEVEL: "fatal"
    }));
    const proxyUrl = await listen(app);
    const firstController = new AbortController();

    const first = await fetch(`${proxyUrl}/v1/responses`, requestInit(firstController.signal, "provider model first"));
    const second = await fetch(`${proxyUrl}/v1/responses`, requestInit(undefined, "provider model second"));
    const body = await second.json() as { error: string; scope: string };
    firstController.abort();
    await first.text().catch(() => "");
    await app.close();

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(body).toMatchObject({
      error: "traffic_limit_exceeded:provider_model:concurrency",
      scope: "provider_model"
    });
  });
});

function requestInit(signal?: AbortSignal, input = "debug this request") {
  return {
    method: "POST",
    headers: {
      authorization: "Bearer proxy-token",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "router-auto",
      input,
      stream: true
    }),
    signal
  };
}
