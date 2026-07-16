import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LlmClassifier,
  type ClassifierTarget,
  type LogicalModelClassifierDeployment,
  type LogicalModelClassifierTargetResolver
} from "../src/classifier.js";

const classifierTarget: ClassifierTarget = {
  provider: {
    id: "provider_openai",
    organizationId: null,
    provider: "openai",
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
  endpoint: { dialect: "openai-responses", path: "/responses" },
  credential: {
    provider: "openai",
    token: "test-key",
    providerConnectionId: "provider_openai"
  }
};

const classifierDeployment: LogicalModelClassifierDeployment = {
  deploymentId: "deployment_classifier",
  organizationId: "org_classifier",
  workspaceId: "workspace_classifier",
  model: "gpt-classifier",
  provider: "openai",
  providerConnectionId: "provider_openai",
  bindingId: "binding_classifier"
};

const logicalTargetResolver: LogicalModelClassifierTargetResolver = {
  async resolve() {
    return classifierTarget;
  }
};

describe("logical model classifier", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retries invalid output and exposes only eligible target IDs and capabilities", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        output_parsed: { target_id: "target_forbidden", reason_codes: ["bad"], confidence: 1 },
        usage: { input_tokens: 4, output_tokens: 1 }
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        output_parsed: { target_id: "target_economy", reason_codes: ["capability_match"], confidence: 0.8 },
        usage: { input_tokens: 10, output_tokens: 3 }
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new LlmClassifier(undefined, logicalTargetResolver).classifyLogicalModel({
      config: {
        classifierDeploymentId: "deployment_classifier",
        instructions: "Choose one eligible target.",
        timeoutMs: 1_000,
        maxAttempts: 2
      },
      classifierModel: "gpt-classifier",
      request: {
        context: { requestedModel: "economy-auto", operationId: "text.generate" },
        candidates: [
          { targetId: "target_economy", capabilities: { tools: true, contextWindow: 128_000 } },
          { targetId: "target_basic", capabilities: { tools: false } }
        ]
      }
    }, classifierDeployment);

    expect(result).toEqual({
      targetId: "target_economy",
      reasonCodes: ["capability_match"],
      confidence: 0.8,
      attempts: 2,
      usage: {
        inputTokens: 14,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
        outputTokens: 4,
        reasoningTokens: 0,
        totalTokens: 18
      }
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(JSON.parse(body.input)).toEqual({
      request: { requestedModel: "economy-auto", operationId: "text.generate" },
      targets: [
        { id: "target_economy", capabilities: { tools: true, contextWindow: 128_000 } },
        { id: "target_basic", capabilities: { tools: false } }
      ]
    });
    expect(body.text.format.schema.properties.target_id.enum).toEqual([
      "target_economy",
      "target_basic"
    ]);
  });

  it("fails closed after the configured attempt limit", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      output_parsed: { target_id: "target_forbidden", reason_codes: ["bad"], confidence: 1 }
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new LlmClassifier(undefined, logicalTargetResolver).classifyLogicalModel({
      config: {
        classifierDeploymentId: "deployment_classifier",
        instructions: "Choose one eligible target.",
        timeoutMs: 1_000,
        maxAttempts: 2
      },
      classifierModel: "gpt-classifier",
      request: {
        context: { requestedModel: "economy-auto", operationId: "text.generate" },
        candidates: [{ targetId: "target_allowed", capabilities: {} }]
      }
    }, classifierDeployment)).rejects.toThrow("invalid logical model target");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries transient classifier target resolution failures within the attempt limit", async () => {
    const resolver: LogicalModelClassifierTargetResolver = {
      resolve: vi.fn()
        .mockRejectedValueOnce(new Error("temporary secret backend failure"))
        .mockResolvedValueOnce(classifierTarget)
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      output_parsed: { target_id: "target_allowed", reason_codes: ["selected"], confidence: 1 }
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new LlmClassifier(undefined, resolver).classifyLogicalModel({
      config: {
        classifierDeploymentId: "deployment_classifier",
        instructions: "Choose one eligible target.",
        timeoutMs: 1_000,
        maxAttempts: 2
      },
      classifierModel: "gpt-classifier",
      request: {
        context: { requestedModel: "economy-auto", operationId: "text.generate" },
        candidates: [{ targetId: "target_allowed", capabilities: {} }]
      }
    }, classifierDeployment);

    expect(result.attempts).toBe(2);
    expect(resolver.resolve).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("times out classifier target resolution before provider I/O", async () => {
    const resolver: LogicalModelClassifierTargetResolver = {
      resolve: vi.fn(() => new Promise<ClassifierTarget>(() => undefined))
    };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const startedAt = performance.now();

    await expect(new LlmClassifier(undefined, resolver).classifyLogicalModel({
      config: {
        classifierDeploymentId: "deployment_classifier",
        instructions: "Choose one eligible target.",
        timeoutMs: 10,
        maxAttempts: 1
      },
      classifierModel: "gpt-classifier",
      request: {
        context: { requestedModel: "economy-auto", operationId: "text.generate" },
        candidates: [{ targetId: "target_allowed", capabilities: {} }]
      }
    }, classifierDeployment)).rejects.toThrow("timed out");

    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(resolver.resolve).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
