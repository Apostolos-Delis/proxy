import type { RouteIds } from "@tanstack/react-router";

import type { router } from "../../router";

type KnownRouteId = RouteIds<typeof router.routeTree>;

export type PageScope = { page: string } & Partial<Record<"artifactId" | "sessionId" | "configId", string>>;

// Keyed by router route ids so route renames surface as type errors instead
// of silently dropping page context.
const PAGE_BY_ROUTE_ID: Partial<Record<KnownRouteId, string>> = {
  "/": "overview",
  "/usage": "usage",
  "/logs": "logs",
  "/logs/$artifactId": "log-detail",
  "/prompts": "prompts",
  "/prompts/$artifactId": "prompt-detail",
  "/sessions": "sessions",
  "/sessions/$sessionId": "session-detail",
  "/routing-configs": "routing-configs",
  "/routing-configs/$configId": "routing-config-detail",
  "/api-keys": "api-keys",
  "/users": "users",
  "/billing": "billing",
  "/settings": "settings"
};

export function pageScopeFromMatch(
  routeId: string,
  params: Record<string, unknown>
): PageScope | undefined {
  const page = PAGE_BY_ROUTE_ID[routeId as KnownRouteId];
  if (!page) return undefined;
  const scope: PageScope = { page };
  for (const key of ["artifactId", "sessionId", "configId"] as const) {
    const value = params[key];
    if (typeof value === "string") scope[key] = value;
  }
  return scope;
}

export function pageScopeLabel(scope: PageScope | undefined) {
  if (!scope) return null;
  const entity = Object.entries(scope).find(([key, value]) => key !== "page" && typeof value === "string");
  return entity ? `${entity[0]} ${entity[1]}` : null;
}
