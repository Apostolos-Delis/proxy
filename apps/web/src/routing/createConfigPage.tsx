import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, FilePlus2, KeyRound, Layers } from "lucide-react";
import { useState, type ReactNode } from "react";

import {
  assignApiKeyRoutingConfig,
  createRoutingConfig,
  fetchApiKeys,
  fetchRoutingConfigDetail,
  fetchRoutingConfigs,
  type ApiKeySummary,
  type CreateRoutingConfigInput,
  type RoutingConfigSummary,
  type RoutingConfigVersionDetail
} from "./data";
import { applyDraft, draftError, draftFromConfig, type ConfigEditorDraft } from "../routingConfigEditor";
import { MenuSelect } from "../table/MenuSelect";
import { GlassCard, PageState, PageTitle } from "../ui";
import { RoutingRulesEditor, RouteMatrixEditor } from "./configEditorFields";
import { isUsableKey, KeyPickList } from "./keyAssignment";

type CreateForm = {
  name: string;
  slug: string;
  description: string;
  sourceConfigId: string;
};

type CreateErrors = Partial<Record<keyof CreateForm, string>>;

export function CreateRoutingConfigPage() {
  const [configsQuery, keysQuery] = useQueries({
    queries: [
      { queryKey: ["routing-configs"], queryFn: fetchRoutingConfigs },
      { queryKey: ["api-keys"], queryFn: fetchApiKeys }
    ]
  });

  if (configsQuery.isLoading) return <PageState title="New routing config" label="Loading routing configs" />;
  if (configsQuery.error) return <PageState title="New routing config" label={configsQuery.error.message} />;

  const sourceConfigs = (configsQuery.data ?? []).filter(
    (config) => config.status === "active" && Boolean(config.activeVersion)
  );
  if (sourceConfigs.length === 0) {
    return <PageState title="New routing config" label="Creating a config requires an active source config to clone." />;
  }
  const apiKeys = (keysQuery.data ?? []).filter(isUsableKey);
  return <CreateConfigForm sourceConfigs={sourceConfigs} apiKeys={apiKeys} />;
}

