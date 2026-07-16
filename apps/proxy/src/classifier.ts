import { z } from "zod";
import { performance } from "node:perf_hooks";
import {
  composeClassifierInstructions,
  type LogicalModelClassificationRequest,
  type LogicalModelClassifierConfig,
  type RoutingConfigClassifier
} from "@proxy/schema";

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

const logicalModelClassifierOutputSchema = z.strictObject({
  target_id: z.string().min(1).max(1_024),
  reason_codes: z.array(z.string().min(1).max(100)).min(1).max(20),
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

export type LogicalModelClassificationInput = {
  config: LogicalModelClassifierConfig;
  classifierModel: string;
  request: LogicalModelClassificationRequest;
};

export type LogicalModelClassifierDeployment = {
  deploymentId: string;
  organizationId: string;
  workspaceId: string;
  model: string;
  provider: string;
  providerConnectionId: string;
  bindingId: string;
};

export type LogicalModelClassifierTargetResolver = {
  resolve(deployment: LogicalModelClassifierDeployment, signal?: AbortSignal): Promise<ClassifierTarget>;
};

export type LogicalModelClassificationResult = {
  targetId: string;
  reasonCodes: string[];
  confidence: number;
  attempts: number;
  usage?: Record<string, unknown>;
};

export type LogicalModelClassifier = Pick<LlmClassifier, "classifyLogicalModel">;

export class ClassifierError extends Error {
  constructor(
    message: string,
    readonly usage?: Record<string, unknown>,
    readonly attempts = 0
  ) {
    super(message);
    this.name = "ClassifierError";
  }
}

export class LlmClassifier {
  constructor(
    private readonly config: AppConfig,
    private readonly metrics: MetricsCollector = new NoopMetricsCollector(),
    private readonly logicalModelTargets?: LogicalModelClassifierTargetResolver
  ) {}

  async classify(
    context: RouteContext,
    settings: ClassifierSettings,
    target: ClassifierTarget
  ): Promise<ClassificationResult> {
    return this.runWithRetries(
      settings,
      settings.maxAttempts,
      settings.timeoutMs,
      (signal) => this.callClassifier(context, settings, target, signal)
    );
  }

  async classifyLogicalModel(
    input: LogicalModelClassificationInput,
    deployment: LogicalModelClassifierDeployment
  ): Promise<LogicalModelClassificationResult> {
    if (input.request.candidates.length === 0) {
      throw new ClassifierError("Logical model classifier requires at least one eligible target.");
    }
    if (!this.logicalModelTargets) {
      throw new ClassifierError("Logical model classifier target resolver is unavailable.");
    }
    const metricSettings = {
      providerId: deployment.provider,
      model: input.classifierModel
    };
    const result = await this.runWithRetries(
      metricSettings,
      input.config.maxAttempts,
      input.config.timeoutMs,
      async (signal) => {
        const target = await this.logicalModelTargets!.resolve(deployment, signal);
        signal.throwIfAborted();
        return this.callLogicalModelClassifier(input, target, signal);
      }
    );
    return {
      targetId: result.output.target_id,
      reasonCodes: result.output.reason_codes,
      confidence: result.output.confidence,
      attempts: result.attempts,
      usage: result.usage
    };
  }

  private async callClassifier(
    context: RouteContext,
    settings: ClassifierSettings,
    target: ClassifierTarget,
    signal: AbortSignal
  ): Promise<{ output: ClassifierOutput; usage?: Record<string, unknown> }> {
    const view = classifierView(context, settings.allowRedactedExcerpt);
    const json = await this.request(target, classifierRequest(settings, view), signal);
    const usage = extractUsage(json);
    const parsed = extractStructuredOutput(json);
    const result = classifierOutputSchema.safeParse(parsed);
    if (!result.success) {
      throw new ClassifierError("Classifier returned invalid structured output.", usage);
    }

    return { output: result.data, usage };
  }

  private async callLogicalModelClassifier(
    input: LogicalModelClassificationInput,
    target: ClassifierTarget,
    signal: AbortSignal
  ) {
    const json = await this.request(
      target,
      logicalModelClassifierRequest(input),
      signal
    );
    const usage = extractUsage(json);
    const result = logicalModelClassifierOutputSchema.safeParse(extractStructuredOutput(json));
    if (!result.success || !input.request.candidates.some((candidate) => candidate.targetId === result.data.target_id)) {
      throw new ClassifierError("Classifier returned an invalid logical model target.", usage);
    }
    return { output: result.data, usage };
  }

  private async request(target: ClassifierTarget, body: unknown, signal: AbortSignal) {
    const response = await fetchWithPinnedAddress(providerRequestUrl({
      provider: target.provider,
      endpoint: target.endpoint,
      config: this.config,
      credential: target.credential
    }), {
      method: "POST",
      headers: classifierHeaders(this.config, target),
      body: JSON.stringify(body),
      redirect: providerRequestRedirect({ provider: target.provider, credential: target.credential }),
      signal
    }, providerRequestPinnedAddress({
      provider: target.provider,
      config: this.config,
      credential: target.credential
    }));

    if (!response.ok) throw new ClassifierError(`Classifier HTTP ${response.status}`);
    return response.json();
  }

  private async runWithRetries<Output>(
    settings: Pick<ClassifierSettings, "providerId" | "model">,
    maxAttempts: number,
    timeoutMs: number,
    call: (signal: AbortSignal) => Promise<{ output: Output; usage?: Record<string, unknown> }>
  ) {
    let lastError: unknown;
    let aggregateUsage: Record<string, unknown> | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const startedAtMs = performance.now();
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const deadline = new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new ClassifierError("Classifier attempt timed out."));
          }, timeoutMs);
        });
        const { output, usage } = await Promise.race([call(controller.signal), deadline]);
        aggregateUsage = mergeClassifierUsage(aggregateUsage, usage);
        this.recordClassifierAttempt(settings, startedAtMs, "succeeded", "none");
        this.recordClassifierUsage(settings, usage);
        return { output, attempts: attempt, usage: aggregateUsage };
      } catch (error) {
        lastError = error;
        const usage = error instanceof ClassifierError ? error.usage : undefined;
        aggregateUsage = mergeClassifierUsage(aggregateUsage, usage);
        this.recordClassifierAttempt(settings, startedAtMs, "failed", "classifier");
        this.recordClassifierUsage(settings, usage);
        if (attempt < maxAttempts) {
          this.metrics.incrementCounter("proxy_classifier_retries_total", {
            provider: settings.providerId,
            model: settings.model,
            error_class: "classifier"
          });
        }
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }

    throw new ClassifierError(
      lastError instanceof Error ? lastError.message : "Classifier failed.",
      aggregateUsage,
      maxAttempts
    );
  }

  private recordClassifierAttempt(
    settings: Pick<ClassifierSettings, "providerId" | "model">,
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
    this.metrics.incrementCounter("proxy_classifier_attempts_total", labels);
    this.metrics.observeHistogram("proxy_classifier_duration_seconds", (performance.now() - startedAtMs) / 1000, {
      provider: settings.providerId,
      model: settings.model,
      outcome
    });
  }

  private recordClassifierUsage(
    settings: Pick<ClassifierSettings, "providerId" | "model">,
    usage: Record<string, unknown> | undefined
  ) {
    if (!usage) return;
    const normalized = normalizeUsage(usage);
    const labels = {
      provider: settings.providerId,
      model: settings.model
    };
    this.metrics.incrementCounter("proxy_classifier_tokens_total", { ...labels, usage_kind: "input" }, normalized.inputTokens);
    this.metrics.incrementCounter("proxy_classifier_tokens_total", { ...labels, usage_kind: "cached_input" }, normalized.cachedInputTokens);
    this.metrics.incrementCounter("proxy_classifier_tokens_total", { ...labels, usage_kind: "cache_creation_input" }, normalized.cacheCreationInputTokens);
    this.metrics.incrementCounter("proxy_classifier_tokens_total", { ...labels, usage_kind: "output" }, normalized.outputTokens);
    this.metrics.incrementCounter("proxy_classifier_tokens_total", { ...labels, usage_kind: "reasoning" }, normalized.reasoningTokens);
    this.metrics.incrementCounter("proxy_classifier_tokens_total", { ...labels, usage_kind: "total" }, normalized.totalTokens);
    const cost = usageCostMicros(pricingForProviderModel(this.config.modelCosts, settings.providerId, settings.model), normalized);
    this.metrics.incrementCounter("proxy_classifier_cost_usd_total", {
      ...labels,
      cost_kind: "classifier"
    }, cost.totalCostMicros / 1_000_000);
  }
}

