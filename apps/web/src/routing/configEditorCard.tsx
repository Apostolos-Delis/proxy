import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Braces, Layers, PenLine, SlidersHorizontal } from "lucide-react";
import { useMemo, useState } from "react";

import { JsonEditor } from "../jsonView";
import type { RoutingConfigDocument } from "../routingConfigEditor";
import { applyDraft, draftError, draftFromConfig, emptyRoutingEditorCatalog, parseConfigJson } from "../routingConfigEditor";
import { GlassCard } from "../ui";
import {
  activateRoutingConfigVersion,
  createRoutingConfigVersion,
  fetchRoutingModelCatalog,
  type RoutingConfigVersionDetail
} from "./data";
import { RequestBudgetEditor, RoutingRulesEditor, RouteTargetsEditor } from "./configEditorFields";

export function ConfigEditorCard({ configId, version }: { configId: string; version: RoutingConfigVersionDetail }) {
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
  const catalog = catalogQuery.data ?? emptyRoutingEditorCatalog();
  const candidate = view === "form" ? applyDraft(baseConfig, draft, catalog) : jsonResult?.config;
  const dirty = candidate !== undefined && JSON.stringify(candidate) !== savedConfigJson;
  const error = validationError ?? jsonResult?.error ?? saveMutation.error?.message;
  const saveDisabled = !dirty || saveMutation.isPending || (view === "form" && catalogQuery.isLoading);

  const switchView = (next: "form" | "json") => {
    if (next === view) return;
    setValidationError(undefined);
    if (next === "json") {
      setJsonText(JSON.stringify(applyDraft(baseConfig, draft, catalog), null, 2));
      setView("json");
      return;
    }
    const parsed = parseConfigJson(jsonText);
    if (!parsed.config) return;
    setBaseConfig(parsed.config);
    setDraft(draftFromConfig(parsed.config));
    setView("form");
  };
  const formValidationError = () => {
    if (catalogQuery.data) return draftError(draft, catalogQuery.data);
    return catalogQuery.error?.message ?? "Routing model catalog is still loading.";
  };

  return (
    <GlassCard>
      <form className="routing-config-edit-form" onSubmit={(event) => {
        event.preventDefault();
        if (!candidate) return;
        const nextError = view === "form" ? formValidationError() : undefined;
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
            <button className="btn btn-primary" type="submit" disabled={saveDisabled}>
              {saveMutation.isPending ? "Saving" : "Save new version"}
            </button>
          </div>
        </div>
        {view === "form" ? (
          <>
            <RoutingRulesEditor draft={draft} onChange={setDraft} />
            <RequestBudgetEditor draft={draft} onChange={setDraft} />
            <div className="editor-subhead"><Layers />Route tier models</div>
            <RouteTargetsEditor
              draft={draft}
              baseConfig={baseConfig}
              catalog={catalog}
              onChange={setDraft}
            />
            {catalogQuery.error ? <div className="action-error">{catalogQuery.error.message}</div> : null}
          </>
        ) : (
          <div className="config-json-editor">
            <p className="proxy-editor-helper">
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
