import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { type PromptSummary, fetchPrompts } from "./api";
import { formatDateTime, formatMoney } from "./format";
import { RoutingConfigMicro } from "./routingSnapshot";
import { CodePill, DataTable, GlassCard, PageState, PageTitle, RouteBadge } from "./ui";

export function PromptsPage() {
  const query = useQuery({ queryKey: ["prompts"], queryFn: fetchPrompts });
  const data = (query.data?.data ?? []).filter(isVisiblePromptArtifact);

  if (query.isLoading) return <PageState title="Prompts" label="Loading prompt artifacts" />;
  if (query.error) return <PageState title="Prompts" label={query.error.message} />;

  return (
    <div className="page page-enter">
      <PageTitle title="Prompt capture" subtitle="Raw user and harness prompts captured by organization, user, request, and session." />
      <GlassCard className="table-wrap">
        <DataTable>
          <thead><tr><th>Prompt</th><th>User</th><th>Session</th><th>Surface</th><th>Route</th><th>Model</th><th>Cost</th><th>Created</th></tr></thead>
          <tbody>{data.map((prompt) => <PromptRow key={prompt.artifactId} prompt={prompt} />)}</tbody>
        </DataTable>
        {data.length === 0 ? <div className="empty">No prompt artifacts captured yet.</div> : null}
      </GlassCard>
    </div>
  );
}

function isVisiblePromptArtifact(prompt: PromptSummary) {
  return prompt.kind !== "tool_schema_metadata" && prompt.kind !== "request_input" && prompt.kind !== "assistant_response";
}

function PromptRow({ prompt }: { prompt: PromptSummary }) {
  const promptText = prompt.preview ?? "Prompt text was not stored for this artifact.";
  return (
    <tr>
      <td>
        <Link to="/prompts/$artifactId" params={{ artifactId: prompt.artifactId }} className="table-link prompt-preview">
          {promptText}
        </Link>
      </td>
      <td><CodePill value={prompt.userId ?? "unknown"} /></td>
      <td><CodePill value={prompt.sessionId ?? "unknown"} /></td>
      <td>{prompt.surface}</td>
      <td><RouteBadge route={prompt.finalRoute} /></td>
      <td>
        <span className="mono">{prompt.selectedModel ?? "unknown"}</span>
        <RoutingConfigMicro snapshot={prompt.routingConfig} />
      </td>
      <td className="mono">{formatMoney(prompt.cost.selected)}</td>
      <td>{formatDateTime(prompt.createdAt)}</td>
    </tr>
  );
}

