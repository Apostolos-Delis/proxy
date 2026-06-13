import { explicitAlias, routeOrder } from "./catalog.js";
import type { AppConfig } from "./config.js";
import type { ProxyEvent } from "./events.js";
import { knownSurfaceValue, normalizeUsage, type NormalizedUsage } from "./persistence/values.js";
import {
  defaultCostBaseline,
  pricingForModel,
  usageCostMicros,
  type ModelPricingTable
} from "./pricing.js";
import type { JsonObject, JsonValue, RouteName, Surface } from "./types.js";
import { isRecord } from "./util.js";

export class ProjectionService {
  constructor(
    private readonly config: AppConfig
  ) {}

  usage(events: ProxyEvent[]) {
    const contexts = new Map<string, JsonObject>();
    const decisions = new Map<string, JsonObject>();
    const starts = new Map<string, string>();
    const streamStarts = new Map<string, string>();
    const requests = [];
    const totals = emptyUsage();
    let selectedCost = 0;
    let baselineCost = 0;

    for (const event of events) {
      if (event.eventType === "routing.context_built") contexts.set(event.scopeId, event.payload as JsonObject);
      if (event.eventType === "routing.decision_recorded") decisions.set(event.scopeId, event.payload as JsonObject);
      if (event.eventType === "provider.request_started") starts.set(event.scopeId, event.createdAt);
      if (event.eventType === "provider.stream_started") streamStarts.set(event.scopeId, event.createdAt);
    }

    for (const event of events) {
      if (!isTerminalProviderEvent(event.eventType)) continue;

      const decision = decisions.get(event.scopeId);
      const context = contexts.get(event.scopeId);
      const usage = normalizeEventUsage((event.payload as JsonObject).usage);
      addUsage(totals, usage);

      const selectedModel = stringValue((event.payload as JsonObject).selectedModel);
      const surface = knownSurfaceValue(decision?.surface);
      const requestedModel = stringValue(decision?.requestedModel);
      const finalRoute = stringValue(decision?.finalRoute) as RouteName | undefined;
      const selected = estimateCost(selectedModel, usage, this.config.modelCosts);
      const baseline = estimateCost(
        baselineModel(surface, requestedModel, selectedModel),
        usage,
        this.config.modelCosts
      );
      selectedCost += selected;
      baselineCost += baseline;

      requests.push({
        requestId: event.scopeId,
        surface,
        requestedModel,
        finalRoute,
        selectedModel,
        terminalStatus: terminalStatus(event),
        inputChars: numberValue(context?.inputChars),
        usage,
        latencyMs: elapsedMs(starts.get(event.scopeId), event.createdAt),
        timeToFirstByteMs: elapsedMs(starts.get(event.scopeId), streamStarts.get(event.scopeId)),
        selectedCost: selected,
        baselineCost: baseline,
        savings: baseline - selected
      });
    }

    return {
      cursor: events.length,
      totals,
      cost: {
        selected: selectedCost,
        baseline: baselineCost,
        savings: baselineCost - selectedCost,
        classifier: 0
      },
      missingUsageRequestIds: missingUsage(events),
      requests
    };
  }

