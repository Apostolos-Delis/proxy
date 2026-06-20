import { ChevronRight, Clock3, Zap } from "lucide-react";
import { useState } from "react";

import { compactId, formatCompact, formatDateTime, formatDurationMs } from "./format";
import { JsonView } from "./jsonView";
import { eventTone, totalSpan, type CompressionReceipt, type PromptArtifactDetail, type ProxyEvent, type RequestSummary } from "./promptDetailData";
import { DataTable, GlassCard, StatusBadge } from "./ui";

export function EventTimeline({ events }: { events: ProxyEvent[] }) {
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

export function CompressionReceiptsCard({ receipts }: { receipts: CompressionReceipt[] }) {
  const savedTokens = receipts.reduce((sum, receipt) => sum + receipt.savedTokens, 0);
  return (
    <GlassCard className="compression-receipts-card table-wrap">
      <div className="card-head">
        <div className="card-title"><Zap />Compression receipts</div>
        <span className="faint mono">{receipts.length} blocks · {formatCompact(savedTokens)} tokens</span>
      </div>
      {receipts.length === 0 ? (
        <div className="empty compact-empty">No compression receipts recorded for this request.</div>
      ) : (
        <DataTable>
          <thead>
            <tr>
              <th>Status</th>
              <th>Rule</th>
              <th>Tool</th>
              <th>Bytes</th>
              <th>Tokens</th>
              <th>Hash</th>
            </tr>
          </thead>
          <tbody>
            {receipts.map((receipt) => (
              <tr key={receipt.id}>
                <td><StatusBadge status={receipt.status} /></td>
                <td>
                  <div className="mono">{receipt.ruleId}</div>
                  <div className="faint">v{receipt.ruleVersion}{receipt.skipReason ? ` · ${receipt.skipReason}` : ""}</div>
                </td>
                <td>
                  <div className="mono">{receipt.toolName}</div>
                  <div className="faint">{receipt.commandClass ?? receipt.blockPath}</div>
                </td>
                <td className="mono">{formatCompact(receipt.originalBytes)} -&gt; {formatCompact(receipt.compressedBytes)}</td>
                <td className="mono">{formatCompact(receipt.savedTokens)}</td>
                <td className="mono" title={receipt.compressedSha256}>{compactId(receipt.compressedSha256, 9)}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </GlassCard>
  );
}

function EventRow({ event, start }: { event: ProxyEvent; start: number }) {
  const [open, setOpen] = useState(false);
  const offset = new Date(event.createdAt).getTime() - start;
  const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : null;
  const hasPayload = payload !== null && Object.keys(payload).length > 0;
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
        <span className="event-offset mono" title={formatDateTime(event.createdAt)}>+{formatDurationMs(offset)}</span>
      </button>
      {open && hasPayload ? <div className="event-payload"><JsonView value={payload} maxHeight={300} /></div> : null}
    </div>
  );
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
