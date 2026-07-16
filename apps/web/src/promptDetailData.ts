import { compactId, formatCompact, formatDurationMs } from "./format";
import type { PromptDetailViewQuery } from "./gql/graphql";

export type PromptDetailResult = NonNullable<PromptDetailViewQuery["prompt"]>;
export type PromptArtifactDetail = PromptDetailResult["requestArtifacts"][number];
export type RequestSummary = NonNullable<PromptDetailResult["request"]>;
export type ProxyEvent = PromptDetailResult["events"][number];
export type CompressionReceipt = PromptDetailResult["compressionReceipts"][number];

const EVENT_TONES: [string, string][] = [
  ["proxy.", "event-proxy"],
  ["prompt_artifacts.", "event-capture"],
  ["routing.", "event-routing"],
  ["provider.", "event-provider"],
  ["compression.", "event-compression"],
  ["usage.", "event-usage"]
];

const EVENT_FAILURE = /failed|rejected|error|timeout/;

export function eventTone(eventType: string) {
  if (EVENT_FAILURE.test(eventType)) return "event-danger";
  return EVENT_TONES.find(([prefix]) => eventType.startsWith(prefix))?.[1] ?? "event-proxy";
}

export function compressionEventSummary(event: ProxyEvent) {
  if (!event.eventType.startsWith("compression.")) return null;
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return null;
  const payload = event.payload as Record<string, unknown>;
  const retrievalId = stringOrNull(payload.retrievalId);
  const toolName = stringOrNull(payload.toolName);
  const status = compressionEventStatus(event.eventType, payload);
  return [
    status,
    retrievalId ? compactId(retrievalId, 11) : null,
    toolName ? `${toolName}()` : null
  ].filter(Boolean).join(" · ");
}

function stringOrNull(value: unknown) {
  return typeof value === "string" ? value : null;
}

// Tool names land in capture metadata as toolName (one call) or toolNames (merged calls).
export function artifactToolNames(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  const record = metadata as Record<string, unknown>;
  const names = [
    ...(typeof record.toolName === "string" ? [record.toolName] : []),
    ...(Array.isArray(record.toolNames) ? record.toolNames.filter((name): name is string => typeof name === "string") : [])
  ];
  return [...new Set(names)];
}

export function exchangeMeta(chars: number | null | undefined, tokenEstimate: number | null | undefined) {
  return [
    chars != null ? `${chars < 1000 ? chars : `${(chars / 1000).toFixed(1)}K`} chars` : null,
    tokenEstimate ? `~${formatCompact(tokenEstimate)} tok` : null
  ].filter(Boolean).join(" · ");
}

export function totalSpan(events: ProxyEvent[], start: number) {
  const end = new Date(events[events.length - 1].createdAt).getTime();
  return formatDurationMs(end - start);
}

export function formatDuration(value?: number | null) {
  if (value == null) return "unknown";
  return formatDurationMs(value);
}


function compressionEventStatus(eventType: string, payload: Record<string, unknown>) {
  if (eventType === "compression.retrieved") return "retrieved";
  if (eventType === "compression.retrieval_failed") return `failed: ${stringOrNull(payload.failureReason) ?? "unknown"}`;
  return stringOrNull(payload.status) ?? eventType.replace(/^compression\./, "");
}
