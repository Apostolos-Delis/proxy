import { createHash } from "node:crypto";

import {
  SURFACE_NAMES,
  defaultCompressionPolicy,
  type CompressionPolicy,
  type CompressionRuleId
} from "@prompt-proxy/schema";

import { bashOutputRule, bashOutputRuleForNames } from "./compressionRules/bashOutput.js";
import { jsonWhitespaceRule } from "./compressionRules/jsonWhitespace.js";
import { mcpJsonRule } from "./compressionRules/mcpJson.js";
import {
  classifyShellCommand,
  shellCommandFromInput,
  shellCommandSummaryRule
} from "./compressionRules/shellCommandSummary.js";
import type { EventService } from "./events.js";
import type { HarnessProfile } from "./harness.js";
import type { JsonObject, Surface } from "./types.js";
import { isRecord, roughTokenEstimate, stableJson, stringField, unreachable } from "./util.js";

// Deterministic compression of tool-result content before it reaches the
// provider. Determinism is non-negotiable: the harness re-sends the full
// conversation every turn, so a given tool result reappears verbatim on every
// subsequent request. A filter that is a pure function of the block content
// produces identical bytes each time, so the prompt-cache prefix stays stable
// and compression compounds instead of busting the cache. No LLM calls here.

export type ToolRef = { name: string; input: unknown };

export type CompressionFilterInput = {
  toolName: string;
  toolInput: unknown;
  content: unknown;
};

// Returns replacement content (a string or content array), or undefined to
// leave the block untouched. Must be deterministic in its inputs.
export type CompressionFilter = (input: CompressionFilterInput) => unknown;

export type CompressionRule = {
  label: string;
  version: number;
  matches: (toolName: string) => boolean;
  filter: CompressionFilter;
  // Per-rule eligibility floor; defaults to MIN_COMPRESSIBLE_CHARS. Cheap O(n)
  // transforms can opt into a lower floor to catch mid-size results.
  minChars?: number;
  minBytes?: number;
  lossy?: boolean;
};

export type CompressionRuleCatalogEntry = {
  id: CompressionRuleId;
  displayName: string;
  version: number;
  classification: "lossless" | "lossy";
  supportedSurfaces: Surface[];
  eligibleToolNames: string[];
  minOriginalBytes: number;
  minSavingsTokens: number;
  knownRisks: string[];
};

export type CompressionRecord = {
  tool: string;
  rule: string;
  ruleVersion: number;
  blockPath: string;
  status: "applied" | "candidate" | "skipped";
  skipReason?: CompressionSkipReason;
  originalContentHash: string;
  compressedContentHash: string;
  beforeBytes: number;
  afterBytes: number;
  beforeChars: number;
  afterChars: number;
  beforeEstimatedTokens: number;
  afterEstimatedTokens: number;
  savedEstimatedTokens: number;
  originalTokenEstimate: number;
  compressedTokenEstimate: number;
  savedTokens: number;
  estimateSource: string;
  command?: string;
  commandClass?: string;
  originalArtifactId?: string;
  compressedArtifactId?: string;
};

export type CompressionResult = { body: unknown; records: CompressionRecord[]; transformedBody?: unknown };
type CompressionArtifactStore = {
  captureCompressionArtifact(input: {
    organizationId: string;
    workspaceId: string;
    requestId: string;
    surface: Surface;
    kind: "compression_original_tool_result" | "compression_compressed_tool_result";
    content: unknown;
    blockPath: string;
    toolName: string;
    ruleId: string;
    ruleVersion: number;
    status: CompressionRecord["status"];
  }): Promise<{ id: string } | undefined>;
};
export type CompressionForwardInput = {
  events: EventService;
  tenantId: string;
  workspaceId: string;
  requestId: string;
  idempotencyKey: string;
  sessionId?: string;
  surface: Surface;
  body: unknown;
  policy: CompressionPolicy;
  deduplicateToolResults?: boolean;
  profile?: HarnessProfile;
  artifactStore?: CompressionArtifactStore;
  warn: (error: unknown, message: string) => void;
};
export type CompressionForwardResult = CompressionResult & {
  compressionEventId?: string;
  receiptIds: string[];
  eventEmitFailed: boolean;
  compressionFailed: boolean;
};
export type CompressionOptions = {
  deduplicateToolResults?: boolean;
  profile?: HarnessProfile;
  minOriginalBytes?: number;
  minSavingsTokens?: number;
  measureOnly?: boolean;
  recordSkips?: boolean;
  tokenEstimator?: CompressionTokenEstimator;
};
export type CompressionTokenEstimator = {
  estimateSource: string;
  countTokens: (content: unknown) => number | undefined;
};
type TokenEstimate = {
  tokens: number;
  source: string;
};
type DuplicateTracker = Set<string>;
type CompressionSkipReason =
  | "below_min_original_bytes"
  | "no_matching_rule"
  | "below_min_savings"
  | "would_grow"
  | "tool_result_error"
  | "content_shape_unsupported"
  | "policy_disabled";

// Only results above this size are eligible — keeps the transform off the hot
// path for cheap calls and avoids touching small blocks where compression
// cannot pay for itself.
export const MIN_COMPRESSIBLE_CHARS = 2048;
export const ROUGH_COMPRESSION_TOKEN_ESTIMATE_SOURCE = "rough_chars_per_4";

