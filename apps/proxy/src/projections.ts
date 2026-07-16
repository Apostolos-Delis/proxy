import type { ProxyEvent } from "./events.js";
import { knownSurfaceValue, normalizeUsage, type NormalizedUsage } from "./persistence/values.js";
import type { JsonObject, JsonValue } from "./types.js";
import { isRecord } from "./util.js";

export class ProjectionService {
  usage(events: ProxyEvent[]) {
    const decisions = new Map<string, JsonObject>();
    const starts = new Map<string, string>();
    const streamStarts = new Map<string, string>();
    const requests = [];
    const totals = emptyUsage();
    let selectedCost = 0;
    let baselineCost = 0;

    for (const event of events) {
      if (event.eventType === "routing.decision_recorded") decisions.set(event.scopeId, event.payload as JsonObject);
      if (event.eventType === "provider.request_started") starts.set(event.scopeId, event.createdAt);
      if (event.eventType === "provider.stream_started") streamStarts.set(event.scopeId, event.createdAt);
    }

    for (const event of events) {
      if (!isTerminalProviderEvent(event.eventType)) continue;
      const payload = event.payload as JsonObject;
      const decision = decisions.get(event.scopeId);
      const usage = normalizeEventUsage(payload.usage);
      addUsage(totals, usage);
      const selectedModel = stringValue(payload.selectedModel) ?? stringValue(decision?.selectedModel);
      const surface = knownSurfaceValue(decision?.surface);
      const selected = 0;
      const baseline = 0;
      selectedCost += selected;
      baselineCost += baseline;
      requests.push({
        requestId: event.scopeId,
        surface,
        requestedModel: stringValue(decision?.requestedModel),
        requestedLogicalModel: stringValue(decision?.requestedLogicalModel),
        resolvedLogicalModelId: stringValue(decision?.resolvedLogicalModelId),
        deploymentId: stringValue(decision?.deploymentId),
        providerConnectionId: stringValue(decision?.providerConnectionId),
        selectedModel,
        terminalStatus: terminalStatus(event),
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
    const lowConfidence = events.flatMap((event) => {
      if (event.eventType !== "routing.decision_recorded") return [];
      const payload = event.payload as JsonObject;
      const routerDecision = isRecord(payload.routerDecision) ? payload.routerDecision : undefined;
      const confidence = numberValue(routerDecision?.confidence);
      if (confidence === undefined || confidence >= 0.55) return [];
      return [{
        requestId: event.scopeId,
        confidence,
        requestedLogicalModel: payload.requestedLogicalModel,
        resolvedLogicalModelId: payload.resolvedLogicalModelId,
        deploymentId: payload.deploymentId
      }];
    });
    return {
      cursor: events.length,
      lowConfidence
    };
  }
}

function isTerminalProviderEvent(eventType: string) {
  return eventType === "provider.response_completed" ||
    eventType === "provider.response_failed" ||
    eventType === "provider.response_cancelled";
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

function missingUsage(events: ProxyEvent[]) {
  return events.filter((event) => {
    if (event.eventType !== "provider.response_completed") return false;
    const usage = (event.payload as JsonObject).usage;
    return usage === null || usage === undefined;
  }).map((event) => event.scopeId);
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