function mergeClassifierUsage(
  aggregate: Record<string, unknown> | undefined,
  attempt: Record<string, unknown> | undefined
) {
  if (!attempt) return aggregate;
  if (!aggregate) return attempt;
  const current = normalizeUsage(aggregate);
  const next = normalizeUsage(attempt);
  return {
    inputTokens: current.inputTokens + next.inputTokens,
    cachedInputTokens: current.cachedInputTokens + next.cachedInputTokens,
    cacheCreationInputTokens: current.cacheCreationInputTokens + next.cacheCreationInputTokens,
    outputTokens: current.outputTokens + next.outputTokens,
    reasoningTokens: current.reasoningTokens + next.reasoningTokens,
    totalTokens: current.totalTokens + next.totalTokens
  };
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

function logicalModelClassifierRequest(input: LogicalModelClassificationInput) {
  const targetIds = input.request.candidates.map((candidate) => candidate.targetId);
  return {
    model: input.classifierModel,
    stream: false,
    instructions: input.config.instructions,
    input: JSON.stringify({
      request: input.request.context,
      targets: input.request.candidates.map((candidate) => ({
        id: candidate.targetId,
        capabilities: candidate.capabilities
      }))
    }),
    text: {
      format: {
        type: "json_schema",
        name: "logical_model_target_selection",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["target_id", "reason_codes", "confidence"],
          properties: {
            target_id: { type: "string", enum: targetIds },
            reason_codes: {
              type: "array",
              items: { type: "string", minLength: 1, maxLength: 100 },
              minItems: 1,
              maxItems: 20
            },
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
