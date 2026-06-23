import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { compactId, formatCompact, formatDateTime, formatMoney, formatPercent } from "./format";
import { CopyButton } from "./jsonView";
import { formatDuration, type PreflightDecision, type PromptArtifactDetail, type RequestSummary } from "./promptDetailData";
import { classifierSnapshot, type ClassifierSnapshot } from "./routingSnapshot";
import { Badge, GlassCard, RouteBadge, StatusBadge } from "./ui";

export function FactsRail({ artifact, request, preflightDecisions }: {
  artifact: PromptArtifactDetail;
  request: RequestSummary | null;
  preflightDecisions: PreflightDecision[];
}) {
  const config = artifact.routingConfig ?? request?.routingConfig;
  const classifier = classifierSnapshot(artifact.classifier ?? request?.classifier);
  return (
    <aside className="detail-rail">
      <GlassCard>
        <div className="rail-summary">
          <Fact label="Status"><StatusBadge status={request?.terminalStatus} /></Fact>
          <Fact label="Latency"><span className="mono">{formatDuration(request?.latencyMs)}</span></Fact>
          <Fact label="First byte"><span className="mono">{formatDuration(request?.timeToFirstByteMs)}</span></Fact>
        </div>
        <FactSection title="Routing">
          <RouteFlow
            requested={request?.requestedModel}
            served={request?.selectedModel ?? artifact.selectedModel}
            provider={request?.provider ?? artifact.provider}
            route={request?.finalRoute ?? artifact.finalRoute}
            classifier={classifier}
          />
          <div className="fact-grid">
            <Fact label="Config" wide>
              {config ? (
                <>
                  <Link to="/routing/$configId" params={{ configId: config.configId }} className="fact-link">
                    {config.configName ?? compactId(config.configId)}
                  </Link>
                  {config.version != null ? <span className="mono faint"> · v{config.version}</span> : null}
                </>
              ) : <span className="faint">none</span>}
            </Fact>
            <Fact label="Config hash" wide>
              {config?.configHash ? <HashValue value={config.configHash} /> : <span className="faint">unknown</span>}
            </Fact>
          </div>
          {preflightDecisions.length > 0 ? <PreflightList decisions={preflightDecisions} /> : null}
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
            <Fact label="Content hash" wide><HashValue value={artifact.contentHash} /></Fact>
          </div>
        </FactSection>
      </GlassCard>
    </aside>
  );
}

function PreflightList({ decisions }: { decisions: PreflightDecision[] }) {
  return (
    <div className="preflight-list">
      {decisions.map((decision) => (
        <div key={decision.id} className={`preflight-row${decision.status === "rejected" ? " preflight-rejected" : ""}`}>
          <div className="preflight-row-head">
            <span>{decisionLabel(decision)}</span>
            <Badge variant={decision.status === "rejected" ? "danger" : "accent"}>{decision.status}</Badge>
          </div>
          <div className="preflight-row-meta">
            <span>{scopeLabel(decision)}</span>
            <span>{decisionUsage(decision)}</span>
            {decision.resetAt ? <span>resets {formatDateTime(decision.resetAt)}</span> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function decisionLabel(decision: PreflightDecision) {
  if (decision.kind === "budget") {
    const window = decision.windowType ? `${decision.windowType} ` : "";
    return `${window}budget`;
  }
  return (decision.limitType ?? decision.kind).replaceAll("_", " ");
}

function scopeLabel(decision: PreflightDecision) {
  const scope = (decision.scopeType ?? "scope").replaceAll("_", " ");
  return decision.scopeId ? `${scope} ${compactId(decision.scopeId, 8)}` : scope;
}

function decisionUsage(decision: PreflightDecision) {
  if (decision.kind === "budget") {
    const used = decision.status === "reserved"
      ? decision.reserved
      : (decision.current ?? 0) + (decision.reserved ?? 0) + (decision.estimatedCost ?? 0);
    const limit = decision.limit ?? 0;
    return `${formatMoney(used)} / ${formatMoney(limit)}`;
  }
  return `${formatCompact(decision.current ?? 0)} / ${formatCompact(decision.limit ?? 0)}`;
}

function RouteFlow({ requested, served, provider, route, classifier }: {
  requested?: string | null;
  served?: string | null;
  provider?: string | null;
  route?: string | null;
  classifier?: ClassifierSnapshot;
}) {
  const recommended = classifier?.recommendedRoute;
  const decision = route || classifier?.model ? (
    <div className="route-flow-decision">
      <RouteBadge route={route} />
      {classifier?.model ? (
        <span className="mono route-flow-note" title="Classifier model and confidence">
          via {classifier.model}
          {typeof classifier.confidence === "number" ? ` · ${formatPercent(classifier.confidence)}` : null}
        </span>
      ) : null}
      {recommended && route && recommended !== route ? (
        <span className="route-flow-note">classifier recommended {recommended}</span>
      ) : null}
    </div>
  ) : null;
  const servedStep = (
    <div className={`route-flow-step${served ? " route-flow-served" : ""}`}>
      <span className="route-flow-label">{requested != null ? "Served" : "Model"}</span>
      <span className={`mono route-flow-model${served ? "" : " faint"}`}>{served ?? "unknown"}</span>
      {provider ? <span className="route-flow-provider">{provider}</span> : null}
    </div>
  );
  if (requested == null) {
    return <div className="route-flow">{servedStep}{decision}</div>;
  }
  return (
    <div className="route-flow route-flow-pipeline">
      <div className="route-flow-step">
        <span className="route-flow-label">Requested</span>
        <span className="mono route-flow-model">{requested}</span>
      </div>
      {decision}
      {servedStep}
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

function HashValue({ value }: { value: string }) {
  return (
    <span className="fact-hash">
      <span className="mono" title={value}>{compactId(value, 10)}</span>
      <CopyButton text={value} />
    </span>
  );
}
