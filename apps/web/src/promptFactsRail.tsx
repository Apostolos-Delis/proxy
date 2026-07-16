import type { ReactNode } from "react";

import { compactId, formatCompact, formatDateTime, formatMoney } from "./format";
import { CopyButton } from "./jsonView";
import { formatDuration, type PromptArtifactDetail, type RequestSummary } from "./promptDetailData";
import { Badge, GlassCard, RouteBadge, StatusIndicator } from "./ui";

export function FactsRail({ artifact, request }: { artifact: PromptArtifactDetail; request: RequestSummary | null }) {
  const logicalModel = request?.requestedLogicalModel ?? artifact.requestedLogicalModel;
  const resolvedLogicalModelId = request?.resolvedLogicalModelId ?? artifact.resolvedLogicalModelId;
  const accessProfileId = request?.accessProfileId ?? artifact.accessProfileId;
  const deploymentId = request?.deploymentId ?? artifact.deploymentId;
  const providerConnectionId = request?.providerConnectionId ?? artifact.providerConnectionId;
  return (
    <aside className="detail-rail">
      <GlassCard>
        <div className="rail-summary">
          <Fact label="Status"><StatusIndicator status={request?.terminalStatus} /></Fact>
          <Fact label="Latency"><span className="mono">{formatDuration(request?.latencyMs)}</span></Fact>
          <Fact label="First byte"><span className="mono">{formatDuration(request?.timeToFirstByteMs)}</span></Fact>
        </div>
        <FactSection title="Gateway resolution">
          <ModelFlow
            requested={request?.requestedModel}
            logicalModel={logicalModel}
            served={request?.selectedModel ?? artifact.selectedModel}
            provider={request?.provider ?? artifact.provider}
          />
          <div className="fact-grid">
            <IdentifierFact label="Resolved logical model" value={resolvedLogicalModelId} />
            <IdentifierFact label="Access profile" value={accessProfileId} />
            <IdentifierFact label="Deployment" value={deploymentId} />
            <IdentifierFact label="Provider connection" value={providerConnectionId} />
            <Fact label="Ingress wire"><span className="mono">{request?.ingressWireId ?? "unknown"}</span></Fact>
            <Fact label="Egress wire"><span className="mono">{request?.egressWireId ?? "unknown"}</span></Fact>
            <Fact label="Router"><span className="mono">{request?.routerKind ?? "direct"}</span></Fact>
            <IdentifierFact label="Decision" value={request?.routerDecisionId} />
          </div>
        </FactSection>
        <FactSection title="Usage">
          <div className="fact-grid">
            <Fact label="Input tokens"><span className="mono">{formatCompact(request?.usage.inputTokens ?? 0)}</span></Fact>
            <Fact label="Cached">
              <span className={`mono${(request?.usage.cachedInputTokens ?? 0) > 0 ? " fact-accent" : ""}`}>
                {formatCompact(request?.usage.cachedInputTokens ?? 0)}
              </span>
            </Fact>
            <Fact label="Output"><span className="mono">{formatCompact(request?.usage.outputTokens ?? 0)}</span></Fact>
            <Fact label="Reasoning"><span className="mono">{formatCompact(request?.usage.reasoningTokens ?? 0)}</span></Fact>
            <Fact label="Total"><span className="mono">{formatCompact(request?.usage.totalTokens ?? 0)}</span></Fact>
            <Fact label="Cost"><span className="mono fact-accent">{formatMoney(request?.selectedCost ?? artifact.cost.selected)}</span></Fact>
          </div>
        </FactSection>
        <FactSection title="Capture">
          <div className="fact-grid">
            <Fact label="Storage"><Badge>{artifact.storageMode}</Badge></Fact>
            <Fact label="Expires"><span>{artifact.expiresAt ? formatDateTime(artifact.expiresAt) : "never"}</span></Fact>
            <Fact label="Kind" wide><span className="mono fact-model">{artifact.kind}</span></Fact>
            <Fact label="Content hash" wide><IdentifierValue value={artifact.contentHash} /></Fact>
          </div>
        </FactSection>
      </GlassCard>
    </aside>
  );
}

function ModelFlow({ requested, logicalModel, served, provider }: {
  requested?: string | null;
  logicalModel?: string | null;
  served?: string | null;
  provider?: string | null;
}) {
  return (
    <div className="route-flow route-flow-pipeline">
      <div className="route-flow-step">
        <span className="route-flow-label">Requested</span>
        <span className="mono route-flow-model">{requested ?? "unknown"}</span>
      </div>
      <div className="route-flow-decision">
        <RouteBadge route={logicalModel} />
      </div>
      <div className={`route-flow-step${served ? " route-flow-served" : ""}`}>
        <span className="route-flow-label">Served</span>
        <span className={`mono route-flow-model${served ? "" : " faint"}`}>{served ?? "unknown"}</span>
        {provider ? <span className="route-flow-provider">{provider}</span> : null}
      </div>
    </div>
  );
}

function FactSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="fact-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function Fact({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`fact${wide ? " fact-wide" : ""}`}>
      <span>{label}</span>
      <strong>{children}</strong>
    </div>
  );
}

function IdentifierFact({ label, value }: { label: string; value?: string | null }) {
  return <Fact label={label} wide>{value ? <IdentifierValue value={value} /> : <span className="faint">unknown</span>}</Fact>;
}

function IdentifierValue({ value }: { value: string }) {
  return (
    <span className="fact-hash">
      <span className="mono" title={value}>{compactId(value, 12)}</span>
      <CopyButton text={value} />
    </span>
  );
}
