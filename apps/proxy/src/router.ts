import {
  modelForRoute,
  nearestReasoningEffort,
  routeOrder,
  routes,
  supportsSurface
} from "./catalog.js";
import type { ModelCatalog } from "./catalog.js";
import { defaultClassifierSettings } from "./classifier.js";
import type { ClassificationResult, ClassifierSettings, LlmClassifier } from "./classifier.js";
import { jsonPayload, type EventService } from "./events.js";
import type { AppConfig } from "./config.js";
import type { BudgetResult, BudgetService, SessionRouteStore } from "./policy.js";
import type {
  JsonObject,
  Provider,
  ProviderEffort,
  RouteContext,
  RouteDecision,
  RouteName,
  RoutingConfigSelection,
  RoutingConfigSnapshot,
  SelectedRouteSettings,
  Verbosity
} from "./types.js";
import type { AnthropicEffort, RoutingConfig } from "@prompt-proxy/schema";

const classifierFailureFallbackRoute: RouteName = "balanced";
const classificationCacheTtlMs = 5 * 60 * 1000;
const classificationCacheMaxEntries = 500;

type ResolvedRouteSettings = {
  selectedModel: string;
  providerSettings: SelectedRouteSettings;
  reasoningEffort?: ProviderEffort;
  verbosity?: Verbosity;
  provider: SelectedRouteSettings["provider"];
};

function settingsForSurface(
  selected: SelectedRouteSettings,
  surface: RouteContext["surface"]
): ResolvedRouteSettings | undefined {
  if (surface === "openai-responses" && selected.provider === "openai") {
    return {
      selectedModel: selected.model,
      provider: "openai",
      reasoningEffort: selected.openai.reasoning?.effort,
      verbosity: selected.openai.text?.verbosity,
      providerSettings: selected
    };
  }
  if (surface === "anthropic-messages" && selected.provider === "anthropic") {
    return {
      selectedModel: selected.model,
      provider: "anthropic",
      reasoningEffort: selected.anthropic.output_config?.effort,
      providerSettings: selected
    };
  }
  return undefined;
}

export class RoutingService {
  private readonly classificationCache = new Map<
    string,
    { result: ClassificationResult; expiresAt: number }
  >();

  constructor(
    private readonly config: AppConfig,
    private readonly classifier: LlmClassifier,
    private readonly events: EventService,
    private readonly modelCatalog: ModelCatalog,
    private readonly budget: BudgetService,
    private readonly sessions: SessionRouteStore
  ) {}