// Registered rules, evaluated in order; first successful rewrite wins. Only
// applied for orgs that have opted into tool-result compression.
export const compressionRules: CompressionRule[] = [
  mcpJsonRule,
  jsonWhitespaceRule,
  bashOutputRule
];

export const compressionRuleCatalog: CompressionRuleCatalogEntry[] = [
  {
    id: "mcp-json-whitespace",
    displayName: "MCP JSON whitespace compaction",
    version: 1,
    classification: "lossless",
    supportedSurfaces: [...SURFACE_NAMES],
    eligibleToolNames: ["mcp__*"],
    minOriginalBytes: 512,
    minSavingsTokens: 0,
    knownRisks: []
  },
  {
    id: "json-whitespace",
    displayName: "Generic JSON whitespace compaction",
    version: 1,
    classification: "lossless",
    supportedSurfaces: [...SURFACE_NAMES],
    eligibleToolNames: ["*"],
    minOriginalBytes: 512,
    minSavingsTokens: 0,
    knownRisks: ["Only applies to valid JSON object or array text."]
  },
  {
    id: "bash-output-noise",
    displayName: "Shell ANSI and progress noise stripping",
    version: 1,
    classification: "lossless",
    supportedSurfaces: [...SURFACE_NAMES],
    eligibleToolNames: ["Bash", "bash", "shell", "local_shell", "run_terminal_cmd"],
    minOriginalBytes: 512,
    minSavingsTokens: 0,
    knownRisks: ["Carriage-return progress output is reduced to the final visible state."]
  },
  {
    id: "shell-command-lossy-summary",
    displayName: "Shell command lossy summary",
    version: 1,
    classification: "lossy",
    supportedSurfaces: [...SURFACE_NAMES],
    eligibleToolNames: ["Bash", "bash", "shell", "local_shell", "run_terminal_cmd"],
    minOriginalBytes: 4096,
    minSavingsTokens: 0,
    knownRisks: ["Drops repeated low-signal lines and keeps error indicators, file paths, line numbers, and tail output."]
  }
];

export function availableCompressionRules(profile?: HarnessProfile): CompressionRuleCatalogEntry[] {
  return compressionRuleCatalog.map((rule) => ({
    ...rule,
    supportedSurfaces: [...rule.supportedSurfaces],
    eligibleToolNames: (rule.id === "bash-output-noise" || rule.id === "shell-command-lossy-summary") && profile
      ? [...profile.bashToolNames]
      : [...rule.eligibleToolNames],
    knownRisks: [...rule.knownRisks]
  }));
}

export function compressionRulesForProfile(profile: HarnessProfile): CompressionRule[] {
  return [mcpJsonRule, bashOutputRuleForNames(profile.bashToolNames)];
}

export function compressionRulesForPolicy(policy: CompressionPolicy, profile?: HarnessProfile): CompressionRule[] {
  const baseRules = profile ? compressionRulesForProfile(profile) : compressionRules;
  const allowLossy = policy.mode === "measure_only" || policy.mode === "compress_explicit_lossy";
  const allowedRules = allowLossy ? withShellSummaryRule(baseRules) : baseRules;
  if (policy.enabledRules === undefined) return allowedRules;
  const enabled = new Set<CompressionRuleId>(policy.enabledRules);
  return allowedRules.filter((rule) => enabled.has(rule.label as CompressionRuleId));
}

function withShellSummaryRule(rules: CompressionRule[]) {
  const existing = rules.find((rule) => rule.label === shellCommandSummaryRule.label);
  if (existing) return rules;
  const bashIndex = rules.findIndex((rule) => rule.label === "bash-output-noise");
  if (bashIndex === -1) return [...rules, shellCommandSummaryRule];
  return [...rules.slice(0, bashIndex), shellCommandSummaryRule, ...rules.slice(bashIndex)];
}

export function compressionPolicyMutates(policy: CompressionPolicy) {
  return policy.mode === "compress_lossless" || policy.mode === "compress_explicit_lossy";
}

function compressionPolicyMeasures(policy: CompressionPolicy) {
  return policy.mode === "measure_only" || compressionPolicyMutates(policy);
}

export function compressToolResults(
  surface: Surface,
  body: unknown,
  rules: CompressionRule[] = compressionRules,
  options: CompressionOptions = {}
): CompressionResult {
  if ((!options.deduplicateToolResults && rules.length === 0 && !options.recordSkips) || !isRecord(body)) return { body, records: [] };
  const records: CompressionRecord[] = [];
  const duplicates: DuplicateTracker | undefined = options.deduplicateToolResults ? new Set() : undefined;
  const compressed = compressForSurface(surface, body, rules, records, duplicates, options);
  return { body: options.measureOnly ? body : compressed, records, transformedBody: compressed };
}

function compressForSurface(
  surface: Surface,
  body: Record<string, unknown>,
  rules: CompressionRule[],
  records: CompressionRecord[],
  duplicates: DuplicateTracker | undefined,
  options: CompressionOptions
) {
  switch (surface) {
    case "openai-responses":
      return compressOpenAI(body, rules, records, duplicates, options);
    case "openai-chat":
      return compressOpenAIChat(body, rules, records, duplicates, options);
    case "anthropic-messages":
      return compressAnthropic(body, rules, records, duplicates, options);
    default:
      return unreachable(surface);
  }
}

