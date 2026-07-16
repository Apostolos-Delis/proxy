import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config.js";
import { BedrockRuntimeProviderAdapter, type BedrockRuntimeClientFactory } from "../src/providerAdapters/bedrockRuntime.js";
import type { ProviderForwardInput } from "../src/providerAdapters/types.js";
import type { ProviderRegistryEntry } from "../src/persistence/providers.js";

const bedrockProvider: ProviderRegistryEntry = {
  id: "provider_amazon_bedrock",
  organizationId: null,
  slug: "amazon-bedrock",
  baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
  adapterKind: "aws-bedrock-converse",
  adapterConfig: { defaultRegion: "us-east-1" },
  authStyle: "aws-sdk",
  endpoints: [
    { dialect: "bedrock-converse", operation: "Converse" },
    { dialect: "bedrock-converse", operation: "ConverseStream" }
  ],
  defaultHeaders: {},
  capabilities: {},
  forwardHarnessHeaders: false,
  enabled: true,
  builtin: true
};

describe("Bedrock runtime adapter", () => {
  it("sends OpenAI Chat requests to mocked Bedrock Converse", async () => {
    const commands: unknown[] = [];
    const adapter = adapterWithClient(async (command) => {
      commands.push(command);
      return {
        output: {
          message: {
            role: "assistant",
            content: [{ text: "Hello from Bedrock." }]
          }
        },
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
        $metadata: { requestId: "bedrock-request-1" }
      };
    });

    const response = await adapter.fetchWithRateLimitRetries({
      input: forwardInput({
        surface: "openai-chat",
        body: {
          modelId: "amazon.nova-pro-v1:0",
          messages: [{ role: "user", content: [{ text: "hi" }] }]
        }
      }),
      providerAttemptId: "attempt_1",
      provider: bedrockProvider,
      endpoint: { dialect: "bedrock-converse", operation: "Converse" },
      signal: new AbortController().signal
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-amzn-requestid")).toBe("bedrock-request-1");
    expect(await response.json()).toMatchObject({
      object: "chat.completion",
      choices: [{
        message: { role: "assistant", content: "Hello from Bedrock." },
        finish_reason: "stop"
      }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 4,
        total_tokens: 14
      }
    });
    expect((commands[0] as any).input).toMatchObject({
      modelId: "amazon.nova-pro-v1:0",
      messages: [{ role: "user", content: [{ text: "hi" }] }]
    });
  });

  it("sends Anthropic Messages requests to mocked Bedrock Converse", async () => {
    const adapter = adapterWithClient(async () => ({
      output: {
        message: {
          role: "assistant",
          content: [{
            toolUse: {
              toolUseId: "call_weather",
              name: "weather",
              input: { city: "Rio" }
            }
          }]
        }
      },
      stopReason: "tool_use",
      usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 }
    }));

    const response = await adapter.fetchWithRateLimitRetries({
      input: forwardInput({
        surface: "anthropic-messages",
        body: {
          modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
          messages: [{ role: "user", content: [{ text: "weather" }] }]
        }
      }),
      providerAttemptId: "attempt_2",
      provider: bedrockProvider,
      endpoint: { dialect: "bedrock-converse", operation: "Converse" },
      signal: new AbortController().signal
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      type: "message",
      content: [{
        type: "tool_use",
        id: "call_weather",
        name: "weather",
        input: { city: "Rio" }
      }],
      stop_reason: "tool_use",
      usage: {
        input_tokens: 12,
        output_tokens: 3
      }
    });
  });

  it("streams mocked Bedrock ConverseStream events as OpenAI Chat SSE", async () => {
    const adapter = adapterWithClient(async () => ({
      stream: streamEvents([
        { messageStart: { role: "assistant" } },
        { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "streamed" } } },
        { messageStop: { stopReason: "end_turn" } },
        { metadata: { usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } } }
      ]),
      $metadata: { requestId: "bedrock-stream-1" }
    }));

    const response = await adapter.fetchWithRateLimitRetries({
      input: forwardInput({
        surface: "openai-chat",
        responseStream: true,
        body: {
          stream: true,
          modelId: "amazon.nova-pro-v1:0",
          messages: [{ role: "user", content: [{ text: "hi" }] }]
        }
      }),
      providerAttemptId: "attempt_3",
      provider: bedrockProvider,
      endpoint: { dialect: "bedrock-converse", operation: "Converse" },
      signal: new AbortController().signal
    });

    const text = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(text).toContain("\"content\":\"streamed\"");
    expect(text).toContain("\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":2,\"total_tokens\":7}");
    expect(text).toContain("data: [DONE]");
  });

  it("classifies Bedrock stream exception messages", () => {
    const adapter = adapterWithClient(async () => ({}));

    expect(adapter.classifyStreamError({
      message: "Rate exceeded while streaming from Bedrock."
    })).toMatchObject({
      category: "rate_limited",
      errorType: "rate_limited",
      metadata: {
        bedrockErrorKind: "rate_limited",
        bedrockOperation: "ConverseStream"
      }
    });
  });

  it("keeps Bedrock classification context per response", async () => {
    const adapter = adapterWithClient(async () => ({
      output: {
        message: {
          role: "assistant",
          content: [{ text: "ok" }]
        }
      },
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
    }));
    const first = await adapter.fetchWithRateLimitRetries({
      input: forwardInput({
        surface: "openai-chat",
        selectedModel: "amazon.nova-lite-v1:0",
        body: {
          modelId: "amazon.nova-lite-v1:0",
          messages: [{ role: "user", content: [{ text: "first" }] }]
        }
      }),
      providerAttemptId: "attempt_context_1",
      provider: bedrockProvider,
      endpoint: { dialect: "bedrock-converse", operation: "Converse" },
      signal: new AbortController().signal
    });
    const second = await adapter.fetchWithRateLimitRetries({
      input: forwardInput({
        surface: "openai-chat",
        selectedModel: "amazon.nova-pro-v1:0",
        body: {
          modelId: "amazon.nova-pro-v1:0",
          messages: [{ role: "user", content: [{ text: "second" }] }]
        }
      }),
      providerAttemptId: "attempt_context_2",
      provider: bedrockProvider,
      endpoint: { dialect: "bedrock-converse", operation: "Converse" },
      signal: new AbortController().signal
    });
    const bodyText = JSON.stringify({
      error: {
        code: "ThrottlingException",
        message: "Rate exceeded."
      }
    });

    expect(adapter.classifyResponse({
      status: 429,
      bodyText,
      response: first
    })?.metadata).toMatchObject({
      model: "amazon.nova-lite-v1:0"
    });
    expect(adapter.classifyResponse({
      status: 429,
      bodyText,
      response: second
    })?.metadata).toMatchObject({
      model: "amazon.nova-pro-v1:0"
    });
  });

});

