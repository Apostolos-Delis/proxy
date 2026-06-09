import { z } from "zod";
import {
  DEFAULT_ROUTING_CLASSIFIER_INSTRUCTIONS,
  type RoutingConfigClassifier
} from "@prompt-proxy/schema";

import type { AppConfig } from "./config.js";
import type { ClassifierOutput, RouteContext } from "./types.js";
import { classifierView } from "./features.js";
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
};

export type ClassifierSettings = RoutingConfigClassifier;

export class ClassifierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClassifierError";
  }
}

export class LlmClassifier {
  constructor(private readonly config: AppConfig) {}

  async classify(
    context: RouteContext,
    settings: ClassifierSettings = defaultClassifierSettings(this.config)
  ): Promise<ClassificationResult> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= settings.maxAttempts; attempt += 1) {
      try {
        const output = await this.callClassifier(context, settings);
        return { output, attempts: attempt };
      } catch (error) {
        lastError = error;
      }
    }

    throw new ClassifierError(
      lastError instanceof Error ? lastError.message : "Classifier failed."
    );
  }

  private async callClassifier(
    context: RouteContext,
    settings: ClassifierSettings
  ): Promise<ClassifierOutput> {
    if (settings.provider !== "openai") {
      throw new ClassifierError(`Classifier provider ${settings.provider} is not supported.`);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), settings.timeoutMs);

    try {
      const baseUrl = this.config.openaiBaseUrl;
      const key = this.config.openaiApiKey;
      const url = `${baseUrl}/responses`;
      const view = classifierView(context, settings.allowRedactedExcerpt);
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key}`
        },
        body: JSON.stringify(classifierRequest(settings, view)),
        signal: controller.signal
      });

      if (!response.ok) {
        throw new ClassifierError(`Classifier HTTP ${response.status}`);
      }

      const json = await response.json();
      const parsed = extractStructuredOutput(json);
      const result = classifierOutputSchema.safeParse(parsed);
      if (!result.success) {
        throw new ClassifierError("Classifier returned invalid structured output.");
      }

      return result.data;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function defaultClassifierSettings(config: AppConfig): ClassifierSettings {
  return {
    provider: config.classifierProvider,
    model: config.classifierModel,
    instructions: DEFAULT_ROUTING_CLASSIFIER_INSTRUCTIONS,
    timeoutMs: config.classifierTimeoutMs,
    maxAttempts: config.classifierMaxAttempts,
    allowRedactedExcerpt: config.classifierAllowRedactedExcerpt,
    structuredOutput: {
      mode: "json_schema",
      schemaName: "route_classification"
    }
  };
}

function classifierRequest(settings: ClassifierSettings, view: unknown) {
  return {
    model: settings.model,
    stream: false,
    instructions: settings.instructions,
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
