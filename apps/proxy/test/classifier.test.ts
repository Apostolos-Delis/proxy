import { afterEach, describe, expect, it, vi } from "vitest";

import { LlmClassifier, type ClassifierSettings, type ClassifierTarget } from "../src/classifier.js";
import type { AppConfig } from "../src/config.js";
import { buildAnthropicContext } from "../src/features.js";

const config = {
  openaiBaseUrl: "https://openai.test/v1",
  openaiApiKey: "test-key"
} as AppConfig;

const validOutput = {
  complexity: "simple",
  risk: [],
  recommended_route: "balanced",
  can_use_fast_model: true,
  needs_deep_reasoning: false,
  reason_codes: ["simple_task"],
  confidence: 0.9
};

function settings(
  model: string,
  effort?: ClassifierSettings["effort"]
): ClassifierSettings {
  return {
    providerId: "openai",
    model,
    timeoutMs: 1000,
    maxAttempts: 1,
    allowRedactedExcerpt: false,
    structuredOutput: { mode: "json_schema", schemaName: "route_classification" },
    ...(effort ? { effort } : {})
  };
}

const classifierTarget: ClassifierTarget = {
  provider: {
    id: "provider_openai",
    organizationId: null,
    slug: "openai",
    baseUrl: "https://openai.test/v1",
    authStyle: "bearer",
    endpoints: [{ dialect: "openai-responses", path: "/responses" }],
    defaultHeaders: {},
    capabilities: { efforts: ["low", "medium", "high", "xhigh"] },
    forwardHarnessHeaders: true,
    enabled: true,
    builtin: true
  },
  endpoint: { dialect: "openai-responses", path: "/responses" }
};

async function classifierRequestBody(classifierSettings: ClassifierSettings) {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ output_parsed: validOutput }), { status: 200 })
  );
  vi.stubGlobal("fetch", fetchMock);

  const context = buildAnthropicContext(
    {
      model: "claude-router-auto",
      messages: [{ role: "user", content: "add a --json flag to the export command" }]
    },
    {}
  );
  await new LlmClassifier(config).classify(context, classifierSettings, classifierTarget);

  expect(fetchMock).toHaveBeenCalledTimes(1);
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
  return JSON.parse(init.body as string) as { reasoning?: { effort: string } };
}

describe("classifier reasoning effort", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults the original gpt-5 family to minimal", async () => {
    const body = await classifierRequestBody(settings("gpt-5-nano-2025-08-07"));
    expect(body.reasoning).toEqual({ effort: "minimal" });
  });

  it("defaults dotted gpt-5.x models to none, which replaced minimal", async () => {
    const body = await classifierRequestBody(settings("gpt-5.4-mini"));
    expect(body.reasoning).toEqual({ effort: "none" });
  });

  it("normalizes an explicit minimal to none on dotted gpt-5.x models", async () => {
    const body = await classifierRequestBody(settings("gpt-5.4-mini", "minimal"));
    expect(body.reasoning).toEqual({ effort: "none" });
  });

  it("keeps explicit efforts that the model supports", async () => {
    const body = await classifierRequestBody(settings("gpt-5.4-mini", "low"));
    expect(body.reasoning).toEqual({ effort: "low" });
  });

  it("omits reasoning for models outside the known reasoning families", async () => {
    const body = await classifierRequestBody(settings("gpt-4o-mini"));
    expect(body.reasoning).toBeUndefined();
  });
});
