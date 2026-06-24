import { Link } from "@tanstack/react-router";
import { ChevronRight, Clock3, FileSearch, ShieldAlert, Zap } from "lucide-react";
import { useState } from "react";

import { compressionSkipReasonLabel } from "./compressionSkipReasons";
import { compactId, formatCompact, formatDateTime, formatDurationMs, formatPercent } from "./format";
import { JsonView } from "./jsonView";
import {
  compressionEventSummary,
  eventTone,
  healthSkipsFromEvents,
  totalSpan,
  type CompressionReceipt,
  type HealthSkipEvidence,
  type PromptArtifactDetail,
  type ProxyEvent,
  type RequestSummary
} from "./promptDetailData";
import { Badge, DataTable, GlassCard, StatusBadge } from "./ui";

export function EventTimeline({ events }: { events: ProxyEvent[] }) {
  const start = events.length > 0 ? new Date(events[0].createdAt).getTime() : 0;
  const healthSkips = healthSkipsFromEvents(events);
  return (
    <GlassCard className="timeline-card">
      <div className="card-head">
        <div className="card-title"><Clock3 />Event timeline</div>
        <span className="faint mono">{events.length} events · {events.length > 0 ? totalSpan(events, start) : "0ms"}</span>
      </div>
      {healthSkips.length > 0 ? <HealthSkipRows skips={healthSkips} /> : null}
      <div className="event-timeline">
        {events.map((event) => <EventRow key={event.eventId} event={event} start={start} />)}
        {events.length === 0 ? <div className="empty compact-empty">No events recorded for this request.</div> : null}
      </div>
    </GlassCard>
  );
}

