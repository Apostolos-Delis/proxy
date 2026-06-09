import type { ReactNode } from "react";

import type { ProxyEvent } from "./api";

export function Timeline({ events }: { events: ProxyEvent[] }) {
  return (
    <div className="panel">
      <h2>Event Timeline</h2>
      <div className="timeline">
        {events.map((event) => (
          <article key={event.eventId} className="timeline-row">
            <div>
              <strong>{event.eventType}</strong>
              <span>{event.producer}</span>
            </div>
            <time>{new Date(event.createdAt).toLocaleString()}</time>
          </article>
        ))}
        {events.length === 0 ? <div className="empty">No events found for this request.</div> : null}
      </div>
    </div>
  );
}

export function JsonPanel({ icon, title, value }: { icon: ReactNode; title: string; value: unknown }) {
  return (
    <div className="panel json-panel">
      <h2>{icon}{title}</h2>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}

export function Header({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <header className="page-header">
      <p>{eyebrow}</p>
      <h1>{title}</h1>
    </header>
  );
}

export function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="metric">
      <div className="metric-icon">{icon}</div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function Quality({ label, value }: { label: string; value: number }) {
  return (
    <div className="quality">
      <span>{label}</span>
      <strong>{value.toLocaleString()}</strong>
    </div>
  );
}

export function PageState({ title, label }: { title: string; label: string }) {
  return (
    <section>
      <Header eyebrow="Prompt Proxy" title={title} />
      <div className="empty">{label}</div>
    </section>
  );
}

export function formatMoney(value: number) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 4
  }).format(value);
}