// Compress deterministically, falling back to the original body if the filter
// throws or the org has not opted in. The forwarded bytes depend ONLY on block
// content and the org's static opt-in — never on event I/O or any per-request
// state — so the prompt-cache prefix stays stable.
export function compressOrFallback(
  surface: Surface,
  body: unknown,
  policy: CompressionPolicy,
  warn: (error: unknown, message: string) => void,
  options: CompressionOptions = {}
): CompressionResult {
  if (!compressionPolicyMeasures(policy)) return { body, records: [] };
  try {
    const effectivePolicy = { ...defaultCompressionPolicy(), ...policy };
    const rules = compressionRulesForPolicy(effectivePolicy, options.profile);
    return compressToolResults(surface, body, rules, {
      ...options,
      minOriginalBytes: effectivePolicy.minOriginalBytes,
      minSavingsTokens: effectivePolicy.minSavingsTokens,
      measureOnly: effectivePolicy.mode === "measure_only",
      recordSkips: effectivePolicy.mode === "measure_only"
    });
  } catch (error) {
    warn(error, "tool result compression failed");
    return { body, records: [] };
  }
}

// Compress the request body and, if anything was compressed, emit a
// compression.recorded event for measurement. The compressed body is returned
// regardless of whether the event write succeeds — a failed event must never
// change the bytes we forward (that would bust the cache on the failing turn).
export async function compressForForward(input: CompressionForwardInput): Promise<unknown> {
  return (await compressForForwardWithResult(input)).body;
}

export async function compressForForwardWithResult(input: CompressionForwardInput): Promise<CompressionForwardResult> {
  let compressionFailed = false;
  const compression = compressOrFallback(
    input.surface,
    input.body,
    input.policy,
    (error, message) => {
      if (message === "tool result compression failed") compressionFailed = true;
      input.warn(error, message);
    },
    {
      deduplicateToolResults: input.deduplicateToolResults === true,
      profile: input.profile
    }
  );
  const { body, records } = compression;
  let compressionEventId: string | undefined;
  let eventEmitFailed = false;
  if (records.length === 0) {
    return { body, records, receiptIds: [], eventEmitFailed, compressionFailed };
  }
  await attachCompressionArtifacts({
    artifactStore: input.artifactStore,
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    requestId: input.requestId,
    surface: input.surface,
    policy: input.policy,
    originalBody: input.body,
    transformedBody: compression.transformedBody ?? body,
    records,
    warn: input.warn
  });
  const beforeChars = records.reduce((sum, record) => sum + record.beforeChars, 0);
  const afterChars = records.reduce((sum, record) => sum + record.afterChars, 0);
  const beforeBytes = records.reduce((sum, record) => sum + record.beforeBytes, 0);
  const afterBytes = records.reduce((sum, record) => sum + record.afterBytes, 0);
  const beforeEstimatedTokens = records.reduce((sum, record) => sum + record.beforeEstimatedTokens, 0);
  const afterEstimatedTokens = records.reduce((sum, record) => sum + record.afterEstimatedTokens, 0);
  const estimateSource = aggregateEstimateSource(records);
  const payload = {
    surface: input.surface,
    mode: input.policy.mode,
    beforeChars,
    afterChars,
    savedChars: beforeChars - afterChars,
    beforeBytes,
    afterBytes,
    savedBytes: beforeBytes - afterBytes,
    beforeEstimatedTokens,
    afterEstimatedTokens,
    savedEstimatedTokens: beforeEstimatedTokens - afterEstimatedTokens,
    originalTokenEstimate: beforeEstimatedTokens,
    compressedTokenEstimate: afterEstimatedTokens,
    savedTokens: beforeEstimatedTokens - afterEstimatedTokens,
    estimateSource,
    blocks: records.length,
    candidates: records.filter((record) => record.status === "candidate").length,
    skipped: records.filter((record) => record.status === "skipped").length,
    policy: input.policy as unknown as JsonObject,
    byRule: records as unknown as JsonObject[]
  } as JsonObject;
  try {
    if (input.policy.mode === "measure_only") {
      for (const [index, record] of records.entries()) {
        await input.events.append({
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
          scopeType: "request",
          scopeId: input.requestId,
          sessionId: input.sessionId,
          correlationId: input.requestId,
          idempotencyKey: `${input.idempotencyKey}:compression-candidate:${index}`,
          producer: "prompt-proxy.compression",
          eventType: "compression.candidate_recorded",
          redactionState: "not_applicable",
          payload: {
            surface: input.surface,
            mode: input.policy.mode,
            policy: input.policy as unknown as JsonObject,
            record: record as unknown as JsonObject
          } as JsonObject
        });
      }
      const event = await input.events.append({
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        scopeType: "request",
        scopeId: input.requestId,
        sessionId: input.sessionId,
        correlationId: input.requestId,
        idempotencyKey: `${input.idempotencyKey}:compression-measurement`,
        producer: "prompt-proxy.compression",
        eventType: "compression.measurement_recorded",
        redactionState: "not_applicable",
        payload
      });
      compressionEventId = event.eventId;
    } else {
      const event = await input.events.append({
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        scopeType: "request",
        scopeId: input.requestId,
        sessionId: input.sessionId,
        correlationId: input.requestId,
        idempotencyKey: input.idempotencyKey,
        producer: "prompt-proxy.compression",
        eventType: "compression.recorded",
        redactionState: "not_applicable",
        payload
      });
      compressionEventId = event.eventId;
    }
  } catch (error) {
    eventEmitFailed = true;
    input.warn(error, "compression event emit failed");
  }
  return {
    body,
    records,
    compressionEventId,
    receiptIds: compressionEventId === undefined ? [] : compressionReceiptIds(compressionEventId, records),
    eventEmitFailed,
    compressionFailed
  };
}