  async decide(input: {
    requestId: string;
    context: RouteContext;
    body: unknown;
    idempotencyKey: string;
    routingConfig?: RoutingConfigSelection;
  }): Promise<RouteDecision> {
    const { requestId, context, idempotencyKey, routingConfig } = input;
    const routingConfigSnapshot = routingConfig?.snapshot;

    await this.events.append({
      scopeType: "request",
      scopeId: requestId,
      correlationId: requestId,
      idempotencyKey,
      producer: "prompt-proxy.routing",
      eventType: "routing.context_built",
      payload: {
        surface: context.surface,
        requestedModel: context.requestedModel,
        inputHash: context.inputHash,
        inputChars: context.inputChars,
        estimatedInputTokens: context.estimatedInputTokens,
        routingInputSource: context.routingInputSource,
        routingInputHash: context.routingInputHash,
        routingInputChars: context.routingInputChars,
        routingEstimatedInputTokens: context.routingEstimatedInputTokens,
        hasTools: context.hasTools,
        toolCount: context.toolCount,
        hasPreviousResponseId: context.hasPreviousResponseId,
        hasImages: context.hasImages,
        extractedHints: context.extractedHints,
        routingExtractedHints: context.routingExtractedHints,
        routingConfig: routingConfigSnapshot ? jsonPayload(routingConfigSnapshot) : null
      }
    });

    const preBudget = this.budget.checkBeforeClassification(context);
    await this.appendBudgetEvents(requestId, idempotencyKey, preBudget);
    if (preBudget.rejected) {
      const rejected = this.reject(context, preBudget.rejected.reason, preBudget.checks, 429);
      await this.recordDecision(requestId, idempotencyKey, rejected);
      return rejected;
    }

    const explicit = context.explicitAlias;
    let classification: ClassificationResult | undefined;
    let requestedRoute: RouteName;
    let classifierFailed = false;
    const classifierSettings = routingConfig?.config.classifier ?? defaultClassifierSettings(this.config);
    if (explicit) {
      requestedRoute = explicit;
    } else {
      const cacheKey = context.organizationId
        ? classificationCacheKey(context.organizationId, context, routingConfigSnapshot)
        : undefined;
      const cached = cacheKey ? this.cachedClassification(cacheKey) : undefined;
      if (cached) {
        classification = cached;
        requestedRoute = cached.output.recommended_route;
        await this.appendClassificationRecorded(
          requestId,
          idempotencyKey,
          classifierSettings,
          cached,
          routingConfigSnapshot,
          { cached: true }
        );
      } else {
        try {
          classification = await this.classify(
            requestId,
            context,
            idempotencyKey,
            classifierSettings,
            routingConfigSnapshot
          );
          requestedRoute = classification.output.recommended_route;
          if (cacheKey) this.storeClassification(cacheKey, classification);
        } catch {
          classifierFailed = true;
          requestedRoute = classifierFailureFallbackRoute;
        }
      }
    }

    let decision = await this.resolveRoute(
      context,
      requestedRoute,
      classification,
      routingConfig,
      classifierSettings
    );
    if (classifierFailed) {
      if (decision.outcome === "reject" && decision.error === "route_not_available_for_surface") {
        for (const route of routeOrder) {
          if (route === requestedRoute) continue;
          const candidate = await this.resolveRoute(context, route, classification, routingConfig, classifierSettings);
          if (candidate.outcome === "route") {
            decision = candidate;
            break;
          }
        }
      }
      if (decision.outcome === "route") {
        decision.guardrailActions.push("classifier_failure_fallback");
        decision.reasonCodes = ["classifier_failure_fallback"];
      }
    }
    if (decision.outcome === "route" && decision.finalRoute) {
      const postBudget = this.budget.checkDecision(context, decision.finalRoute);
      decision.budgetChecks = [...preBudget.checks, ...postBudget.checks];
      await this.appendBudgetEvents(requestId, idempotencyKey, postBudget);
      if (postBudget.rejected) {
        const rejected = this.reject(context, postBudget.rejected.reason, decision.budgetChecks, 429);
        await this.recordDecision(requestId, idempotencyKey, rejected);
        return rejected;
      }
    }

    if (decision.session) {
      this.sessions.commit({
        sessionKey: decision.session.sessionKey,
        sessionId: decision.session.sessionId,
        userId: decision.session.userId,
        teamId: decision.session.teamId,
        previousRoute: decision.session.previousRoute,
        currentRoute: decision.session.currentRoute,
        selectedRoute: decision.session.currentRoute,
        pin: decision.session.pin,
        action: decision.session.action
      });
      await this.events.append({
        tenantId: context.organizationId,
        workspaceId: context.workspaceId,
        scopeType: "session",
        scopeId: decision.session.sessionKey,
        sessionId: decision.session.sessionId,
        correlationId: requestId,
        idempotencyKey,
        producer: "prompt-proxy.session",
        eventType: "session.route_memory_recorded",
        payload: jsonPayload({
          ...decision.session,
          surface: context.surface
        }) as JsonObject
      });
    }

    await this.recordDecision(requestId, idempotencyKey, decision);

    return decision;
  }

