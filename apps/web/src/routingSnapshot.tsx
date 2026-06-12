import { Link } from "@tanstack/react-router";

import { compactId } from "./format";

export type RoutingConfigSnapshot = {
  configId: string;
  configName?: string | null;
  versionId?: string | null;
  version?: number | null;
  configHash?: string | null;
};

export type ClassifierSnapshot = {
  provider?: string;
  model?: string;
  attempts?: number;
  confidence?: number;
  recommendedRoute?: string;
  routingConfigId?: string;
  routingConfigVersionId?: string;
  routingConfigHash?: string;
};

// Classifier snapshots travel over the wire as a JSON scalar; narrow them
// back into the display shape the console renders.
export function classifierSnapshot(value: unknown): ClassifierSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as ClassifierSnapshot;
}

export function RoutingConfigMicro({ snapshot }: { snapshot?: RoutingConfigSnapshot | null }) {
  if (!snapshot) return null;
  return (
    <span className="routing-config-micro" title={snapshot.configHash ? `config hash ${snapshot.configHash}` : undefined}>
      <Link to="/routing/$configId" params={{ configId: snapshot.configId }}>
        {snapshot.configName ?? compactId(snapshot.configId)}
      </Link>
      <span>· {versionLabel(snapshot)}</span>
    </span>
  );
}

function versionLabel(snapshot: RoutingConfigSnapshot) {
  if (typeof snapshot.version !== "number") return "version unknown";
  return `v${snapshot.version}`;
}