export async function appendCompressionEvidence(input: {
  events: EventService;
  tenantId: string;
  workspaceId: string;
  requestId: string;
  idempotencyKey: string;
  sessionId?: string;
  surface: Surface;
  policy: CompressionPolicy;
  originalBody: unknown;
  compressedBody: unknown;
  forwardedBody: unknown;
  result: CompressionForwardResult;
  warn: (error: unknown, message: string) => void;
}) {
  const summary = compressionRecordSummary(input.result.records);
  const providerWouldReceiveCompressedToolOutput = summary.appliedBlocks > 0 && compressionPolicyMutates(input.policy);
  const payload: JsonObject = {
    surface: input.surface,
    mode: input.policy.mode,
    policy: input.policy as unknown as JsonObject,
    evaluatedBlocks: summary.evaluatedBlocks,
    appliedBlocks: summary.appliedBlocks,
    candidateBlocks: summary.candidateBlocks,
    skippedBlocks: summary.skippedBlocks,
    savedEstimatedTokens: summary.savedEstimatedTokens,
    ruleIds: summary.ruleIds,
    receiptIds: input.result.receiptIds,
    originalRequestHash: requestBodyHash(input.originalBody),
    compressedRequestHash: requestBodyHash(input.compressedBody),
    forwardedRequestHash: requestBodyHash(input.forwardedBody),
    providerWouldReceiveCompressedToolOutput,
    forwardedToolOutputState: providerWouldReceiveCompressedToolOutput ? "some_compressed" : "original",
    compressionEventEmitted: input.result.compressionEventId !== undefined
  };
  if (input.result.compressionEventId !== undefined) payload.compressionEventId = input.result.compressionEventId;
  if (input.result.eventEmitFailed) payload.compressionEventEmitFailed = true;
  if (input.result.compressionFailed) payload.compressionFailure = "tool_result_compression_failed";

  try {
    await input.events.append({
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      scopeType: "request",
      scopeId: input.requestId,
      sessionId: input.sessionId,
      correlationId: input.requestId,
      idempotencyKey: `${input.idempotencyKey}:compression-evidence`,
      producer: "prompt-proxy.routing",
      eventType: "routing.compression_evidence_recorded",
      redactionState: "not_applicable",
      payload
    });
  } catch (error) {
    input.warn(error, "compression evidence event emit failed");
  }
}

export function compressionForwardTelemetry(result: CompressionForwardResult, policy: CompressionPolicy): JsonObject {
  const summary = compressionRecordSummary(result.records);
  const providerWouldReceiveCompressedToolOutput = summary.appliedBlocks > 0 && compressionPolicyMutates(policy);
  const payload: JsonObject = {
    compressionMode: policy.mode,
    compressionEvaluatedBlocks: summary.evaluatedBlocks,
    compressionAppliedBlocks: summary.appliedBlocks,
    compressionCandidateBlocks: summary.candidateBlocks,
    compressionSkippedBlocks: summary.skippedBlocks,
    compressionSavedEstimatedTokens: summary.savedEstimatedTokens,
    compressionRuleIds: summary.ruleIds,
    compressionReceiptIds: result.receiptIds,
    compressionEventEmitted: result.compressionEventId !== undefined,
    providerWouldReceiveCompressedToolOutput,
    providerToolOutputState: providerWouldReceiveCompressedToolOutput ? "some_compressed" : "original"
  };
  if (result.compressionEventId !== undefined) payload.compressionEventId = result.compressionEventId;
  if (result.eventEmitFailed) payload.compressionEventEmitFailed = true;
  if (result.compressionFailed) payload.compressionFailure = "tool_result_compression_failed";
  return payload;
}

export function providerCompressionTerminalTelemetry(
  compressionTelemetry: JsonObject | undefined,
  providerRequestConfirmed: boolean
): JsonObject {
  if (!compressionTelemetry) return {};
  return {
    ...compressionTelemetry,
    providerRequestConfirmed,
    providerSawCompressedToolOutput:
      providerRequestConfirmed && compressionTelemetry.providerWouldReceiveCompressedToolOutput === true
  };
}

