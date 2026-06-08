import { routeOrder } from "./catalog.js";
import type { AppConfig } from "./config.js";
import type { BudgetCheck, RouteContext, RouteName } from "./types.js";
import { stableJson } from "./util.js";

export type BudgetResult = {
  checks: BudgetCheck[];
  rejected?: BudgetCheck;
};

export class BudgetService {
  constructor(private readonly config: AppConfig) {}

  checkBeforeClassification(context: RouteContext): BudgetResult {
    const checks: BudgetCheck[] = [];
    pushTokenLimit(
      checks,
      "request",
      context.estimatedInputTokens,
      this.config.budgetMaxEstimatedInputTokens,
      "request_estimated_input_limit"
    );
    pushTokenLimit(
      checks,
      "user",
      context.estimatedInputTokens,
      context.userId ? this.config.budgetUserEstimatedInputLimits[context.userId] : undefined,
      "user_estimated_input_limit"
    );
    pushTokenLimit(
      checks,
      "team",
      context.estimatedInputTokens,
      context.teamId ? this.config.budgetTeamEstimatedInputLimits[context.teamId] : undefined,
      "team_estimated_input_limit"
    );
    pushWarning(
      checks,
      context.estimatedInputTokens,
      this.config.budgetWarningEstimatedInputTokens
    );
    if (context.explicitAlias) {
      pushRouteLimit(checks, context.explicitAlias, this.config.budgetMaxRoute);
    }
    return result(checks);
  }

  checkDecision(context: RouteContext, route: RouteName): BudgetResult {
    const checks: BudgetCheck[] = [];
    pushRouteLimit(checks, route, this.config.budgetMaxRoute);
    pushTokenLimit(
      checks,
      "route",
      context.estimatedInputTokens,
      this.config.budgetRouteEstimatedInputLimits[route],
      "route_estimated_input_limit"
    );
    return result(checks);
  }
}

export type SessionRouteState = {
  sessionKey: string;
  sessionId: string;
  userId?: string;
  teamId?: string;
  currentRoute: RouteName;
  requestCount: number;
};

export type SessionRouteUpdate = {
  sessionKey: string;
  sessionId: string;
  userId?: string;
  teamId?: string;
  previousRoute?: RouteName;
  currentRoute: RouteName;
  selectedRoute: RouteName;
  action: "stored" | "upgraded" | "kept" | "explicit_override";
};

export class SessionRouteStore {
  private readonly sessions = new Map<string, SessionRouteState>();

  plan(context: RouteContext, route: RouteName): SessionRouteUpdate | undefined {
    if (!context.sessionId) return undefined;

    const sessionKey = sessionScope(context);
    const existing = this.sessions.get(sessionKey);
    if (context.explicitAlias) {
      return {
        sessionKey,
        sessionId: context.sessionId,
        userId: context.userId,
        teamId: context.teamId,
        previousRoute: existing?.currentRoute,
        currentRoute: route,
        selectedRoute: route,
        action: "explicit_override"
      };
    }

    if (!existing) {
      return {
        sessionKey,
        sessionId: context.sessionId,
        userId: context.userId,
        teamId: context.teamId,
        currentRoute: route,
        selectedRoute: route,
        action: "stored"
      };
    }

    const selectedRoute = higherRoute(existing.currentRoute, route);
    const action = selectedRoute === existing.currentRoute ? "kept" : "upgraded";

    return {
      sessionKey,
      sessionId: context.sessionId,
      userId: context.userId,
      teamId: context.teamId,
      previousRoute: existing.currentRoute,
      currentRoute: selectedRoute,
      selectedRoute,
      action
    };
  }

  commit(update: SessionRouteUpdate) {
    const existing = this.sessions.get(update.sessionKey);
    this.sessions.set(update.sessionKey, {
      sessionKey: update.sessionKey,
      sessionId: update.sessionId,
      userId: update.userId,
      teamId: update.teamId,
      currentRoute: update.selectedRoute,
      requestCount: (existing?.requestCount ?? 0) + 1
    });
  }

  list() {
    return [...this.sessions.values()];
  }
}

function pushTokenLimit(
  checks: BudgetCheck[],
  scope: BudgetCheck["scope"],
  current: number,
  limit: number | undefined,
  reason: string
) {
  if (limit === undefined) return;
  checks.push({
    scope,
    status: current > limit ? "reject" : "ok",
    reason,
    current,
    limit
  });
}

function pushWarning(
  checks: BudgetCheck[],
  current: number,
  limit: number | undefined
) {
  if (limit === undefined || current <= limit) return;
  checks.push({
    scope: "request",
    status: "warning",
    reason: "request_estimated_input_warning",
    current,
    limit
  });
}

function pushRouteLimit(
  checks: BudgetCheck[],
  route: RouteName,
  maxRoute: RouteName | undefined
) {
  if (!maxRoute) return;
  checks.push({
    scope: "route",
    status: routeIndex(route) > routeIndex(maxRoute) ? "reject" : "ok",
    reason: "route_limit",
    current: route,
    limit: maxRoute
  });
}

function result(checks: BudgetCheck[]): BudgetResult {
  return {
    checks,
    rejected: checks.find((check) => check.status === "reject")
  };
}

function higherRoute(left: RouteName, right: RouteName) {
  return routeIndex(left) >= routeIndex(right) ? left : right;
}

function routeIndex(route: RouteName) {
  return routeOrder.indexOf(route);
}

function sessionScope(context: RouteContext) {
  return stableJson([
    context.surface,
    context.teamId ?? null,
    context.userId ?? null,
    context.sessionId
  ]);
}
