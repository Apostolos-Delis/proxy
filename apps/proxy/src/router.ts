import {
  TRANSLATABLE_DIALECT_PAIRS,
  harnessCompatibilityForTarget,
  type HarnessCompatibilityProfileId,
  type RoutingConfig,
  type RouteTarget
} from "@prompt-proxy/schema";

import {
  anthropicEffortForModel,
  nearestReasoningEffort,
  reasoningEffortsFromCapabilities,
  routeOrder
} from "./catalog.js";
import { ClassifierError, defaultClassifierSettings } from "./classifier.js";
import type { ClassificationResult, ClassifierSettings, ClassifierTarget, LlmClassifier } from "./classifier.js";
import { hasUserSignal } from "./features.js";
import { jsonPayload, type EventService } from "./events.js";
import type { AppConfig } from "./config.js";
import {
  type MetricsCollector,
  NoopMetricsCollector
} from "./metrics.js";
import {
  ProviderRegistryError,
  providerEndpointForDialect,
  type ProviderRegistryEntry,
  type ProviderRegistryResolver
} from "./persistence/providers.js";
import { providerHealthTargetKey, type ProviderHealthTarget } from "./persistence/providerHealth.js";
import { capRoute, checkBeforeClassification, checkDecision, type SessionRouteStore } from "./policy.js";
import { buildRouteExecutionPlan, type TargetAvailability } from "./routeExecutionPlan.js";
import { translators, translationTag } from "./translators/index.js";
import type {
  Dialect,
  JsonObject,
  Provider,
  ProviderEffort,
  ProviderHealthSkip,
  RouteContext,
  RouteDecision,
  RouteName,
  RoutingConfigSelection,
  RoutingConfigSnapshot,
  SelectedRouteSettings,
  UpstreamCredential,
  Verbosity
} from "./types.js";

const classifierFailureFallbackRoute: RouteName = "balanced";
const classificationCacheTtlMs = 5 * 60 * 1000;
const classificationCacheMaxEntries = 500;

type ResolvedRouteSettings = {
  selectedModel: string;
  providerSettings: SelectedRouteSettings;
  reasoningEffort?: ProviderEffort;
  verbosity?: Verbosity;
  provider: Provider;
};

type ProviderCredentialResolver = {
  resolveForRequest(input: {
    organizationId: string;
    workspaceId?: string;
    apiKeyId?: string;
    provider: Provider;
  }): Promise<UpstreamCredential | undefined>;
};

type ProviderHealthReader = {
  skipsForTargets(input: {
    organizationId: string;
    targets: ProviderHealthTarget[];
    now?: Date;
  }): Promise<Map<string, ProviderHealthSkip>>;
};

function routeSettings(selected: SelectedRouteSettings, supportedEfforts?: ProviderEffort[]): ResolvedRouteSettings {
  const effort = effectiveEffort(selected, supportedEfforts);
  const providerSettings = { ...selected };
  if (effort) providerSettings.effort = effort;
  else delete providerSettings.effort;
  return {
    selectedModel: selected.model,
    provider: selected.providerId,
    reasoningEffort: effort,
    verbosity: selected.dialect === "openai-responses" ? selected.verbosity : undefined,
    providerSettings
  };
}

function effectiveEffort(selected: SelectedRouteSettings, supportedEfforts?: ProviderEffort[]): ProviderEffort | undefined {
  if (!selected.effort) return undefined;
  if (selected.dialect === "anthropic-messages" && selected.thinking?.type !== "adaptive") {
    return undefined;
  }
  if (selected.dialect === "anthropic-messages") {
    return anthropicEffortForModel(selected.model, selected.effort);
  }
  if (supportedEfforts !== undefined) {
    if (supportedEfforts.length === 0) return undefined;
    return nearestReasoningEffort(selected.effort, supportedEfforts) ?? selected.effort;
  }
  const efforts = defaultSupportedEfforts(selected.dialect);
  return nearestReasoningEffort(selected.effort, efforts) ?? selected.effort;
}