async function attachCompressionArtifacts(input: {
  artifactStore?: CompressionArtifactStore;
  tenantId: string;
  workspaceId: string;
  requestId: string;
  surface: Surface;
  policy: CompressionPolicy;
  originalBody: unknown;
  transformedBody: unknown;
  records: CompressionRecord[];
  warn: (error: unknown, message: string) => void;
}) {
  if (!input.artifactStore) return;
  if (!input.policy.storeOriginalArtifact && !input.policy.storeCompressedArtifact) return;
  for (const record of input.records) {
    if (record.status === "skipped") continue;
    const originalContent = contentAtBlockPath(input.surface, input.originalBody, record.blockPath);
    const compressedContent = contentAtBlockPath(input.surface, input.transformedBody, record.blockPath);
    try {
      if (input.policy.storeOriginalArtifact) {
        const artifact = await input.artifactStore.captureCompressionArtifact({
          organizationId: input.tenantId,
          workspaceId: input.workspaceId,
          requestId: input.requestId,
          surface: input.surface,
          kind: "compression_original_tool_result",
          content: originalContent,
          blockPath: record.blockPath,
          toolName: record.tool,
          ruleId: record.rule,
          ruleVersion: record.ruleVersion,
          status: record.status
        });
        if (artifact) record.originalArtifactId = artifact.id;
      }
      if (input.policy.storeCompressedArtifact) {
        const artifact = await input.artifactStore.captureCompressionArtifact({
          organizationId: input.tenantId,
          workspaceId: input.workspaceId,
          requestId: input.requestId,
          surface: input.surface,
          kind: "compression_compressed_tool_result",
          content: compressedContent,
          blockPath: record.blockPath,
          toolName: record.tool,
          ruleId: record.rule,
          ruleVersion: record.ruleVersion,
          status: record.status
        });
        if (artifact) record.compressedArtifactId = artifact.id;
      }
    } catch (error) {
      input.warn(error, "compression artifact capture failed");
    }
  }
}

function contentAtBlockPath(surface: Surface, body: unknown, blockPath: string) {
  const block = valueAtPath(body, blockPath);
  if (!isRecord(block)) return block;
  if (surface === "anthropic-messages") return block.content;
  if (surface === "openai-responses") return block.output;
  if (surface === "openai-chat") return block.content;
  return block;
}

function valueAtPath(value: unknown, path: string) {
  return path.split(".").reduce<unknown>((current, part) => {
    if (Array.isArray(current)) return current[Number(part)];
    if (isRecord(current)) return current[part];
    return undefined;
  }, value);
}

function compressionRecordSummary(records: CompressionRecord[]) {
  return {
    evaluatedBlocks: records.length,
    appliedBlocks: records.filter((record) => record.status === "applied").length,
    candidateBlocks: records.filter((record) => record.status === "candidate").length,
    skippedBlocks: records.filter((record) => record.status === "skipped").length,
    savedEstimatedTokens: records.reduce((sum, record) => sum + record.savedEstimatedTokens, 0),
    ruleIds: Array.from(new Set(records.map((record) => record.rule))).sort()
  };
}

function compressionReceiptIds(eventId: string, records: CompressionRecord[]) {
  return records.map((_, index) => `${eventId}:compression:${index}`);
}

export function requestBodyHash(body: unknown) {
  return `sha256:${createHash("sha256").update(stableJson(body)).digest("hex")}`;
}

// Both walkers rebuild only the spine that leads to a rewritten block —
// untouched messages/items keep their original references. Bodies reach tens
// of MB and most requests have nothing eligible to compress, so a deep clone
// per request would be an avoidable hot-path allocation. The input body is
// never mutated; spreading a rewritten block preserves its other fields,
// including any cache_control markers.
function compressAnthropic(
  request: Record<string, unknown>,
  rules: CompressionRule[],
  records: CompressionRecord[],
  duplicates: DuplicateTracker | undefined,
  options: CompressionOptions
): unknown {
  if (!Array.isArray(request.messages)) return request;
  const toolNames = anthropicToolNames(request.messages);
  let changed = false;
  const messages = request.messages.map((message, messageIndex) => {
    if (!isRecord(message) || message.role !== "user" || !Array.isArray(message.content)) return message;
    let messageChanged = false;
    const content = message.content.map((block, blockIndex) => {
      if (!isRecord(block) || block.type !== "tool_result") return block;
      const blockPath = `messages.${messageIndex}.content.${blockIndex}`;
      const toolUseId = stringField(block, "tool_use_id");
      const ref = toolUseId ? toolNames.get(toolUseId) : undefined;
      const toolName = ref?.name ?? "unknown";
      const duplicate = applyDuplicateReference(toolName, block.content, records, duplicates, blockPath, options);
      if (duplicate !== undefined) {
        messageChanged = true;
        return { ...block, content: duplicate };
      }
      const replaced = applyRules(rules, toolName, ref?.input, block.content, records, options, blockPath);
      if (replaced === undefined) {
        trackDuplicateContent(block.content, duplicates);
        return block;
      }
      messageChanged = true;
      return { ...block, content: replaced };
    });
    if (!messageChanged) return message;
    changed = true;
    return { ...message, content };
  });
  return changed ? { ...request, messages } : request;
}

function compressOpenAI(
  request: Record<string, unknown>,
  rules: CompressionRule[],
  records: CompressionRecord[],
  duplicates: DuplicateTracker | undefined,
  options: CompressionOptions
): unknown {
  if (!Array.isArray(request.input)) return request;
  const callNames = openAICallNames(request.input);
  let changed = false;
  const input = request.input.map((item, itemIndex) => {
    if (!isRecord(item) || item.type !== "function_call_output") return item;
    const blockPath = `input.${itemIndex}`;
    const callId = stringField(item, "call_id");
    const ref = callId ? callNames.get(callId) : undefined;
    const toolName = ref?.name ?? "unknown";
    const duplicate = applyDuplicateReference(toolName, item.output, records, duplicates, blockPath, options);
    if (duplicate !== undefined) {
      changed = true;
      return { ...item, output: duplicate };
    }
    const replaced = applyRules(rules, toolName, ref?.input, item.output, records, options, blockPath);
    if (replaced === undefined) {
      trackDuplicateContent(item.output, duplicates);
      return item;
    }
    changed = true;
    return { ...item, output: replaced };
  });
  return changed ? { ...request, input } : request;
}

