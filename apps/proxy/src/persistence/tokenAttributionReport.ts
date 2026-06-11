import { isRecord } from "../util.js";

export type TokenAttributionFilters = {
  start?: string;
  end?: string;
};

// Newest-first sample cap: bounds memory for orgs with deep event history.
// When the cap is hit the report is flagged sampled so the console can say so.
export const TOKEN_ATTRIBUTION_SAMPLE_CAP = 5000;

const TOP_OFFENDERS = 20;

const BUCKET_KEYS = [
  "systemPrompt",
  "orgSystemPrompt",
  "toolSchemas",
  "history",
  "newToolResults",
  "latestUser"
] as const;

type Totals = { chars: number; estimatedTokens: number };

export function aggregateTokenAttribution(payloads: unknown[], sampled: boolean) {
  const buckets = new Map<string, Totals>(BUCKET_KEYS.map((key) => [key, { chars: 0, estimatedTokens: 0 }]));
  const toolSchemas = new Map<string, Totals>();
  const toolResults = new Map<string, Totals & { blocks: number }>();

  for (const payload of payloads) {
    if (!isRecord(payload)) continue;
    for (const key of BUCKET_KEYS) {
      const bucket = payload[key];
      if (!isRecord(bucket)) continue;
      const totals = buckets.get(key)!;
      totals.chars += numberOf(bucket.chars);
      totals.estimatedTokens += numberOf(bucket.estimatedTokens);
    }
    for (const entry of arrayOf(payload.toolSchemasByName)) {
      const name = stringOf(entry.name);
      if (!name) continue;
      const totals = toolSchemas.get(name) ?? { chars: 0, estimatedTokens: 0 };
      totals.chars += numberOf(entry.chars);
      totals.estimatedTokens += numberOf(entry.estimatedTokens);
      toolSchemas.set(name, totals);
    }
    for (const entry of arrayOf(payload.newToolResultsByTool)) {
      const name = stringOf(entry.tool);
      if (!name) continue;
      const totals = toolResults.get(name) ?? { chars: 0, estimatedTokens: 0, blocks: 0 };
      totals.chars += numberOf(entry.chars);
      totals.estimatedTokens += numberOf(entry.estimatedTokens);
      totals.blocks += numberOf(entry.blocks);
      toolResults.set(name, totals);
    }
  }

  return {
    requestCount: payloads.length,
    sampled,
    buckets: BUCKET_KEYS.map((key) => ({ key, ...buckets.get(key)! })),
    toolSchemas: topEntries(toolSchemas).map(([name, totals]) => ({
      name,
      chars: totals.chars,
      estimatedTokens: totals.estimatedTokens,
      blocks: null as number | null
    })),
    toolResults: topEntries(toolResults).map(([name, totals]) => ({
      name,
      chars: totals.chars,
      estimatedTokens: totals.estimatedTokens,
      blocks: totals.blocks as number | null
    }))
  };
}

function topEntries<T extends Totals>(entries: Map<string, T>) {
  return [...entries.entries()]
    .sort((left, right) => right[1].chars - left[1].chars)
    .slice(0, TOP_OFFENDERS);
}

function arrayOf(value: unknown) {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function numberOf(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringOf(value: unknown) {
  return typeof value === "string" && value ? value : undefined;
}
