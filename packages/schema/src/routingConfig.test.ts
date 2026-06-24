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
  schemaVersion: 2,
  displayName: "Default coding router",
  description: "Routes coding-agent traffic by complexity.",
  classifier: {
    providerId: "openai",
    model: "gpt-5-nano-2025-08-07",
    rules: "Keep auth/ and payments/ on hard or deep.",
    effort: "minimal",
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
      targets: [
        {
          providerId: "anthropic",
          model: "claude-haiku-4-5",
          effort: "low",
          thinking: { type: "disabled" }
        },
        {
          providerId: "openai",
          model: "gpt-5-nano-2025-08-07",
          effort: "low",
          verbosity: "low",
          metadata: {
            surface: "responses"
          }
        },
        {
          providerId: "acme-vllm",
          model: "qwen3-coder-30b"
        }
      ]
    },
    balanced: {
      description: "Default coding tasks",
      targets: [
        {
          providerId: "anthropic",
          model: "claude-sonnet-4-5",
          effort: "medium",
          thinking: { type: "adaptive", display: "omitted" }
        },
        {
          providerId: "openai",
          model: "gpt-5.4",
          effort: "medium",
          verbosity: "low"
        }
      ]
    },
    hard: {
      description: "Debugging, multi-file edits, migrations",
      targets: [
        {
          providerId: "anthropic",
          model: "claude-sonnet-4-5",
          effort: "high",
          thinking: { type: "adaptive", display: "omitted" }
        },
        {
          providerId: "openai",
          model: "gpt-5.5",
          effort: "high",
          verbosity: "medium"
        }
      ]
    },
    deep: {
      description: "Architecture, system design, security, storage design",
      targets: [
        {
          providerId: "anthropic",
          model: "claude-opus-4-5",
          effort: "ultracode",
          thinking: { type: "adaptive", display: "omitted" },
          maxOutputTokens: 32000,
          metadata: { retained: true }
        },
        {
          providerId: "openai",
          model: "gpt-5.5-pro",
          effort: "xhigh",
          verbosity: "medium"
        }
      ]
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
  it("accepts a target-list routing config", () => {
    expect(routingConfigSchema.parse(validConfig)).toEqual(validConfig);
  });

  it("parses v2 configs without rewriting thinking or metadata", () => {
    const parsed = routingConfigSchema.parse(validConfig);

    expect(JSON.stringify(parsed)).toBe(JSON.stringify(validConfig));
  });

  it("rejects v1 provider-block configs at parse time", () => {
    const result = routingConfigSchema.safeParse({
      ...validConfig,
      schemaVersion: 1,
      classifier: {
        provider: "openai",
        model: "gpt-5-nano-2025-08-07",
        timeoutMs: 1500,
        maxAttempts: 2,
        allowRedactedExcerpt: true,
        structuredOutput: {
          mode: "json_schema"
        }
      },
      routes: {
        ...validConfig.routes,
        fast: {
          openai: {
            model: "gpt-5-nano-2025-08-07"
          }
        }
      }
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["schemaVersion"]);
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
      systemPrompt: "You are assisting through the organization's proxy."
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

  it("rejects whitespace-only classifier and target strings", () => {
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
          targets: [
            {
              ...validConfig.routes.fast.targets[0],
              model: "\t"
            }
          ]
        }
      }
    });

    expect(classifierResult.success).toBe(false);
    expect(classifierResult.error?.issues[0]?.path).toEqual(["classifier", "model"]);
    expect(providerResult.success).toBe(false);
    expect(providerResult.error?.issues[0]?.path).toEqual(["routes", "fast", "targets", 0, "model"]);
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
          targets: [
            {
              ...validConfig.routes.deep.targets[0],
              model: "\tclaude-opus-4-5\n"
            }
          ]
        }
      }
    });

    expect(classifierResult.success).toBe(false);
    expect(classifierResult.error?.issues[0]?.path).toEqual(["classifier", "model"]);
    expect(providerResult.success).toBe(false);
    expect(providerResult.error?.issues[0]?.path).toEqual(["routes", "deep", "targets", 0, "model"]);
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

  it("rejects invalid targets before runtime", () => {
    const result = routingConfigSchema.safeParse({
      ...validConfig,
      routes: {
        ...validConfig.routes,
        hard: {
          ...validConfig.routes.hard,
          targets: [
            {
              ...validConfig.routes.hard.targets[0],
              effort: "maximum"
            }
          ]
        }
      }
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["routes", "hard", "targets", 0, "effort"]);
  });

  it("keeps provider-only efforts out of classifier config", () => {
    for (const effort of ["max", "ultracode"]) {
      const result = routingConfigSchema.safeParse({
        ...validConfig,
        classifier: {
          ...validConfig.classifier,
          effort
        }
      });

      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(["classifier", "effort"]);
    }
  });

  it("requires each route to define at least one target", () => {
    const result = routingConfigSchema.safeParse({
      ...validConfig,
      routes: {
        ...validConfig.routes,
        fast: {
          description: "No target",
          targets: []
        }
      }
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["routes", "fast", "targets"]);
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
