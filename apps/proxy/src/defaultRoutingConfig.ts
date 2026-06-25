import { createHash } from "node:crypto";

import {
  defaultCompressionPolicy,
  routingConfigSchema,
  type RouteName,
  type RoutingConfig
} from "@proxy/schema";

import type { AppConfig } from "./config.js";
import type { ResolvedRoutingConfig } from "./persistence/routingConfig.js";

export class DefaultRoutingConfigResolver {
  constructor(private readonly config: AppConfig) {}

  async resolve(input: { organizationId: string; workspaceId: string }): Promise<ResolvedRoutingConfig> {
    const configId = `${input.organizationId}:routing-config:default`;
    const routingConfig = defaultRoutingConfig(this.config);
    return {
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      configId,
      configName: "Default routing config",
      versionId: `${configId}:v1`,
      version: 1,
      configHash: sha256Hex(JSON.stringify(routingConfig)),
      config: routingConfig,
      cacheTtlUpgrade: false,
      automaticCaching: false,
      toolResultCompressionPolicy: defaultCompressionPolicy(),
      duplicateToolResultReferences: false
    };
  }
}

function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function defaultRoutingConfig(config: AppConfig): RoutingConfig {
  return routingConfigSchema.parse({
    schemaVersion: 3,
    displayName: "Default coding router",
    description: "Seeded default routing config for coding-agent traffic.",
    classifier: {
      providerId: config.classifierProvider,
      model: config.classifierModel,
      effort: "minimal",
      timeoutMs: config.classifierTimeoutMs,
      maxAttempts: config.classifierMaxAttempts,
      allowRedactedExcerpt: config.classifierAllowRedactedExcerpt,
      structuredOutput: {
        mode: "json_schema",
        schemaName: "routing_classifier"
      }
    },
    routes: {
      fast: routeConfig(config, "fast", "Simple shell/status/read-only tasks", "low"),
      balanced: routeConfig(config, "balanced", "Default coding tasks", "medium"),
      hard: routeConfig(config, "hard", "Debugging, multi-file edits, and migrations", "high"),
      deep: routeConfig(config, "deep", "Architecture, system design, security, and storage design", "xhigh")
    },
    limits: {
      maxRoute: "deep",
      fallbackRoute: "hard"
    },
    session: {
      pinInitialRoute: true,
      allowUpgrade: true,
      allowDowngrade: false
    }
  });
}

function routeConfig(
  config: AppConfig,
  route: RouteName,
  description: string,
  effort: "low" | "medium" | "high" | "xhigh"
): RoutingConfig["routes"][RouteName] {
  return {
    description,
    retry: {
      maxAttempts: 2,
      retryableStatusCodes: [429, 500, 502, 503, 504]
    },
    anthropic: {
      deployments: [{
        provider: "anthropic",
        model: modelFor(config, "anthropic", route),
        order: 0,
        weight: 1,
        timeoutMs: 60000,
        output_config: { effort },
        ...(route === "fast"
          ? {}
          : {
              thinking: { type: "adaptive" as const, display: "omitted" as const }
            })
      }]
    },
    openai: {
      deployments: [{
        provider: "openai",
        model: modelFor(config, "openai", route),
        order: 1,
        weight: 1,
        timeoutMs: 60000,
        reasoning: { effort },
        text: { verbosity: route === "fast" || route === "balanced" ? "low" : "medium" }
      }]
    }
  };
}

function modelFor(config: AppConfig, provider: "openai" | "anthropic", route: RouteName) {
  if (provider === "openai") {
    if (route === "fast") return config.openaiFastModel;
    if (route === "balanced") return config.openaiBalancedModel;
    if (route === "hard") return config.openaiHardModel;
    return config.openaiDeepModel;
  }
  if (route === "fast") return config.anthropicFastModel;
  if (route === "balanced") return config.anthropicBalancedModel;
  if (route === "hard") return config.anthropicHardModel;
  return config.anthropicDeepModel;
}
