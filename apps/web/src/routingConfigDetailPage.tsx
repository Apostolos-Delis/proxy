import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, ArrowLeft, CheckCircle2 } from "lucide-react";

import {
  activateRoutingConfigVersion,
  archiveRoutingConfig,
  fetchRoutingConfigDetail,
  type RoutingConfigDetail,
  type RoutingConfigDocument,
  type RoutingConfigProviderSettings,
  type RoutingConfigVersionDetail
} from "./api";
import { compactId, formatDateTime, formatInteger } from "./format";
import { Badge, DataTable, GlassCard, JsonPanel, PageState, PageTitle, RouteBadge, StatusBadge } from "./ui";

const routeOrder = ["fast", "balanced", "hard", "deep"] as const;

export function RoutingConfigDetailPage({ configId }: { configId: string }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["routing-config", configId],
    queryFn: () => fetchRoutingConfigDetail(configId)
  });
  const activateMutation = useMutation({
    mutationFn: (versionId: string) => activateRoutingConfigVersion(configId, versionId),
    onSuccess: (data) => {
      queryClient.setQueryData(["routing-config", configId], data);
      queryClient.invalidateQueries({ queryKey: ["routing-configs"] });
    }
  });
  const archiveMutation = useMutation({
    mutationFn: () => archiveRoutingConfig(configId),
    onSuccess: (data) => {
      queryClient.setQueryData(["routing-config", configId], data);
      queryClient.invalidateQueries({ queryKey: ["routing-configs"] });
    }
  });

  if (query.isLoading) return <PageState title="Routing config" label="Loading routing config" />;
  if (query.error) return <PageState title="Routing config" label={query.error.message} />;
  if (!query.data) return <PageState title="Routing config" label="No routing config data" />;

  const activeVersion = query.data.versions.find((version) => version.active);
  const activeConfig = activeVersion?.config;
  return (
    <div className="page page-enter">
      <PageTitle
        title={query.data.config.name}
        subtitle={query.data.config.description ?? compactId(query.data.config.id, 24)}
        actions={<Link to="/routing-configs" className="btn"><ArrowLeft />All configs</Link>}
      />
      <div className="routing-detail-grid">
        <ConfigSummary detail={query.data} activeVersion={activeVersion} />
        <ClassifierCard config={activeConfig} />
      </div>
      {activeConfig ? <RouteTierTable config={activeConfig} /> : <MissingActiveConfig />}
      <VersionHistory
        versions={query.data.versions}
        pendingVersionId={activateMutation.isPending ? activateMutation.variables : undefined}
        onActivate={(versionId) => activateMutation.mutate(versionId)}
        error={activateMutation.error?.message}
      />
      <ArchivePanel
        detail={query.data}
        pending={archiveMutation.isPending}
        error={archiveMutation.error?.message}
        onArchive={() => archiveMutation.mutate()}
      />
      {activeConfig ? <JsonPanel title="Active config JSON" value={activeConfig} /> : null}
    </div>
  );
}

function ConfigSummary({ detail, activeVersion }: { detail: RoutingConfigDetail; activeVersion?: RoutingConfigVersionDetail }) {
  return (
    <GlassCard>
      <div className="card-head">
        <div className="card-title">Active version</div>
        <StatusBadge status={detail.config.status} />
      </div>
      <div className="routing-summary-grid">
        <Metric label="Version" value={activeVersion ? `v${activeVersion.version}` : "none"} detail={activeVersion ? compactId(activeVersion.configHash, 12) : undefined} />
        <Metric label="API keys" value={formatInteger(detail.config.assignedApiKeyCount)} detail={detail.config.assignedApiKeyCount === 0 ? "unused" : "assigned"} />
        <Metric label="Updated" value={formatDateTime(detail.config.updatedAt)} detail={detail.config.slug === "default" ? "default config" : detail.config.slug} />
      </div>
    </GlassCard>
  );
}

function ClassifierCard({ config }: { config?: RoutingConfigDocument }) {
  if (!config) return null;
  return (
    <GlassCard>
      <div className="card-head">
        <div className="card-title">Classifier</div>
        <Badge variant="accent">{config.classifier.provider}</Badge>
      </div>
      <div className="routing-summary-grid">
        <Metric label="Model" value={config.classifier.model} />
        <Metric label="Attempts" value={formatInteger(config.classifier.maxAttempts)} detail={`${formatInteger(config.classifier.timeoutMs)}ms timeout`} />
        <Metric label="Excerpt" value={config.classifier.allowRedactedExcerpt ? "allowed" : "disabled"} detail={String(config.classifier.structuredOutput?.mode ?? "json_schema")} />
      </div>
    </GlassCard>
  );
}

function MissingActiveConfig() {
  return (
    <GlassCard className="empty-state">
      <strong>No active version config</strong>
      <span>Activate a version before assigning this routing config to API keys.</span>
    </GlassCard>
  );
}

function RouteTierTable({ config }: { config: RoutingConfigDocument }) {
  return (
    <GlassCard className="table-wrap routing-configs-card">
      <div className="card-head">
        <div className="card-title">Route tier model matrix</div>
        <span className="faint mono">max {String(config.limits.maxRoute ?? "unknown")}</span>
      </div>
      <DataTable>
        <thead><tr><th>Tier</th><th>OpenAI</th><th>Anthropic</th><th>Description</th></tr></thead>
        <tbody>
          {routeOrder.map((route) => {
            const tier = config.routes[route];
            return (
              <tr key={route}>
                <td><RouteBadge route={route} /></td>
                <td><ProviderSettings settings={tier?.openai} provider="openai" /></td>
                <td><ProviderSettings settings={tier?.anthropic} provider="anthropic" /></td>
                <td>{tier?.description ?? "No description"}</td>
              </tr>
            );
          })}
        </tbody>
      </DataTable>
    </GlassCard>
  );
}

function VersionHistory({ versions, pendingVersionId, onActivate, error }: {
  versions: RoutingConfigVersionDetail[];
  pendingVersionId?: string;
  onActivate: (versionId: string) => void;
  error?: string;
}) {
  return (
    <GlassCard className="table-wrap routing-configs-card">
      <div className="card-head">
        <div className="card-title">Version history</div>
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
      <td>{version.active ? <Badge variant="success" dot>Active</Badge> : <StatusBadge status={version.status} />}</td>
      <td><span className="mono faint">{compactId(version.configHash, 12)}</span></td>
      <td>{formatDateTime(version.createdAt)}</td>
      <td>{version.activatedAt ? formatDateTime(version.activatedAt) : <span className="faint">never</span>}</td>
      <td>
        {version.active ? (
          <span className="row gap-8 faint"><CheckCircle2 />Current</span>
        ) : (
          <button className="btn btn-sm" type="button" disabled={pending || version.status === "archived"} onClick={() => onActivate(version.id)}>
            {pending ? "Activating" : "Activate"}
          </button>
        )}
      </td>
    </tr>
  );
}

function ArchivePanel({ detail, pending, error, onArchive }: {
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

function ProviderSettings({ settings, provider }: { settings?: RoutingConfigProviderSettings; provider: string }) {
  if (!settings) return <span className="faint">{provider}: none</span>;
  const effort = settings.reasoning?.effort ?? settings.output_config?.effort ?? settings.thinking?.type;
  return (
    <div>
      <div className="mono">{settings.model ?? "unknown"}</div>
      <div className="faint">{effort ? `effort ${effort}` : provider}</div>
    </div>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="routing-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {detail ? <small>{detail}</small> : null}
    </div>
  );
}
