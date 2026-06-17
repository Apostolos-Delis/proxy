import { createRootRouteWithContext, createRoute, createRouter } from "@tanstack/react-router";

import { LoginPage, requireAdmin, requireAuth, type RouterContext } from "./auth";
import { BillingPage } from "./billingPage";
import { CostPage } from "./costPage";
import { InvitePage } from "./invitePage";
import { CreateApiKeyPage } from "./keys/createKeyPage";
import { KeysPage } from "./keysPage";
import { OverviewPage } from "./overviewPage";
import { ProvidersPage } from "./providersPage";
import { PromptDetailPage } from "./promptDetailPage";
import { PromptsPage } from "./promptsPage";
import { RequestsPage } from "./requestsPage";
import { CreateRoutingConfigPage } from "./routing/createConfigPage";
import { RoutingConfigDetailPage } from "./routingConfigDetailPage";
import { RoutingConfigsPage } from "./routingConfigsPage";
import { SessionDetailPage } from "./sessionDetailPage";
import { SessionsPage } from "./sessionsPage";
import { SettingsPage } from "./settingsPage";
import { AppShell } from "./shell";
import { CachingPage } from "./cachingPage";
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

const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/invite/$token",
  component: InviteRoutePage
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

const costRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/cost",
  beforeLoad: requireAuth,
  component: CostPage
});

const cachingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/caching",
  beforeLoad: requireAuth,
  component: CachingPage
});

const promptsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/prompts",
  beforeLoad: requireAdmin,
  component: PromptsPage
});

const promptDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/prompts/$artifactId",
  beforeLoad: requireAdmin,
  component: PromptDetailRoutePage
});

const sessionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sessions",
  beforeLoad: requireAdmin,
  component: SessionsPage
});

const sessionDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sessions/$sessionId",
  beforeLoad: requireAdmin,
  component: SessionDetailRoutePage
});

const logsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/logs",
  beforeLoad: requireAdmin,
  component: RequestsPage
});

const logDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/logs/$artifactId",
  beforeLoad: requireAdmin,
  component: LogDetailRoutePage
});

const keysRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/api-keys",
  beforeLoad: requireAdmin,
  component: KeysPage
});

const keysCreateRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/api-keys/new",
  beforeLoad: requireAdmin,
  component: CreateApiKeyPage
});

const providersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/providers",
  beforeLoad: requireAdmin,
  component: ProvidersPage
});

const routingConfigsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/routing",
  beforeLoad: requireAdmin,
  component: RoutingConfigsPage
});

const routingConfigCreateRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/routing/new",
  beforeLoad: requireAdmin,
  component: CreateRoutingConfigPage
});

const routingConfigDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/routing/$configId",
  beforeLoad: requireAdmin,
  component: RoutingConfigDetailRoutePage
});

const usersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/users",
  beforeLoad: requireAdmin,
  component: UsersPage
});

const billingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/billing",
  beforeLoad: requireAdmin,
  component: BillingPage
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  beforeLoad: requireAdmin,
  component: SettingsPage
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  inviteRoute,
  indexRoute,
  usageRoute,
  costRoute,
  cachingRoute,
  promptsRoute,
  promptDetailRoute,
  sessionsRoute,
  sessionDetailRoute,
  logsRoute,
  logDetailRoute,
  keysRoute,
  keysCreateRoute,
  providersRoute,
  routingConfigsRoute,
  routingConfigCreateRoute,
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

function InviteRoutePage() {
  const { token } = inviteRoute.useParams();
  return <InvitePage token={token} />;
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
