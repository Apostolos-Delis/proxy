import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";

import {
  activateRoutingConfigVersion,
  archiveRoutingConfig,
  fetchRoutingConfigDetail,
  type RoutingConfigDetail,
  type RoutingConfigVersionDetail
} from "./routing/data";
import { compactId, formatDateTime, formatInteger } from "./format";
import { ConfigEditorCard } from "./routing/configEditorCard";
import { ConfigApiKeysCard } from "./routing/keyAssignment";
import { ArchivePanel, VersionHistory } from "./routing/versionHistory";
import { GlassCard, PageState, StatusBadge } from "./ui";

export function RoutingConfigDetailPage({ configId }: { configId: string }) {
  const queryClient = useQueryClient();
  const { isLoading: queryIsLoading, error: queryError, data: queryData } = useQuery({
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

  if (queryIsLoading) return <PageState title="Routing config" label="Loading routing config" />;
  if (queryError) return <PageState title="Routing config" label={queryError.message} />;
  if (!queryData) return <PageState title="Routing config" label="No routing config data" />;

  const activeVersion = queryData.versions.find((version) => version.active);
  return (
    <div className="page page-enter routing-detail-stack">
      <div className="routing-back-row">
        <Link to="/routing" className="btn btn-sm"><ArrowLeft />All configs</Link>
      </div>
      <div className="page-title-row routing-detail-title">
        <div>
          <div className="routing-detail-name">
            <h2>{queryData.config.name}</h2>
            <StatusBadge status={queryData.config.status} />
          </div>
          <div className="muted">{queryData.config.description ?? "No description"}</div>
        </div>
      </div>
      <FactsStrip detail={queryData} activeVersion={activeVersion} />
      <ConfigApiKeysCard configId={configId} />
      {activeVersion ? <ConfigEditorCard key={activeVersion.id} configId={configId} version={activeVersion} /> : <MissingActiveConfig />}
      <VersionHistory
        versions={queryData.versions}
        pendingVersionId={activateMutation.isPending ? activateMutation.variables : undefined}
        onActivate={(versionId) => activateMutation.mutate(versionId)}
        error={activateMutation.error?.message}
      />
      <ArchivePanel
        detail={queryData}
        pending={archiveMutation.isPending}
        error={archiveMutation.error?.message}
        onArchive={() => archiveMutation.mutate()}
      />
    </div>
  );
}

function FactsStrip({ detail, activeVersion }: { detail: RoutingConfigDetail; activeVersion?: RoutingConfigVersionDetail }) {
  const classifier = activeVersion?.config.classifier;
  return (
    <GlassCard className="config-facts">
      <Fact
        label="Active version"
        value={activeVersion ? `v${activeVersion.version}` : "none"}
        detail={activeVersion ? `hash ${compactId(activeVersion.configHash, 8)}` : "activate a version below"}
      />
      <Fact
        label="API keys"
        value={formatInteger(detail.config.assignedApiKeyCount)}
        detail={detail.config.assignedApiKeyCount === 0 ? "unused" : "assigned"}
      />
      <Fact
        label="Classifier"
        value={classifier?.model ?? "none"}
        detail={classifier ? `${classifier.providerId} · ${formatInteger(classifier.maxAttempts)} attempts` : undefined}
      />
      <Fact
        label="Updated"
        value={formatDateTime(detail.config.updatedAt)}
        detail={detail.config.slug}
      />
    </GlassCard>
  );
}

function Fact({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="routing-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {detail ? <small>{detail}</small> : null}
    </div>
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
