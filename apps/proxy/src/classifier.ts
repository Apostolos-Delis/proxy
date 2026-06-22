import { z } from "zod";
import { performance } from "node:perf_hooks";
import {
  composeClassifierInstructions,
  type RoutingConfigClassifier
} from "@prompt-proxy/schema";

import type { AppConfig } from "./config.js";
import {
  type MetricsCollector,
  NoopMetricsCollector
} from "./metrics.js";
import { normalizeUsage } from "./persistence/values.js";
import { pricingForProviderModel, usageCostMicros } from "./pricing.js";
import type {
  ClassifierOutput,
  RouteContext,
  UpstreamCredential
} from "./types.js";
import { classifierView } from "./features.js";
import {
  operatorTokenForProvider,
  type ProviderRegistryEndpoint,
  type ProviderRegistryEntry
} from "./persistence/providers.js";
import {
  fetchWithPinnedAddress,
  providerRequestPinnedAddress,
  providerRequestRedirect,
  providerRequestUrl
} from "./upstream.js";
import { isRecord } from "./util.js";

const classifierOutputSchema = z.object({
  complexity: z.enum(["trivial", "simple", "normal", "hard", "deep"]),
  risk: z.array(z.string()),
  recommended_route: z.enum(["fast", "balanced", "hard", "deep"]),
  can_use_fast_model: z.boolean(),
  needs_deep_reasoning: z.boolean(),
  reason_codes: z.array(z.string()).min(1),
  confidence: z.number().min(0).max(1)
});

export type ClassificationResult = {
  output: ClassifierOutput;
  attempts: number;
  usage?: Record<string, unknown>;
};

export type ClassifierSettings = RoutingConfigClassifier;

export type ClassifierTarget = {
  provider: ProviderRegistryEntry;
  endpoint: ProviderRegistryEndpoint;
  credential?: UpstreamCredential;
};

export class ClassifierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClassifierError";
  }
}

export class LlmClassifier {
  constructor(
    private readonly config: AppConfig,
    private readonly metrics: MetricsCollector = new NoopMetricsCollector()
  ) {}

  async classify(
    context: RouteContext,
    settings: ClassifierSettings,
    target: ClassifierTarget
  ): Promise<ClassificationResult> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= settings.maxAttempts; attempt += 1) {
      const startedAtMs = performance.now();
      try {
        const { output, usage } = await this.callClassifier(context, settings, target);
        this.recordClassifierAttempt(settings, startedAtMs, "succeeded", "none");
        this.recordClassifierUsage(settings, usage);
        return { output, attempts: attempt, usage };
      } catch (error) {
        lastError = error;
        this.recordClassifierAttempt(settings, startedAtMs, "failed", "classifier");
        if (attempt < settings.maxAttempts) {
          this.metrics.incrementCounter("prompt_proxy_classifier_retries_total", {
            provider: settings.providerId,
            model: settings.model,
            error_class: "classifier"
          });
        }
      }
    }

    throw new ClassifierError(
      lastError instanceof Error ? lastError.message : "Classifier failed."
    );
  }

  private async callClassifier(
    context: RouteContext,
    settings: ClassifierSettings,
    target: ClassifierTarget
  ): Promise<{ output: ClassifierOutput; usage?: Record<string, unknown> }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), settings.timeoutMs);

    try {
      const view = classifierView(context, settings.allowRedactedExcerpt);
      const response = await fetchWithPinnedAddress(providerRequestUrl({
        provider: target.provider,
        endpoint: target.endpoint,
        config: this.config,
        credential: target.credential
      }), {
        method: "POST",
        headers: classifierHeaders(this.config, target),
        body: JSON.stringify(classifierRequest(settings, view)),
        redirect: providerRequestRedirect({ provider: target.provider, credential: target.credential }),
        signal: controller.signal
      }, providerRequestPinnedAddress({
        provider: target.provider,
        config: this.config,
        credential: target.credential
      }));

      if (!response.ok) {
        throw new ClassifierError(`Classifier HTTP ${response.status}`);
      }

      const json = await response.json();
      const parsed = extractStructuredOutput(json);
      const result = classifierOutputSchema.safeParse(parsed);
      if (!result.success) {
        throw new ClassifierError("Classifier returned invalid structured output.");
      }

      return { output: result.data, usage: extractUsage(json) };
    } finally {
      clearTimeout(timeout);
    }
  }

  private recordClassifierAttempt(
    settings: ClassifierSettings,
    startedAtMs: number,
    outcome: "succeeded" | "failed",
    errorClass: string
  ) {
    const labels = {
      provider: settings.providerId,
      model: settings.model,
      outcome,
      error_class: errorClass
    };
    this.metrics.incrementCounter("prompt_proxy_classifier_attempts_total", labels);
    this.metrics.observeHistogram("prompt_proxy_classifier_duration_seconds", (performance.now() - startedAtMs) / 1000, {
      provider: settings.providerId,
      model: settings.model,
      outcome
    });
  }

  private recordClassifierUsage(settings: ClassifierSettings, usage: Record<string, unknown> | undefined) {
    if (!usage) return;
    const normalized = normalizeUsage(usage);
    const labels = {
      provider: settings.providerId,
      model: settings.model
    };
    this.metrics.incrementCounter("prompt_proxy_classifier_tokens_total", { ...labels, usage_kind: "input" }, normalized.inputTokens);
    this.metrics.incrementCounter("prompt_proxy_classifier_tokens_total", { ...labels, usage_kind: "cached_input" }, normalized.cachedInputTokens);
    this.metrics.incrementCounter("prompt_proxy_classifier_tokens_total", { ...labels, usage_kind: "cache_creation_input" }, normalized.cacheCreationInputTokens);
    this.metrics.incrementCounter("prompt_proxy_classifier_tokens_total", { ...labels, usage_kind: "output" }, normalized.outputTokens);
    this.metrics.incrementCounter("prompt_proxy_classifier_tokens_total", { ...labels, usage_kind: "reasoning" }, normalized.reasoningTokens);
    this.metrics.incrementCounter("prompt_proxy_classifier_tokens_total", { ...labels, usage_kind: "total" }, normalized.totalTokens);
    const cost = usageCostMicros(pricingForProviderModel(this.config.modelCosts, settings.providerId, settings.model), normalized);
    this.metrics.incrementCounter("prompt_proxy_classifier_cost_usd_total", {
      ...labels,
      cost_kind: "classifier"
    }, cost.totalCostMicros / 1_000_000);
  }
}

