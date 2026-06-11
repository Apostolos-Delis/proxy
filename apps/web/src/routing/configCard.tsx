import { Link } from "@tanstack/react-router";
import { KeyRound } from "lucide-react";

import type { RouteMatrixRow, RoutingConfigSummary } from "./data";
import { formatDateTime, formatInteger } from "../format";
import { Badge, RouteBadge, StatusBadge } from "../ui";

export function RoutingConfigCard({ config }: { config: RoutingConfigSummary }) {
  return (
    <Link
      to="/routing-configs/$configId"
      params={{ configId: config.id }}
      className="glass card config-card"
    >
      <div className="config-card-head">
        <div>
          <div className="config-card-name">{config.name}</div>
          <div className="config-card-meta">
            {config.slug === "default" ? <Badge variant="accent">Default</Badge> : null}
            <span className="code-pill">{config.slug}</span>
            <span className="mono faint">{activeVersionLabel(config)}</span>
          </div>
        </div>
        <StatusBadge status={config.status} />
      </div>
      {config.description ? <p className="config-card-description">{config.description}</p> : null}
      <RouteMatrixSection routes={config.routeMatrix} />
      <div className="config-card-foot">
        <KeyCount count={config.assignedApiKeyCount} />
        <span className="faint">Updated {formatDateTime(config.updatedAt)}</span>
      </div>
    </Link>
  );
}

function RouteMatrixSection({ routes }: { routes: RouteMatrixRow[] }) {
  if (routes.length === 0) {
    return (
      <div className="config-card-section">
        <span className="config-card-label">Route matrix</span>
        <span className="faint">No active version.</span>
      </div>
    );
  }
  return (
    <div className="config-card-section">
      <span className="config-card-label">Route matrix</span>
      <div className="config-card-matrix">
        <div className="config-card-matrix-row config-card-matrix-header">
          <span />
          <span className="config-card-provider-header config-card-provider-openai">OpenAI</span>
          <span className="config-card-provider-header config-card-provider-anthropic">Anthropic</span>
        </div>
        {routes.map((route) => (
          <div key={route.route} className="config-card-matrix-row" title={route.description ?? undefined}>
            <RouteBadge route={route.route} />
            <ModelCell model={route.openaiModel} effort={route.openaiEffort} />
            <ModelCell model={route.anthropicModel} effort={route.anthropicEffort} />
          </div>
        ))}
      </div>
    </div>
  );
}

function ModelCell({ model, effort }: { model: string | null; effort: string | null }) {
  if (!model) return <span className="mono faint">—</span>;
  return (
    <span className="config-card-model mono">
      <span>{model}</span>
      {effort ? <span className={`effort-chip effort-${effort}`}>{effort}</span> : null}
    </span>
  );
}

function KeyCount({ count }: { count: number }) {
  if (count === 0) return <Badge variant="warn" dot>No keys assigned</Badge>;
  return (
    <span className="row gap-8 config-card-keys">
      <KeyRound />
      {formatInteger(count)} {count === 1 ? "API key" : "API keys"}
    </span>
  );
}

function activeVersionLabel(config: RoutingConfigSummary) {
  return config.activeVersion ? `v${config.activeVersion.version}` : "no active version";
}
