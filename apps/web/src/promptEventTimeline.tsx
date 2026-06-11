import { ChevronRight, Clock3 } from "lucide-react";
import { useState } from "react";

import { formatDateTime, formatDurationMs } from "./format";
import { JsonView } from "./jsonView";
import { eventTone, totalSpan, type PromptArtifactDetail, type ProxyEvent, type RequestSummary } from "./promptDetailData";
import { GlassCard } from "./ui";

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
