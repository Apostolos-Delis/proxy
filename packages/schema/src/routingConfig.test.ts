import { describe, expect, it } from "vitest";

import {
  anthropicEffortForModel,
  anthropicReasoningEffortsForModel,
  composeClassifierInstructions,
  providerRegistryEntrySchema,
  ROUTING_CLASSIFIER_BASE_INSTRUCTIONS,
  routingConfigSchema,
  supportsAnthropicAdaptiveThinking,
  type RoutingConfig
} from "./index.js";

const validConfig = {
  schemaVersion: 3,
  displayName: "Default coding router",
  description: "Routes coding-agent traffic by complexity.",
  classifier: {
    providerId: "openai",
    model: "gpt-5-nano-2025-08-07",
    rules: "Keep auth/ and payments/ on hard or deep.",
    timeoutMs: 1500,
    maxAttempts: 2,
    allowRedactedExcerpt: true,
    structuredOutput: {
      mode: "json_schema",
      schemaName: "routing_classifier"
    }
  },
  routes: {
    fast: {
      description: "Simple shell/status/read-only tasks",
      retry: {
        maxAttempts: 2,
        retryableStatusCodes: [429, 500, 502, 503, 504]
      },
      openai: {
        deployments: [{
          provider: "openai",
          model: "gpt-5-nano-2025-08-07",
          order: 0,
          weight: 1,
          timeoutMs: 60000,
          reasoning: { effort: "low" },
          text: { verbosity: "low" },
          metadata: {
            surface: "responses"
          }
        }]
      },
      anthropic: {
        deployments: [{
          provider: "anthropic",
          model: "claude-haiku-4-5",
          order: 0,
          weight: 1,
          timeoutMs: 60000,
          thinking: { type: "disabled" },
          output_config: { effort: "low" }
        }]
      }
    },
    balanced: {
      description: "Default coding tasks",
      retry: {
        maxAttempts: 2,
        retryableStatusCodes: [429, 500, 502, 503, 504]
      },
      openai: {
        deployments: [{
          provider: "openai",
          model: "gpt-5.4",
          order: 0,
          weight: 1,
          timeoutMs: 60000,
          reasoning: { effort: "medium" },
          text: { verbosity: "low" }
        }]
      },
      anthropic: {
        deployments: [{
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          order: 0,
          weight: 1,
          timeoutMs: 60000,
          thinking: { type: "adaptive", display: "omitted" },
          output_config: { effort: "medium" }
        }]
      }
    },
    hard: {
      description: "Debugging, multi-file edits, migrations",
      retry: {
        maxAttempts: 2,
        retryableStatusCodes: [429, 500, 502, 503, 504]
      },
      openai: {
        deployments: [{
          provider: "openai",
          model: "gpt-5.5",
          order: 0,
          weight: 1,
          timeoutMs: 60000,
          reasoning: { effort: "high" },
          text: { verbosity: "medium" }
        }]
      },
      anthropic: {
        deployments: [{
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          order: 0,
          weight: 1,
          timeoutMs: 60000,
          thinking: { type: "adaptive", display: "omitted" },
          output_config: { effort: "high" }
        }]
      }
    },
    deep: {
      description: "Architecture, system design, security, storage design",
      retry: {
        maxAttempts: 2,
        retryableStatusCodes: [429, 500, 502, 503, 504]
      },
      openai: {
        deployments: [{
          provider: "openai",
          model: "gpt-5.5-pro",
          order: 0,
          weight: 1,
          timeoutMs: 60000,
          reasoning: { effort: "xhigh" },
          text: { verbosity: "medium" }
        }]
      },
      anthropic: {
        deployments: [{
          provider: "anthropic",
          model: "claude-opus-4-5",
          order: 0,
          weight: 1,
          timeoutMs: 60000,
          thinking: { type: "adaptive", display: "omitted" },
          output_config: { effort: "xhigh" }
        }]
      }
    }
  },
  limits: {
    maxRoute: "deep",
    fallbackRoute: "hard",
    maxEstimatedInputTokens: 200000,
    routeEstimatedInputLimits: {
      fast: 12000,
      balanced: 64000,
      hard: 200000,
      deep: 400000
    }
  },
  session: {
    pinInitialRoute: true,
    allowUpgrade: true,
    allowDowngrade: false
  }
} satisfies RoutingConfig;