function compressOpenAIChat(
  request: Record<string, unknown>,
  rules: CompressionRule[],
  records: CompressionRecord[],
  duplicates: DuplicateTracker | undefined,
  options: CompressionOptions
): unknown {
  if (!Array.isArray(request.messages)) return request;
  const callRefs = openAIChatCallRefs(request.messages);
  let changed = false;
  const messages = request.messages.map((message, messageIndex) => {
    if (!isRecord(message) || message.role !== "tool") return message;
    const blockPath = `messages.${messageIndex}`;
    const toolCallId = stringField(message, "tool_call_id");
    const ref = toolCallId ? callRefs.get(toolCallId) : undefined;
    const toolName = ref?.name ?? "unknown";
    const duplicate = applyDuplicateReference(toolName, message.content, records, duplicates, blockPath, options);
    if (duplicate !== undefined) {
      changed = true;
      return { ...message, content: duplicate };
    }
    const replaced = applyRules(rules, toolName, ref?.input, message.content, records, options, blockPath);
    if (replaced === undefined) {
      trackDuplicateContent(message.content, duplicates);
      return message;
    }
    changed = true;
    return { ...message, content: replaced };
  });
  return changed ? { ...request, messages } : request;
}

// Apply the first rule that shrinks a tool-result content payload. Records the
// before/after size only when the filter actually shrank the content.
function applyRules(
  rules: CompressionRule[],
  toolName: string,
  toolInput: unknown,
  content: unknown,
  records: CompressionRecord[],
  options: CompressionOptions,
  blockPath: string
): unknown {
  const beforeChars = contentChars(content);
  const beforeBytes = contentBytes(content);
  let matchedRule: CompressionRule | undefined;
  let matchedBelowMin: CompressionRule | undefined;
  let matchedFilterError: CompressionRule | undefined;
  let matchedUnsupported: CompressionRule | undefined;
  let matchedWouldGrow: { rule: CompressionRule; afterChars: number; afterContent: unknown } | undefined;
  let matchedBelowSavings: {
    rule: CompressionRule;
    afterChars: number;
    afterContent: unknown;
    beforeTokenEstimate: TokenEstimate;
    afterTokenEstimate: TokenEstimate;
  } | undefined;
  for (const rule of rules) {
    if (!rule.matches(toolName)) continue;
    matchedRule ??= rule;
    const minBytes = Math.max(rule.minBytes ?? rule.minChars ?? MIN_COMPRESSIBLE_CHARS, options.minOriginalBytes ?? 0);
    if (beforeBytes < minBytes) {
      matchedBelowMin ??= rule;
      continue;
    }
    let replaced: unknown;
    try {
      replaced = rule.filter({ toolName, toolInput, content });
    } catch (error) {
      if (!options.recordSkips) throw error;
      matchedFilterError ??= rule;
      continue;
    }
    if (replaced === undefined) {
      matchedUnsupported ??= rule;
      continue;
    }
    const afterChars = contentChars(replaced);
    if (afterChars >= beforeChars) {
      matchedWouldGrow ??= { rule, afterChars, afterContent: replaced };
      continue;
    }
    const beforeTokenEstimate = estimateCompressionTokens(content, beforeChars, options.tokenEstimator);
    const afterTokenEstimate = estimateCompressionTokens(replaced, afterChars, options.tokenEstimator);
    const savedEstimatedTokens = beforeTokenEstimate.tokens - afterTokenEstimate.tokens;
    if (savedEstimatedTokens < (options.minSavingsTokens ?? 0)) {
      matchedBelowSavings ??= { rule, afterChars, afterContent: replaced, beforeTokenEstimate, afterTokenEstimate };
      continue;
    }
    const estimateSource = tokenEstimateSource(beforeTokenEstimate, afterTokenEstimate);
    records.push({
      tool: toolName,
      rule: rule.label,
      ruleVersion: rule.version,
      blockPath,
      status: options.measureOnly ? "candidate" : "applied",
      originalContentHash: contentSha256(content),
      compressedContentHash: contentSha256(replaced),
      beforeBytes,
      afterBytes: contentBytes(replaced),
      beforeChars,
      afterChars,
      beforeEstimatedTokens: beforeTokenEstimate.tokens,
      afterEstimatedTokens: afterTokenEstimate.tokens,
      savedEstimatedTokens,
      originalTokenEstimate: beforeTokenEstimate.tokens,
      compressedTokenEstimate: afterTokenEstimate.tokens,
      savedTokens: savedEstimatedTokens,
      estimateSource,
      ...shellCommandRecordFields(rule, toolInput, content)
    });
    return replaced;
  }
  if (options.recordSkips) {
    recordSkip({
      records,
      toolName,
      blockPath,
      content,
      beforeChars,
      rule: matchedFilterError ?? matchedBelowSavings?.rule ?? matchedWouldGrow?.rule ?? matchedBelowMin ?? matchedUnsupported ?? matchedRule,
      reason: skipReason(matchedRule, matchedBelowMin, matchedFilterError, matchedUnsupported, matchedWouldGrow, matchedBelowSavings),
      afterChars: matchedBelowSavings?.afterChars ?? matchedWouldGrow?.afterChars,
      afterContent: matchedBelowSavings?.afterContent ?? matchedWouldGrow?.afterContent,
      beforeTokenEstimate: matchedBelowSavings?.beforeTokenEstimate,
      afterTokenEstimate: matchedBelowSavings?.afterTokenEstimate,
      tokenEstimator: options.tokenEstimator,
      toolInput
    });
  }
  return undefined;
}