  tokenCountDecision(context: RouteContext, routingConfig?: RoutingConfigSelection): RouteDecision {
    let finalRoute = context.explicitAlias ?? "hard";
    const guardrailActions: string[] = [];
    const routingConfigSnapshot = routingConfig?.snapshot;

    if (!routingConfig) {
      let model = modelForRoute(this.modelCatalog, finalRoute, context.surface);

      if (!supportsSurface(model, context.surface)) {
        const compatible = routeOrder.find((route) =>
          supportsSurface(modelForRoute(this.modelCatalog, route, context.surface), context.surface)
        );
        if (!compatible) return this.reject(context, "no_compatible_route");
        finalRoute = compatible;
        model = modelForRoute(this.modelCatalog, finalRoute, context.surface);
        guardrailActions.push("surface_compatibility_escalated");
      }
    }

    const routeSettings = this.resolveProviderSettings(context, finalRoute, routingConfig?.config);
    if (!routeSettings) return this.reject(context, "route_not_available_for_surface");

    return {
      outcome: "route",
      surface: context.surface,
      requestedModel: context.requestedModel,
      classifierRoute: finalRoute,
      finalRoute,
      selectedModel: routeSettings.selectedModel,
      provider: routeSettings.provider,
      reasoningEffort: routeSettings.reasoningEffort,
      verbosity: routeSettings.verbosity,
      providerSettings: routeSettings.providerSettings,
      guardrailActions,
      reasonCodes: ["token_count_model_resolution"],
      routingConfig: routingConfigSnapshot,
      policyVersion: "2026-06-08"
    };
  }

  private async classify(
    requestId: string,
    context: RouteContext,
    idempotencyKey: string,
    classifierSettings: ClassifierSettings,
    routingConfig?: RoutingConfigSnapshot
  ) {
    try {
      const result = await this.classifier.classify(context, classifierSettings);
      await this.appendClassificationRecorded(
        requestId,
        idempotencyKey,
        classifierSettings,
        result,
        routingConfig,
        { cached: false }
      );
      return result;
    } catch (error) {
      await this.events.append({
        scopeType: "request",
        scopeId: requestId,
        correlationId: requestId,
        idempotencyKey,
        producer: "prompt-proxy.classifier",
        eventType: "routing.classification_failed",
        payload: {
          model: classifierSettings.model,
          error: error instanceof Error ? error.message : "Classifier failed.",
          routingConfig: routingConfig ? jsonPayload(routingConfig) : null
        }
      });
      throw error;
    }
  }

  private async appendClassificationRecorded(
    requestId: string,
    idempotencyKey: string,
    classifierSettings: ClassifierSettings,
    result: ClassificationResult,
    routingConfig: RoutingConfigSnapshot | undefined,
    options: { cached: boolean }
  ) {
    await this.events.append({
      scopeType: "request",
      scopeId: requestId,
      correlationId: requestId,
      idempotencyKey,
      producer: "prompt-proxy.classifier",
      eventType: "routing.classification_recorded",
      payload: {
        model: classifierSettings.model,
        attempts: options.cached ? 0 : result.attempts,
        cached: options.cached,
        confidence: result.output.confidence,
        recommendedRoute: result.output.recommended_route,
        reasonCodes: result.output.reason_codes,
        risk: result.output.risk,
        routingConfig: routingConfig ? jsonPayload(routingConfig) : null
      },
      metadata: {
        contentMode: classifierSettings.allowRedactedExcerpt
          ? "redacted_excerpt"
          : "features_only",
        redactionState: "redacted",
        provider: classifierSettings.provider
      }
    });
  }

