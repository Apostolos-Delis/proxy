import { Boxes, ChevronRight, Cloud, GitBranch, Shield } from "lucide-react";
import { useState, type ReactNode } from "react";

import {
  logicalModelProviders,
  logicalModelResolution,
  logicalModelSearchValue,
  logicalModelStatus,
  logicalModelTargetStatus,
  readinessReasonLabel,
  type LogicalModelSummary
} from "../modelsPageData";
import {
  ConsoleTable,
  optionItems,
  type ConsoleTableAdvancedField,
  type ConsoleTableColumn,
  type ConsoleTableFilter
} from "../table";
import { Badge, StatusIndicator } from "../ui";

export function ModelsTable({ models }: { models: LogicalModelSummary[] }) {
  const [expandedModelId, setExpandedModelId] = useState<string | null>(null);
  const toggleModel = (modelId: string) => setExpandedModelId(expandedModelId === modelId ? null : modelId);

  return (
    <section className="models-catalog" aria-labelledby="logical-models-title">
      <div className="models-section-head">
        <div>
          <div className="card-title" id="logical-models-title"><Boxes />Logical models</div>
          <div className="stat-sub">Direct models resolve to one deployment; routers classify requests across eligible targets.</div>
        </div>
        <span className="models-count mono">{models.length} {models.length === 1 ? "model" : "models"}</span>
      </div>
      <ConsoleTable
        className="models-table-card"
        urlState
        data={models}
        columns={modelColumns(expandedModelId, toggleModel)}
        search={{ placeholder: "Search models, targets, providers...", getValue: logicalModelSearchValue }}
        filters={modelFilters(models)}
        advancedFields={modelAdvancedFields}
        emptyLabel={models.length === 0 ? "No logical models configured." : "No logical models match these filters."}
        initialPageSize={25}
        pageSizeOptions={[25, 50, 100]}
        renderExpandedRow={(model) => expandedModelId === model.id ? <ModelDetails model={model} /> : null}
      />
    </section>
  );
}

function modelColumns(expandedModelId: string | null, onToggle: (modelId: string) => void): ConsoleTableColumn<LogicalModelSummary>[] {
  return [
    {
      id: "model",
      header: "Model",
      size: 330,
      accessorFn: (model) => model.name,
      cell: ({ row }) => (
        <button
          type="button"
          className="model-expand-button"
          aria-expanded={expandedModelId === row.original.id}
          onClick={() => onToggle(row.original.id)}
        >
          <ChevronRight />
          <span className="model-identity">
            <strong>{row.original.name}</strong>
            <span className="mono">{row.original.slug}</span>
            {row.original.description ? <span className="model-description" title={row.original.description}>{row.original.description}</span> : null}
          </span>
        </button>
      )
    },
    {
      id: "resolution",
      header: "Resolution",
      size: 130,
      accessorFn: logicalModelResolution,
      cell: ({ row }) => (
        <Badge variant={row.original.kind === "router" ? "accent" : undefined}>
          {logicalModelResolution(row.original)}
        </Badge>
      )
    },
    {
      id: "routes",
      header: "Routes",
      size: 230,
      accessorFn: (model) => model.targets.length,
      cell: ({ row }) => <RouteSummary model={row.original} />
    },
    {
      id: "access",
      header: "Access",
      size: 200,
      accessorFn: (model) => model.profiles.join(", "),
      cell: ({ row }) => <AccessSummary profiles={row.original.profiles} />
    },
    {
      id: "status",
      header: "Status",
      size: 130,
      accessorFn: logicalModelStatus,
      cell: ({ row }) => <StatusIndicator status={logicalModelStatus(row.original)} />
    }
  ];
}

function RouteSummary({ model }: { model: LogicalModelSummary }) {
  if (model.targets.length === 0) return <span className="faint">No targets</span>;
  if (model.kind === "direct" && model.targets.length === 1) {
    const target = model.targets[0]!;
    return (
      <div className="model-cell-stack">
        <span className="mono model-cell-primary" title={target.upstreamModelId}>{target.upstreamModelId}</span>
        <span className="model-cell-secondary">{target.provider}</span>
      </div>
    );
  }
  const providers = logicalModelProviders(model);
  return (
    <div className="model-cell-stack">
      <span className="model-cell-primary">{model.targets.length} targets</span>
      <span className="model-cell-secondary">{providers.join(" · ") || "No providers"}</span>
    </div>
  );
}