export function defaultClassifierSettings(config: AppConfig): ClassifierSettings {
  return {
    providerId: config.classifierProvider,
    model: config.classifierModel,
    timeoutMs: config.classifierTimeoutMs,
    maxAttempts: config.classifierMaxAttempts,
    allowRedactedExcerpt: config.classifierAllowRedactedExcerpt,
    structuredOutput: {
      mode: "json_schema",
      schemaName: "route_classification"
    }
  };
}

function classifierHeaders(config: AppConfig, target: ClassifierTarget) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...target.provider.defaultHeaders
  };
  const credential = target.credential?.provider === target.provider.slug ? target.credential : undefined;
  const operatorToken = target.provider.builtin
    ? operatorTokenForProvider(target.provider.slug, config)
    : undefined;
  const token = credential?.token ?? operatorToken;

  if (target.provider.authStyle === "bearer" && token) headers.authorization = `Bearer ${token}`;
  if (target.provider.authStyle === "x-api-key" && token) headers["x-api-key"] = token;
  if (target.provider.authStyle !== "none" && !token) {
    throw new ClassifierError(`Classifier provider ${target.provider.slug} credential is not configured.`);
  }

  return headers;
}

function classifierRequest(settings: ClassifierSettings, view: unknown) {
  const reasoningEffort = normalizeReasoningEffort(
    settings.model,
    settings.effort ?? defaultReasoningEffort(settings.model)
  );
  return {
    model: settings.model,
    stream: false,
    ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
    instructions: composeClassifierInstructions(settings.rules),
    input: JSON.stringify(view),
    text: {
      format: {
        type: "json_schema",
        name: settings.structuredOutput.schemaName ?? "route_classification",
        schema: {
          type: "object",
          additionalProperties: false,
          required: [
            "complexity",
            "risk",
            "recommended_route",
            "can_use_fast_model",
            "needs_deep_reasoning",
            "reason_codes",
            "confidence"
          ],
          properties: {
            complexity: { enum: ["trivial", "simple", "normal", "hard", "deep"] },
            risk: { type: "array", items: { type: "string" } },
            recommended_route: { enum: ["fast", "balanced", "hard", "deep"] },
            can_use_fast_model: { type: "boolean" },
            needs_deep_reasoning: { type: "boolean" },
            reason_codes: { type: "array", items: { type: "string" }, minItems: 1 },
            confidence: { type: "number", minimum: 0, maximum: 1 }
          }
        }
      }
    }
  };
}

// Non-reasoning models reject the reasoning parameter outright, so only
// default to minimal effort for model families known to accept it.
function defaultReasoningEffort(model: string) {
  return /^(gpt-5|o\d)/.test(model) ? ("minimal" as const) : undefined;
}

// Dotted gpt-5.x releases dropped the "minimal" tier in favor of "none";
// sending minimal to them is a hard 400 and the classifier never succeeds.
function normalizeReasoningEffort(model: string, effort?: string) {
  if (effort === "minimal" && model.startsWith("gpt-5.")) return "none";
  return effort;
}

function extractUsage(json: unknown): Record<string, unknown> | undefined {
  if (!isRecord(json) || !isRecord(json.usage)) return undefined;
  return json.usage;
}

function extractStructuredOutput(json: unknown): unknown {
  if (!isRecord(json)) return undefined;
  if (isRecord(json.output_parsed)) return json.output_parsed;
  if (typeof json.output_text === "string") return parseJson(json.output_text);

  const content = findOutputText(json.output);
  return content ? parseJson(content) : undefined;
}

function findOutputText(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findOutputText(item);
      if (found) return found;
    }
  }
  if (isRecord(value)) {
    if (
      (value.type === "output_text" || value.type === "text") &&
      typeof value.text === "string"
    ) return value.text;
    if (Array.isArray(value.content)) return findOutputText(value.content);
    if (Array.isArray(value.output)) return findOutputText(value.output);
  }
  return undefined;
}

function parseJson(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
