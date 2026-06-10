import type { RoutingConfigDocument, RoutingConfigProviderSettings } from "./api";
import { DataTable, RouteBadge } from "./ui";

export const editorRouteOrder = ["fast", "balanced", "hard", "deep"] as const;

export type EditorRouteName = typeof editorRouteOrder[number];

export type ConfigEditorDraft = {
  systemPrompt: string;
  routes: Record<EditorRouteName, { openaiModel: string; anthropicModel: string }>;
};

export function draftFromConfig(config: RoutingConfigDocument): ConfigEditorDraft {
  const routes = {} as ConfigEditorDraft["routes"];
  for (const route of editorRouteOrder) {
    routes[route] = {
      openaiModel: config.routes[route]?.openai?.model ?? "",
      anthropicModel: config.routes[route]?.anthropic?.model ?? ""
    };
  }
  return {
    systemPrompt: config.systemPrompt ?? "",
    routes
  };
}

export function applyDraft(base: RoutingConfigDocument, draft: ConfigEditorDraft): RoutingConfigDocument {
  const routes: RoutingConfigDocument["routes"] = { ...base.routes };
  for (const route of editorRouteOrder) {
    const baseRoute = base.routes[route] ?? {};
    const nextRoute = { ...baseRoute };
    const openai = providerBlock(baseRoute.openai, draft.routes[route].openaiModel);
    const anthropic = providerBlock(baseRoute.anthropic, draft.routes[route].anthropicModel);
    if (openai) nextRoute.openai = openai;
    else delete nextRoute.openai;
    if (anthropic) nextRoute.anthropic = anthropic;
    else delete nextRoute.anthropic;
    routes[route] = nextRoute;
  }
  const next = { ...base, routes };
  const systemPrompt = draft.systemPrompt.trim();
  if (systemPrompt) next.systemPrompt = systemPrompt;
  else delete next.systemPrompt;
  return next;
}

export function draftError(draft: ConfigEditorDraft): string | undefined {
  const missing = editorRouteOrder.filter((route) =>
    !draft.routes[route].openaiModel.trim() && !draft.routes[route].anthropicModel.trim()
  );
  if (missing.length === 0) return undefined;
  return `Each tier needs at least one model. Missing: ${missing.join(", ")}.`;
}

export function draftsEqual(left: ConfigEditorDraft, right: ConfigEditorDraft) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function ConfigEditorFields({ draft, baseConfig, onChange }: {
  draft: ConfigEditorDraft;
  baseConfig: RoutingConfigDocument;
  onChange: (draft: ConfigEditorDraft) => void;
}) {
  const setRouteModel = (route: EditorRouteName, provider: "openaiModel" | "anthropicModel", model: string) => {
    onChange({
      ...draft,
      routes: {
        ...draft.routes,
        [route]: { ...draft.routes[route], [provider]: model }
      }
    });
  };
  return (
    <div className="route-matrix-editor">
      <label className="routing-create-field">
        <span>System prompt</span>
        <textarea
          value={draft.systemPrompt}
          rows={3}
          placeholder="Prepended to the system prompt of every routed request. Leave empty to forward harness prompts unchanged."
          onChange={(event) => onChange({ ...draft, systemPrompt: event.target.value })}
        />
      </label>
      <DataTable>
        <thead><tr><th>Tier</th><th>OpenAI model</th><th>Anthropic model</th><th>Description</th></tr></thead>
        <tbody>
          {editorRouteOrder.map((route) => {
            const tier = baseConfig.routes[route];
            return (
              <tr key={route}>
                <td><RouteBadge route={route} /></td>
                <td>
                  <ModelInput
                    value={draft.routes[route].openaiModel}
                    hint={effortHint(tier?.openai)}
                    onChange={(model) => setRouteModel(route, "openaiModel", model)}
                  />
                </td>
                <td>
                  <ModelInput
                    value={draft.routes[route].anthropicModel}
                    hint={effortHint(tier?.anthropic)}
                    onChange={(model) => setRouteModel(route, "anthropicModel", model)}
                  />
                </td>
                <td className="faint">{tier?.description ?? "No description"}</td>
              </tr>
            );
          })}
        </tbody>
      </DataTable>
    </div>
  );
}

function ModelInput({ value, hint, onChange }: {
  value: string;
  hint?: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="routing-create-field route-model-field">
      <input
        value={value}
        placeholder="none"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint ? <span className="faint">{hint}</span> : null}
    </div>
  );
}

function effortHint(settings?: RoutingConfigProviderSettings) {
  const effort = settings?.reasoning?.effort ?? settings?.output_config?.effort;
  if (effort) return `effort ${effort}`;
  return settings?.thinking?.type ? `thinking ${settings.thinking.type}` : undefined;
}

function providerBlock(base: RoutingConfigProviderSettings | undefined, model: string) {
  const trimmed = model.trim();
  if (!trimmed) return undefined;
  return { ...base, model: trimmed };
}
