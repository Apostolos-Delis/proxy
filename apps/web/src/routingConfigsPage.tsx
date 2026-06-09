import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { GitBranch, KeyRound, Settings2 } from "lucide-react";

import { fetchRoutingConfigs, type RoutingConfigRouteMatrixRow, type RoutingConfigSummary } from "./api";
import { compactId, formatDateTime, formatInteger } from "./format";
import { Badge, DataTable, GlassCard, PageState, PageTitle, RouteBadge, StatusBadge } from "./ui";

export function RoutingConfigsPage() {
  const query = useQuery({ queryKey: ["routing-configs"], queryFn: fetchRoutingConfigs });

  if (query.isLoading) return <PageState title="Routing configs" label="Loading routing configs" />;
  if (query.error) return <PageState title="Routing configs" label={query.error.message} />;

  const configs = query.data?.data ?? [];

  return (
    <div className="page page-enter">
      <PageTitle
        title="Routing configs"
        subtitle="Model tiers, classifier settings, and API key assignment targets."
        actions={<Link to="/settings" className="btn"><Settings2 />Runtime settings</Link>}
      />
      <GlassCard className="table-wrap routing-configs-card">
        <DataTable>
          <thead>
            <tr><th>Config</th><th>Status</th><th>Active version</th><th>Route matrix</th><th>API keys</th><th>Updated</th></tr>
          </thead>
          <tbody>{configs.map((config) => <RoutingConfigRow key={config.id} config={config} />)}</tbody>
        </DataTable>
        {configs.length === 0 ? <RoutingConfigsEmpty /> : null}
      </GlassCard>
    </div>
  );
}

export function RoutingConfigDetailPage({ configId }: { configId: string }) {
  return (
    <div className="page page-enter">
      <PageTitle
        title="Routing config"
        subtitle={configId}
        actions={<Link to="/routing-configs" className="btn">All configs</Link>}
      />
      <GlassCard className="empty-state">
        <GitBranch />
        <strong>Routing config detail is wired</strong>
        <span>Version history, tier mapping, and activation controls land in the detail ticket.</span>
      </GlassCard>
    </div>
  );
}

function RoutingConfigRow({ config }: { config: RoutingConfigSummary }) {
  return (
    <tr>
      <td>
        <Link to="/routing-configs/$configId" params={{ configId: config.id }} className="table-link">
          {config.name}
        </Link>
        <div className="row gap-8 routing-config-meta">
          {config.slug === "default" ? <Badge variant="accent">Default</Badge> : null}
          <span className="mono faint">{compactId(config.id, 16)}</span>
        </div>
      </td>
      <td><StatusBadge status={config.status} /></td>
      <td><ActiveVersion config={config} /></td>
      <td><RouteMatrixPreview routes={config.routeMatrix} /></td>
      <td><ApiKeyCount count={config.assignedApiKeyCount} /></td>
      <td>{formatDateTime(config.updatedAt)}</td>
    </tr>
  );
}

function ActiveVersion({ config }: { config: RoutingConfigSummary }) {
  if (!config.activeVersion) return <span className="faint">No active version</span>;
  return (
    <div>
      <div className="mono">v{config.activeVersion.version}</div>
      <div className="mono faint">{compactId(config.activeVersion.configHash, 8)}</div>
    </div>
  );
}

function RouteMatrixPreview({ routes }: { routes: RoutingConfigRouteMatrixRow[] }) {
  if (routes.length === 0) return <span className="faint">No active matrix</span>;
  return (
    <div className="route-matrix-preview">
      {routes.map((route) => (
        <div key={route.route} className="route-matrix-row" title={route.description ?? undefined}>
          <RouteBadge route={route.route} />
          <span className="mono faint">{providerRouteLabel("openai", route.openaiModel, route.openaiEffort)}</span>
          <span className="mono faint">{providerRouteLabel("anthropic", route.anthropicModel, route.anthropicEffort)}</span>
        </div>
      ))}
    </div>
  );
}

function ApiKeyCount({ count }: { count: number }) {
  if (count === 0) return <Badge variant="warn" dot>Unused</Badge>;
  return (
    <span className="row gap-8">
      <KeyRound />
      <span>{formatInteger(count)}</span>
    </span>
  );
}

function RoutingConfigsEmpty() {
  return (
    <div className="empty-state routing-configs-empty">
      <GitBranch />
      <strong>No routing configs found</strong>
      <span>Create or seed a routing config before assigning API keys.</span>
    </div>
  );
}

function providerRouteLabel(provider: string, model: string | null, effort: string | null) {
  if (!model) return `${provider}: none`;
  return effort ? `${provider}: ${model} · ${effort}` : `${provider}: ${model}`;
}