  private cachedClassification(key: string) {
    const entry = this.classificationCache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.classificationCache.delete(key);
      return undefined;
    }
    // Re-insert so eviction order tracks recency of use, not just insertion.
    this.classificationCache.delete(key);
    this.classificationCache.set(key, entry);
    return entry.result;
  }

  private storeClassification(key: string, result: ClassificationResult) {
    if (this.classificationCache.size >= classificationCacheMaxEntries) {
      const oldest = this.classificationCache.keys().next().value;
      if (oldest !== undefined) this.classificationCache.delete(oldest);
    }
    this.classificationCache.set(key, {
      result,
      expiresAt: Date.now() + classificationCacheTtlMs
    });
  }

  private async resolveRoute(
    context: RouteContext,
    classifierRoute: RouteName,
    classification?: ClassificationResult,
    routingConfig?: RoutingConfigSelection,
    classifierSettings: ClassifierSettings = defaultClassifierSettings(this.config)
  ): Promise<RouteDecision> {
    let finalRoute = classifierRoute;
    const guardrailActions: string[] = [];
    const routingConfigSnapshot = routingConfig?.snapshot;
    if (classification?.output.needs_deep_reasoning && finalRoute !== "deep") {
      finalRoute = "deep";
      guardrailActions.push("classifier_deep_reasoning_escalated");
    }
    if (classification && !classification.output.can_use_fast_model && finalRoute === "fast") {
      finalRoute = "balanced";
      guardrailActions.push("classifier_fast_route_disallowed");
    }

    if (!routingConfig) {
      let model = modelForRoute(this.modelCatalog, finalRoute, context.surface);

      if (!supportsSurface(model, context.surface)) {
        const compatible = routeOrder.find((route) =>
          supportsSurface(modelForRoute(this.modelCatalog, route, context.surface), context.surface)
        );
        if (!compatible) return this.reject(context, "no_compatible_route");
        finalRoute = compatible;
        model = modelForRoute(this.modelCatalog, finalRoute, context.surface);
        guardrailActions.push("surface_compatibility_escalated");
      }

      if (context.hasTools && !model.supportsTools) {
        const compatible = routeOrder.find(
          (route) => modelForRoute(this.modelCatalog, route, context.surface).supportsTools
        );
        if (!compatible) return this.reject(context, "no_tool_compatible_route");
        finalRoute = compatible;
        guardrailActions.push("tool_compatibility_escalated");
      }
    }

    const session = await this.sessions.plan(context, finalRoute);
    if (session) {
      finalRoute = session.selectedRoute;
      if (session.action === "kept") guardrailActions.push("session_route_kept");
      if (session.action === "upgraded") guardrailActions.push("session_route_upgraded");
      if (session.action === "explicit_override") guardrailActions.push("session_explicit_route_override");
    }

    // Reuse the session's pinned provider settings on kept routes so the
    // upstream request shape stays byte-stable and provider prompt caches
    // survive routing-config publishes mid-session.
    let pinnedRouteSettings: ResolvedRouteSettings | undefined;
    let invalidatedPin: { provider: Provider; routingConfigVersionId?: string } | undefined;
    if (session?.action === "kept" && session.pin) {
      pinnedRouteSettings = settingsForSurface(session.pin.settings, context.surface);
      if (pinnedRouteSettings) {
        guardrailActions.push("session_settings_pinned");
      } else {
        guardrailActions.push("session_pin_invalidated");
        invalidatedPin = {
          provider: session.pin.settings.provider,
          routingConfigVersionId: session.pin.routingConfigVersionId
        };
      }
    }

    const routeSettings =
      pinnedRouteSettings ?? this.resolveProviderSettings(context, finalRoute, routingConfig?.config);
    if (!routeSettings) return this.reject(context, "route_not_available_for_surface");

    let sessionPin: NonNullable<RouteDecision["session"]>["pin"];
    if (session) {
      sessionPin = pinnedRouteSettings && session.pin
        ? session.pin
        : {
            settings: routeSettings.providerSettings,
            routingConfigVersionId: routingConfig?.snapshot.versionId
          };
    }

    return {
      outcome: "route",
      surface: context.surface,
      requestedModel: context.requestedModel,
      classifierRoute,
      finalRoute,
      selectedModel: routeSettings.selectedModel,
      provider: routeSettings.provider,
      reasoningEffort: routeSettings.reasoningEffort,
      verbosity: routeSettings.verbosity,
      providerSettings: routeSettings.providerSettings,
      guardrailActions,
      reasonCodes: classification?.output.reason_codes ?? [`alias_${finalRoute}`],
      budgetChecks: [],
      session: session
        ? {
            sessionKey: session.sessionKey,
            sessionId: session.sessionId,
            userId: session.userId,
            teamId: session.teamId,
            previousRoute: session.previousRoute,
            currentRoute: session.currentRoute,
            pin: sessionPin,
            invalidatedPin,
            action: session.action
          }
        : undefined,
      classifier: classification
        ? {
            provider: classifierSettings.provider,
            model: classifierSettings.model,
            attempts: classification.attempts,
            confidence: classification.output.confidence,
            recommendedRoute: classification.output.recommended_route,
            routingConfigId: routingConfigSnapshot?.configId,
            routingConfigVersionId: routingConfigSnapshot?.versionId,
            routingConfigHash: routingConfigSnapshot?.configHash
          }
        : undefined,
      routingConfig: routingConfigSnapshot,
      policyVersion: "2026-06-08"
    };
  }

  private resolveProviderSettings(
    context: RouteContext,
    route: RouteName,
    routingConfig?: RoutingConfig
  ): ResolvedRouteSettings | undefined {
    if (routingConfig) {
      const routeConfig = routingConfig.routes[route];
      if (context.surface === "openai-responses") {
        if (!routeConfig.openai) return undefined;
        return settingsForSurface(
          { provider: "openai", model: routeConfig.openai.model, openai: routeConfig.openai },
          context.surface
        );
      }
      if (!routeConfig.anthropic) return undefined;
      return settingsForSurface(
        { provider: "anthropic", model: routeConfig.anthropic.model, anthropic: routeConfig.anthropic },
        context.surface
      );
    }

    const model = modelForRoute(this.modelCatalog, route, context.surface);
    const routeConfig = routes[route];
    const effort = nearestReasoningEffort(
      routeConfig.reasoningEffort,
      model.supportedReasoningEfforts
    );
    const anthropicEffort: AnthropicEffort = effort === "minimal" ? "low" : effort;
    const providerSettings = context.surface === "openai-responses"
      ? {
          provider: "openai" as const,
          model: model.upstreamModel,
          openai: {
            model: model.upstreamModel,
            reasoning: { effort },
            text: { verbosity: routeConfig.verbosity }
          }
        }
      : {
          provider: "anthropic" as const,
          model: model.upstreamModel,
          anthropic: {
            model: model.upstreamModel,
            thinking: { type: "adaptive" as const },
            output_config: { effort: anthropicEffort }
          }
        };
    return {
      selectedModel: model.upstreamModel,
      provider: model.provider,
      reasoningEffort: context.surface === "openai-responses" ? effort : anthropicEffort,
      verbosity: routeConfig.verbosity,
      providerSettings
    };
  }

  private async appendBudgetEvents(
    requestId: string,
    idempotencyKey: string,
    result: BudgetResult
  ) {
    if (result.checks.length === 0) return;
    await this.events.append({
      scopeType: "request",
      scopeId: requestId,
      correlationId: requestId,
      idempotencyKey,
      producer: "prompt-proxy.budget",
      eventType: "budget.checked",
      payload: {
        checks: jsonPayload(result.checks)
      }
    });
    for (const check of result.checks) {
      if (check.status !== "warning") continue;
      await this.events.append({
        scopeType: "request",
        scopeId: requestId,
        correlationId: requestId,
        idempotencyKey,
        producer: "prompt-proxy.budget",
        eventType: "budget.warning_emitted",
        payload: jsonPayload(check) as JsonObject
      });
    }
  }

  private async recordDecision(
    requestId: string,
    idempotencyKey: string,
    decision: RouteDecision
  ) {
    const payload = { ...decision };
    delete payload.providerSettings;
    await this.events.append({
      scopeType: "request",
      scopeId: requestId,
      correlationId: requestId,
      idempotencyKey,
      producer: "prompt-proxy.routing",
      eventType: "routing.decision_recorded",
      payload: jsonPayload(payload) as JsonObject
    });
  }

  private reject(
    context: RouteContext,
    error: string,
    budgetChecks: RouteDecision["budgetChecks"] = [],
    errorStatus = 400
  ): RouteDecision {
    return {
      outcome: "reject",
      surface: context.surface,
      requestedModel: context.requestedModel,
      guardrailActions: [],
      reasonCodes: [error],
      budgetChecks,
      policyVersion: "2026-06-08",
      error,
      errorStatus
    };
  }
}

// Must cover every context field that feeds classifierView, or distinct
// classifier inputs would share a cache entry.
function classificationCacheKey(
  organizationId: string,
  context: RouteContext,
  snapshot?: RoutingConfigSnapshot
) {
  return [
    organizationId,
    context.userId ?? "",
    context.teamId ?? "",
    context.surface,
    context.requestedModel,
    context.inputHash,
    context.hasTools,
    context.toolCount,
    context.hasImages,
    context.hasPreviousResponseId,
    snapshot?.configHash ?? "default"
  ].join("|");
}
