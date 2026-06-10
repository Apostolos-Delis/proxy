import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Clock3, MessagesSquare } from "lucide-react";
import { useState, type ReactNode } from "react";

import { type PromptArtifactDetail, type ProxyEvent, type RequestSummary, fetchPromptDetail } from "./api";
import { compactId, formatCompact, formatDateTime, formatMoney } from "./format";
import { CopyButton, JsonView } from "./jsonView";
import { Badge, GlassCard, PageState, PageTitle, RouteBadge, StatusBadge } from "./ui";

export function PromptDetailPage({ artifactId }: { artifactId: string }) {
  const query = useQuery({
    queryKey: ["prompt", artifactId],
    queryFn: () => fetchPromptDetail(artifactId)
  });

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

const EXCHANGE_ROLES: Record<string, { role: string; label: string }> = {
  instructions: { role: "system", label: "Instructions" },
  system: { role: "system", label: "System prompt" },
  latest_user_message: { role: "user", label: "User" },
  assistant_response: { role: "assistant", label: "Assistant" }
};

function ExchangeCard({ artifacts, focusedArtifactId }: {
  artifacts: PromptArtifactDetail[];
  focusedArtifactId: string;
}) {
  const visible = artifacts.filter((artifact) => EXCHANGE_ROLES[artifact.kind]);
  const hasAssistant = visible.some((artifact) => artifact.kind === "assistant_response");
  return (
    <GlassCard className="exchange-card">
      <div className="card-head">
        <div className="card-title"><MessagesSquare />Exchange</div>
        <span className="faint mono">{visible.length} artifacts</span>
      </div>
      <div className="conversation">
        {visible.map((artifact) => (
          <ExchangeBubble key={artifact.artifactId} artifact={artifact} focused={artifact.artifactId === focusedArtifactId} />
        ))}
        {visible.length === 0 ? <div className="empty compact-empty">No prompt content captured for this request.</div> : null}
        {!hasAssistant && visible.length > 0 ? (
          <div className="convo-bubble convo-assistant">
            <span className="convo-role">assistant</span>
            <p className="convo-missing">Response not captured for this request.</p>
          </div>
        ) : null}
      </div>
    </GlassCard>
  );
}

function ExchangeBubble({ artifact, focused }: { artifact: PromptArtifactDetail; focused: boolean }) {
  const { role } = EXCHANGE_ROLES[artifact.kind];
  const text = artifact.rawText ?? artifact.redactedText;
  return (
    <div className={`convo-bubble convo-${role}${focused ? " convo-focused" : ""}`}>
      <span className="convo-role">{role}</span>
      <span className="convo-bubble-meta mono">
        {artifact.chars !== undefined ? `${formatCompact(artifact.chars)} chars` : null}
        {artifact.tokenEstimate ? ` · ~${formatCompact(artifact.tokenEstimate)} tok` : null}
      </span>
      {text ? <CopyButton text={text} /> : null}
      {text ? <p>{text}</p> : <p className="convo-missing">Content not stored ({artifact.storageMode}).</p>}
    </div>
  );
}

const EVENT_TONES: [string, string][] = [
  ["proxy.", "event-proxy"],
  ["prompt_artifacts.", "event-capture"],
  ["routing.", "event-routing"],
  ["provider.", "event-provider"],
  ["usage.", "event-usage"]
];

function EventTimeline({ events }: { events: ProxyEvent[] }) {
  const start = events.length > 0 ? new Date(events[0].createdAt).getTime() : 0;
  return (
    <GlassCard className="timeline-card">
      <div className="card-head">
        <div className="card-title"><Clock3 />Event timeline</div>
        <span className="faint mono">{events.length} events · {events.length > 0 ? totalSpan(events, start) : "0ms"}</span>
      </div>
      <div className="event-timeline">
        {events.map((event) => <EventRow key={event.eventId} event={event} start={start} />)}
        {events.length === 0 ? <div className="empty compact-empty">No events recorded for this request.</div> : null}
      </div>
    </GlassCard>
  );
}

function EventRow({ event, start }: { event: ProxyEvent; start: number }) {
  const [open, setOpen] = useState(false);
  const offset = new Date(event.createdAt).getTime() - start;
  const hasPayload = event.payload && Object.keys(event.payload).length > 0;
  return (
    <div className={`event-row ${eventTone(event.eventType)}`}>
      <span className="event-dot" aria-hidden />
      <button
        type="button"
        className="event-summary"
        disabled={!hasPayload}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {hasPayload ? <ChevronRight className={`event-chevron${open ? " open" : ""}`} /> : <span className="event-chevron-spacer" />}
        <span className="event-name mono">{event.eventType}</span>
        <span className="event-producer">{event.producer.replace(/^prompt-proxy\./, "")}</span>
        <span className="event-offset mono" title={formatDateTime(event.createdAt)}>+{formatMs(offset)}</span>
      </button>
      {open && hasPayload ? <div className="event-payload"><JsonView value={event.payload} maxHeight={300} /></div> : null}
    </div>
  );
}

function eventTone(eventType: string) {
  return EVENT_TONES.find(([prefix]) => eventType.startsWith(prefix))?.[1] ?? "event-proxy";
}

function totalSpan(events: ProxyEvent[], start: number) {
  const end = new Date(events[events.length - 1].createdAt).getTime();
  return formatMs(end - start);
}

function formatMs(value: number) {
  if (value < 1000) return `${Math.max(0, Math.round(value))}ms`;
  return `${(value / 1000).toFixed(2)}s`;
}

function RawJsonCard({ artifact, request }: { artifact: PromptArtifactDetail; request: RequestSummary | null }) {
  const [open, setOpen] = useState(false);
  return (
    <GlassCard className="raw-json-card">
      <button type="button" className="raw-json-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <ChevronRight className={`event-chevron${open ? " open" : ""}`} />
        <span className="card-title">Raw JSON</span>
        <span className="faint">artifact &amp; request records</span>
      </button>
      {open ? <JsonView value={{ artifact, request }} maxHeight={520} /> : null}
    </GlassCard>
  );
}

function FactsRail({ artifact, request }: { artifact: PromptArtifactDetail; request: RequestSummary | null }) {
  const config = artifact.routingConfig ?? request?.routingConfig;
  const classifier = artifact.classifier ?? request?.classifier;
  return (
    <aside className="detail-rail">
      <GlassCard>
        <FactSection title="Request">
          <Fact label="Status"><StatusBadge status={request?.terminalStatus} /></Fact>
          <Fact label="Route"><RouteBadge route={request?.finalRoute} /></Fact>
          <Fact label="Model">
            <span className="mono fact-model">
              {request?.requestedModel && request.requestedModel !== request.selectedModel ? <>{request.requestedModel} <span className="faint">&rarr;</span> </> : null}
              {request?.selectedModel ?? artifact.selectedModel ?? "unknown"}
            </span>
          </Fact>
          <Fact label="Provider"><span>{request?.provider ?? artifact.provider ?? "unknown"}</span></Fact>
          <Fact label="Latency"><span className="mono">{formatDuration(request?.latencyMs)}</span></Fact>
          <Fact label="First byte"><span className="mono">{formatDuration(request?.timeToFirstByteMs)}</span></Fact>
        </FactSection>
        <FactSection title="Usage">
          <Fact label="Input tokens"><span className="mono">{formatCompact(request?.usage.inputTokens ?? 0)}</span></Fact>
          <Fact label="Cached"><span className="mono">{formatCompact(request?.usage.cachedInputTokens ?? 0)}</span></Fact>
          <Fact label="Output"><span className="mono">{formatCompact(request?.usage.outputTokens ?? 0)}</span></Fact>
          <Fact label="Reasoning"><span className="mono">{formatCompact(request?.usage.reasoningTokens ?? 0)}</span></Fact>
          <Fact label="Total"><span className="mono">{formatCompact(request?.usage.totalTokens ?? 0)}</span></Fact>
          <Fact label="Cost"><span className="mono">{formatMoney(request?.selectedCost ?? artifact.cost.selected)}</span></Fact>
        </FactSection>
        <FactSection title="Routing">
          <Fact label="Config">
            {config ? (
              <Link to="/routing-configs/$configId" params={{ configId: config.configId }} className="fact-link">
                {config.configName ?? compactId(config.configId)}
              </Link>
            ) : <span className="faint">none</span>}
          </Fact>
          <Fact label="Version"><span className="mono">{config?.version != null ? `v${config.version}` : "unknown"}</span></Fact>
          <Fact label="Config hash">
            {config?.configHash ? <HashValue value={config.configHash} /> : <span className="faint">unknown</span>}
          </Fact>
          <Fact label="Classifier"><span className="mono fact-model">{classifier?.model ?? "unknown"}</span></Fact>
        </FactSection>
        <FactSection title="Capture">
          <Fact label="Storage"><Badge>{artifact.storageMode}</Badge></Fact>
          <Fact label="Kind"><span className="mono">{artifact.kind}</span></Fact>
          <Fact label="Content hash"><HashValue value={artifact.contentHash} /></Fact>
          <Fact label="Expires"><span>{artifact.expiresAt ? formatDateTime(artifact.expiresAt) : "never"}</span></Fact>
        </FactSection>
      </GlassCard>
    </aside>
  );
}

function FactSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="fact-section">
      <h3>{title}</h3>
      <div className="fact-grid">{children}</div>
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="fact">
      <span>{label}</span>
      <strong>{children}</strong>
    </div>
  );
}

function HashValue({ value }: { value: string }) {
  return (
    <span className="fact-hash">
      <span className="mono" title={value}>{compactId(value, 16)}</span>
      <CopyButton text={value} />
    </span>
  );
}

function formatDuration(value?: number) {
  if (value === undefined) return "unknown";
  return formatMs(value);
}
