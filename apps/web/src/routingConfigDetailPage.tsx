import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Layers, PenLine } from "lucide-react";
import { useState } from "react";

import {
  activateRoutingConfigVersion,
  archiveRoutingConfig,
  createRoutingConfigVersion,
  fetchRoutingConfigDetail,
  type RoutingConfigDetail,
  type RoutingConfigVersionDetail
} from "./api";
import { compactId, formatDateTime, formatInteger } from "./format";
import { ConfigApiKeysCard } from "./routing/keyAssignment";
import { PromptEditors, RouteMatrixEditor } from "./routing/configEditorFields";
import { ArchivePanel, VersionHistory } from "./routing/versionHistory";
import { applyDraft, draftError, draftFromConfig, draftsEqual } from "./routingConfigEditor";
import { GlassCard, JsonPanel, PageState, PageTitle, StatusBadge } from "./ui";

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
  return (
    <div className="page page-enter routing-detail-stack">
      <PageTitle
        title={query.data.config.name}
        subtitle={query.data.config.description ?? "No description"}
        actions={
          <>
            <StatusBadge status={query.data.config.status} />
            <Link to="/routing-configs" className="btn"><ArrowLeft />All configs</Link>
          </>
        }
      />
      <FactsStrip detail={query.data} activeVersion={activeVersion} />
      <ConfigApiKeysCard configId={configId} />
      {activeVersion ? <ConfigEditorCard key={activeVersion.id} configId={configId} version={activeVersion} /> : <MissingActiveConfig />}
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
      {activeVersion ? <JsonPanel title="Active config JSON" value={activeVersion.config} /> : null}
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
        detail={classifier ? `${classifier.provider} · ${formatInteger(classifier.maxAttempts)} attempts` : undefined}
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

function ConfigEditorCard({ configId, version }: { configId: string; version: RoutingConfigVersionDetail }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(() => draftFromConfig(version.config));
  const [activateAfterSave, setActivateAfterSave] = useState(true);
  const [validationError, setValidationError] = useState<string>();
  const saveMutation = useMutation({
    mutationFn: async () => {
      const created = await createRoutingConfigVersion(configId, applyDraft(version.config, draft));
      if (!activateAfterSave) return created;
      const newest = [...created.versions].sort((left, right) => right.version - left.version)[0];
      return newest ? activateRoutingConfigVersion(configId, newest.id) : created;
    },
    onSuccess: (detail) => {
      queryClient.setQueryData(["routing-config", configId], detail);
      queryClient.invalidateQueries({ queryKey: ["routing-configs"] });
    }
  });
  const dirty = !draftsEqual(draft, draftFromConfig(version.config));
  const error = validationError ?? saveMutation.error?.message;

  return (
    <GlassCard className="routing-configs-card">
      <form className="routing-config-edit-form" onSubmit={(event) => {
        event.preventDefault();
        const nextError = draftError(draft);
        setValidationError(nextError);
        if (!nextError) saveMutation.mutate();
      }}>
        <div className="card-head">
          <div>
            <div className="card-title"><PenLine />Prompts &amp; route models</div>
            <div className="faint">Saving creates a new version from v{version.version} · max route {String(version.config.limits.maxRoute ?? "unknown")}</div>
          </div>
          <div className="row gap-8">
            <label className="row gap-8 faint">
              <input
                type="checkbox"
                checked={activateAfterSave}
                onChange={(event) => setActivateAfterSave(event.target.checked)}
              />
              Activate immediately
            </label>
            <button className="btn btn-primary" type="submit" disabled={!dirty || saveMutation.isPending}>
              {saveMutation.isPending ? "Saving" : "Save new version"}
            </button>
          </div>
        </div>
        <PromptEditors draft={draft} onChange={setDraft} />
        <div className="editor-subhead"><Layers />Route tier models</div>
        <RouteMatrixEditor draft={draft} baseConfig={version.config} onChange={setDraft} />
        {error ? <div className="action-error">{error}</div> : null}
      </form>
    </GlassCard>
  );
}
