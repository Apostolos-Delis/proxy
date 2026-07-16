import type { AppendEventInput, EventAppender } from "./events.js";
import type { MetricsCollector } from "./metrics.js";
import {
  promptCachePlanEventPayload,
  type PromptCachePlan
} from "./promptCachePlan.js";
import { recordPromptCachePlanMetrics } from "./providerMetrics.js";
import { scheduleObservability } from "./observability.js";
import type { Provider, Surface } from "./types.js";

type Warn = (error: unknown, message: string) => void;

export function observePromptCachePlan(input: {
  events: EventAppender;
  metrics: MetricsCollector;
  warn: Warn;
  tenantId: string;
  workspaceId: string;
  scopeId: string;
  correlationId: string;
  idempotencyKey: string;
  sessionId?: string;
  actor?: AppendEventInput["actor"];
  surface: Surface;
  provider: Provider;
  model: string;
  plan?: PromptCachePlan;
}) {
  const plan = input.plan;
  if (!plan) return;

  try {
    recordPromptCachePlanMetrics(input.metrics, {
      surface: input.surface,
      provider: input.provider,
      model: input.model,
      plan
    });
  } catch (error) {
    input.warn(error, "prompt cache plan metrics record failed");
  }

  scheduleObservability(input.warn, "prompt cache plan event emit", async () => {
    await input.events.append({
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      scopeType: "request",
      scopeId: input.scopeId,
      sessionId: input.sessionId,
      correlationId: input.correlationId,
      idempotencyKey: input.idempotencyKey,
      actor: input.actor,
      producer: "proxy.prompt-cache",
      eventType: "prompt_cache.plan_applied",
      redactionState: "not_applicable",
      payload: promptCachePlanEventPayload({
        surface: input.surface,
        model: input.model,
        plan
      })
    });
  });
}
