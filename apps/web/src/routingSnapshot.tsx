import { Link } from "@tanstack/react-router";
import { GitBranch } from "lucide-react";
import type { ReactNode } from "react";

import type { ClassifierSnapshot, RoutingConfigSnapshot } from "./api";
import { compactId } from "./format";
import { GlassCard, RouteBadge } from "./ui";

export type RoutingSnapshotValue = {
  finalRoute?: string;
  selectedModel?: string;
  provider?: string;
  requestedModel?: string;
  routingConfig?: RoutingConfigSnapshot | null;
  classifier?: ClassifierSnapshot | null;
};

export function RoutingSnapshotPanel({ value }: { value: RoutingSnapshotValue }) {
  const config = value.routingConfig;
  return (
    <GlassCard className="routing-snapshot-panel">
      <div className="card-head">
        <div className="card-title"><GitBranch />Routing snapshot</div>
        {config ? <ConfigLink snapshot={config} /> : <span className="faint">No config snapshot</span>}
      </div>
      <div className="snapshot-grid">
        <SnapshotDatum label="Selected route"><RouteBadge route={value.finalRoute} /></SnapshotDatum>
        <SnapshotDatum label="Selected model"><span className="mono">{value.selectedModel ?? "unknown"}</span></SnapshotDatum>
        <SnapshotDatum label="Provider"><span>{value.provider ?? "unknown"}</span></SnapshotDatum>
        <SnapshotDatum label="Classifier"><span className="mono">{classifierLabel(value.classifier)}</span></SnapshotDatum>
        <SnapshotDatum label="Config version"><span className="mono">{versionLabel(config)}</span></SnapshotDatum>
        <SnapshotDatum label="Config hash"><span className="mono">{hashLabel(config)}</span></SnapshotDatum>
      </div>
      {config ? <div className="snapshot-foot mono faint">{compactId(config.configId, 24)} · {versionIdLabel(config)}</div> : null}
    </GlassCard>
  );
}

export function RoutingConfigMicro({ snapshot }: { snapshot?: RoutingConfigSnapshot | null }) {
  if (!snapshot) return null;
  return (
    <span className="routing-config-micro">
      <Link to="/routing-configs/$configId" params={{ configId: snapshot.configId }}>
        {snapshot.configName ?? compactId(snapshot.configId)}
      </Link>
      <span>{versionLabel(snapshot)} · {hashLabel(snapshot)}</span>
    </span>
  );
}

export function routingDecisionSubtitle(value: RoutingSnapshotValue) {
  const parts = [value.selectedModel ?? value.requestedModel ?? "unknown model"];
  if (value.routingConfig) parts.push(versionLabel(value.routingConfig));
  if (value.routingConfig?.configHash) parts.push(hashLabel(value.routingConfig));
  return parts.join(" · ");
}

function ConfigLink({ snapshot }: { snapshot: RoutingConfigSnapshot }) {
  return (
    <Link to="/routing-configs/$configId" params={{ configId: snapshot.configId }} className="snapshot-config-link">
      {snapshot.configName ?? compactId(snapshot.configId)}
    </Link>
  );
}

function SnapshotDatum({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="snapshot-datum">
      <span>{label}</span>
      <strong>{children}</strong>
    </div>
  );
}

function classifierLabel(classifier?: ClassifierSnapshot | null) {
  if (!classifier?.model) return "unknown";
  if (!classifier.provider) return classifier.model;
  return `${classifier.provider} · ${classifier.model}`;
}

function versionLabel(snapshot?: RoutingConfigSnapshot | null) {
  if (!snapshot) return "unknown";
  if (typeof snapshot.version !== "number") return "version unknown";
  return `v${snapshot.version}`;
}

function versionIdLabel(snapshot: RoutingConfigSnapshot) {
  if (!snapshot.versionId) return "version id unknown";
  return compactId(snapshot.versionId, 18);
}

function hashLabel(snapshot?: RoutingConfigSnapshot | null) {
  if (!snapshot?.configHash) return "hash unknown";
  return compactId(snapshot.configHash, 18);
}
