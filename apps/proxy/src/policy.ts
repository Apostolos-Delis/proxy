import type { RoutingConfigLimits } from "@proxy/schema";

import { routeOrder } from "./catalog.js";
import { hasUserSignal } from "./features.js";
import type { BudgetCheck, RouteContext, RouteName, SelectedRouteSettings, Surface } from "./types.js";
import { stableJson } from "./util.js";

export type BudgetResult = {
  checks: BudgetCheck[];
  rejected?: BudgetCheck;
};

export function checkBeforeClassification(context: RouteContext, limits?: RoutingConfigLimits): BudgetResult {
  const checks: BudgetCheck[] = [];
  pushTokenLimit(
    checks,
    "request",
    context.estimatedInputTokens,
    limits?.maxEstimatedInputTokens,
    "request_estimated_input_limit"
  );
  if (context.explicitAlias) {
    pushRouteLimit(checks, context.explicitAlias, limits?.maxRoute);
  }
  return result(checks);
}

export function checkDecision(context: RouteContext, route: RouteName, limits?: RoutingConfigLimits): BudgetResult {
  const checks: BudgetCheck[] = [];
  // Routing clamps auto routes to maxRoute before this runs, so the route
  // check is an audit row, not an enforcement point.
  pushRouteLimit(checks, route, limits?.maxRoute);
  pushTokenLimit(
    checks,
    "route",
    context.estimatedInputTokens,
    limits?.routeEstimatedInputLimits?.[route],
    "route_estimated_input_limit"
  );
  return result(checks);
}

export type SessionPin = {
  settings: SelectedRouteSettings;
  routingConfigVersionId?: string;
};

export type SessionPinLoader = (input: {
  organizationId: string;
  workspaceId: string;
  surface: Surface;
  sessionId: string;
}) => Promise<{
  currentRoute: RouteName;
  pin?: SessionPin;
  requestCount: number;
  softFloor?: boolean;
} | undefined>;

export type SessionRouteState = {
  sessionKey: string;
  sessionId: string;
  userId?: string;
  teamId?: string;
  currentRoute: RouteName;
  pin?: SessionPin;
  requestCount: number;
  softFloor: boolean;
};

export type SessionRouteUpdate = {
  sessionKey: string;
  sessionId: string;
  userId?: string;
  teamId?: string;
  previousRoute?: RouteName;
  currentRoute: RouteName;
  selectedRoute: RouteName;
  pin?: SessionPin;
  softFloor: boolean;
  action: "stored" | "upgraded" | "kept" | "capped" | "explicit_override";
};

export class SessionRouteStore {
  private readonly sessions = new Map<string, SessionRouteState>();

  constructor(private readonly loadPin?: SessionPinLoader) {}

  async peek(context: RouteContext): Promise<{ route: RouteName; soft: boolean } | undefined> {
    if (!context.sessionId) return undefined;
    const existing = await this.hydrate(sessionScope(context), context);
    if (!existing) return undefined;
    return { route: existing.currentRoute, soft: existing.softFloor };
  }

  async plan(
    context: RouteContext,
    route: RouteName,
    maxRoute?: RouteName,
    userSignal = hasUserSignal(context)
  ): Promise<SessionRouteUpdate | undefined> {
    if (!context.sessionId) return undefined;

    const sessionKey = sessionScope(context);
    const existing = await this.hydrate(sessionKey, context);
    if (context.explicitAlias) {
      return {
        sessionKey,
        sessionId: context.sessionId,
        userId: context.userId,
        teamId: context.teamId,
        previousRoute: existing?.currentRoute,
        currentRoute: route,
        selectedRoute: route,
        softFloor: false,
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
        softFloor: !userSignal,
        action: "stored"
      };
    }

    if (existing.softFloor && userSignal) {
      return {
        sessionKey,
        sessionId: context.sessionId,
        userId: context.userId,
        teamId: context.teamId,
        previousRoute: existing.currentRoute,
        currentRoute: route,
        selectedRoute: route,
        softFloor: false,
        action: "stored"
      };
    }

    // Memory above a lowered maxRoute settles at the cap instead of holding
    // the session at a route every future request would be denied.
    const cappedCurrentRoute = capRoute(existing.currentRoute, maxRoute);
    const selectedRoute = userSignal ? higherRoute(cappedCurrentRoute, route) : cappedCurrentRoute;
    let action: SessionRouteUpdate["action"] = "capped";
    if (selectedRoute === existing.currentRoute) {
      action = "kept";
    } else if (routeIndex(selectedRoute) > routeIndex(existing.currentRoute)) {
      action = "upgraded";
    }

    return {
      sessionKey,
      sessionId: context.sessionId,
      userId: context.userId,
      teamId: context.teamId,
      previousRoute: existing.currentRoute,
      currentRoute: selectedRoute,
      selectedRoute,
      pin: action === "kept" ? existing.pin : undefined,
      softFloor: existing.softFloor,
      action
    };
  }

  commit(update: SessionRouteUpdate) {
    // requestCount is observational (debug endpoint only) and may undercount
    // when concurrent requests hydrate the same key; do not gate routing on it.
    const existing = this.sessions.get(update.sessionKey);
    this.sessions.set(update.sessionKey, {
      sessionKey: update.sessionKey,
      sessionId: update.sessionId,
      userId: update.userId,
      teamId: update.teamId,
      currentRoute: update.selectedRoute,
      pin: update.pin,
      requestCount: (existing?.requestCount ?? 0) + 1,
      softFloor: update.softFloor
    });
  }

  list() {
    return [...this.sessions.values()];
  }

  private async hydrate(sessionKey: string, context: RouteContext): Promise<SessionRouteState | undefined> {
    const cached = this.sessions.get(sessionKey);
    if (cached) return cached;
    if (!this.loadPin || !context.organizationId || !context.workspaceId || !context.sessionId) return undefined;

    const persisted = await this.loadPin({
      organizationId: context.organizationId,
      workspaceId: context.workspaceId,
      surface: context.surface,
      sessionId: context.sessionId
    });
    // A concurrent request may have hydrated or committed this key while we
    // awaited the loader; its state is at least as fresh as what we loaded.
    const raced = this.sessions.get(sessionKey);
    if (raced) return raced;
    if (!persisted) return undefined;

    const state: SessionRouteState = {
      sessionKey,
      sessionId: context.sessionId,
      userId: context.userId,
      teamId: context.teamId,
      currentRoute: persisted.currentRoute,
      pin: persisted.pin,
      requestCount: persisted.requestCount,
      softFloor: persisted.softFloor ?? false
    };
    this.sessions.set(sessionKey, state);
    return state;
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

export function capRoute(route: RouteName, maxRoute: RouteName | undefined): RouteName {
  if (!maxRoute) return route;
  return routeIndex(route) > routeIndex(maxRoute) ? maxRoute : route;
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
    context.workspaceId ?? null,
    context.surface,
    context.teamId ?? null,
    context.userId ?? null,
    context.sessionId
  ]);
}
