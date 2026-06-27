import { Archive, CheckCircle2, History } from "lucide-react";

import type { RoutingConfigDetail, RoutingConfigVersionDetail } from "./data";
import { compactId, formatDateTime, formatInteger } from "../format";
import { DataTable, GlassCard, StatusIndicator } from "../ui";

export function VersionHistory({ versions, pendingVersionId, onActivate, error }: {
  versions: RoutingConfigVersionDetail[];
  pendingVersionId?: string;
  onActivate: (versionId: string) => void;
  error?: string;
}) {
  return (
    <GlassCard className="table-wrap routing-configs-card">
      <div className="card-head">
        <div className="card-title"><History />Version history</div>
        {error ? <span className="action-error">{error}</span> : null}
      </div>
      <DataTable>
        <thead><tr><th>Version</th><th>Status</th><th>Hash</th><th>Created</th><th>Activated</th><th>Action</th></tr></thead>
        <tbody>{versions.map((version) => <VersionRow key={version.id} version={version} pending={pendingVersionId === version.id} onActivate={onActivate} />)}</tbody>
      </DataTable>
    </GlassCard>
  );
}

function VersionRow({ version, pending, onActivate }: {
  version: RoutingConfigVersionDetail;
  pending: boolean;
  onActivate: (versionId: string) => void;
}) {
  return (
    <tr>
      <td><span className="mono">v{version.version}</span></td>
      <td><VersionStatus version={version} /></td>
      <td><span className="mono faint">{compactId(version.configHash, 12)}</span></td>
      <td>{formatDateTime(version.createdAt)}</td>
      <td>{version.activatedAt ? formatDateTime(version.activatedAt) : <span className="faint">never</span>}</td>
      <td>
        {version.active ? (
          <span className="version-current"><CheckCircle2 />Current</span>
        ) : (
          <button className="btn btn-sm" type="button" disabled={pending || version.status === "archived"} onClick={() => onActivate(version.id)}>
            {pending ? "Activating" : "Activate"}
          </button>
        )}
      </td>
    </tr>
  );
}

// A version keeps status "active" after a newer version replaces it; only the
// config's pointer marks the current one, so label the others "superseded".
function VersionStatus({ version }: { version: RoutingConfigVersionDetail }) {
  if (version.active) return <StatusIndicator status="active" />;
  if (version.status === "active") return <StatusIndicator status="superseded" />;
  return <StatusIndicator status={version.status} />;
}

export function ArchivePanel({ detail, pending, error, onArchive }: {
  detail: RoutingConfigDetail;
  pending: boolean;
  error?: string;
  onArchive: () => void;
}) {
  const disabled = pending || detail.config.status === "archived" || detail.config.assignedApiKeyCount > 0;
  return (
    <GlassCard>
      <div className="card-head">
        <div>
          <div className="card-title"><Archive />Archive config</div>
          <div className="faint">Only unused configs can be archived.</div>
        </div>
        <button className="btn" type="button" disabled={disabled} onClick={onArchive}>{pending ? "Archiving" : "Archive"}</button>
      </div>
      {detail.config.assignedApiKeyCount > 0 ? <div className="faint">{formatInteger(detail.config.assignedApiKeyCount)} API keys still use this config.</div> : null}
      {error ? <div className="action-error">{error}</div> : null}
    </GlassCard>
  );
}
