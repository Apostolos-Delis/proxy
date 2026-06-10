import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { MessagesSquare } from "lucide-react";

import { type PromptSummary, type RequestSummary, fetchPromptDetail, fetchPrompts } from "./api";
import { compactId, formatDateTime, formatMoney } from "./format";
import { RoutingConfigMicro, RoutingSnapshotPanel } from "./routingSnapshot";
import { CodePill, DataTable, GlassCard, JsonPanel, PageState, PageTitle, RawTextPanel, RouteBadge, Timeline } from "./ui";

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

export function PromptDetailPage({ artifactId }: { artifactId: string }) {
  const query = useQuery({
    queryKey: ["prompt", artifactId],
    queryFn: () => fetchPromptDetail(artifactId)
  });

  if (query.isLoading) return <PageState title="Prompt" label="Loading prompt detail" />;
  if (query.error) return <PageState title="Prompt" label={query.error.message} />;
  if (!query.data) return <PageState title="Prompt" label="No prompt data" />;

  const artifact = query.data.artifact;
  const rawText = artifact.rawText ?? artifact.redactedText ?? "No raw prompt stored.";
  const snapshot = promptSnapshot(artifact, query.data.request);
  return (
    <div className="page page-enter">
      <PageTitle
        title="Prompt detail"
        subtitle={compactId(artifact.artifactId, 18)}
        actions={artifact.sessionId ? (
          <Link to="/sessions/$sessionId" params={{ sessionId: artifact.sessionId }} className="btn">
            <MessagesSquare />View session
          </Link>
        ) : null}
      />
      <div className="detail-grid">
        <RawTextPanel title="Raw prompt" value={rawText} />
        <RoutingSnapshotPanel value={snapshot} />
      </div>
      <div className="detail-grid">
        <JsonPanel title="Context" value={{
          requestId: artifact.requestId,
          userId: artifact.userId,
          sessionId: artifact.sessionId,
          surface: artifact.surface,
          storageMode: artifact.storageMode,
          contentHash: artifact.contentHash,
          chars: artifact.chars,
          tokenEstimate: artifact.tokenEstimate,
          selectedModel: artifact.selectedModel,
          routingConfig: artifact.routingConfig,
          classifier: artifact.classifier,
          request: query.data.request
        }} />
      </div>
      <Timeline events={query.data.events} />
    </div>
  );
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

function promptSnapshot(artifact: PromptSummary, request: RequestSummary | null) {
  return {
    finalRoute: artifact.finalRoute ?? request?.finalRoute,
    selectedModel: artifact.selectedModel ?? request?.selectedModel,
    provider: artifact.provider ?? request?.provider,
    requestedModel: request?.requestedModel,
    routingConfig: artifact.routingConfig ?? request?.routingConfig,
    classifier: artifact.classifier ?? request?.classifier
  };
}
