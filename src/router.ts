import {
  modelForRoute,
  nearestReasoningEffort,
  routeOrder,
  routes,
  supportsSurface
} from "./catalog.js";
import type { ModelCatalog } from "./catalog.js";
import type { ClassificationResult, LlmClassifier } from "./classifier.js";
import { jsonPayload, type EventService } from "./events.js";
import type { AppConfig } from "./config.js";
import type { BudgetResult, BudgetService, SessionRouteStore } from "./policy.js";
import type { JsonObject, RouteContext, RouteDecision, RouteName } from "./types.js";
import { isRecord } from "./util.js";

export class RoutingService {
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
  }): Promise<RouteDecision> {
    const { requestId, context, idempotencyKey } = input;

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
        inputChars: context.inputChars,
        estimatedInputTokens: context.estimatedInputTokens,
        routingInputSource: context.routingInputSource,
        routingInputChars: context.routingInputChars,
        routingEstimatedInputTokens: context.routingEstimatedInputTokens,
        hasTools: context.hasTools,
        toolCount: context.toolCount,
        hasPreviousResponseId: context.hasPreviousResponseId,
        hasImages: context.hasImages,
        extractedHints: context.extractedHints,
        routingExtractedHints: context.routingExtractedHints
      }
    });

    await this.events.append({
      scopeType: "request",
      scopeId: requestId,
      correlationId: requestId,
      idempotencyKey,
      producer: "prompt-proxy.policy",
      eventType: "policy.trust_checked",
      payload: jsonPayload(this.config.routePolicyTrust) as JsonObject
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
    if (explicit) {
      requestedRoute = explicit;
    } else {
      classification = await this.classify(requestId, context, idempotencyKey);
      requestedRoute = classification.output.recommended_route;
    }

    const decision = this.resolveRoute(context, requestedRoute, classification);
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
        action: decision.session.action
      });
      await this.events.append({
        scopeType: "session",
        scopeId: decision.session.sessionKey,
        sessionId: decision.session.sessionId,
        correlationId: requestId,
        idempotencyKey,
        producer: "prompt-proxy.session",
        eventType: "session.route_memory_recorded",
        payload: jsonPayload(decision.session) as JsonObject
      });
    }

    await this.recordDecision(requestId, idempotencyKey, decision);

    return decision;
  }

  rewrite(body: unknown, decision: RouteDecision) {
    if (!decision.selectedModel || !decision.reasoningEffort || !decision.verbosity) {
      throw new Error("Cannot rewrite request without a selected route.");
    }

    if (decision.surface === "openai-responses") {
      const request = structuredClone(isRecord(body) ? body : {});
      request.model = decision.selectedModel;
      request.reasoning = {
        ...(isRecord(request.reasoning) ? request.reasoning : {}),
        effort: decision.reasoningEffort
      };
      request.text = {
        ...(isRecord(request.text) ? request.text : {}),
        verbosity: decision.verbosity
      };
      return request;
    }

    const request = structuredClone(isRecord(body) ? body : {});
    request.model = decision.selectedModel;
    request.output_config = {
      ...(isRecord(request.output_config) ? request.output_config : {}),
      effort: decision.reasoningEffort
    };
    request.thinking = {
      ...(isRecord(request.thinking) ? request.thinking : {}),
      type: "adaptive"
    };
    return request;
  }

  tokenCountDecision(context: RouteContext): RouteDecision {
    let finalRoute = context.explicitAlias ?? "hard";
    const guardrailActions: string[] = [];
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

    const routeConfig = routes[finalRoute];
    const effort = nearestReasoningEffort(
      routeConfig.reasoningEffort,
      model.supportedReasoningEfforts
    );

    return {
      outcome: "route",
      surface: context.surface,
      requestedModel: context.requestedModel,
      classifierRoute: finalRoute,
      finalRoute,
      selectedModel: model.upstreamModel,
      provider: model.provider,
      reasoningEffort: effort,
      verbosity: routeConfig.verbosity,
      guardrailActions,
      reasonCodes: ["token_count_model_resolution"],
      policyVersion: "2026-06-08"
    };
  }

  rewriteTokenCount(body: unknown, decision: RouteDecision) {
    if (!decision.selectedModel) {
      throw new Error("Cannot rewrite token-count request without a selected model.");
    }

    const request = structuredClone(isRecord(body) ? body : {});
    request.model = decision.selectedModel;
    return request;
  }

  private async classify(
    requestId: string,
    context: RouteContext,
    idempotencyKey: string
  ) {
    try {
      const result = await this.classifier.classify(context);
      await this.events.append({
        scopeType: "request",
        scopeId: requestId,
        correlationId: requestId,
        idempotencyKey,
        producer: "prompt-proxy.classifier",
        eventType: "routing.classification_recorded",
        payload: {
          model: this.config.classifierModel,
          attempts: result.attempts,
          confidence: result.output.confidence,
          recommendedRoute: result.output.recommended_route,
          reasonCodes: result.output.reason_codes,
          risk: result.output.risk
        },
        metadata: {
          contentMode: this.config.classifierAllowRedactedExcerpt
            ? "redacted_excerpt"
            : "features_only",
          redactionState: "redacted",
          provider: this.config.classifierProvider
        }
      });
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
          model: this.config.classifierModel,
          error: error instanceof Error ? error.message : "Classifier failed."
        }
      });
      throw error;
    }
  }

  private resolveRoute(
    context: RouteContext,
    classifierRoute: RouteName,
    classification?: ClassificationResult
  ): RouteDecision {
    let finalRoute = classifierRoute;
    const guardrailActions: string[] = [];
    if (classification?.output.needs_deep_reasoning && finalRoute !== "deep") {
      finalRoute = "deep";
      guardrailActions.push("classifier_deep_reasoning_escalated");
    }
    if (classification && !classification.output.can_use_fast_model && finalRoute === "fast") {
      finalRoute = "balanced";
      guardrailActions.push("classifier_fast_route_disallowed");
    }

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
      model = modelForRoute(this.modelCatalog, finalRoute, context.surface);
      guardrailActions.push("tool_compatibility_escalated");
    }

    const session = this.sessions.plan(context, finalRoute);
    if (session) {
      finalRoute = session.selectedRoute;
      model = modelForRoute(this.modelCatalog, finalRoute, context.surface);
      if (session.action === "kept") guardrailActions.push("session_route_kept");
      if (session.action === "upgraded") guardrailActions.push("session_route_upgraded");
      if (session.action === "explicit_override") guardrailActions.push("session_explicit_route_override");
    }

    const routeConfig = routes[finalRoute];
    const effort = nearestReasoningEffort(
      routeConfig.reasoningEffort,
      model.supportedReasoningEfforts
    );
    if (effort !== routeConfig.reasoningEffort) {
      guardrailActions.push("reasoning_effort_clamped");
    }

    return {
      outcome: "route",
      surface: context.surface,
      requestedModel: context.requestedModel,
      classifierRoute,
      finalRoute,
      selectedModel: model.upstreamModel,
      provider: model.provider,
      reasoningEffort: effort,
      verbosity: routeConfig.verbosity,
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
            action: session.action
          }
        : undefined,
      classifier: classification
        ? {
            model: this.config.classifierModel,
            attempts: classification.attempts,
            confidence: classification.output.confidence,
            recommendedRoute: classification.output.recommended_route
          }
        : undefined,
      policyVersion: "2026-06-08"
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
    await this.events.append({
      scopeType: "request",
      scopeId: requestId,
      correlationId: requestId,
      idempotencyKey,
      producer: "prompt-proxy.routing",
      eventType: "routing.decision_recorded",
      payload: jsonPayload(decision) as JsonObject
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
