import { GitBranch, Route } from "lucide-react";

import { compactId } from "./format";
import { attemptsForCandidate, decisionWithPlan, formatSkipReason, routePlanFromDecision } from "./routePlanData";
import type { ProviderAttemptEvidence, RouteDecisionEvidence, RoutePlanCandidate, RoutePlanEvidence } from "./routePlanData";
import { GlassCard, StatusIndicator } from "./ui";

export function RoutePlanCard({
  routeDecisions,
  providerAttempts
}: {
  routeDecisions: RouteDecisionEvidence[];
  providerAttempts: ProviderAttemptEvidence[];
}) {
  const decision = decisionWithPlan(routeDecisions);
  const plan = routePlanFromDecision(decision);
  if (!plan) {
    return (
      <GlassCard className="route-plan-card">
        <div className="card-head">
          <div className="card-title"><Route />Route plan</div>
        </div>
        <div className="empty compact-empty">No route plan recorded for this request.</div>
      </GlassCard>
    );
  }

  const selectedCandidateId = plan.selected?.candidateId ?? decision?.selectedCandidateId ?? null;
  return (
    <GlassCard className="route-plan-card">
      <div className="card-head">
        <div className="card-title"><Route />Route plan</div>
        <span className="faint mono">{plan.candidates.length} candidates</span>
      </div>
      <RoutePlanFacts plan={plan} decision={decision} />
      <div className="route-candidate-table">
        <div className="route-candidate-head">
          <span>#</span>
          <span>Target</span>
          <span>Dialect</span>
          <span>Status</span>
          <span>Provider attempt</span>
        </div>
        {plan.candidates.map((candidate) => (
          <CandidateRow
            key={candidate.id}
            candidate={candidate}
            selected={candidate.id === selectedCandidateId}
            attempts={attemptsForCandidate(providerAttempts, candidate.id)}
          />
        ))}
      </div>
    </GlassCard>
  );
}

function RoutePlanFacts({ plan, decision }: { plan: RoutePlanEvidence; decision: RouteDecisionEvidence | undefined }) {
  const selected = plan.selected;
  const config = decision?.routingConfig ?? null;
  const configVersion = config?.version ?? plan.routingConfig.version;
  const configHash = config?.configHash ?? plan.routingConfig.hash;
  return (
    <div className="route-plan-facts">
      <Fact label="Classifier" value={plan.classifier.route ?? decision?.classifierRoute ?? "unknown"} detail={confidenceLabel(plan.classifier.confidence ?? decision?.confidence)} />
      <Fact label="Config" value={configVersion ? `v${configVersion}` : "unknown"} detail={configHash ? compactId(configHash, 18) : undefined} />
      <Fact label="Selected" value={selected?.providerId ?? decision?.selectedProvider ?? "unknown"} detail={selected?.model ?? decision?.selectedModel ?? undefined} />
      <Fact label="Mode" value={selected?.translated || decision?.translated ? "translated" : "native"} detail={decision?.translatorId ?? undefined} />
    </div>
  );
}

function Fact({ label, value, detail }: { label: string; value: string; detail?: string | null }) {
  return (
    <div className="route-plan-fact">
      <span>{label}</span>
      <strong className="mono">{value}</strong>
      {detail ? <em>{detail}</em> : null}
    </div>
  );
}

function CandidateRow({
  candidate,
  selected,
  attempts
}: {
  candidate: RoutePlanCandidate;
  selected: boolean;
  attempts: ProviderAttemptEvidence[];
}) {
  return (
    <div className={`route-candidate-row${selected ? " selected" : ""}`}>
      <span className="mono route-candidate-order">{candidate.order + 1}</span>
      <div className="route-candidate-target">
        <span className="row gap-8">
          {selected ? <GitBranch className="route-selected-icon" /> : <span className="route-candidate-spacer" />}
          <strong className="mono">{candidate.providerId}</strong>
        </span>
        <span className="faint mono">{candidate.model}</span>
      </div>
      <div className="route-candidate-dialect">
        <span className="mono">{candidate.endpointDialect}</span>
        <span className={candidate.translated ? "badge badge-accent" : "badge"}>{candidate.translated ? "translated" : "native"}</span>
      </div>
      <div className="route-candidate-status">
        <StatusIndicator status={candidate.eligible ? "eligible" : "skipped"} />
        {candidate.skipReasons.length > 0 ? (
          <div className="route-skip-list">
            {candidate.skipReasons.map((reason) => <span key={reason}>{formatSkipReason(reason)}</span>)}
          </div>
        ) : null}
      </div>
      <div className="route-attempt-list">
        {attempts.length > 0
          ? attempts.map((attempt) => <AttemptStatus key={attempt.id} attempt={attempt} />)
          : <span className="faint">not attempted</span>}
      </div>
    </div>
  );
}

function AttemptStatus({ attempt }: { attempt: ProviderAttemptEvidence }) {
  const label = [
    attempt.attemptIndex != null ? `#${attempt.attemptIndex}` : null,
    attempt.fallbackIndex != null ? `fb ${attempt.fallbackIndex}` : null
  ].filter(Boolean).join(" · ");
  return (
    <span className="route-attempt-status">
      <StatusIndicator status={attempt.terminalStatus} />
      {label ? <span className="mono faint">{label}</span> : null}
    </span>
  );
}

function confidenceLabel(value: number | null | undefined) {
  if (value == null) return undefined;
  return `${Math.round(value * 100)}% confidence`;
}