function AccessSummary({ profiles }: { profiles: string[] }) {
  if (profiles.length === 0) return <span className="faint">No profiles</span>;
  return (
    <div className="model-cell-stack">
      <span className="model-cell-primary">{profiles.length} {profiles.length === 1 ? "profile" : "profiles"}</span>
      <span className="model-cell-secondary" title={profiles.join(", ")}>{profiles[0]}{profiles.length > 1 ? ` +${profiles.length - 1}` : ""}</span>
    </div>
  );
}

function ModelDetails({ model }: { model: LogicalModelSummary }) {
  return (
    <div className="model-expanded-panel">
      <div className="model-expanded-facts">
        <ModelFact label="Compatibility">
          {model.wires.length > 0 ? model.wires.map((wire) => <Badge key={wire}>{wire}</Badge>) : <span className="faint">No available API wires</span>}
        </ModelFact>
        <ModelFact label="Access profiles">
          {model.profiles.length > 0 ? model.profiles.map((profile) => <Badge key={profile}>{profile}</Badge>) : <span className="faint">No access profiles</span>}
        </ModelFact>
        {model.kind === "router" ? (
          <ModelFact label="Classifier">
            <span>{model.classifierDeployment ?? "Not configured"}</span>
            {model.classifierReasonCodes.length > 0 ? <span className="model-detail-warning">{readinessReasonLabel(model.classifierReasonCodes)}</span> : null}
          </ModelFact>
        ) : null}
        {!model.available && model.reasonCodes.length > 0 ? (
          <ModelFact label="Model readiness">
            <StatusIndicator status={logicalModelStatus(model)} />
            <span className="model-detail-warning">{readinessReasonLabel(model.reasonCodes)}</span>
          </ModelFact>
        ) : null}
      </div>
      {model.kind === "router" && model.routingPolicy ? (
        <div className="model-policy">
          <span className="model-detail-label"><GitBranch />Routing policy</span>
          <p>{model.routingPolicy}</p>
        </div>
      ) : null}
      <div className="model-targets">
        <div className="model-targets-head">
          <span className="model-detail-label"><Cloud />Target deployments</span>
          <span className="mono faint">{model.targets.length}</span>
        </div>
        {model.targets.length > 0 ? (
          <div className="model-target-list" role="list">
            {model.targets.map((target) => (
              <div className="model-target-row" role="listitem" key={target.targetId}>
                <span className="model-target-priority mono">{target.priority + 1}</span>
                <span className="model-target-identity">
                  <strong>{target.deploymentName}</strong>
                  <span className="mono" title={target.upstreamModelId}>{target.upstreamModelId}</span>
                </span>
                <span className="model-target-provider">{target.provider}</span>
                <span className="model-target-wires">
                  {target.wires.length > 0 ? target.wires.map((wire) => <Badge key={wire}>{wire}</Badge>) : <span className="faint">No wires</span>}
                </span>
                <span className="model-target-status">
                  <StatusIndicator status={logicalModelTargetStatus(target)} />
                  {!target.available && target.reasonCodes.length > 0 ? <span className="model-detail-warning">{readinessReasonLabel(target.reasonCodes)}</span> : null}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="model-target-empty"><Shield />No target deployments configured.</div>
        )}
      </div>
    </div>
  );
}

function ModelFact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="model-fact">
      <span className="model-detail-label">{label}</span>
      <div>{children}</div>
    </div>
  );
}

const modelAdvancedFields: ConsoleTableAdvancedField<LogicalModelSummary>[] = [
  { id: "name", label: "Name", getValue: (model) => model.name },
  { id: "slug", label: "Slug", getValue: (model) => model.slug },
  { id: "description", label: "Description", getValue: (model) => model.description },
  { id: "resolution", label: "Resolution", getValue: logicalModelResolution },
  { id: "status", label: "Status", getValue: logicalModelStatus },
  { id: "provider", label: "Provider", getValue: logicalModelProviders },
  { id: "target", label: "Target model", getValue: (model) => model.targets.flatMap((target) => [target.deploymentName, target.upstreamModelId]) },
  { id: "wire", label: "API wire", getValue: (model) => model.wires },
  { id: "access", label: "Access profile", getValue: (model) => model.profiles }
];

function modelFilters(models: LogicalModelSummary[]): ConsoleTableFilter<LogicalModelSummary>[] {
  return [
    { id: "status", label: "Status", allLabel: "All statuses", options: optionItems(models.map(logicalModelStatus)), getValue: logicalModelStatus },
    { id: "resolution", label: "Resolution", allLabel: "All resolutions", options: optionItems(models.map(logicalModelResolution)), getValue: logicalModelResolution },
    { id: "provider", label: "Provider", allLabel: "All providers", options: optionItems(models.flatMap(logicalModelProviders)), getValue: logicalModelProviders }
  ];
}
