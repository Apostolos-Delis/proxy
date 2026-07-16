import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Boxes, Cpu, Download, Layers } from "lucide-react";

import { isListedPromptArtifact } from "./artifactKinds";
import { downloadJson } from "./dashboard";
import { compactId, formatDateTime, formatMoney } from "./format";
import { graphql } from "./gql";
import type { PromptsListQuery } from "./gql/graphql";
import { gqlFetch } from "./graphql";
import { ConsoleTable, optionItems, type ConsoleTableAdvancedField, type ConsoleTableColumn, type ConsoleTableFilter } from "./table";
import { CodePill, PageState, PageTitle, RouteBadge } from "./ui";

const PromptsListDocument = graphql(`
  query PromptsList {
    prompts {
      data {
        artifactId
        userId
        sessionId
        surface
        kind
        preview
        requestedLogicalModel
        resolvedLogicalModelId
        deploymentId
        providerConnectionId
        selectedModel
        createdAt
        cost {
          selected
        }
      }
    }
  }
`);

type PromptSummary = PromptsListQuery["prompts"]["data"][number];

export function PromptsPage() {
  const { data: queryData, isLoading: queryIsLoading, error: queryError } = useQuery({ queryKey: ["prompts"], queryFn: () => gqlFetch(PromptsListDocument) });
  const data = (queryData?.prompts.data ?? []).filter(isVisiblePromptArtifact);

  if (queryIsLoading) return <PageState title="Prompts" label="Loading prompt artifacts" />;
  if (queryError) return <PageState title="Prompts" label={queryError.message} />;

  return (
    <div className="page page-enter">
      <PageTitle title="Prompt capture" subtitle="Raw user and harness prompts captured by organization, user, request, and session." />
      <ConsoleTable
        className="logs-table-card"
        urlState
        data={data}
        columns={promptColumns}
        search={{ placeholder: "Search prompts, users, sessions...", getValue: promptSearchValue }}
        filters={promptFilters(data)}
        advancedFields={promptAdvancedFields}
        emptyLabel="No prompt artifacts captured yet."
        actions={({ visibleData }) => (
          <button className="btn" type="button" onClick={() => downloadJson("proxy-prompt-artifacts.json", visibleData)}>
            <Download />Export
          </button>
        )}
      />
    </div>
  );
}

const promptColumns: ConsoleTableColumn<PromptSummary>[] = [
  {
    id: "proxy",
    header: "Prompt",
    size: 380,
    accessorFn: (prompt) => prompt.preview ?? "",
    cell: ({ row }) => (
      <Link to="/prompts/$artifactId" params={{ artifactId: row.original.artifactId }} className={`table-link${row.original.preview ? "" : " table-link-placeholder"}`}>
        {row.original.preview ?? "Prompt text was not stored for this artifact."}
      </Link>
    )
  },
  { id: "user", header: "User", size: 160, accessorFn: (prompt) => prompt.userId ?? "unknown", cell: ({ row }) => <CodePill value={compactId(row.original.userId ?? "unknown", 8)} /> },
  { id: "session", header: "Session", size: 160, accessorFn: (prompt) => prompt.sessionId ?? "unknown", cell: ({ row }) => <CodePill value={compactId(row.original.sessionId ?? "unknown", 8)} /> },
  { id: "surface", header: "Surface", size: 120, accessorFn: (prompt) => prompt.surface },
  { id: "logicalModel", header: "Logical model", size: 180, accessorFn: promptLogicalModel, cell: ({ row }) => <RouteBadge route={promptLogicalModel(row.original)} /> },
  {
    id: "model",
    header: "Model",
    size: 220,
    accessorFn: promptModel,
    cell: ({ row }) => <span className="mono">{promptModel(row.original)}</span>
  },
  { id: "cost", header: "Cost", size: 96, accessorFn: (prompt) => prompt.cost.selected, cell: ({ row }) => <span className="mono">{formatMoney(row.original.cost.selected)}</span> },
  { id: "created", header: "Created", size: 170, accessorFn: (prompt) => prompt.createdAt, cell: ({ row }) => formatDateTime(row.original.createdAt) }
];

const promptAdvancedFields: ConsoleTableAdvancedField<PromptSummary>[] = [
  { id: "proxy", label: "Prompt", getValue: (prompt) => prompt.preview },
  { id: "user", label: "User", getValue: (prompt) => prompt.userId },
  { id: "session", label: "Session", getValue: (prompt) => prompt.sessionId },
  { id: "surface", label: "Surface", getValue: (prompt) => prompt.surface },
  { id: "logicalModel", label: "Logical model", getValue: promptLogicalModel },
  { id: "model", label: "Model", getValue: promptModel },
  { id: "deployment", label: "Deployment", getValue: (prompt) => prompt.deploymentId },
  { id: "providerConnection", label: "Provider connection", getValue: (prompt) => prompt.providerConnectionId }
];

function promptFilters(prompts: PromptSummary[]): ConsoleTableFilter<PromptSummary>[] {
  return [
    { id: "surface", label: "Surface", allLabel: "All surfaces", icon: <Layers />, options: optionItems(prompts.map((prompt) => prompt.surface)), getValue: (prompt) => prompt.surface },
    { id: "logicalModel", label: "Logical model", allLabel: "All logical models", icon: <Boxes />, options: optionItems(prompts.map(promptLogicalModel)), getValue: promptLogicalModel },
    { id: "model", label: "Model", allLabel: "All models", icon: <Cpu />, options: optionItems(prompts.map(promptModel)), getValue: promptModel }
  ];
}

function promptSearchValue(prompt: PromptSummary) {
  return [
    prompt.preview,
    prompt.userId,
    prompt.sessionId,
    prompt.surface,
    promptLogicalModel(prompt),
    promptModel(prompt),
    prompt.deploymentId,
    prompt.providerConnectionId
  ].filter((value): value is string => Boolean(value));
}

function promptLogicalModel(prompt: PromptSummary) {
  return prompt.requestedLogicalModel ?? prompt.resolvedLogicalModelId ?? "unknown";
}

function promptModel(prompt: PromptSummary) {
  return prompt.selectedModel ?? "unknown";
}

function isVisiblePromptArtifact(prompt: PromptSummary) {
  return isListedPromptArtifact(prompt.kind);
}