function defaultSupportedEfforts(dialect: Dialect): ProviderEffort[] {
  if (dialect === "anthropic-messages") return ["low", "medium", "high", "xhigh", "max", "ultracode"];
  return ["minimal", "low", "medium", "high", "xhigh", "max", "ultracode"];
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
    private readonly sessions: SessionRouteStore,
    private readonly providerRegistry: ProviderRegistryResolver,
    private readonly credentials?: ProviderCredentialResolver,
    private readonly providerHealth?: ProviderHealthReader,
    private readonly metrics: MetricsCollector = new NoopMetricsCollector()
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
    const compressionPolicy = routingConfig?.compressionPolicy;

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
        transport: context.transport ?? "http",
        harness: context.harness ?? null,
        harnessProfileId: context.harnessProfileId ?? null,
        hasTools: context.hasTools,
        toolCount: context.toolCount,
        hasPreviousResponseId: context.hasPreviousResponseId,
        hasImages: context.hasImages,
        extractedHints: context.extractedHints,
        routingExtractedHints: context.routingExtractedHints,
        routingConfig: routingConfigSnapshot ? jsonPayload(routingConfigSnapshot) : null,
        compressionPolicy: compressionPolicy ? jsonPayload(compressionPolicy) : null
      }
    });

    const preBudget = checkBeforeClassification(context, routingConfig?.config.limits);
    if (preBudget.rejected) {
      const rejected = this.reject(context, preBudget.rejected.reason, preBudget.checks, 429);
      rejected.compressionPolicy = compressionPolicy;
      await this.recordDecision(requestId, idempotencyKey, rejected);
      return rejected;
    }

    const explicit = context.explicitAlias;
    let classification: ClassificationResult | undefined;
    let requestedRoute: RouteName;
    let classifierFailed = false;
    let skipReason: "session_route_ceiling" | "session_route_no_user_signal" | undefined;
    const classifierSettings = routingConfig?.config.classifier ?? defaultClassifierSettings(this.config);
    const ceilingRoute = capRoute(
      routeOrder[routeOrder.length - 1],
      routingConfig?.config.limits.maxRoute
    );
    const sessionRoute = explicit ? undefined : await this.sessions.peek(context);
    if (explicit) {
      requestedRoute = explicit;
    } else if (atOrAbove(sessionRoute?.route, ceilingRoute) && !sessionRoute?.soft) {
      // Session memory never downgrades and auto routes are capped at the
      // config ceiling, so memory at or above it already fixes the decision —
      // skip the classifier call instead of spending its latency and tokens.
      skipReason = "session_route_ceiling";
      requestedRoute = ceilingRoute;
    } else if (sessionRoute && !hasUserSignal(context)) {
      skipReason = "session_route_no_user_signal";
      requestedRoute = sessionRoute.route;
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
          requestedRoute = sessionRoute?.route
            ?? routingConfig?.config.limits.fallbackRoute
            ?? classifierFailureFallbackRoute;
        }
      }
    }

    const floorSignal = hasUserSignal(context) && !classifierFailed && !skipReason;
    let decision = await this.resolveRoute(
      context,
      requestedRoute,
      classification,
      routingConfig,
      classifierSettings,
      floorSignal
    );
    if (classifierFailed) {
      if (decision.outcome === "reject" && decision.error === "route_not_available_for_surface") {
        for (const route of routeOrder) {
          // Candidates above the ceiling clamp back to it, and the ceiling is
          // itself a candidate.
          if (route === requestedRoute || !atOrAbove(ceilingRoute, route)) continue;
          const candidate = await this.resolveRoute(context, route, classification, routingConfig, classifierSettings, floorSignal);
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
    if (skipReason && decision.outcome === "route") {
      decision.reasonCodes = [skipReason];
    }
    if (decision.outcome === "route" && decision.finalRoute) {
      const postBudget = checkDecision(context, decision.finalRoute, routingConfig?.config.limits);
      decision.budgetChecks = [...preBudget.checks, ...postBudget.checks];
      if (postBudget.rejected) {
        const rejected = this.reject(context, postBudget.rejected.reason, decision.budgetChecks, 429);
        rejected.compressionPolicy = compressionPolicy;
        await this.recordDecision(requestId, idempotencyKey, rejected);
        return rejected;
      }
    } else {
      decision.budgetChecks = preBudget.checks;
    }

    if (decision.outcome === "route") {
      decision.routeExecutionPlan = await buildRouteExecutionPlan({
        requestId,
        context,
        decision,
        classifierSettings,
        routingConfig: routingConfig?.config,
        defaultOrganizationId: this.config.defaultOrganizationId,
        targetAvailability: (target, mode) => this.targetAvailability(context, target, mode)
      });
      await this.recordRouteExecutionPlan(requestId, idempotencyKey, decision);
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
        softFloor: decision.session.softFloor,
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
          surface: context.surface,
          transport: context.transport ?? "http",
          harness: context.harness ?? null,
          harnessProfileId: context.harnessProfileId ?? null
        }) as JsonObject
      });
    }

    await this.recordDecision(requestId, idempotencyKey, decision);

    return decision;
  }

  async tokenCountDecision(context: RouteContext, routingConfig?: RoutingConfigSelection): Promise<RouteDecision> {
    // Clamp so token counts are computed against a model the real request can
    // actually reach.
    let finalRoute = capRoute(context.explicitAlias ?? "hard", routingConfig?.config.limits.maxRoute);
    const guardrailActions: string[] = [];
    const routingConfigSnapshot = routingConfig?.snapshot;
    const compressionPolicy = routingConfig?.compressionPolicy;

    const healthSkips: ProviderHealthSkip[] = [];
    const routeSettings = await this.resolveProviderSettings(context, finalRoute, routingConfig?.config, guardrailActions, healthSkips);
    if (!routeSettings) {
      const healthUnavailable = exhaustedByHealth(guardrailActions, healthSkips);
      const rejected = this.reject(
        context,
        healthUnavailable ? "provider_health_unavailable" : "route_not_available_for_surface",
        [],
        healthUnavailable ? 503 : 400,
        healthSkips
      );
      rejected.guardrailActions = guardrailActions;
      rejected.compressionPolicy = compressionPolicy;
      return rejected;
    }

    const decision: RouteDecision = {
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
      compressionPolicy,
      policyVersion: "2026-06-08"
    };
    if (healthSkips.length > 0) decision.healthSkips = healthSkips;
    return decision;
  }

  private async classify(
    requestId: string,
    context: RouteContext,
    idempotencyKey: string,
    classifierSettings: ClassifierSettings,
    routingConfig?: RoutingConfigSnapshot
  ) {
    try {
      const target = await this.classifierTarget(context, classifierSettings);
      const result = await this.classifier.classify(context, classifierSettings, target);
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

  private async classifierTarget(
    context: RouteContext,
    settings: ClassifierSettings
  ): Promise<ClassifierTarget> {
    const organizationId = context.organizationId ?? this.config.defaultOrganizationId;
    let provider;
    try {
      provider = await this.providerRegistry.resolve({
        organizationId,
        provider: settings.providerId
      });
    } catch (error) {
      throw new ClassifierError(
        error instanceof ProviderRegistryError ? error.code : "classifier_provider_registry_unavailable"
      );
    }
    if (!provider) throw new ClassifierError(`Classifier provider ${settings.providerId} was not found.`);
    if (!provider.enabled) throw new ClassifierError(`Classifier provider ${settings.providerId} is disabled.`);

    const endpoint = providerEndpointForDialect(provider, "openai-responses");
    if (!endpoint) {
      throw new ClassifierError(`Classifier provider ${settings.providerId} does not expose an OpenAI Responses endpoint.`);
    }

    let credential;
    if (!provider.builtin && provider.authStyle !== "none") {
      credential = await this.credentials?.resolveForRequest({
        organizationId,
        workspaceId: context.workspaceId,
        apiKeyId: context.apiKeyId,
        provider: settings.providerId
      });
      if (!credential) {
        throw new ClassifierError(`Classifier provider ${settings.providerId} credential is not configured.`);
      }
    }

    return { provider, endpoint, credential };
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
        provider: classifierSettings.providerId,
        attempts: options.cached ? 0 : result.attempts,
        cached: options.cached,
        // Only a fresh classifier call costs tokens; cache hits reuse a prior
        // decision and must not be billed a second time.
        usage: options.cached || !result.usage ? null : jsonPayload(result.usage),
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
        provider: classifierSettings.providerId
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
    classifierSettings: ClassifierSettings = defaultClassifierSettings(this.config),
    floorSignal: boolean = hasUserSignal(context)
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

    // maxRoute is a spend ceiling for auto-routed requests: clamp instead of
    // failing them. Explicit aliases above the cap are rejected up front.
    const maxRoute = routingConfig?.config.limits.maxRoute;
    if (maxRoute && capRoute(finalRoute, maxRoute) !== finalRoute) {
      finalRoute = maxRoute;
      guardrailActions.push("route_limit_clamped");
    }

    const session = await this.sessions.plan(context, finalRoute, maxRoute, floorSignal);
    const healthSkips: ProviderHealthSkip[] = [];
    if (session) {
      finalRoute = session.selectedRoute;
      if (session.action === "kept") guardrailActions.push("session_route_kept");
      if (session.action === "upgraded") guardrailActions.push("session_route_upgraded");
      if (session.action === "capped") guardrailActions.push("session_route_capped");
      if (session.action === "explicit_override") guardrailActions.push("session_explicit_route_override");
    }

    // Reuse the session's pinned provider settings on kept routes so the
    // upstream request shape stays byte-stable and provider prompt caches
    // survive routing-config publishes mid-session.
    let pinnedRouteSettings: ResolvedRouteSettings | undefined;
    let invalidatedPin: { provider: Provider; routingConfigVersionId?: string } | undefined;
    if (session?.action === "kept" && session.pin) {
      pinnedRouteSettings = await this.resolvePinnedSettings(context, session.pin.settings, guardrailActions, healthSkips);
      if (pinnedRouteSettings) {
        guardrailActions.push("session_settings_pinned");
      } else {
        guardrailActions.push("session_pin_invalidated");
        invalidatedPin = {
          provider: session.pin.settings.providerId,
          routingConfigVersionId: session.pin.routingConfigVersionId
        };
        if (context.statefulResponses === true) {
          const rejected = this.reject(context, "session_pin_unavailable", [], 400, healthSkips);
          rejected.guardrailActions = guardrailActions;
          rejected.compressionPolicy = routingConfig?.compressionPolicy;
          return rejected;
        }
        guardrailActions.push("pin_rebound");
      }
    }

    const routeSettings =
      pinnedRouteSettings ?? await this.resolveProviderSettings(context, finalRoute, routingConfig?.config, guardrailActions, healthSkips);
    if (!routeSettings) {
      const healthUnavailable = exhaustedByHealth(guardrailActions, healthSkips);
      const rejected = this.reject(
        context,
        healthUnavailable ? "provider_health_unavailable" : "route_not_available_for_surface",
        [],
        healthUnavailable ? 503 : 400,
        healthSkips
      );
      rejected.guardrailActions = guardrailActions;
      rejected.compressionPolicy = routingConfig?.compressionPolicy;
      return rejected;
    }

    let sessionPin: NonNullable<RouteDecision["session"]>["pin"];
    if (session) {
      sessionPin = pinnedRouteSettings && session.pin
        ? session.pin
        : {
            settings: routeSettings.providerSettings,
            routingConfigVersionId: routingConfig?.snapshot.versionId
          };
    }

    const decision: RouteDecision = {
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
            softFloor: session.softFloor,
            action: session.action
          }
        : undefined,
      classifier: classification
        ? {
            provider: classifierSettings.providerId,
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
      compressionPolicy: routingConfig?.compressionPolicy,
      policyVersion: "2026-06-08"
    };
    if (healthSkips.length > 0) decision.healthSkips = healthSkips;
    return decision;
  }

  private async recordRouteExecutionPlan(
    requestId: string,
    idempotencyKey: string,
    decision: RouteDecision
  ) {
    const plan = decision.routeExecutionPlan;
    if (!plan) return;
    const selectedCandidate = plan.selected
      ? plan.candidates.find((candidate) => candidate.id === plan.selected?.candidateId)
      : undefined;
    await this.events.append({
      scopeType: "request",
      scopeId: requestId,
      correlationId: requestId,
      idempotencyKey,
      producer: "prompt-proxy.routing",
      eventType: "routing.plan_recorded",
      payload: jsonPayload({
        requestedModel: decision.requestedModel,
        classifierRoute: decision.classifierRoute,
        finalRoute: decision.finalRoute,
        provider: decision.provider,
        selectedModel: decision.selectedModel,
        routingConfig: decision.routingConfig ?? null,
        routeExecutionPlan: plan,
        selectedCandidateId: plan.selected?.candidateId,
        translated: plan.selected?.translated ?? false,
        translatorId: selectedCandidate?.translatorId ?? null,
        policyVersion: decision.policyVersion
      }) as JsonObject
    });
  }

  private resolveProviderSettings(
    context: RouteContext,
    route: RouteName,
    routingConfig: RoutingConfig | undefined,
    guardrailActions: string[] = [],
    healthSkips: ProviderHealthSkip[] = []
  ): Promise<ResolvedRouteSettings | undefined> {
    if (routingConfig) {
      const routeConfig = routingConfig.routes[route];
      return this.resolveTargets(context, routeConfig.targets, guardrailActions, healthSkips);
    }

    return Promise.resolve(undefined);
  }

  private async resolveTargets(
    context: RouteContext,
    targets: RouteTarget[],
    guardrailActions: string[],
    healthSkips: ProviderHealthSkip[]
  ): Promise<ResolvedRouteSettings | undefined> {
    const translatedCandidates: RouteTarget[] = [];
    for (const target of targets) {
      const availability = await this.targetAvailability(context, target, "native");
      if (availability.status === "unavailable") {
        if (availability.healthSkip) healthSkips.push(availability.healthSkip);
        if (availability.reason === "dialect_unavailable") {
          translatedCandidates.push(target);
          continue;
        }
        guardrailActions.push(`target_skipped_${availability.reason}:${target.providerId}`);
        continue;
      }
      appendTranslationAction(guardrailActions, context.surface, availability.dialect);
      return routeSettings({ ...target, dialect: availability.dialect }, availability.supportedEfforts);
    }
    for (const target of translatedCandidates) {
      const availability = await this.targetAvailability(context, target, "translated");
      if (availability.status === "unavailable") {
        if (availability.healthSkip) healthSkips.push(availability.healthSkip);
        guardrailActions.push(`target_skipped_${availability.reason}:${target.providerId}`);
        continue;
      }
      appendTranslationAction(guardrailActions, context.surface, availability.dialect);
      return routeSettings({ ...target, dialect: availability.dialect }, availability.supportedEfforts);
    }
    return undefined;
  }

  private async resolvePinnedSettings(
    context: RouteContext,
    settings: SelectedRouteSettings,
    guardrailActions: string[],
    healthSkips: ProviderHealthSkip[]
  ): Promise<ResolvedRouteSettings | undefined> {
    const availability = await this.targetAvailability(context, settings);
    if (availability.status === "unavailable") {
      if (availability.healthSkip) healthSkips.push(availability.healthSkip);
      guardrailActions.push(`pin_skipped_${availability.reason}:${settings.providerId}`);
      return undefined;
    }
    appendTranslationAction(guardrailActions, context.surface, availability.dialect);
    return routeSettings(settings, availability.supportedEfforts);
  }

  private async targetAvailability(
    context: RouteContext,
    target: Pick<RouteTarget, "providerId" | "model"> & { dialect?: Dialect },
    mode: "native" | "translated" = "translated"
  ): Promise<TargetAvailability> {
    const organizationId = context.organizationId ?? this.config.defaultOrganizationId;
    let provider;
    try {
      provider = await this.providerRegistry.resolve({
        organizationId,
        provider: target.providerId
      });
    } catch (error) {
      return {
        status: "unavailable",
        reason: error instanceof ProviderRegistryError ? error.code : "provider_registry_unavailable"
      };
    }
    if (!provider) return { status: "unavailable", reason: "provider_not_found" };
    if (!provider.enabled) return { status: "unavailable", reason: "provider_disabled" };
    const targetDialects = compatibilityTargetDialects(context, provider, target, mode);
    const compatibility = harnessCompatibilityForTarget({
      profileId: compatibilityProfileId(context),
      surface: context.surface,
      transport: context.transport ?? "http",
      statefulResponses: context.statefulResponses,
      hasPreviousResponseId: context.hasPreviousResponseId,
      unsupportedFields: context.unsupportedFields,
      targetDialects,
      availableTranslators: availableTranslatorPairs()
    });
    if (compatibility.status === "unavailable") return { status: "unavailable", reason: compatibility.reason ?? "dialect_unavailable" };
    if (!compatibility.dialect) return { status: "unavailable", reason: "dialect_unavailable" };
    const endpoint = providerEndpointForDialect(provider, compatibility.dialect);
    if (!endpoint) return { status: "unavailable", reason: "dialect_unavailable" };
    const credential = await this.credentials?.resolveForRequest({
      organizationId,
      workspaceId: context.workspaceId,
      apiKeyId: context.apiKeyId,
      provider: target.providerId
    });
    if (!provider.builtin && provider.authStyle !== "none" && !credential) {
      return { status: "unavailable", reason: "provider_credential_unresolved", dialect: endpoint.dialect };
    }
    if (credential) {
      const healthSkip = await this.healthSkipForTarget(organizationId, provider, target, credential);
      if (healthSkip) {
        return {
          status: "unavailable",
          reason: healthSkipReason(healthSkip),
          dialect: endpoint.dialect,
          healthSkip
        };
      }
    }
    return {
      status: "available",
      dialect: endpoint.dialect,
      supportedEfforts: reasoningEffortsFromCapabilities(provider.capabilities),
      providerAccountId: credential?.providerAccountId
    };
  }

  private async healthSkipForTarget(
    organizationId: string,
    provider: ProviderRegistryEntry,
    target: Pick<RouteTarget, "providerId" | "model">,
    credential: UpstreamCredential
  ) {
    if (!this.providerHealth) return undefined;
    const healthTarget = {
      provider: target.providerId,
      providerId: provider.id,
      providerAccountId: credential.providerAccountId,
      model: target.model
    };
    const skips = await this.providerHealth.skipsForTargets({
      organizationId,
      targets: [healthTarget]
    });
    return skips.get(providerHealthTargetKey(healthTarget));
  }

  private async recordDecision(
    requestId: string,
    idempotencyKey: string,
    decision: RouteDecision
  ) {
    const payload = { ...decision };
    delete payload.providerSettings;
    delete payload.routeExecutionPlan;
    await this.events.append({
      scopeType: "request",
      scopeId: requestId,
      correlationId: requestId,
      idempotencyKey,
      producer: "prompt-proxy.routing",
      eventType: "routing.decision_recorded",
      payload: jsonPayload(payload) as JsonObject
    });
    this.recordDecisionMetric(decision);
  }

  private reject(
    context: RouteContext,
    error: string,
    budgetChecks: RouteDecision["budgetChecks"] = [],
    errorStatus = 400,
    healthSkips: ProviderHealthSkip[] = []
  ): RouteDecision {
    const rejectedCheck = budgetChecks.find((check) => check.status === "reject" && check.reason === error);
    const decision: RouteDecision = {
      outcome: "reject",
      surface: context.surface,
      requestedModel: context.requestedModel,
      guardrailActions: [],
      reasonCodes: [error],
      budgetChecks,
      policyVersion: "2026-06-08",
      error,
      errorMessage: rejectionMessage(error, rejectedCheck),
      errorDetails: rejectedCheck ? {
        reasonCode: error,
        scope: rejectedCheck.scope,
        current: rejectedCheck.current,
        limit: rejectedCheck.limit
      } : undefined,
      errorStatus
    };
    if (healthSkips.length > 0) decision.healthSkips = healthSkips;
    return decision;
  }

  private recordDecisionMetric(decision: RouteDecision) {
    const requestedRoute = requestedRouteLabel(decision);
    const guardrailAction = decision.guardrailActions[0] ?? "none";
    if (decision.outcome === "reject") {
      this.metrics.incrementCounter("prompt_proxy_routing_rejections_total", {
        surface: decision.surface,
        requested_route: requestedRoute,
        error_class: "routing",
        guardrail_action: guardrailAction
      });
      return;
    }

    this.metrics.incrementCounter("prompt_proxy_routing_decisions_total", {
      surface: decision.surface,
      requested_route: requestedRoute,
      final_route: decision.finalRoute ?? "none",
      provider: decision.provider ?? "unknown",
      model: decision.selectedModel ?? "unknown",
      guardrail_action: guardrailAction
    });
  }
}

function requestedRouteLabel(decision: RouteDecision) {
  if (decision.classifierRoute) return decision.classifierRoute;
  if (decision.requestedModel?.startsWith("router-")) return decision.requestedModel.slice("router-".length);
  if (decision.requestedModel?.includes("router-")) return decision.requestedModel.split("router-").at(-1) ?? "unknown";
  if (decision.requestedModel) return "provider_model";
  return "unknown";
}

function rejectionMessage(error: string, check: NonNullable<RouteDecision["budgetChecks"]>[number] | undefined) {
  if (error === "request_estimated_input_limit" && check) {
    return `Prompt Proxy rejected this request before routing because the full request is estimated at ${formatCount(check.current)} input tokens, above the active routing config limit of ${formatCount(check.limit)}. This estimate includes the full session envelope and history, not just the latest user message. Start a compacted or new session, or disable/raise limits.maxEstimatedInputTokens in the routing config.`;
  }
  if (error === "route_estimated_input_limit" && check) {
    return `Prompt Proxy rejected this request because the selected route's input limit is ${formatCount(check.limit)} estimated tokens and the full request is estimated at ${formatCount(check.current)}. Adjust limits.routeEstimatedInputLimits for this route or use a smaller session.`;
  }
  if (error === "route_limit" && check) {
    return `Prompt Proxy rejected this request because route ${String(check.current)} exceeds the active routing config maxRoute ${String(check.limit)}.`;
  }
  if (error === "provider_health_unavailable") {
    return "Prompt Proxy rejected this request because every eligible provider target is currently unhealthy, cooling down, or locked out. Check provider health before retrying.";
  }
  return error;
}

function formatCount(value: string | number) {
  return typeof value === "number" ? value.toLocaleString("en-US") : value;
}

function atOrAbove(route: RouteName | undefined, ceiling: RouteName) {
  return route !== undefined && routeOrder.indexOf(route) >= routeOrder.indexOf(ceiling);
}

function appendTranslationAction(guardrailActions: string[], from: Dialect, to: Dialect) {
  if (from === to) return;
  const tag = translationTag(from, to);
  if (!guardrailActions.includes(tag)) guardrailActions.push(tag);
}

function exhaustedByHealth(guardrailActions: string[], healthSkips: ProviderHealthSkip[]) {
  if (healthSkips.length === 0) return false;
  const skipActions = guardrailActions.filter((action) =>
    action.startsWith("target_skipped_") || action.startsWith("pin_skipped_"));
  return skipActions.length > 0 && skipActions.every((action) =>
    action.startsWith("target_skipped_provider_account_cooldown:") ||
    action.startsWith("target_skipped_provider_account_terminal:") ||
    action.startsWith("target_skipped_provider_model_lockout:") ||
    action.startsWith("target_skipped_provider_model_terminal:") ||
    action.startsWith("pin_skipped_provider_account_cooldown:") ||
    action.startsWith("pin_skipped_provider_account_terminal:") ||
    action.startsWith("pin_skipped_provider_model_lockout:") ||
    action.startsWith("pin_skipped_provider_model_terminal:"));
}

function healthSkipReason(healthSkip: ProviderHealthSkip) {
  if (healthSkip.scope === "provider_account_model") {
    return healthSkip.healthStatus === "terminal" ? "provider_model_terminal" : "provider_model_lockout";
  }
  if (healthSkip.healthStatus === "terminal") return "provider_account_terminal";
  return "provider_account_cooldown";
}

function compatibilityTargetDialects(
  context: RouteContext,
  provider: ProviderRegistryEntry,
  target: Pick<RouteTarget, "providerId"> & { dialect?: Dialect },
  mode: "native" | "translated" = "translated"
) {
  if (target.dialect) {
    return providerEndpointForDialect(provider, target.dialect) ? [target.dialect] : [];
  }
  if (mode === "native") {
    return providerEndpointForDialect(provider, context.surface) ? [context.surface] : [];
  }
  return provider.endpoints.map((endpoint) => endpoint.dialect);
}

function availableTranslatorPairs() {
  return TRANSLATABLE_DIALECT_PAIRS.filter(([from, to]) => translators.get(from, to));
}

function compatibilityProfileId(context: RouteContext): HarnessCompatibilityProfileId {
  if (context.harnessProfileId) return context.harnessProfileId;
  if (context.surface === "anthropic-messages") return "generic-anthropic-messages";
  if (context.surface === "openai-chat") return "openai-chat-sdk";
  return "generic-openai-responses";
}

// Key on the routing view, not the byte-identical provider body. The full
// input hash is deliberately omitted so repeated latest-user asks can reuse a
// classifier result as history grows; the coarse token bucket still separates
// materially different context sizes.
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
    context.harnessProfileId ?? "",
    context.transport ?? "http",
    context.requestedModel,
    context.routingInputSource,
    context.routingInputHash,
    context.routingEstimatedInputTokens,
    inputTokenBucket(context.estimatedInputTokens),
    context.hasTools,
    context.toolCount,
    context.hasImages,
    context.hasPreviousResponseId,
    context.unsupportedFields?.join(",") ?? "",
    context.routingExtractedHints.join(","),
    snapshot?.configHash ?? "default"
  ].join("|");
}

function inputTokenBucket(tokens: number) {
  return Math.ceil(tokens / 1024);
}
