import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Braces, Layers, PenLine, SlidersHorizontal } from "lucide-react";
import { useMemo, useState } from "react";

import {
  activateRoutingConfigVersion,
  archiveRoutingConfig,
  createRoutingConfigVersion,
  fetchRoutingModelCatalog,
  fetchRoutingConfigDetail,
  type RoutingConfigDetail,
  type RoutingConfigVersionDetail
} from "./routing/data";
import type { RoutingConfigDocument } from "./routingConfigEditor";
import { compactId, formatDateTime, formatInteger } from "./format";
import { ConfigApiKeysCard } from "./routing/keyAssignment";
import { RoutingRulesEditor, RouteTargetsEditor } from "./routing/configEditorFields";
import { ArchivePanel, VersionHistory } from "./routing/versionHistory";
import { applyDraft, draftError, draftFromConfig, parseConfigJson } from "./routingConfigEditor";
import { JsonEditor } from "./jsonView";
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

function ConfigEditorCard({ configId, version }: { configId: string; version: RoutingConfigVersionDetail }) {
  const queryClient = useQueryClient();
  const catalogQuery = useQuery({
    queryKey: ["routing-model-catalog"],
    queryFn: fetchRoutingModelCatalog
  });
  const [baseConfig, setBaseConfig] = useState(version.config);
  const [draft, setDraft] = useState(() => draftFromConfig(version.config));
  const [view, setView] = useState<"form" | "json">("form");
  const [jsonText, setJsonText] = useState("");
  const [activateAfterSave, setActivateAfterSave] = useState(true);
  const [validationError, setValidationError] = useState<string>();
  const saveMutation = useMutation({
    mutationFn: async (config: RoutingConfigDocument) => {
      const created = await createRoutingConfigVersion(configId, config);
      if (!activateAfterSave) return created;
      const newest = [...created.versions].sort((left, right) => right.version - left.version)[0];
      return newest ? activateRoutingConfigVersion(configId, newest.id) : created;
    },
    onSuccess: (detail) => {
      queryClient.setQueryData(["routing-config", configId], detail);
      queryClient.invalidateQueries({ queryKey: ["routing-configs"] });
    }
  });

  const savedConfigJson = useMemo(() => JSON.stringify(version.config), [version.config]);
  const jsonResult = view === "json" ? parseConfigJson(jsonText) : undefined;
  const candidate = view === "form" ? applyDraft(baseConfig, draft) : jsonResult?.config;
  const dirty = candidate !== undefined && JSON.stringify(candidate) !== savedConfigJson;
  const error = validationError ?? jsonResult?.error ?? saveMutation.error?.message;

  const switchView = (next: "form" | "json") => {
    if (next === view) return;
    setValidationError(undefined);
    if (next === "json") {
      setJsonText(JSON.stringify(applyDraft(baseConfig, draft), null, 2));
      setView("json");
      return;
    }
    const parsed = parseConfigJson(jsonText);
    if (!parsed.config) return;
    setBaseConfig(parsed.config);
    setDraft(draftFromConfig(parsed.config));
    setView("form");
  };

  return (
    <GlassCard>
      <form className="routing-config-edit-form" onSubmit={(event) => {
        event.preventDefault();
        if (!candidate) return;
        const nextError = view === "form" ? draftError(draft) : undefined;
        setValidationError(nextError);
        if (!nextError) saveMutation.mutate(candidate);
      }}>
        <div className="card-head">
          <div>
            <div className="card-title"><PenLine />Prompts &amp; route models</div>
            <div className="faint">Saving creates a new version from v{version.version} · max route {String(version.config.limits.maxRoute ?? "unknown")}</div>
          </div>
          <div className="row gap-8">
            <div className="segmented editor-view-toggle">
              <button
                type="button"
                className={view === "form" ? "active" : ""}
                disabled={view === "json" && !jsonResult?.config}
                title={view === "json" && !jsonResult?.config ? "Fix the JSON before switching back" : undefined}
                onClick={() => switchView("form")}
              >
                <SlidersHorizontal />UI
              </button>
              <button
                type="button"
                className={view === "json" ? "active" : ""}
                onClick={() => switchView("json")}
              >
                <Braces />JSON
              </button>
            </div>
            <label className="row gap-8 faint">
              <input
                type="checkbox"
                role="switch"
                checked={activateAfterSave}
                aria-checked={activateAfterSave}
                onChange={(event) => setActivateAfterSave(event.target.checked)}
              />
              Activate immediately
            </label>
            <button className="btn btn-primary" type="submit" disabled={!dirty || saveMutation.isPending}>
              {saveMutation.isPending ? "Saving" : "Save new version"}
            </button>
          </div>
        </div>
        {view === "form" ? (
          <>
            <RoutingRulesEditor draft={draft} onChange={setDraft} />
            <div className="editor-subhead"><Layers />Route tier models</div>
            <RouteTargetsEditor
              draft={draft}
              baseConfig={baseConfig}
              catalog={catalogQuery.data ?? { providers: [], models: [] }}
              onChange={setDraft}
            />
            {catalogQuery.error ? <div className="action-error">{catalogQuery.error.message}</div> : null}
          </>
        ) : (
          <div className="config-json-editor">
            <p className="prompt-editor-helper">
              The full config document — classifier, route tiers, limits, and session policy. Edits here cover settings the form does not expose and are validated server-side on save.
            </p>
            <JsonEditor value={jsonText} onChange={setJsonText} />
          </div>
        )}
        {error ? <div className="action-error">{error}</div> : null}
      </form>
    </GlassCard>
  );
}
