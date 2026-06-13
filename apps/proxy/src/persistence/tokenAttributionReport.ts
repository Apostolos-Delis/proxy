import { isRecord } from "../util.js";

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

// Tool schemas have no notion of blocks, so the shared row type carries a
// nullable count rather than splitting into two shapes.
type OffenderRow = { name: string; chars: number; estimatedTokens: number; blocks: number | null };
type SchemaChurnAccumulator = Totals & {
  requests: number;
  requestNames: Set<string>;
  hashes: Set<string>;
  sessions: Set<string>;
  hashesBySession: Map<string, Set<string>>;
};

export function aggregateTokenAttribution(payloads: unknown[], sampled: boolean) {
  const buckets = new Map<string, Totals>(BUCKET_KEYS.map((key) => [key, { chars: 0, estimatedTokens: 0 }]));
  const toolSchemas = new Map<string, Totals>();
  const toolResults = new Map<string, Totals & { blocks: number }>();
  const schemaChurn = new Map<string, SchemaChurnAccumulator>();

  for (const [index, payload] of payloads.entries()) {
    if (!isRecord(payload)) continue;
    const sessionId = stringOf(payload.sessionId);
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
    for (const entry of arrayOf(payload.toolSchemaHashesByName)) {
      const name = stringOf(entry.name);
      const schemaHash = stringOf(entry.schemaHash);
      if (!name || !schemaHash) continue;
      const totals = schemaChurn.get(name) ?? emptySchemaChurnAccumulator();
      const requestKey = `${index}:${name}`;
      if (!totals.requestNames.has(requestKey)) {
        totals.requestNames.add(requestKey);
        totals.requests += 1;
      }
      totals.hashes.add(schemaHash);
      totals.chars += numberOf(entry.chars);
      totals.estimatedTokens += numberOf(entry.estimatedTokens);
      if (sessionId) {
        totals.sessions.add(sessionId);
        const hashes = totals.hashesBySession.get(sessionId) ?? new Set<string>();
        hashes.add(schemaHash);
        totals.hashesBySession.set(sessionId, hashes);
      }
      schemaChurn.set(name, totals);
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
    toolSchemas: topEntries(toolSchemas).map(([name, totals]): OffenderRow => ({
      name,
      chars: totals.chars,
      estimatedTokens: totals.estimatedTokens,
      blocks: null
    })),
    toolResults: topEntries(toolResults).map(([name, totals]): OffenderRow => ({
      name,
      chars: totals.chars,
      estimatedTokens: totals.estimatedTokens,
      blocks: totals.blocks
    })),
    schemaChurn: topSchemaChurn(schemaChurn)
  };
}

function topEntries<T extends Totals>(entries: Map<string, T>) {
  return [...entries.entries()]
    .sort((left, right) => right[1].chars - left[1].chars)
    .slice(0, TOP_OFFENDERS);
}

function topSchemaChurn(entries: Map<string, SchemaChurnAccumulator>) {
  return [...entries.entries()]
    .map(([name, totals]) => {
      const churningSessions = [...totals.hashesBySession.values()]
        .filter((hashes) => hashes.size > 1)
        .length;
      return {
        name,
        chars: totals.chars,
        estimatedTokens: totals.estimatedTokens,
        requests: totals.requests,
        sessions: totals.sessions.size,
        schemaHashes: totals.hashes.size,
        churningSessions,
        status: totals.hashes.size > 1 ? "churning" : "stable"
      };
    })
    .sort((left, right) =>
      Number(right.status === "churning") - Number(left.status === "churning") ||
      right.churningSessions - left.churningSessions ||
      right.schemaHashes - left.schemaHashes ||
      right.estimatedTokens - left.estimatedTokens ||
      left.name.localeCompare(right.name)
    )
    .slice(0, TOP_OFFENDERS);
}

function emptySchemaChurnAccumulator(): SchemaChurnAccumulator {
  return {
    chars: 0,
    estimatedTokens: 0,
    requests: 0,
    requestNames: new Set(),
    hashes: new Set(),
    sessions: new Set(),
    hashesBySession: new Map()
  };
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
