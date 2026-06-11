import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { MessagesSquare } from "lucide-react";

import { compactId, formatDateTime } from "./format";
import { graphql } from "./gql";
import { gqlFetch } from "./graphql";
import { CopyButton } from "./jsonView";
import { ExchangeCard } from "./promptExchangeCard";
import { EventTimeline, RawJsonCard } from "./promptEventTimeline";
import { FactsRail } from "./promptFactsRail";
import { PageState, PageTitle } from "./ui";

const PromptDetailViewDocument = graphql(`
  query PromptDetailView($artifactId: ID!) {
    prompt(artifactId: $artifactId) {
      artifact {
        artifactId
        requestId
        userId
        sessionId
        surface
        kind
        sourceIndex
        storageMode
        contentHash
        chars
        tokenEstimate
        preview
        rawText
        redactedText
        expiresAt
        finalRoute
        provider
        selectedModel
        classifier
        createdAt
        routingConfig {
          configId
          configName
          versionId
          version
          configHash
        }
        cost {
          selected
        }
      }
      requestArtifacts {
        artifactId
        requestId
        userId
        sessionId
        surface
        kind
        sourceIndex
        storageMode
        contentHash
        chars
        tokenEstimate
        preview
        rawText
        redactedText
        expiresAt
        finalRoute
        provider
        selectedModel
        classifier
        createdAt
        routingConfig {
          configId
          configName
          versionId
          version
          configHash
        }
        cost {
          selected
        }
      }
      request {
        requestId
        terminalStatus
        finalRoute
        requestedModel
        selectedModel
        provider
        latencyMs
        timeToFirstByteMs
        selectedCost
        classifier
        usage {
          inputTokens
          cachedInputTokens
          outputTokens
          reasoningTokens
          totalTokens
        }
        routingConfig {
          configId
          configName
          versionId
          version
          configHash
        }
      }
      events {
        eventId
        eventType
        producer
        payload
        createdAt
      }
    }
  }
`);

export function promptDetailQueryOptions(artifactId: string) {
  return {
    queryKey: ["prompt", artifactId] as const,
    queryFn: async () => (await gqlFetch(PromptDetailViewDocument, { artifactId })).prompt
  };
}

export function PromptDetailPage({ artifactId }: { artifactId: string }) {
  const query = useQuery(promptDetailQueryOptions(artifactId));

  if (query.isLoading) return <PageState title="Prompt" label="Loading prompt detail" />;
  if (query.error) return <PageState title="Prompt" label={query.error.message} />;
  if (!query.data) return <PageState title="Prompt" label="No prompt data" />;

  const { artifact, request, events } = query.data;
  const artifacts = query.data.requestArtifacts ?? [artifact];
  return (
    <div className="page page-enter">
      <PageTitle
        title="Prompt detail"
        subtitle={`${artifact.surface} · ${formatDateTime(artifact.createdAt)}`}
        actions={artifact.sessionId ? (
          <Link to="/sessions/$sessionId" params={{ sessionId: artifact.sessionId }} className="btn">
            <MessagesSquare />View session
          </Link>
        ) : null}
      />
      <div className="detail-id-row">
        <IdChip label="artifact" value={artifact.artifactId} />
        <IdChip label="request" value={artifact.requestId} />
        {artifact.userId ? <IdChip label="user" value={artifact.userId} /> : null}
      </div>
      <div className="detail-layout">
        <div className="detail-main">
          <ExchangeCard artifacts={artifacts} focusedArtifactId={artifact.artifactId} />
          <EventTimeline events={events} />
          <RawJsonCard artifact={artifact} request={request} />
        </div>
        <FactsRail artifact={artifact} request={request} />
      </div>
    </div>
  );
}

function IdChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="id-chip">
      <span className="id-chip-label">{label}</span>
      <span className="mono">{compactId(value, 26)}</span>
      <CopyButton text={value} />
    </span>
  );
}
