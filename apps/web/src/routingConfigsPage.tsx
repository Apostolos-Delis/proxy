import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitBranch, KeyRound, Plus, Settings2, X } from "lucide-react";
import { useState, type ReactNode } from "react";

import {
  createRoutingConfig,
  fetchRoutingConfigDetail,
  fetchRoutingConfigs,
  type CreateRoutingConfigInput,
  type RoutingConfigRouteMatrixRow,
  type RoutingConfigSummary
} from "./api";
import { compactId, formatDateTime, formatInteger } from "./format";
import {
  applyDraft,
  ConfigEditorFields,
  draftError,
  draftFromConfig,
  type ConfigEditorDraft
} from "./routingConfigEditor";
import { Badge, DataTable, GlassCard, PageState, PageTitle, RouteBadge, StatusBadge } from "./ui";

type CreateRoutingConfigForm = {
  name: string;
  slug: string;
  description: string;
  sourceConfigId: string;
};

type CreateRoutingConfigErrors = Partial<Record<keyof CreateRoutingConfigForm, string>>;

export function RoutingConfigsPage() {
  const [showCreate, setShowCreate] = useState(false);
  const query = useQuery({ queryKey: ["routing-configs"], queryFn: fetchRoutingConfigs });

  if (query.isLoading) return <PageState title="Routing configs" label="Loading routing configs" />;
  if (query.error) return <PageState title="Routing configs" label={query.error.message} />;

  const configs = query.data?.data ?? [];
  const createButton = (
    <button className="btn btn-primary" type="button" onClick={() => setShowCreate((open) => !open)}>
      {showCreate ? <X /> : <Plus />}
      {showCreate ? "Close" : "New config"}
    </button>
  );

  return (
    <div className="page page-enter">
      <PageTitle
        title="Routing configs"
        subtitle="Model tiers, classifier settings, and API key assignment targets."
        actions={<><Link to="/settings" className="btn"><Settings2 />Runtime settings</Link>{createButton}</>}
      />
      {showCreate ? <CreateRoutingConfigPanel configs={configs} onCreated={() => setShowCreate(false)} /> : null}
      <GlassCard className="table-wrap routing-configs-card">
        <DataTable>
          <thead>
            <tr><th>Config</th><th>Status</th><th>Active version</th><th>Route matrix</th><th>API keys</th><th>Updated</th></tr>
          </thead>
          <tbody>{configs.map((config) => <RoutingConfigRow key={config.id} config={config} />)}</tbody>
        </DataTable>
        {configs.length === 0 ? <RoutingConfigsEmpty /> : null}
      </GlassCard>
    </div>
  );
}

