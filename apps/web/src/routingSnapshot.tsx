import { Link } from "@tanstack/react-router";

import type { RoutingConfigSnapshot } from "./api";
import { compactId } from "./format";

export function RoutingConfigMicro({ snapshot }: { snapshot?: RoutingConfigSnapshot | null }) {
  if (!snapshot) return null;
  return (
    <span className="routing-config-micro" title={snapshot.configHash ? `config hash ${snapshot.configHash}` : undefined}>
      <Link to="/routing-configs/$configId" params={{ configId: snapshot.configId }}>
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
