import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Activity, Coins, Database, FileText } from "lucide-react";

import { type PromptSummary, fetchPromptDetail, fetchPrompts } from "./api";
import { Header, Metric, PageState, Timeline, formatMoney } from "./ui";

export function PromptsPage() {
  const query = useQuery({ queryKey: ["prompts"], queryFn: fetchPrompts });
  const data = query.data?.data ?? [];

  if (query.isLoading) return <PageState title="Prompts" label="Loading prompts" />;
  if (query.error) return <PageState title="Prompts" label={query.error.message} />;

  return (
    <section>
      <Header eyebrow={`${data.length} rows`} title="Prompts" />
      <div className="table-panel">
        <table>
          <thead>
            <tr>
              <th>Prompt</th>
              <th>User</th>
              <th>Session</th>
              <th>Surface</th>
              <th>Route</th>
              <th>Model</th>
              <th>Cost</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {data.map((prompt) => (
              <PromptRow key={prompt.artifactId} prompt={prompt} />
            ))}
          </tbody>
        </table>
        {data.length === 0 ? <div className="empty">No prompt artifacts captured yet.</div> : null}
      </div>
    </section>
  );
}

export function PromptDetailPage({ artifactId }: { artifactId: string }) {
  const query = useQuery({
    queryKey: ["prompt", artifactId],
    queryFn: () => fetchPromptDetail(artifactId)
  });

  if (query.isLoading) return <PageState title="Prompt" label="Loading prompt" />;
  if (query.error) return <PageState title="Prompt" label={query.error.message} />;
  if (!query.data) return <PageState title="Prompt" label="No prompt data" />;

  const artifact = query.data.artifact;
  const request = query.data.request;
  return (
    <section>
      <Header eyebrow={artifact.artifactId} title="Prompt Detail" />
      <div className="metrics compact">
        <Metric icon={<FileText size={20} />} label="Kind" value={artifact.kind} />
        <Metric icon={<Database size={20} />} label="Route" value={artifact.finalRoute ?? "unknown"} />
        <Metric icon={<Coins size={20} />} label="Cost" value={formatMoney(artifact.cost.selected)} />
        <Metric icon={<Activity size={20} />} label="Status" value={request?.terminalStatus ?? "unknown"} />
      </div>
      <div className="detail-grid">
        <div className="panel prompt-text">
          <h2>Raw Prompt</h2>
          <pre>{artifact.rawText ?? artifact.redactedText ?? "No raw prompt stored."}</pre>
        </div>
        <div className="panel json-panel">
          <h2>Context</h2>
          <pre>{JSON.stringify({
            requestId: artifact.requestId,
            userId: artifact.userId,
            sessionId: artifact.sessionId,
            surface: artifact.surface,
            storageMode: artifact.storageMode,
            contentHash: artifact.contentHash,
            selectedModel: artifact.selectedModel,
            request
          }, null, 2)}</pre>
        </div>
      </div>
      <Timeline events={query.data.events} />
    </section>
  );
}

function PromptRow({ prompt }: { prompt: PromptSummary }) {
  return (
    <tr>
      <td>
        <Link to="/prompts/$artifactId" params={{ artifactId: prompt.artifactId }} className="table-link">
          {prompt.preview ?? prompt.contentHash}
        </Link>
      </td>
      <td>{prompt.userId ?? "unknown"}</td>
      <td>{prompt.sessionId ?? "unknown"}</td>
      <td>{prompt.surface}</td>
      <td>{prompt.finalRoute ?? "unknown"}</td>
      <td>{prompt.selectedModel ?? "unknown"}</td>
      <td>{formatMoney(prompt.cost.selected)}</td>
      <td>{new Date(prompt.createdAt).toLocaleString()}</td>
    </tr>
  );
}