export function CompressionReceiptsCard({ receipts }: { receipts: CompressionReceipt[] }) {
  const summary = compressionReceiptSummary(receipts);
  const headerTokens = summary.measuredSavedTokens > 0
    ? `${formatCompact(summary.actualSavedTokens)} actual · ${formatCompact(summary.measuredSavedTokens)} measured`
    : `${formatCompact(summary.actualSavedTokens)} actual tokens saved`;
  return (
    <GlassCard className="compression-receipts-card table-wrap">
      <div className="card-head">
        <div className="card-title"><Zap />Compression receipts</div>
        <span className="faint mono">{receipts.length} blocks · {headerTokens}</span>
      </div>
      {receipts.length === 0 ? (
        <div className="empty compact-empty">No compression receipts recorded for this request.</div>
      ) : (
        <>
          <CompressionSummaryStrip summary={summary} />
          <DataTable>
            <thead>
              <tr>
                <th>Status</th>
                <th>Rule</th>
                <th>Tool</th>
                <th>Bytes</th>
                <th>Tokens</th>
                <th>Retrieval</th>
                <th>Hash</th>
              </tr>
            </thead>
            <tbody>
              {receipts.map((receipt) => (
                <tr key={receipt.id}>
                  <td>
                    <StatusBadge status={receipt.status} />
                    <div className="faint">{providerCompressionLabel(receipt)} · {providerForwardingLabel(receipt)}</div>
                  </td>
                  <td>
                    <div className="mono">{receipt.ruleId}</div>
                    <div className="faint">v{receipt.ruleVersion}{receipt.skipReason ? ` · ${compressionSkipReasonLabel(receipt.skipReason)}` : ""}</div>
                  </td>
                  <td>
                    <div className="mono">{receipt.toolName}</div>
                    <div className="faint">{receipt.commandClass ?? receipt.blockPath}</div>
                  </td>
                  <td>
                    <div className="mono">{formatCompact(receipt.originalBytes)} -&gt; {formatCompact(receipt.compressedBytes)}</div>
                    <div className="faint">{compressionReductionLabel(receipt.savedBytes, receipt.originalBytes)}</div>
                  </td>
                  <td className="mono">{formatCompact(receipt.savedTokens)}</td>
                  <td><ReceiptRetrieval receipt={receipt} /></td>
                  <td className="mono" title={receipt.compressedSha256}>{compactId(receipt.compressedSha256, 9)}</td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </>
      )}
    </GlassCard>
  );
}

type CompressionReceiptSummary = {
  compressedCount: number;
  measuredCount: number;
  skippedCount: number;
  providerCompressedCount: number;
  providerOriginalCount: number;
  actualOriginalBytes: number;
  actualSavedBytes: number;
  actualSavedTokens: number;
  measuredOriginalBytes: number;
  measuredSavedBytes: number;
  measuredSavedTokens: number;
};

export function compressionReceiptSummary(receipts: CompressionReceipt[]): CompressionReceiptSummary {
  const summary: CompressionReceiptSummary = {
    compressedCount: 0,
    measuredCount: 0,
    skippedCount: 0,
    providerCompressedCount: 0,
    providerOriginalCount: 0,
    actualOriginalBytes: 0,
    actualSavedBytes: 0,
    actualSavedTokens: 0,
    measuredOriginalBytes: 0,
    measuredSavedBytes: 0,
    measuredSavedTokens: 0
  };

  for (const receipt of receipts) {
    if (isProviderCompression(receipt)) {
      summary.compressedCount += 1;
      summary.providerCompressedCount += 1;
      summary.actualOriginalBytes += receipt.originalBytes;
      summary.actualSavedBytes += receipt.savedBytes;
      summary.actualSavedTokens += receipt.savedTokens;
    } else if (receipt.status === "applied" && receipt.mode === "measure_only") {
      summary.measuredCount += 1;
      summary.providerOriginalCount += 1;
      summary.measuredOriginalBytes += receipt.originalBytes;
      summary.measuredSavedBytes += receipt.savedBytes;
      summary.measuredSavedTokens += receipt.savedTokens;
    } else {
      summary.skippedCount += 1;
      summary.providerOriginalCount += 1;
    }
  }

  return summary;
}

function CompressionSummaryStrip({ summary }: { summary: CompressionReceiptSummary }) {
  return (
    <div className="compression-summary-strip" aria-label="Compression receipt summary">
      <CompressionSummaryItem label="Compressed" value={formatCompact(summary.compressedCount)} detail="provider saw compressed" />
      <CompressionSummaryItem label="Measured" value={formatCompact(summary.measuredCount)} detail="potential only" />
      <CompressionSummaryItem label="Skipped" value={formatCompact(summary.skippedCount)} detail="no rewrite" />
      <CompressionSummaryItem
        label="Actual savings"
        value={`${formatCompact(summary.actualSavedBytes)} bytes`}
        detail={`${formatCompact(summary.actualSavedTokens)} tokens · ${compressionReductionLabel(summary.actualSavedBytes, summary.actualOriginalBytes)}`}
      />
      <CompressionSummaryItem
        label="Measured potential"
        value={`${formatCompact(summary.measuredSavedBytes)} bytes`}
        detail={`${formatCompact(summary.measuredSavedTokens)} tokens · ${compressionReductionLabel(summary.measuredSavedBytes, summary.measuredOriginalBytes)}`}
      />
      <CompressionSummaryItem
        label="Provider input"
        value={`${formatCompact(summary.providerCompressedCount)} / ${formatCompact(summary.providerOriginalCount)}`}
        detail="compressed / original"
      />
    </div>
  );
}

function CompressionSummaryItem({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="compression-summary-item">
      <span>{label}</span>
      <strong className="mono">{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function ReceiptRetrieval({ receipt }: { receipt: CompressionReceipt }) {
  if (!receipt.retrievalId) return <span className="faint">not recorded</span>;
  const originalArtifactId = receipt.retrievalAvailable ? receipt.originalArtifactId : null;
  return (
    <div className="receipt-retrieval-cell">
      <Badge variant={receipt.retrievalAvailable ? "success" : undefined} dot>
        {receipt.retrievalAvailable ? "available" : "unavailable"}
      </Badge>
      <span className="mono faint receipt-retrieval-id" title={receipt.retrievalMarker ?? receipt.retrievalId}>
        {compactId(receipt.retrievalId, 8)}
      </span>
      {receipt.originalArtifactExpiresAt ? (
        <span className="faint receipt-expiry" title={receipt.originalArtifactExpiresAt}>
          expires {formatDateTime(receipt.originalArtifactExpiresAt)}
        </span>
      ) : null}
      {originalArtifactId ? (
        <Link
          to="/prompts/$artifactId"
          params={{ artifactId: originalArtifactId }}
          className="btn btn-sm btn-ghost receipt-retrieve-link"
          title="Open original compression artifact"
        >
          <FileSearch />Original
        </Link>
      ) : null}
    </div>
  );
}

function providerCompressionLabel(receipt: CompressionReceipt) {
  if (receipt.status !== "applied") return receipt.status === "skipped" ? "not compressed" : "not applied";
  return receipt.mode === "measure_only" ? "measured only" : "compressed";
}

function providerForwardingLabel(receipt: CompressionReceipt) {
  return isProviderCompression(receipt) ? "provider saw compressed" : "provider saw original";
}

function isProviderCompression(receipt: CompressionReceipt) {
  return receipt.status === "applied" && receipt.mode !== "measure_only";
}

function compressionReductionLabel(savedBytes: number, originalBytes: number) {
  if (originalBytes <= 0) return "no byte baseline";
  return `${formatPercent(Math.max(0, Math.min(1, savedBytes / originalBytes)))} smaller`;
}

function HealthSkipRows({ skips }: { skips: HealthSkipEvidence[] }) {
  return (
    <div className="health-skip-list">
      {skips.map((skip, index) => <HealthSkipRow key={`${skip.providerAccountId ?? "account"}:${skip.model ?? "model"}:${index}`} skip={skip} />)}
    </div>
  );
}

function HealthSkipRow({ skip }: { skip: HealthSkipEvidence }) {
  const title = [skip.provider ?? "provider", skip.model ?? "model"].join(" / ");
  return (
    <div className="health-skip-row">
      <ShieldAlert />
      <div className="health-skip-main">
        <strong>{title}</strong>
        <span className="faint mono">{skip.providerAccountId ?? skip.providerId ?? "unknown account"}</span>
      </div>
      <Badge variant="warn" dot>{healthSkipLabel(skip)}</Badge>
      <span className="health-skip-detail">{healthSkipDetail(skip)}</span>
    </div>
  );
}

function EventRow({ event, start }: { event: ProxyEvent; start: number }) {
  const [open, setOpen] = useState(false);
  const offset = new Date(event.createdAt).getTime() - start;
  const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : null;
  const hasPayload = payload !== null && Object.keys(payload).length > 0;
  const compressionSummary = compressionEventSummary(event);
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
        {compressionSummary ? <span className="event-detail">{compressionSummary}</span> : null}
        <span className="event-producer">{event.producer.replace(/^proxy\./, "")}</span>
        <span className="event-offset mono" title={formatDateTime(event.createdAt)}>+{formatDurationMs(offset)}</span>
      </button>
      {open && hasPayload ? <div className="event-payload"><JsonView value={payload} maxHeight={300} /></div> : null}
    </div>
  );
}

function healthSkipLabel(skip: HealthSkipEvidence) {
  if ((skip.scope === "provider_account_model" || skip.scope === "provider_model") && skip.healthStatus === "terminal") return "model terminal";
  if (skip.scope === "provider_account_model" || skip.scope === "provider_model") return "model lockout";
  if (skip.scope === "provider_account" && skip.healthStatus === "terminal") return "account terminal";
  if (skip.scope === "provider_account") return "account cooldown";
  return "health skip";
}

function healthSkipDetail(skip: HealthSkipEvidence) {
  const parts = [
    skip.healthStatus,
    skip.errorType,
    skip.expiresAt ? `until ${formatDateTime(skip.expiresAt)}` : null
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "no additional health metadata";
}

export function RawJsonCard({ artifact, request }: { artifact: PromptArtifactDetail; request: RequestSummary | null }) {
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