function CreateRoutingConfigPanel({ configs, onCreated }: { configs: RoutingConfigSummary[]; onCreated: () => void }) {
  const sourceConfigs = configs.filter((config) => config.status === "active" && Boolean(config.activeVersion));
  const [form, setForm] = useState<CreateRoutingConfigForm>(() => ({
    name: "",
    slug: "",
    description: "",
    sourceConfigId: sourceConfigs[0]?.id ?? ""
  }));
  const [errors, setErrors] = useState<CreateRoutingConfigErrors>({});
  const [editorError, setEditorError] = useState<string>();
  const [draftState, setDraftState] = useState<{ versionId: string; draft: ConfigEditorDraft } | null>(null);
  const queryClient = useQueryClient();
  const sourceQuery = useQuery({
    queryKey: ["routing-config", form.sourceConfigId],
    queryFn: () => fetchRoutingConfigDetail(form.sourceConfigId),
    enabled: Boolean(form.sourceConfigId)
  });
  const sourceVersion = sourceQuery.data?.versions.find((version) => version.active);
  const draft = draftState && draftState.versionId === sourceVersion?.id
    ? draftState.draft
    : sourceVersion
      ? draftFromConfig(sourceVersion.config)
      : null;
  const createMutation = useMutation({
    mutationFn: (input: CreateRoutingConfigInput) => createRoutingConfig(input),
    onSuccess: (detail) => {
      queryClient.setQueryData<{ data: RoutingConfigSummary[] }>(["routing-configs"], (current) => ({
        data: [detail.config, ...(current?.data ?? []).filter((config) => config.id !== detail.config.id)]
      }));
      queryClient.invalidateQueries({ queryKey: ["routing-configs"] });
      setForm({ name: "", slug: "", description: "", sourceConfigId: sourceConfigs[0]?.id ?? "" });
      setErrors({});
      setEditorError(undefined);
      setDraftState(null);
      onCreated();
    }
  });
  const disabled = sourceConfigs.length === 0 || createMutation.isPending;

  return (
    <GlassCard className="routing-config-create">
      <form onSubmit={(event) => {
        event.preventDefault();
        const nextErrors = validateCreateForm(form);
        const nextEditorError = !sourceVersion || !draft
          ? "Source routing config has no active version."
          : draftError(draft);
        setErrors(nextErrors);
        setEditorError(nextEditorError);
        if (Object.keys(nextErrors).length > 0 || nextEditorError || !sourceVersion || !draft) return;
        const description = form.description.trim();
        createMutation.mutate({
          name: form.name.trim(),
          slug: form.slug.trim(),
          description: description || null,
          config: {
            ...applyDraft(sourceVersion.config, draft),
            displayName: form.name.trim(),
            description: description || undefined
          }
        });
      }}>
        <div className="card-head routing-create-head">
          <div>
            <div className="card-title"><Plus />New routing config</div>
            <div className="faint">Clone an active config, then set its system prompt and route tier models.</div>
          </div>
          <button className="btn btn-primary" type="submit" disabled={disabled}>
            {createMutation.isPending ? "Creating" : "Create config"}
          </button>
        </div>
        <div className="routing-create-grid">
          <Field label="Name" error={errors.name}>
            <input value={form.name} onChange={(event) => setForm((value) => {
              const name = event.target.value;
              const syncSlug = !value.slug || value.slug === slugFor(value.name);
              return { ...value, name, slug: syncSlug ? slugFor(name) : value.slug };
            })} placeholder="Production coding agents" />
          </Field>
          <Field label="Slug" error={errors.slug}>
            <input value={form.slug} onChange={(event) => setForm((value) => ({
              ...value,
              slug: slugFor(event.target.value)
            }))} placeholder="production-coding-agents" />
          </Field>
          <Field label="Clone from" error={errors.sourceConfigId}>
            <select value={form.sourceConfigId} onChange={(event) => setForm((value) => ({ ...value, sourceConfigId: event.target.value }))}>
              {sourceConfigs.map((config) => (
                <option key={config.id} value={config.id}>{config.name} · v{config.activeVersion?.version ?? "?"}</option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Description" error={errors.description}>
          <textarea value={form.description} onChange={(event) => setForm((value) => ({ ...value, description: event.target.value }))} rows={3} placeholder="When this routing config should be assigned." />
        </Field>
        {sourceVersion && draft ? (
          <ConfigEditorFields
            draft={draft}
            baseConfig={sourceVersion.config}
            onChange={(next) => setDraftState({ versionId: sourceVersion.id, draft: next })}
          />
        ) : sourceQuery.isLoading ? (
          <div className="faint">Loading source config…</div>
        ) : null}
        {sourceConfigs.length === 0 ? <div className="action-error">Create requires an active source routing config.</div> : null}
        {editorError ? <div className="action-error">{editorError}</div> : null}
        {createMutation.error ? <div className="action-error">{createMutation.error.message}</div> : null}
      </form>
    </GlassCard>
  );
}

function Field({ label, error, children }: { label: string; error?: string; children: ReactNode }) {
  return (
    <label className="routing-create-field">
      <span>{label}</span>
      {children}
      {error ? <small>{error}</small> : null}
    </label>
  );
}

function RoutingConfigRow({ config }: { config: RoutingConfigSummary }) {
  return (
    <tr>
      <td>
        <Link to="/routing-configs/$configId" params={{ configId: config.id }} className="table-link">
          {config.name}
        </Link>
        <div className="row gap-8 routing-config-meta">
          {config.slug === "default" ? <Badge variant="accent">Default</Badge> : null}
          <span className="mono faint">{compactId(config.id, 16)}</span>
        </div>
      </td>
      <td><StatusBadge status={config.status} /></td>
      <td><ActiveVersion config={config} /></td>
      <td><RouteMatrixPreview routes={config.routeMatrix} /></td>
      <td><ApiKeyCount count={config.assignedApiKeyCount} /></td>
      <td>{formatDateTime(config.updatedAt)}</td>
    </tr>
  );
}

function ActiveVersion({ config }: { config: RoutingConfigSummary }) {
  if (!config.activeVersion) return <span className="faint">No active version</span>;
  return (
    <div>
      <div className="mono">v{config.activeVersion.version}</div>
      <div className="mono faint">{compactId(config.activeVersion.configHash, 8)}</div>
    </div>
  );
}

function RouteMatrixPreview({ routes }: { routes: RoutingConfigRouteMatrixRow[] }) {
  if (routes.length === 0) return <span className="faint">No active matrix</span>;
  return (
    <div className="route-matrix-preview">
      {routes.map((route) => (
        <div key={route.route} className="route-matrix-row" title={route.description ?? undefined}>
          <RouteBadge route={route.route} />
          <span className="mono faint">{providerRouteLabel("openai", route.openaiModel, route.openaiEffort)}</span>
          <span className="mono faint">{providerRouteLabel("anthropic", route.anthropicModel, route.anthropicEffort)}</span>
        </div>
      ))}
    </div>
  );
}

function ApiKeyCount({ count }: { count: number }) {
  if (count === 0) return <Badge variant="warn" dot>Unused</Badge>;
  return (
    <span className="row gap-8">
      <KeyRound />
      <span>{formatInteger(count)}</span>
    </span>
  );
}

function RoutingConfigsEmpty() {
  return (
    <div className="empty-state routing-configs-empty">
      <GitBranch />
      <strong>No routing configs found</strong>
      <span>Seed a routing config before adding UI-managed variants.</span>
    </div>
  );
}

function providerRouteLabel(provider: string, model: string | null, effort: string | null) {
  if (!model) return `${provider}: none`;
  return effort ? `${provider}: ${model} · ${effort}` : `${provider}: ${model}`;
}

function validateCreateForm(form: CreateRoutingConfigForm) {
  const errors: CreateRoutingConfigErrors = {};
  if (!form.name.trim()) errors.name = "Name is required.";
  if (!form.slug.trim()) errors.slug = "Slug is required.";
  if (form.slug.trim() && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(form.slug.trim())) {
    errors.slug = "Use lowercase letters, numbers, and single hyphens.";
  }
  if (!form.sourceConfigId) errors.sourceConfigId = "Choose an active source config.";
  return errors;
}

function slugFor(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