function adapterWithClient(send: (command: unknown) => Promise<unknown>) {
  const events = { append: vi.fn(async () => {}) };
  const clientFactory: BedrockRuntimeClientFactory = () => ({ send });
  return new BedrockRuntimeProviderAdapter(loadConfig({ LOG_LEVEL: "fatal" }), events, clientFactory);
}

function forwardInput(input: {
  surface: ProviderForwardInput["surface"];
  body: unknown;
  responseStream?: boolean;
  selectedModel?: string;
}): ProviderForwardInput {
  const selectedModel = input.selectedModel ?? "amazon.nova-pro-v1:0";
  const deploymentId = `deployment_bedrock_${selectedModel}`;
  const providerConnectionId = "bedrock_connection";
  const endpoint = { dialect: "bedrock-converse" as const, operation: "Converse" as const };
  return {
    requestId: "request_bedrock",
    idempotencyKey: "idem_bedrock",
    organizationId: "org_bedrock",
    workspaceId: "workspace_default",
    surface: input.surface,
    target: {
      resolution: {
        outcome: "resolved",
        accessProfileId: "profile_bedrock",
        logicalModelId: "logical_model_bedrock",
        logicalModelSlug: "coding-auto",
        routerKind: null,
        deploymentId,
        upstreamModelId: selectedModel,
        providerConnectionId,
        bindingId: "binding_bedrock",
        egressWireId: "bedrock-converse",
        endpointPath: null,
        providerAdapterKind: "aws-bedrock-converse",
        providerAdapterContractVersion: "1",
        wireAdapterId: null,
        wireAdapterVersion: null,
        routerDecisionId: null,
        routerDecision: null,
        parameterCaps: {}
      },
      provider: "amazon-bedrock",
      upstreamModelId: selectedModel,
      deploymentId,
      providerConnectionId,
      requestConfig: {},
      deploymentConfig: {},
      capabilities: {},
      timeoutMs: 10_000,
      providerEntry: bedrockProvider,
      endpoint,
      credential: {
        provider: "amazon-bedrock",
        providerConnectionId,
        token: "bedrock-bearer",
        connectionSettings: {
          credentialMode: "aws_bedrock_bearer_token",
          region: "us-east-1"
        }
      }
    },
    body: input.body,
    responseStream: input.responseStream,
    headers: {},
    reply: {} as ProviderForwardInput["reply"]
  };
}

async function* streamEvents(items: unknown[]) {
  for (const item of items) yield item;
}
