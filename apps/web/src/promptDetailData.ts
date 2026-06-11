import { formatDurationMs } from "./format";
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

export function eventTone(eventType: string) {
  return EVENT_TONES.find(([prefix]) => eventType.startsWith(prefix))?.[1] ?? "event-proxy";
}

export function totalSpan(events: ProxyEvent[], start: number) {
  const end = new Date(events[events.length - 1].createdAt).getTime();
  return formatDurationMs(end - start);
}

export function formatDuration(value?: number | null) {
  if (value == null) return "unknown";
  return formatDurationMs(value);
}
