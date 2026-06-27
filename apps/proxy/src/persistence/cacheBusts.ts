import { CACHE_TTL_DEFAULT_MS } from "../cacheWindows.js";
import { sha256, stableJson } from "../util.js";

export const CACHE_BUST_CAUSES = [
  "ttl_expiry",
  "model_switch",
  "provider_switch",
  "org_prompt_edit",
  "tool_schema_churn",
  "translator_change",
  "compression_policy_change",
  "route_config_change",
  "unknown"
] as const;

export type CacheBustCause = typeof CACHE_BUST_CAUSES[number];

// Newest-first ledger sample cap; busts older than the cap fall out of view.
export const CACHE_BUST_SAMPLE_CAP = 10_000;

export type CacheBustLedgerRow = {
  sessionId: string;
  requestId: string;
  provider: string;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  createdAt: Date;
  orgPromptHash?: string | null;
  toolSchemaHash?: string | null;
  translatorId?: string | null;
  compressionPolicyHash?: string | null;
  routingConfigHash?: string | null;
  routingConfigVersionId?: string | null;
};

type CacheBustEvidence = Pick<
  CacheBustLedgerRow,
  "orgPromptHash" | "toolSchemaHash" | "compressionPolicyHash"
>;

export type CacheBustEvidenceEvent = {
  requestId: string;
  eventType: string;
  payload: Record<string, unknown>;
};

export type CacheBust = {
  sessionId: string;
  requestId: string;
  at: string;
  cause: CacheBustCause;
  droppedCacheReadTokens: number;
  rebuiltTokens: number;
  model: string;
  previousModel: string;
  gapMs: number;
};

// A request only counts as having had a warm cache worth losing if the prior
// request read at least this many cached tokens (~ the minimum cacheable
// prefix on Anthropic models).
const WARM_CACHE_MIN_TOKENS = 2048;
// Reads collapsing below this fraction of the previous read count as a bust.
const COLLAPSE_FRACTION = 0.1;
// The context must actually have re-billed at roughly its prior size —
// otherwise the drop is just a much smaller request (e.g. a sidecar call).
const REBUILD_FRACTION = 0.5;
// Both Anthropic and OpenAI prompt caches expire after roughly five minutes
// of inactivity; gaps beyond this expire the prefix.
const CACHE_TTL_MS = CACHE_TTL_DEFAULT_MS;

// Heuristic detector over ledger rows. Known limits: a brand-new conversation
// reusing an existing session id reads as an unknown-cause bust (the ledger
// cannot distinguish it from a real prefix loss), and a sample cap that cuts
// a session's older rows can only miss busts, never fabricate them — a bust
// requires the surviving predecessor itself to have had warm reads.
export function detectCacheBusts(rows: CacheBustLedgerRow[]) {
  const bySession = new Map<string, Map<string, CacheBustLedgerRow>>();
  for (const row of rows) {
    // Retried requests write one ledger row per provider attempt; keep only
    // the latest row per request so retry pairs cannot read as busts.
    const session = bySession.get(row.sessionId) ?? new Map<string, CacheBustLedgerRow>();
    const existing = session.get(row.requestId);
    if (!existing || existing.createdAt.getTime() < row.createdAt.getTime()) {
      session.set(row.requestId, row);
    }
    bySession.set(row.sessionId, session);
  }

  const busts: CacheBust[] = [];
  for (const session of bySession.values()) {
    const sessionRows = [...session.values()].sort((left, right) =>
      left.createdAt.getTime() - right.createdAt.getTime() ||
      left.requestId.localeCompare(right.requestId)
    );
    for (let index = 1; index < sessionRows.length; index += 1) {
      const previous = sessionRows[index - 1];
      const current = sessionRows[index];
      if (previous.cachedInputTokens < WARM_CACHE_MIN_TOKENS) continue;
      if (current.cachedInputTokens >= previous.cachedInputTokens * COLLAPSE_FRACTION) continue;

      const rebuiltTokens = rebuiltContextTokens(current);
      if (rebuiltTokens < previous.cachedInputTokens * REBUILD_FRACTION) continue;

      const gapMs = current.createdAt.getTime() - previous.createdAt.getTime();
      busts.push({
        sessionId: current.sessionId,
        requestId: current.requestId,
        at: current.createdAt.toISOString(),
        cause: classify(previous, current, gapMs),
        droppedCacheReadTokens: previous.cachedInputTokens,
        rebuiltTokens,
        model: current.model,
        previousModel: previous.model,
        gapMs
      });
    }
  }

  busts.sort((left, right) => new Date(right.at).getTime() - new Date(left.at).getTime());
  const countsByCause = emptyCacheBustCauseCounts();
  for (const bust of busts) countsByCause[bust.cause] += 1;

  return {
    busts,
    countsByCause,
    sessionsScanned: bySession.size
  };
}

