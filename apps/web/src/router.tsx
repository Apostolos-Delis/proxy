import { createRootRouteWithContext, createRoute, createRouter } from "@tanstack/react-router";

import { LoginPage, requireAuth, type RouterContext } from "./auth";
import { BillingPage } from "./billingPage";
import { KeysPage } from "./keysPage";
import { OverviewPage } from "./overviewPage";
import { PromptDetailPage, PromptsPage } from "./promptsPage";
import { RequestsPage } from "./requestsPage";
import { RoutingConfigDetailPage } from "./routingConfigDetailPage";
import { RoutingConfigsPage } from "./routingConfigsPage";
import { SessionDetailPage, SessionsPage } from "./sessionsPage";
import { SettingsPage } from "./settingsPage";
import { AppShell } from "./shell";
import { UsagePage } from "./usagePage";
import { UsersPage } from "./usersPage";

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: AppShell
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: requireAuth,
  component: OverviewPage
});

const usageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/usage",
  beforeLoad: requireAuth,
  component: UsagePage
});

const promptsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/prompts",
  beforeLoad: requireAuth,
  component: PromptsPage
});

const promptDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/prompts/$artifactId",
  beforeLoad: requireAuth,
  component: PromptDetailRoutePage
});

const sessionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sessions",
  beforeLoad: requireAuth,
  component: SessionsPage
});

const sessionDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sessions/$sessionId",
  beforeLoad: requireAuth,
  component: SessionDetailRoutePage
});

const logsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/logs",
  beforeLoad: requireAuth,
  component: RequestsPage
});

const logDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/logs/$artifactId",
  beforeLoad: requireAuth,
  component: LogDetailRoutePage
});

const keysRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/api-keys",
  beforeLoad: requireAuth,
  component: KeysPage
});

const routingConfigsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/routing-configs",
  beforeLoad: requireAuth,
  component: RoutingConfigsPage
});

const routingConfigDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/routing-configs/$configId",
  beforeLoad: requireAuth,
  component: RoutingConfigDetailRoutePage
});

const usersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/users",
  beforeLoad: requireAuth,
  component: UsersPage
});

const billingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/billing",
  beforeLoad: requireAuth,
  component: BillingPage
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  beforeLoad: requireAuth,
  component: SettingsPage
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  indexRoute,
  usageRoute,
  promptsRoute,
  promptDetailRoute,
  sessionsRoute,
  sessionDetailRoute,
  logsRoute,
  logDetailRoute,
  keysRoute,
  routingConfigsRoute,
  routingConfigDetailRoute,
  usersRoute,
  billingRoute,
  settingsRoute
]);

export const router = createRouter({
  routeTree,
  context: undefined!,
  scrollRestoration: true
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

function PromptDetailRoutePage() {
  const { artifactId } = promptDetailRoute.useParams();
  return <PromptDetailPage artifactId={artifactId} />;
}

function SessionDetailRoutePage() {
  const { sessionId } = sessionDetailRoute.useParams();
  return <SessionDetailPage sessionId={sessionId} />;
}

function LogDetailRoutePage() {
  const { artifactId } = logDetailRoute.useParams();
  return <PromptDetailPage artifactId={artifactId} />;
}

function RoutingConfigDetailRoutePage() {
  const { configId } = routingConfigDetailRoute.useParams();
  return <RoutingConfigDetailPage configId={configId} />;
}
