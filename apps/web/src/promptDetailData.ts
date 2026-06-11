import { formatCompact, formatDurationMs } from "./format";
import type { PromptDetailViewQuery } from "./gql/graphql";

export type PromptDetailResult = NonNullable<PromptDetailViewQuery["prompt"]>;
export type PromptArtifactDetail = PromptDetailResult["requestArtifacts"][number];
export type RequestSummary = NonNullable<PromptDetailResult["request"]>;
export type ProxyEvent = PromptDetailResult["events"][number];

const EVENT_TONES: [string, string][] = [
  ["proxy.", "event-proxy"],
  ["prompt_artifacts.", "event-capture"],
  ["routing.", "event-routing"],
  ["provider.", "event-provider"],
  ["usage.", "event-usage"]
];

const EVENT_FAILURE = /failed|rejected|error|timeout/;

export function eventTone(eventType: string) {
  if (EVENT_FAILURE.test(eventType)) return "event-danger";
  return EVENT_TONES.find(([prefix]) => eventType.startsWith(prefix))?.[1] ?? "event-proxy";
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