describe("routingConfigSchema", () => {
  it("accepts a default OpenAI and Anthropic routing config", () => {
    expect(routingConfigSchema.parse(validConfig)).toEqual(validConfig);
  });

  it("accepts configs without classifier rules", () => {
    const { rules: _rules, ...classifierWithoutRules } = validConfig.classifier;

    expect(routingConfigSchema.safeParse({
      ...validConfig,
      classifier: classifierWithoutRules
    }).success).toBe(true);
  });

  it("rejects the pre-cutover classifier.instructions field", () => {
    const { rules: _rules, ...classifierWithoutRules } = validConfig.classifier;
    const result = routingConfigSchema.safeParse({
      ...validConfig,
      classifier: {
        ...classifierWithoutRules,
        instructions: "Classify the coding-agent request."
      }
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["classifier"]);
  });

  it("rejects whitespace-only classifier rules", () => {
    const result = routingConfigSchema.safeParse({
      ...validConfig,
      classifier: {
        ...validConfig.classifier,
        rules: "   "
      }
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["classifier", "rules"]);
  });

  it("rejects the pre-cutover top-level systemPrompt field", () => {
    const result = routingConfigSchema.safeParse({
      ...validConfig,
      systemPrompt: "You are assisting through the organization's prompt proxy."
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual([]);
  });

  it("rejects unknown top-level fields", () => {
    const result = routingConfigSchema.safeParse({
      ...validConfig,
      promptRewrite: {
        enabled: false
      }
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual([]);
  });

  it("rejects invalid classifier settings with useful paths", () => {
    const result = routingConfigSchema.safeParse({
      ...validConfig,
      classifier: {
        ...validConfig.classifier,
        timeoutMs: 0
      }
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["classifier", "timeoutMs"]);
  });

  it("rejects expensive classifier retry settings before runtime", () => {
    const timeoutResult = routingConfigSchema.safeParse({
      ...validConfig,
      classifier: {
        ...validConfig.classifier,
        timeoutMs: 30001
      }
    });
    const attemptResult = routingConfigSchema.safeParse({
      ...validConfig,
      classifier: {
        ...validConfig.classifier,
        maxAttempts: 6
      }
    });

    expect(timeoutResult.success).toBe(false);
    expect(timeoutResult.error?.issues[0]?.path).toEqual(["classifier", "timeoutMs"]);
    expect(attemptResult.success).toBe(false);
    expect(attemptResult.error?.issues[0]?.path).toEqual(["classifier", "maxAttempts"]);
  });

  it("rejects whitespace-only classifier and provider strings", () => {
    const classifierResult = routingConfigSchema.safeParse({
      ...validConfig,
      classifier: {
        ...validConfig.classifier,
        model: "   "
      }
    });
    const providerResult = routingConfigSchema.safeParse({
      ...validConfig,
      routes: {
        ...validConfig.routes,
        fast: {
          ...validConfig.routes.fast,
          openai: {
            deployments: [{
              ...validConfig.routes.fast.openai.deployments[0],
              model: "\t"
            }]
          }
        }
      }
    });

    expect(classifierResult.success).toBe(false);
    expect(classifierResult.error?.issues[0]?.path).toEqual(["classifier", "model"]);
    expect(providerResult.success).toBe(false);
    expect(providerResult.error?.issues[0]?.path).toEqual([
      "routes",
      "fast",
      "openai",
      "deployments",
      0,
      "model"
    ]);
  });

  it("rejects model identifiers with surrounding whitespace", () => {
    const classifierResult = routingConfigSchema.safeParse({
      ...validConfig,
      classifier: {
        ...validConfig.classifier,
        model: " gpt-5-nano-2025-08-07 "
      }
    });
    const providerResult = routingConfigSchema.safeParse({
      ...validConfig,
      routes: {
        ...validConfig.routes,
        deep: {
          ...validConfig.routes.deep,
          anthropic: {
            deployments: [{
              ...validConfig.routes.deep.anthropic.deployments[0],
              model: "\tclaude-opus-4-5\n"
            }]
          }
        }
      }
    });

    expect(classifierResult.success).toBe(false);
    expect(classifierResult.error?.issues[0]?.path).toEqual(["classifier", "model"]);
    expect(providerResult.success).toBe(false);
    expect(providerResult.error?.issues[0]?.path).toEqual([
      "routes",
      "deep",
      "anthropic",
      "deployments",
      0,
      "model"
    ]);
  });

  it("rejects structured-output schema identifiers with surrounding whitespace", () => {
    const result = routingConfigSchema.safeParse({
      ...validConfig,
      classifier: {
        ...validConfig.classifier,
        structuredOutput: {
          ...validConfig.classifier.structuredOutput,
          schemaName: " routing_classifier "
        }
      }
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["classifier", "structuredOutput", "schemaName"]);
  });

  it("rejects invalid provider blocks before runtime", () => {
    const result = routingConfigSchema.safeParse({
      ...validConfig,
      routes: {
        ...validConfig.routes,
        hard: {
          ...validConfig.routes.hard,
          openai: {
            deployments: [{
              ...validConfig.routes.hard.openai.deployments[0],
              reasoning: { effort: "maximum" }
            }]
          }
        }
      }
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual([
      "routes",
      "hard",
      "openai",
      "deployments",
      0,
      "reasoning",
      "effort"
    ]);
  });

  it("rejects pre-cutover single-model provider blocks", () => {
    const result = routingConfigSchema.safeParse({
      ...validConfig,
      schemaVersion: 1,
      routes: {
        ...validConfig.routes,
        hard: {
          ...validConfig.routes.hard,
          openai: {
            model: "gpt-5.5",
            reasoning: { effort: "high" }
          }
        }
      }
    });

    expect(result.success).toBe(false);
  });

  it("requires deployment identity and positive order-group weight", () => {
    const missingProvider = routingConfigSchema.safeParse({
      ...validConfig,
      routes: {
        ...validConfig.routes,
        hard: {
          ...validConfig.routes.hard,
          openai: {
            deployments: [{
              ...validConfig.routes.hard.openai.deployments[0],
              provider: " "
            }]
          }
        }
      }
    });
    const zeroWeight = routingConfigSchema.safeParse({
      ...validConfig,
      routes: {
        ...validConfig.routes,
        fast: {
          ...validConfig.routes.fast,
          openai: {
            deployments: [{
              ...validConfig.routes.fast.openai.deployments[0],
              weight: 0
            }]
          }
        }
      }
    });

    expect(missingProvider.success).toBe(false);
    expect(missingProvider.error?.issues[0]?.path).toEqual(["routes", "hard", "openai", "deployments", 0, "provider"]);
    expect(zeroWeight.success).toBe(false);
    expect(zeroWeight.error?.issues[0]?.path).toEqual(["routes", "fast", "openai", "deployments", 0, "weight"]);
  });

  it("requires bounded route retry policy", () => {
    const missingRetry = routingConfigSchema.safeParse({
      ...validConfig,
      routes: {
        ...validConfig.routes,
        fast: {
          description: validConfig.routes.fast.description,
          openai: validConfig.routes.fast.openai,
          anthropic: validConfig.routes.fast.anthropic
        }
      }
    });
    const tooManyAttempts = routingConfigSchema.safeParse({
      ...validConfig,
      routes: {
        ...validConfig.routes,
        hard: {
          ...validConfig.routes.hard,
          retry: {
            ...validConfig.routes.hard.retry,
            maxAttempts: 6
          }
        }
      }
    });

    expect(missingRetry.success).toBe(false);
    expect(missingRetry.error?.issues[0]?.path).toEqual(["routes", "fast", "retry"]);
    expect(tooManyAttempts.success).toBe(false);
    expect(tooManyAttempts.error?.issues[0]?.path).toEqual(["routes", "hard", "retry", "maxAttempts"]);
  });

  it("requires each route to define at least one provider", () => {
    const result = routingConfigSchema.safeParse({
      ...validConfig,
      routes: {
        ...validConfig.routes,
        fast: {
          description: "No provider",
          retry: validConfig.routes.fast.retry
        }
      }
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["routes", "fast", "openai"]);
  });

  it("accepts partial route estimated input limits", () => {
    const result = routingConfigSchema.safeParse({
      ...validConfig,
      limits: {
        ...validConfig.limits,
        routeEstimatedInputLimits: {
          fast: 12000
        }
      }
    });

    expect(result.success).toBe(true);
  });

  it("rejects unknown route estimated input limit keys", () => {
    const result = routingConfigSchema.safeParse({
      ...validConfig,
      limits: {
        ...validConfig.limits,
        routeEstimatedInputLimits: {
          fast: 12000,
          turbo: 1
        }
      }
    });

    expect(result.success).toBe(false);
  });

  it("rejects fallback routes above the configured max route", () => {
    const result = routingConfigSchema.safeParse({
      ...validConfig,
      limits: {
        ...validConfig.limits,
        maxRoute: "balanced",
        fallbackRoute: "hard"
      }
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["limits", "fallbackRoute"]);
  });
});

describe("providerRegistryEntrySchema", () => {
  it("accepts custom provider registry entries", () => {
    const entry = {
      slug: "acme-vllm",
      base_url: "https://models.example.com/v1",
      adapter_kind: "generic-http-json",
      adapter_config: {},
      auth_style: "bearer",
      endpoints: [
        { dialect: "openai-chat", path: "/chat/completions" },
        { dialect: "openai-responses", path: "/responses" }
      ],
      default_headers: {
        "x-routing-pool": "primary"
      },
      capabilities: {
        efforts: ["low", "medium", "high", "xhigh"]
      },
      forward_harness_headers: false,
      enabled: true
    };

    expect(providerRegistryEntrySchema.parse(entry)).toEqual(entry);
  });

  it("accepts Bedrock provider registry entries", () => {
    const entry = {
      slug: "amazon-bedrock",
      base_url: "https://bedrock-runtime.us-east-1.amazonaws.com",
      adapter_kind: "aws-bedrock-converse",
      adapter_config: { defaultRegion: "us-east-1" },
      auth_style: "aws-sdk",
      endpoints: [
        { dialect: "bedrock-converse", operation: "Converse" },
        { dialect: "bedrock-converse", operation: "ConverseStream" }
      ],
      default_headers: {},
      capabilities: {},
      forward_harness_headers: false,
      enabled: true
    };

    expect(providerRegistryEntrySchema.parse(entry)).toEqual(entry);
  });

  it("rejects invalid registry entries with useful paths", () => {
    const result = providerRegistryEntrySchema.safeParse({
      slug: " acme-vllm ",
      base_url: "not a url",
      auth_style: "bearer",
      endpoints: [
        { dialect: "openai-chat", path: "chat/completions" }
      ],
      default_headers: {
        "x-empty": ""
      },
      forward_harness_headers: false,
      enabled: true
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual(expect.arrayContaining([
      ["slug"],
      ["base_url"],
      ["endpoints", 0, "path"],
      ["default_headers", "x-empty"]
    ]));
  });

  it("rejects invalid adapter and endpoint combinations", () => {
    const genericAws = providerRegistryEntrySchema.safeParse({
      slug: "bad-auth",
      base_url: "https://models.example.com/v1",
      adapter_kind: "generic-http-json",
      auth_style: "aws-sdk",
      endpoints: [{ dialect: "openai-chat", path: "/chat/completions" }],
      default_headers: {},
      forward_harness_headers: false,
      enabled: true
    });
    const bedrockPath = providerRegistryEntrySchema.safeParse({
      slug: "bad-bedrock",
      base_url: "https://bedrock-runtime.us-east-1.amazonaws.com",
      adapter_kind: "aws-bedrock-converse",
      auth_style: "aws-sdk",
      endpoints: [{ dialect: "openai-chat", path: "/chat/completions" }],
      default_headers: {},
      forward_harness_headers: false,
      enabled: true
    });
    const emptyPath = providerRegistryEntrySchema.safeParse({
      slug: "empty-path",
      base_url: "https://models.example.com/v1",
      adapter_kind: "generic-http-json",
      auth_style: "bearer",
      endpoints: [{ dialect: "openai-chat", path: "" }],
      default_headers: {},
      forward_harness_headers: false,
      enabled: true
    });

    expect(genericAws.success).toBe(false);
    expect(genericAws.error?.issues.map((issue) => issue.path)).toContainEqual(["auth_style"]);
    expect(bedrockPath.success).toBe(false);
    expect(bedrockPath.error?.issues.map((issue) => issue.path)).toContainEqual(["endpoints", 0, "path"]);
    expect(emptyPath.success).toBe(false);
    expect(emptyPath.error?.issues.map((issue) => issue.path)).toContainEqual(["endpoints", 0, "path"]);
  });
});

describe("Anthropic model effort support", () => {
  it("maps route efforts to the supported Anthropic model scale", () => {
    expect(anthropicReasoningEffortsForModel("claude-sonnet-4-5")).toEqual([]);
    expect(anthropicEffortForModel("claude-sonnet-4-5", "high")).toBeUndefined();
    expect(anthropicEffortForModel("claude-opus-4-5", "ultracode")).toBe("high");
    expect(anthropicEffortForModel("claude-opus-4-8", "ultracode")).toBe("xhigh");
    expect(supportsAnthropicAdaptiveThinking("claude-opus-4-5")).toBe(false);
    expect(supportsAnthropicAdaptiveThinking("claude-opus-4-8")).toBe(true);
  });
});

describe("composeClassifierInstructions", () => {
  it("returns the built-in prompt when no rules are configured", () => {
    expect(composeClassifierInstructions()).toBe(ROUTING_CLASSIFIER_BASE_INSTRUCTIONS);
    expect(composeClassifierInstructions("   ")).toBe(ROUTING_CLASSIFIER_BASE_INSTRUCTIONS);
  });

  it("inserts organization rules before the output-format reminder", () => {
    const composed = composeClassifierInstructions("  auth/ routes deep.  ");

    expect(composed).toContain("Organization routing rules");
    expect(composed).toContain("auth/ routes deep.");
    expect(composed.indexOf("auth/ routes deep.")).toBeGreaterThan(
      composed.indexOf("Route tiers:")
    );
    expect(composed.endsWith("Return only JSON matching the requested schema.")).toBe(true);
  });
});