  routeQuality(events: ProxyEvent[]) {
    const contexts = new Map<string, JsonObject>();
    const terminals = new Map<string, string>();
    const cheaperLikelyWouldWork = [];
    const cheapCausedRetriesOrRepairs = [];
    const lowConfidence = [];

    for (const event of events) {
      if (event.eventType === "routing.context_built") contexts.set(event.scopeId, event.payload as JsonObject);
      if (event.eventType === "provider.response_failed") terminals.set(event.scopeId, "failed");
      if (event.eventType === "provider.response_cancelled") terminals.set(event.scopeId, "cancelled");
    }

    for (const event of events) {
      if (event.eventType === "routing.decision_recorded") {
        const payload = event.payload as JsonObject;
        const finalRoute = stringValue(payload.finalRoute) as RouteName | undefined;
        const classifier = isRecord(payload.classifier) ? payload.classifier : undefined;
        const confidence = numberValue(classifier?.confidence);
        const context = contexts.get(event.scopeId);
        const toolCount = numberValue(context?.toolCount);
        const estimatedTokens = numberValue(context?.estimatedInputTokens);

        if (confidence !== undefined && confidence < this.config.routeQualityLowConfidenceThreshold) {
          lowConfidence.push({
            requestId: event.scopeId,
            confidence,
            finalRoute,
            requestedModel: payload.requestedModel
          });
        }

        if (
          finalRoute &&
          routeIndex(finalRoute) > routeIndex("fast") &&
          confidence !== undefined &&
          confidence >= 0.8 &&
          toolCount === 0 &&
          estimatedTokens !== undefined &&
          estimatedTokens < 1000
        ) {
          cheaperLikelyWouldWork.push({
            requestId: event.scopeId,
            finalRoute,
            confidence,
            estimatedTokens
          });
        }

        if (
          finalRoute &&
          routeIndex(finalRoute) <= routeIndex("balanced") &&
          terminals.get(event.scopeId) === "failed"
        ) {
          cheapCausedRetriesOrRepairs.push({
            requestId: event.scopeId,
            finalRoute,
            reason: "cheap_route_failed"
          });
        }
      }

      if (event.eventType === "session.route_memory_recorded") {
        const payload = event.payload as JsonObject;
        if (
          payload.action === "upgraded" &&
          stringValue(payload.previousRoute) &&
          routeIndex(stringValue(payload.previousRoute) as RouteName) <= routeIndex("balanced")
        ) {
          cheapCausedRetriesOrRepairs.push({
            sessionId: payload.sessionId,
            previousRoute: payload.previousRoute,
            currentRoute: payload.currentRoute,
            reason: "session_upgraded_after_cheaper_route"
          });
        }
      }
    }

    return {
      cursor: events.length,
      cheaperLikelyWouldWork,
      cheapCausedRetriesOrRepairs,
      lowConfidence
    };
  }
}

function isTerminalProviderEvent(eventType: string) {
  return (
    eventType === "provider.response_completed" ||
    eventType === "provider.response_failed" ||
    eventType === "provider.response_cancelled"
  );
}

function terminalStatus(event: ProxyEvent) {
  const payloadStatus = (event.payload as JsonObject).terminalStatus;
  if (payloadStatus === "completed" || payloadStatus === "failed" || payloadStatus === "cancelled") {
    return payloadStatus;
  }
  if (event.eventType === "provider.response_completed") return "completed";
  if (event.eventType === "provider.response_cancelled") return "cancelled";
  return "failed";
}

function normalizeEventUsage(value: JsonValue | undefined): NormalizedUsage {
  return normalizeUsage(isRecord(value) ? value : {});
}

function emptyUsage(): NormalizedUsage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0
  };
}

function addUsage(target: NormalizedUsage, source: NormalizedUsage) {
  target.inputTokens += source.inputTokens;
  target.cachedInputTokens += source.cachedInputTokens;
  target.cacheCreationInputTokens += source.cacheCreationInputTokens;
  target.outputTokens += source.outputTokens;
  target.reasoningTokens += source.reasoningTokens;
  target.totalTokens += source.totalTokens;
}

function estimateCost(model: string | undefined, usage: NormalizedUsage, pricing: ModelPricingTable) {
  if (!model) return 0;
  return usageCostMicros(pricingForModel(pricing, model), usage).totalCostMicros / 1_000_000;
}

// No-database mode has no organization settings, so the baseline is always
// the default counterfactual.
function baselineModel(
  surface: Surface | undefined,
  requestedModel: string | undefined,
  selectedModel: string | undefined
) {
  if (!surface) return undefined;
  const route = requestedModel ? explicitAlias(surface, requestedModel) : undefined;
  if (route) return selectedModel;
  switch (surface) {
    case "openai-responses":
      return defaultCostBaseline["openai-responses"];
    case "openai-chat":
      return defaultCostBaseline["openai-chat"];
    case "anthropic-messages":
      return defaultCostBaseline["anthropic-messages"];
  }
}

function missingUsage(events: ProxyEvent[]) {
  return events
    .filter((event) => {
      if (event.eventType !== "provider.response_completed") return false;
      const usage = (event.payload as JsonObject).usage;
      return usage === null || usage === undefined;
    })
    .map((event) => event.scopeId);
}

function elapsedMs(start: string | undefined, end: string | undefined) {
  if (!start || !end) return undefined;
  return new Date(end).getTime() - new Date(start).getTime();
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function routeIndex(route: RouteName) {
  return routeOrder.indexOf(route);
}
