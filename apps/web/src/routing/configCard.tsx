import { Link } from "@tanstack/react-router";
import { ChevronRight, KeyRound } from "lucide-react";

import type { RouteMatrixRow, RoutingConfigSummary } from "./data";
import { formatDateTime, formatInteger } from "../format";
import { ProgressMeter } from "../ui";
import { EffortMeter, TierGauge } from "./tierViz";

export function RoutingConfigCard({ config }: { config: RoutingConfigSummary }) {
  const isDefault = config.slug === "default";
  const archived = config.status === "archived";
  return (
    <Link
      to="/routing/$configId"
      params={{ configId: config.id }}
      className={`glass card config-card${archived ? " config-card-archived" : ""}`}
      title={config.description ?? undefined}
    >
      <div className="config-card-head">
        <div className="config-card-title">
          <span className="config-card-name">{config.name}</span>
          {archived
            ? <span className="config-card-status"><span className="dot" />archived</span>
            : null}
        </div>
        <ChevronRight className="config-card-chevron" />
      </div>
      <div className="config-card-meta">
        <span
          className={isDefault ? "tag tag-accent" : "tag"}
          title={isDefault ? "Default config" : undefined}
        >
          {config.slug}
        </span>
        {config.activeVersion ? <span className="mono faint">v{config.activeVersion.version}</span> : null}
      </div>
      <RouteMatrixSection routes={config.routeMatrix} dim={archived} />
      <div className="config-card-foot">
        <span className="config-card-usage">
          <KeyCount count={config.assignedApiKeyCount} />
          <TrafficShare share={config.trafficShare} />
        </span>
        <span className="faint nowrap">updated {formatDateTime(config.updatedAt)}</span>
      </div>
    </Link>
  );
}

function RouteMatrixSection({ routes, dim }: { routes: RouteMatrixRow[]; dim: boolean }) {
  if (routes.length === 0) {
    return <span className="faint">No active version.</span>;
  }
  return (
    <div className="config-card-matrix">
      <div className="config-card-matrix-row config-card-matrix-header">
        <span />
        <span>OPENAI</span>
        <span>ANTHROPIC</span>
      </div>
      {routes.map((route) => (
        <div key={route.route} className="config-card-matrix-row" title={route.description ?? undefined}>
          <TierGauge route={route.route} dim={dim} />
          <ModelCell model={route.openaiModel} effort={route.openaiEffort} dim={dim} />
          <ModelCell model={route.anthropicModel} effort={route.anthropicEffort} dim={dim} />
        </div>
      ))}
    </div>
  );
}

function ModelCell({ model, effort, dim }: { model: string | null; effort: string | null; dim: boolean }) {
  if (!model) return <span className="mono faint">—</span>;
  return (
    <span className="config-card-model">
      <span className="mono">{model}</span>
      <EffortMeter effort={effort} dim={dim} />
    </span>
  );
}

function KeyCount({ count }: { count: number }) {
  return (
    <span className={`config-card-keys${count === 0 ? " none" : ""}`}>
      <KeyRound />
      {count === 0 ? "no keys assigned" : `${formatInteger(count)} ${count === 1 ? "key" : "keys"}`}
    </span>
  );
}

function TrafficShare({ share }: { share: number }) {
  const percent = Math.round(share * 100);
  if (percent <= 0) return null;
  return (
    <span className="config-card-traffic">
      <ProgressMeter value={share} max={1} />
      <span className="faint nowrap">{percent}% of traffic</span>
    </span>
  );
}