function applyDuplicateReference(
  toolName: string,
  content: unknown,
  records: CompressionRecord[],
  duplicates: DuplicateTracker | undefined,
  blockPath: string,
  options: CompressionOptions
): unknown {
  if (!duplicates) return undefined;
  const fingerprint = contentFingerprint(content);
  const beforeBytes = contentBytes(content);
  if (beforeBytes < Math.max(MIN_COMPRESSIBLE_CHARS, options.minOriginalBytes ?? 0)) return undefined;
  if (!duplicates.has(fingerprint.key)) return undefined;
  const replacement = duplicateReference(content, fingerprint.hash, fingerprint.chars);
  const afterChars = contentChars(replacement);
  if (afterChars >= fingerprint.chars) return undefined;
  const beforeTokenEstimate = estimateCompressionTokens(content, fingerprint.chars, options.tokenEstimator);
  const afterTokenEstimate = estimateCompressionTokens(replacement, afterChars, options.tokenEstimator);
  const savedEstimatedTokens = beforeTokenEstimate.tokens - afterTokenEstimate.tokens;
  const estimateSource = tokenEstimateSource(beforeTokenEstimate, afterTokenEstimate);
  if (savedEstimatedTokens < (options.minSavingsTokens ?? 0)) {
    if (options.recordSkips) {
      recordSkip({
        records,
        toolName,
        blockPath,
        content,
        beforeChars: fingerprint.chars,
        ruleLabel: "duplicate-tool-result-reference",
        ruleVersion: 1,
        reason: "below_min_savings",
        afterChars,
        afterContent: replacement,
        beforeTokenEstimate,
        afterTokenEstimate
      });
    }
    return undefined;
  }
  records.push({
    tool: toolName,
    rule: "duplicate-tool-result-reference",
    ruleVersion: 1,
    blockPath,
    status: options.measureOnly ? "candidate" : "applied",
    originalContentHash: contentSha256(content),
    compressedContentHash: contentSha256(replacement),
    beforeBytes,
    afterBytes: contentBytes(replacement),
    beforeChars: fingerprint.chars,
    afterChars,
    beforeEstimatedTokens: beforeTokenEstimate.tokens,
    afterEstimatedTokens: afterTokenEstimate.tokens,
    savedEstimatedTokens,
    originalTokenEstimate: beforeTokenEstimate.tokens,
    compressedTokenEstimate: afterTokenEstimate.tokens,
    savedTokens: savedEstimatedTokens,
    estimateSource
  });
  return replacement;
}

function skipReason(
  matchedRule: CompressionRule | undefined,
  matchedBelowMin: CompressionRule | undefined,
  matchedFilterError: CompressionRule | undefined,
  matchedUnsupported: CompressionRule | undefined,
  matchedWouldGrow: { rule: CompressionRule; afterChars: number; afterContent: unknown } | undefined,
  matchedBelowSavings: {
    rule: CompressionRule;
    afterChars: number;
    afterContent: unknown;
    beforeTokenEstimate: TokenEstimate;
    afterTokenEstimate: TokenEstimate;
  } | undefined
): CompressionSkipReason {
  if (!matchedRule) return "no_matching_rule";
  if (matchedFilterError) return "tool_result_error";
  if (matchedBelowSavings) return "below_min_savings";
  if (matchedWouldGrow) return "would_grow";
  if (matchedBelowMin) return "below_min_original_bytes";
  if (matchedUnsupported) return "content_shape_unsupported";
  return "no_matching_rule";
}

function recordSkip(input: {
  records: CompressionRecord[];
  toolName: string;
  blockPath: string;
  content: unknown;
  beforeChars: number;
  rule?: CompressionRule;
  ruleLabel?: string;
  ruleVersion?: number;
  reason: CompressionSkipReason;
  afterChars?: number;
  afterContent?: unknown;
  beforeTokenEstimate?: TokenEstimate;
  afterTokenEstimate?: TokenEstimate;
  tokenEstimator?: CompressionTokenEstimator;
  toolInput?: unknown;
}) {
  const afterChars = input.afterChars ?? input.beforeChars;
  const beforeTokenEstimate = input.beforeTokenEstimate ?? estimateCompressionTokens(input.content, input.beforeChars, input.tokenEstimator);
  const afterTokenEstimate = input.afterTokenEstimate ?? estimateCompressionTokens(
    input.afterContent ?? input.content,
    afterChars,
    input.tokenEstimator
  );
  const savedEstimatedTokens = beforeTokenEstimate.tokens - afterTokenEstimate.tokens;
  const estimateSource = tokenEstimateSource(beforeTokenEstimate, afterTokenEstimate);
  input.records.push({
    tool: input.toolName,
    rule: input.ruleLabel ?? input.rule?.label ?? "none",
    ruleVersion: input.ruleVersion ?? input.rule?.version ?? 0,
    blockPath: input.blockPath,
    status: "skipped",
    skipReason: input.reason,
    originalContentHash: contentSha256(input.content),
    compressedContentHash: input.afterContent === undefined ? contentSha256(input.content) : contentSha256(input.afterContent),
    beforeBytes: contentBytes(input.content),
    afterBytes: input.afterContent === undefined ? contentBytes(input.content) : contentBytes(input.afterContent),
    beforeChars: input.beforeChars,
    afterChars,
    beforeEstimatedTokens: beforeTokenEstimate.tokens,
    afterEstimatedTokens: afterTokenEstimate.tokens,
    savedEstimatedTokens,
    originalTokenEstimate: beforeTokenEstimate.tokens,
    compressedTokenEstimate: afterTokenEstimate.tokens,
    savedTokens: savedEstimatedTokens,
    estimateSource,
    ...shellCommandRecordFields(input.rule, input.toolInput, input.content)
  });
}

