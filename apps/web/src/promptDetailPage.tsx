import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronLeft, Copy, MessagesSquare } from "lucide-react";

import { compactId, formatDateTime } from "./format";
import { graphql } from "./gql";
import { gqlFetch } from "./graphql";
import { useCopyFeedback } from "./jsonView";
import { ExchangeCard } from "./promptExchangeCard";
import { CompressionReceiptsCard, EventTimeline, RawJsonCard } from "./promptEventTimeline";
import { FactsRail } from "./promptFactsRail";
import { RoutePlanCard } from "./routePlanCard";
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
        metadata
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
        metadata
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
      routeDecisions {
        selectedProvider
        selectedModel
        classifierRoute
        finalRoute
        confidence
        routeExecutionPlan
        selectedCandidateId
        translated
        translatorId
        routingConfig {
          configId
          configName
          versionId
          version
          configHash
        }
      }
      providerAttempts {
        id
        requestId
        provider
        model
        terminalStatus
        statusCode
        error
        routeCandidateId
        attemptIndex
        fallbackIndex
        skipReason
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
      compressionReceipts {
        id
        mode
        surface
        blockPath
        toolName
        command
        commandClass
        ruleId
        ruleVersion
        status
        skipReason
        originalBytes
        compressedBytes
        savedBytes
        originalTokenEstimate
        compressedTokenEstimate
        savedTokens
        estimateSource
        originalSha256
        compressedSha256
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
  const { isLoading: queryIsLoading, error: queryError, data: queryData } = useQuery(promptDetailQueryOptions(artifactId));

  if (queryIsLoading) return <PageState title="Prompt" label="Loading prompt detail" />;
  if (queryError) return <PageState title="Prompt" label={queryError.message} />;
  if (!queryData) return <PageState title="Prompt" label="No prompt data" />;

  const { artifact, request, events, compressionReceipts, routeDecisions, providerAttempts } = queryData;
  const artifacts = queryData.requestArtifacts ?? [artifact];
  return (
    <div className="page page-enter">
      <div className="detail-back-row">
        <Link to="/logs" className="btn btn-sm"><ChevronLeft />Logs</Link>
      </div>
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
        {artifact.sessionId ? <IdChip label="session" value={artifact.sessionId} accent /> : null}
      </div>
      <div className="detail-layout">
        <div className="detail-main">
          <ExchangeCard artifacts={artifacts} request={request} focusedArtifactId={artifact.artifactId} />
          <CompressionReceiptsCard receipts={compressionReceipts} />
          <RoutePlanCard routeDecisions={routeDecisions} providerAttempts={providerAttempts} />
          <EventTimeline events={events} />
          <RawJsonCard artifact={artifact} request={request} />
        </div>
        <FactsRail artifact={artifact} request={request} />
      </div>
    </div>
  );
}

function IdChip({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  const { copied, copy } = useCopyFeedback();
  return (
    <button
      type="button"
      className={`id-chip${accent ? " id-chip-accent" : ""}`}
      title={value}
      onClick={() => copy(value)}
    >
      <span className="id-chip-label">{label}</span>
      <span className="mono">{compactId(value, 13)}</span>
      {copied ? <Check className="id-chip-check" /> : <Copy />}
    </button>
  );
}