export function cacheBustEvidenceByRequest(events: CacheBustEvidenceEvent[]) {
  const byRequest = new Map<string, CacheBustEvidence>();
  for (const event of events) {
    const evidence = byRequest.get(event.requestId) ?? {};
    if (event.eventType === "tokens.attributed") {
      const orgPromptHash = hashOrNull(event.payload.orgSystemPromptHash);
      if (orgPromptHash !== undefined) evidence.orgPromptHash = orgPromptHash;
      const toolSchemaHash = toolSchemaFingerprint(event.payload.toolSchemaHashesByName);
      if (toolSchemaHash !== undefined) evidence.toolSchemaHash = toolSchemaHash;
    }
    if (event.eventType === "routing.compression_evidence_recorded") {
      const compressionPolicyHash = compressionPolicyFingerprint(event.payload);
      if (compressionPolicyHash !== undefined) evidence.compressionPolicyHash = compressionPolicyHash;
    }
    byRequest.set(event.requestId, evidence);
  }
  return byRequest;
}

// Tokens billed at uncached/write price on the busted request. Anthropic
// rebuilds show up as cache_creation; OpenAI ones as uncached input.
function rebuiltContextTokens(row: CacheBustLedgerRow) {
  if (row.provider === "anthropic") return row.cacheCreationInputTokens;
  return Math.max(0, row.inputTokens - row.cachedInputTokens);
}

function classify(previous: CacheBustLedgerRow, current: CacheBustLedgerRow, gapMs: number): CacheBustCause {
  if (current.provider !== previous.provider) return "provider_switch";
  if (current.model !== previous.model) return "model_switch";
  if (knownChange(previous.orgPromptHash, current.orgPromptHash)) return "org_prompt_edit";
  if (knownChange(previous.toolSchemaHash, current.toolSchemaHash)) return "tool_schema_churn";
  if (knownChange(previous.translatorId, current.translatorId)) return "translator_change";
  if (knownChange(previous.compressionPolicyHash, current.compressionPolicyHash)) return "compression_policy_change";
  if (routingConfigChanged(previous, current)) return "route_config_change";
  if (gapMs > CACHE_TTL_MS) return "ttl_expiry";
  return "unknown";
}

export function emptyCacheBustCauseCounts() {
  return Object.fromEntries(CACHE_BUST_CAUSES.map((cause) => [cause, 0])) as Record<CacheBustCause, number>;
}

function knownChange(left: string | null | undefined, right: string | null | undefined) {
  return left !== undefined && right !== undefined && left !== right;
}

function routingConfigChanged(previous: CacheBustLedgerRow, current: CacheBustLedgerRow) {
  if (previous.routingConfigHash !== undefined && current.routingConfigHash !== undefined) {
    return previous.routingConfigHash !== current.routingConfigHash;
  }
  return knownChange(previous.routingConfigVersionId, current.routingConfigVersionId);
}

function hashOrNull(value: unknown) {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function toolSchemaFingerprint(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const entries = value
    .flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const entry = item as Record<string, unknown>;
      const name = typeof entry.name === "string" ? entry.name : undefined;
      const schemaHash = typeof entry.schemaHash === "string" ? entry.schemaHash : undefined;
      return name && schemaHash ? [{ name, schemaHash }] : [];
    })
    .sort((left, right) => left.name.localeCompare(right.name) || left.schemaHash.localeCompare(right.schemaHash));
  return sha256(stableJson(entries));
}

function compressionPolicyFingerprint(payload: Record<string, unknown>) {
  if ("policy" in payload) return sha256(stableJson(payload.policy));
  if (typeof payload.mode !== "string") return undefined;
  return sha256(stableJson({ mode: payload.mode, ruleIds: stringArray(payload.ruleIds) }));
}

function stringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").sort();
}
