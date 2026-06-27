import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { BedrockRuntimeProviderAdapter } from "../src/providerAdapters/bedrockRuntime.js";
import type { ProviderRegistryEntry } from "../src/persistence/providers.js";
import type { ProviderForwardInput } from "../src/adapters.js";

const requiredEnv = ["AWS_REGION", "AWS_BEDROCK_TEST_MODEL"].filter((key) => !process.env[key]);
const liveDescribe = requiredEnv.length === 0 ? describe : describe.skip;

liveDescribe(`Bedrock live integration${requiredEnv.length > 0 ? ` (set ${requiredEnv.join(", ")} to run)` : ""}`, () => {
  const region = process.env.AWS_REGION!;
  const model = process.env.AWS_BEDROCK_TEST_MODEL!;
  const toolModel = process.env.AWS_BEDROCK_TEST_TOOL_MODEL;

  it("calls Converse and returns usage", async () => {
    const adapter = liveAdapter();
    const response = await adapter.fetchWithRateLimitRetries({
      input: forwardInput({
        region,
        model,
        surface: "openai-chat",
        body: {
          messages: [{ role: "user", content: [{ text: "Reply with the single word ok." }] }],
          inferenceConfig: { maxTokens: 32, temperature: 0 }
        }
      }),
      providerAttemptId: "attempt_live_converse",
      provider: liveProvider(region),
      endpoint: { dialect: "bedrock-converse", operation: "Converse" },
      signal: new AbortController().signal
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Bedrock Converse failed with HTTP ${response.status}: ${text.slice(0, 500)}`);
    const body = JSON.parse(text) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };

    expect(body.choices?.[0]?.message?.content).toEqual(expect.any(String));
    expect(body.usage?.prompt_tokens).toBeGreaterThan(0);
    expect(body.usage?.completion_tokens).toBeGreaterThan(0);
    expect(body.usage?.total_tokens).toBeGreaterThan(0);
  }, 60_000);

  it("calls ConverseStream and terminates the caller SSE stream", async () => {
    const adapter = liveAdapter();
    const response = await adapter.fetchWithRateLimitRetries({
      input: forwardInput({
        region,
        model,
        surface: "openai-chat",
        responseStream: true,
        body: {
          stream: true,
          messages: [{ role: "user", content: [{ text: "Reply with a short sentence." }] }],
          inferenceConfig: { maxTokens: 48, temperature: 0 }
        }
      }),
      providerAttemptId: "attempt_live_stream",
      provider: liveProvider(region),
      endpoint: { dialect: "bedrock-converse", operation: "ConverseStream" },
      signal: new AbortController().signal
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Bedrock ConverseStream failed with HTTP ${response.status}: ${text.slice(0, 500)}`);

    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(text).toContain("data: [DONE]");
    expect(text).toContain("\"usage\"");
  }, 60_000);

  it.skipIf(!toolModel)("calls Converse with forced tool use when AWS_BEDROCK_TEST_TOOL_MODEL is set", async () => {
    const adapter = liveAdapter();
    const response = await adapter.fetchWithRateLimitRetries({
      input: forwardInput({
        region,
        model: toolModel!,
        surface: "anthropic-messages",
        body: {
          messages: [{ role: "user", content: [{ text: "Use the weather tool for Rio." }] }],
          inferenceConfig: { maxTokens: 128, temperature: 0 },
          toolConfig: {
            tools: [{
              toolSpec: {
                name: "get_weather",
                description: "Gets the current weather for a city.",
                inputSchema: {
                  json: {
                    type: "object",
                    properties: { city: { type: "string" } },
                    required: ["city"]
                  }
                }
              }
            }],
            toolChoice: { tool: { name: "get_weather" } }
          }
        }
      }),
      providerAttemptId: "attempt_live_tool",
      provider: liveProvider(region),
      endpoint: { dialect: "bedrock-converse", operation: "Converse" },
      signal: new AbortController().signal
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Bedrock tool Converse failed with HTTP ${response.status}: ${text.slice(0, 500)}`);
    const body = JSON.parse(text) as { content?: { type?: string; name?: string }[] };

    expect(body.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tool_use", name: "get_weather" })
    ]));
  }, 60_000);
});

function liveAdapter() {
  const events = { append: async () => {} };
  return new BedrockRuntimeProviderAdapter(loadConfig({
    ...process.env,
    LOG_LEVEL: "fatal",
    PROXY_TOKEN: "proxy-token",
    OPENAI_API_KEY: "openai-upstream-key",
    ANTHROPIC_API_KEY: "anthropic-upstream-key",
    BEDROCK_OPERATOR_DEFAULT_CHAIN_ENABLED: "true",
    BEDROCK_LOCAL_CREDENTIALS_ENABLED: "true"
  }), events);
}

function liveProvider(region: string): ProviderRegistryEntry {
  return {
    id: "provider_amazon_bedrock_live",
    organizationId: null,
    slug: "amazon-bedrock",
    baseUrl: `https://bedrock-runtime.${region}.amazonaws.com`,
    adapterKind: "aws-bedrock-converse",
    adapterConfig: { defaultRegion: region },
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
}

function forwardInput(input: {
  region: string;
  model: string;
  surface: ProviderForwardInput["surface"];
  body: unknown;
  responseStream?: boolean;
}): ProviderForwardInput {
  return {
    requestId: "request_bedrock_live",
    idempotencyKey: "idem_bedrock_live",
    organizationId: "org_bedrock_live",
    workspaceId: "org_bedrock_live:workspace:default",
    surface: input.surface,
    provider: "amazon-bedrock",
    body: input.body,
    responseStream: input.responseStream,
    headers: {},
    decision: {
      outcome: "route",
      surface: input.surface,
      requestedModel: "router-hard",
      selectedModel: input.model,
      provider: "amazon-bedrock",
      providerSettings: {
        provider: "amazon-bedrock",
        model: input.model,
        dialect: "bedrock-converse",
        deployment: {
          key: "hard:0",
          provider: "amazon-bedrock",
          model: input.model,
          order: 0,
          weight: 1,
          timeoutMs: 60_000,
          metadata: {
            bedrock: { region: input.region }
          }
        },
        openai: {
          provider: "amazon-bedrock",
          model: input.model,
          order: 0,
          weight: 1,
          timeoutMs: 60_000,
          metadata: {
            bedrock: { region: input.region }
          }
        }
      },
      guardrailActions: [],
      reasonCodes: [],
      policyVersion: "test"
    },
    reply: {} as ProviderForwardInput["reply"]
  };
}