function trackDuplicateContent(content: unknown, duplicates: DuplicateTracker | undefined) {
  if (!duplicates) return;
  const fingerprint = contentFingerprint(content);
  if (fingerprint.chars >= MIN_COMPRESSIBLE_CHARS) duplicates.add(fingerprint.key);
}

function contentFingerprint(content: unknown) {
  const serialized = typeof content === "string" ? content : stableJson(content);
  const hash = createHash("sha256").update(serialized).digest("hex");
  const chars = typeof content === "string" ? content.length : serialized.length;
  return { hash, chars, key: `${hash}:${serialized.length}` };
}

function contentSha256(content: unknown) {
  return `sha256:${createHash("sha256").update(serializedContent(content)).digest("hex")}`;
}

function contentBytes(content: unknown) {
  return Buffer.byteLength(serializedContent(content));
}

function estimateCompressionTokens(
  content: unknown,
  chars: number,
  estimator: CompressionTokenEstimator | undefined
): TokenEstimate {
  if (!estimator) return { tokens: roughTokenEstimate(chars), source: ROUGH_COMPRESSION_TOKEN_ESTIMATE_SOURCE };
  const tokens = estimator.countTokens(content);
  if (tokens !== undefined && Number.isFinite(tokens) && tokens >= 0) {
    return { tokens: Math.ceil(tokens), source: estimator.estimateSource };
  }
  return { tokens: roughTokenEstimate(chars), source: ROUGH_COMPRESSION_TOKEN_ESTIMATE_SOURCE };
}

function tokenEstimateSource(before: TokenEstimate, after: TokenEstimate) {
  return before.source === after.source ? before.source : `${before.source}->${after.source}`;
}

function shellCommandRecordFields(rule: CompressionRule | undefined, toolInput: unknown, content: unknown) {
  if (rule?.label !== "bash-output-noise" && rule?.label !== "shell-command-lossy-summary") return {};
  const command = shellCommandFromInput(toolInput);
  const commandClass = classifyShellCommand(toolInput, typeof content === "string" ? content : "");
  return {
    ...(command ? { command } : {}),
    commandClass
  };
}

function aggregateEstimateSource(records: CompressionRecord[]) {
  const sources = new Set(records.map((record) => record.estimateSource));
  return sources.size === 1 ? records[0].estimateSource : "mixed";
}

function serializedContent(content: unknown) {
  if (typeof content === "string") return content;
  return JSON.stringify(content) ?? "null";
}

function duplicateReference(content: unknown, hash: string, originalChars: number) {
  const text = `[duplicate tool result omitted; contentHash=sha256:${hash}; originalChars=${originalChars}]`;
  return Array.isArray(content) ? [{ type: "text", text }] : text;
}

function anthropicToolNames(messages: unknown): Map<string, ToolRef> {
  const map = new Map<string, ToolRef>();
  if (!Array.isArray(messages)) return map;
  for (const message of messages) {
    if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isRecord(block) && block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
        map.set(block.id, { name: block.name, input: block.input });
      }
    }
  }
  return map;
}

function openAICallNames(input: unknown[]): Map<string, ToolRef> {
  const map = new Map<string, ToolRef>();
  for (const item of input) {
    if (isRecord(item) && item.type === "function_call" && typeof item.call_id === "string" && typeof item.name === "string") {
      map.set(item.call_id, { name: item.name, input: item.arguments });
    }
  }
  return map;
}

function openAIChatCallRefs(messages: unknown[]): Map<string, ToolRef> {
  const map = new Map<string, ToolRef>();
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls) {
      if (!isRecord(call) || typeof call.id !== "string") continue;
      const fn = isRecord(call.function) ? call.function : undefined;
      const name = (fn ? stringField(fn, "name") : undefined) ?? stringField(call, "name");
      if (name) map.set(call.id, { name, input: fn?.arguments ?? call.arguments });
    }
  }
  return map;
}

// Shared shape handler for content filters: tool-result content is either a
// bare string or Claude Code's [{type:"text", text}] block array. Applies a
// per-string transform (which returns a replacement or undefined for "leave
// as-is") and returns the rewritten content, or undefined if nothing changed.
export function mapTextContent(
  content: unknown,
  transform: (text: string) => string | undefined
): unknown {
  if (typeof content === "string") {
    return transform(content);
  }
  if (Array.isArray(content)) {
    let changed = false;
    const next = content.map((block) => {
      if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
        const replaced = transform(block.text);
        if (replaced !== undefined && replaced !== block.text) {
          changed = true;
          return { ...block, text: replaced };
        }
      }
      return block;
    });
    return changed ? next : undefined;
  }
  return undefined;
}

function contentChars(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "string") return value.length;
  return stableJson(value).length;
}