function CreateConfigForm({ sourceConfigs, apiKeys }: {
  sourceConfigs: RoutingConfigSummary[];
  apiKeys: ApiKeySummary[];
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<CreateForm>(() => ({
    name: "",
    slug: "",
    description: "",
    sourceConfigId: sourceConfigs[0]?.id ?? ""
  }));
  const [errors, setErrors] = useState<CreateErrors>({});
  const [editorError, setEditorError] = useState<string>();
  const [draftState, setDraftState] = useState<{ versionId: string; draft: ConfigEditorDraft } | null>(null);
  const [selectedKeyIds, setSelectedKeyIds] = useState<ReadonlySet<string>>(new Set());

  const sourceQuery = useQuery({
    queryKey: ["routing-config", form.sourceConfigId],
    queryFn: () => fetchRoutingConfigDetail(form.sourceConfigId),
    enabled: Boolean(form.sourceConfigId)
  });
  const sourceVersion = sourceQuery.data?.versions.find((version) => version.active);
  const draft = deriveDraft(draftState, sourceVersion);

  const createMutation = useMutation({
    mutationFn: async (input: { create: CreateRoutingConfigInput; keyIds: string[] }) => {
      const detail = await createRoutingConfig(input.create);
      try {
        for (const keyId of input.keyIds) {
          await assignApiKeyRoutingConfig(keyId, detail.config.id);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Config created, but assigning keys failed: ${message}. Attach keys from the config page.`);
      }
      return detail;
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["routing-configs"] });
      queryClient.invalidateQueries({ queryKey: ["api-keys"] });
    },
    onSuccess: (detail) => {
      navigate({ to: "/routing-configs/$configId", params: { configId: detail.config.id } });
    }
  });

  const submit = () => {
    const nextErrors = validateCreateForm(form);
    const nextEditorError = !sourceVersion || !draft
      ? "Source routing config has no active version."
      : draftError(draft);
    setErrors(nextErrors);
    setEditorError(nextEditorError);
    if (Object.keys(nextErrors).length > 0 || nextEditorError || !sourceVersion || !draft) return;
    const description = form.description.trim();
    createMutation.mutate({
      create: {
        name: form.name.trim(),
        slug: form.slug.trim(),
        description: description || null,
        config: {
          ...applyDraft(sourceVersion.config, draft),
          displayName: form.name.trim(),
          description: description || undefined
        }
      },
      keyIds: [...selectedKeyIds]
    });
  };

  return (
    <div className="page page-enter routing-create-page">
      <PageTitle
        title="New routing config"
        subtitle="Clone an active config, set its prompts and tier models, then point API keys at it."
        actions={<Link to="/routing-configs" className="btn"><ArrowLeft />All configs</Link>}
      />
      <form className="routing-create-form" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <GlassCard>
          <div className="card-head">
            <div className="card-title"><FilePlus2 />Basics</div>
          </div>
          <div className="routing-basics">
          <div className="routing-create-grid">
            <Field label="Name" error={errors.name}>
              <input value={form.name} placeholder="Production coding agents" onChange={(event) => {
                const name = event.target.value;
                setForm((value) => {
                  const syncSlug = !value.slug || value.slug === slugFor(value.name);
                  return { ...value, name, slug: syncSlug ? slugFor(name) : value.slug };
                });
              }} />
            </Field>
            <Field label="Slug" error={errors.slug}>
              <input value={form.slug} placeholder="production-coding-agents" onChange={(event) => {
                const slug = slugFor(event.target.value);
                setForm((value) => ({ ...value, slug }));
              }} />
            </Field>
            <div className="routing-create-field">
              <span>Clone from</span>
              <MenuSelect
                value={form.sourceConfigId}
                options={sourceConfigs.map((config) => ({
                  value: config.id,
                  label: `${config.name} · v${config.activeVersion?.version ?? "?"}`
                }))}
                ariaLabel="Clone from"
                onChange={(sourceConfigId) => setForm((value) => ({ ...value, sourceConfigId }))}
              />
              {errors.sourceConfigId ? <small>{errors.sourceConfigId}</small> : null}
            </div>
          </div>
          <Field label="Description" error={errors.description}>
            <textarea
              value={form.description}
              rows={2}
              placeholder="When this routing config should be assigned."
              onChange={(event) => setForm((value) => ({ ...value, description: event.target.value }))}
            />
          </Field>
          </div>
        </GlassCard>
        {sourceVersion && draft ? (
          <>
            <GlassCard>
              <RoutingRulesEditor
                draft={draft}
                onChange={(next) => setDraftState({ versionId: sourceVersion.id, draft: next })}
              />
            </GlassCard>
            <GlassCard>
              <div className="card-head">
                <div>
                  <div className="card-title"><Layers />Route tier models</div>
                  <div className="faint">The model each tier uses per provider. Every tier needs at least one model.</div>
                </div>
              </div>
              <RouteMatrixEditor
                draft={draft}
                baseConfig={sourceVersion.config}
                onChange={(next) => setDraftState({ versionId: sourceVersion.id, draft: next })}
              />
            </GlassCard>
          </>
        ) : (
          <GlassCard>
            <div className="faint">{sourceQuery.error?.message ?? "Loading source config…"}</div>
          </GlassCard>
        )}
        <GlassCard>
          <div className="card-head">
            <div>
              <div className="card-title"><KeyRound />Assign API keys</div>
              <div className="faint">Selected keys switch to this config as soon as it is created.</div>
            </div>
            <span className="faint">{selectedKeyIds.size} selected</span>
          </div>
          <KeyPickList
            keys={apiKeys}
            selectedIds={selectedKeyIds}
            onToggle={(keyId) => setSelectedKeyIds((current) => {
              const next = new Set(current);
              if (next.has(keyId)) next.delete(keyId);
              else next.add(keyId);
              return next;
            })}
          />
        </GlassCard>
        <div className="routing-create-actions">
          <div className="routing-create-errors">
            {editorError ? <div className="action-error">{editorError}</div> : null}
            {createMutation.error ? <div className="action-error">{createMutation.error.message}</div> : null}
          </div>
          <Link to="/routing-configs" className="btn">Cancel</Link>
          <button className="btn btn-primary" type="submit" disabled={createMutation.isPending}>
            {createMutation.isPending ? "Creating…" : "Create config"}
          </button>
        </div>
      </form>
    </div>
  );
}

function deriveDraft(
  draftState: { versionId: string; draft: ConfigEditorDraft } | null,
  sourceVersion: RoutingConfigVersionDetail | undefined
) {
  if (draftState && draftState.versionId === sourceVersion?.id) return draftState.draft;
  if (sourceVersion) return draftFromConfig(sourceVersion.config);
  return null;
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

function validateCreateForm(form: CreateForm) {
  const errors: CreateErrors = {};
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
