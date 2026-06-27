import { builtinProviderCachingCapabilities, type ProviderCachingCapabilities, type ProviderCacheTtl } from "@proxy/schema";

import type { Dialect, JsonObject, RouteContext, RouteDecision, Surface } from "./types.js";
import { translators } from "./translators/index.js";
import { isRecord, roughTokenEstimate, sha256, stableJson } from "./util.js";

export type PromptCachePlan = {
  mode: "off" | "observe" | "implicit" | "explicit";
  provider: string;
  dialect: string;
  cacheKey?: "provided";
  cacheGroup?: {
    source: "prompt_cache_key" | "session" | "unknown";
    key: string;
  };
  retention?: ProviderCacheTtl | "in_memory";
  breakpointStrategy?: "preserve_client" | "top_level_auto" | "static_prefix";
  appliedControls: string[];
  skippedControls: Array<{ control: string; reason: string }>;
};

const knownPromptCacheControls = new Set([
  "cache_key_preserved",
  "client_breakpoints_preserved",
  "cross_dialect_cache_fields",
  "implicit_prefix_caching",
  "prompt_cache",
  "retention_preserved",
  "top_level_auto_breakpoint",
  "ttl_1h"
]);

const knownPromptCacheSkipReasons = new Set([
  "missing_provider_settings",
  "not_eligible",
  "not_multi_turn_or_no_cacheable_target",
  "provider_capability_unavailable",
  "setting_disabled",
  "translated_request"
]);
const MIN_TTL_UPGRADE_CACHEABLE_TOKENS = 2048;

export function promptCachePlanEventPayload(input: {
  surface: Surface;
  model: string;
  route?: string | null;
  plan: PromptCachePlan;
}): JsonObject {
  const payload: JsonObject = {
    surface: input.surface,
    provider: input.plan.provider,
    model: input.model,
    dialect: input.plan.dialect,
    mode: input.plan.mode,
    translated: input.surface !== input.plan.dialect,
    appliedControls: input.plan.appliedControls.map(promptCacheControlLabel),
    skippedControls: input.plan.skippedControls.map((skipped) => ({
      control: promptCacheControlLabel(skipped.control),
      reason: promptCacheSkipReasonLabel(skipped.reason)
    }))
  };
  if (input.route) payload.route = input.route;
  if (input.plan.cacheKey) payload.cacheKey = input.plan.cacheKey;
  if (input.plan.cacheGroup) payload.cacheGroup = {
    source: input.plan.cacheGroup.source,
    key: input.plan.cacheGroup.key
  };
  if (input.plan.retention) payload.retention = input.plan.retention;
  if (input.plan.breakpointStrategy) payload.breakpointStrategy = input.plan.breakpointStrategy;
  return payload;
}

export function promptCacheControlLabel(control: string) {
  return knownPromptCacheControls.has(control) ? control : "other";
}

export function promptCacheSkipReasonLabel(reason: string) {
  return knownPromptCacheSkipReasons.has(reason) ? reason : "other";
}

export type PromptCachePlanSettings = {
  automaticCaching?: boolean;
  cacheTtlUpgrade?: boolean;
};

export function computePromptCachePlan(input: {
  body: unknown;
  bodyDialect?: Surface | Dialect;
  sourceBody?: unknown;
  context: Pick<RouteContext, "surface"> & Partial<Pick<RouteContext, "transport" | "harnessProfileId" | "estimatedInputTokens" | "sessionId">>;
  decision: RouteDecision;
  capabilities?: ProviderCachingCapabilities;
  settings?: PromptCachePlanSettings;
}): PromptCachePlan {
  const provider = input.decision.provider ?? input.decision.providerSettings?.provider ?? "unknown";
  const dialect = input.decision.providerSettings?.dialect ?? input.context.surface;
  const capabilities = input.capabilities ?? builtinProviderCachingCapabilities(provider);
  const targetBody = bodyForTargetDialect(input.body, input.bodyDialect ?? input.context.surface, dialect);
  const body = isRecord(targetBody) ? targetBody : {};
  const sourceBody = isRecord(input.sourceBody) ? input.sourceBody : undefined;
  const translatedCacheFields = input.context.surface !== dialect && sourceBody !== undefined && hasProviderCacheField(sourceBody);
  const skippedControls: PromptCachePlan["skippedControls"] = [];
  const appliedControls: string[] = [];

  if (!input.decision.providerSettings) {
    return {
      mode: "off",
      provider,
      dialect,
      appliedControls,
      skippedControls: [{ control: "prompt_cache", reason: "missing_provider_settings" }]
    };
  }

  if (capabilities.implicitPrefixCaching) {
    appliedControls.push("implicit_prefix_caching");
    const cacheKey = cacheKeyState(body, capabilities);
    const cacheGroup = implicitCacheGroup(body, capabilities, input.context.sessionId);
    if (cacheKey) appliedControls.push("cache_key_preserved");
    const retention = retentionState(body, capabilities);
    if (retention) appliedControls.push("retention_preserved");
    if (input.context.surface !== dialect) {
      skippedControls.push({ control: "cross_dialect_cache_fields", reason: "translated_request" });
    }
    return {
      mode: "implicit",
      provider,
      dialect,
      cacheKey,
      cacheGroup,
      retention,
      appliedControls,
      skippedControls
    };
  }

  if (capabilities.explicitBreakpoints) {
    const hasBreakpoints = hasAnthropicCacheControl(body);
    const multiTurn = isAnthropicMultiTurnRequest(body);
    const canAuto = input.settings?.automaticCaching === true && multiTurn && !hasBreakpoints;
    const ttlBody = canAuto && body.cache_control === undefined
      ? { ...body, cache_control: { type: "ephemeral" } }
      : body;
    const canUpgradeTtl = input.settings?.cacheTtlUpgrade === true &&
      capabilities.supportedTtls.includes("1h") &&
      hasAnthropicDefaultTtlCacheControl(ttlBody) &&
      isAnthropicCacheTtlUpgradeEligible(ttlBody);

    if (hasBreakpoints) {
      appliedControls.push("client_breakpoints_preserved");
    } else if (canAuto) {
      appliedControls.push("top_level_auto_breakpoint");
    } else {
      skippedControls.push({
        control: "top_level_auto_breakpoint",
        reason: input.settings?.automaticCaching === true
          ? "not_multi_turn_or_no_cacheable_target"
          : "setting_disabled"
      });
    }

    if (canUpgradeTtl) {
      appliedControls.push("ttl_1h");
    } else if (input.settings?.cacheTtlUpgrade === true) {
      skippedControls.push({ control: "ttl_1h", reason: "not_eligible" });
    }
    if (translatedCacheFields) {
      skippedControls.push({ control: "cross_dialect_cache_fields", reason: "translated_request" });
    }

    let strategy: PromptCachePlan["breakpointStrategy"];
    if (hasBreakpoints) strategy = "preserve_client";
    else if (canAuto) strategy = "top_level_auto";

    return {
      mode: appliedControls.length > 0 ? "explicit" : "observe",
      provider,
      dialect,
      breakpointStrategy: strategy,
      appliedControls,
      skippedControls
    };
  }

  return {
    mode: "off",
    provider,
    dialect,
    appliedControls,
    skippedControls: [{ control: "prompt_cache", reason: "provider_capability_unavailable" }]
  };
}

function bodyForTargetDialect(body: unknown, source: Surface | Dialect, target: string) {
  if (source === target) return body;
  const translator = translators.get(source as RouteContext["surface"], target as RouteContext["surface"]);
  return translator?.request(body) ?? body;
}

function cacheKeyState(body: Record<string, unknown>, capabilities: ProviderCachingCapabilities): "provided" | undefined {
  if (!capabilities.cacheKeyField) return undefined;
  return typeof body[capabilities.cacheKeyField] === "string" ? "provided" : undefined;
}

function implicitCacheGroup(
  body: Record<string, unknown>,
  capabilities: ProviderCachingCapabilities,
  sessionId: string | undefined
): NonNullable<PromptCachePlan["cacheGroup"]> {
  const cacheKey = capabilities.cacheKeyField ? body[capabilities.cacheKeyField] : undefined;
  if (typeof cacheKey === "string") {
    return {
      source: "prompt_cache_key",
      key: sha256(`prompt_cache_key:${cacheKey}`)
    };
  }
  if (sessionId) return { source: "session", key: sessionId };
  return { source: "unknown", key: "unknown" };
}

function retentionState(body: Record<string, unknown>, capabilities: ProviderCachingCapabilities): ProviderCacheTtl | "in_memory" | undefined {
  if (!capabilities.retentionField) return undefined;
  const value = body[capabilities.retentionField];
  if (value === "in_memory" || value === "24h" || value === "1h" || value === "5m") return value;
  return undefined;
}

function hasProviderCacheField(body: Record<string, unknown>) {
  return body.prompt_cache_key !== undefined ||
    body.prompt_cache_retention !== undefined ||
    hasAnthropicCacheControl(body);
}

export function hasAnthropicCacheControl(request: Record<string, unknown>): boolean {
  if (request.cache_control !== undefined) return true;
  if (anyBlockHasCacheControl(request.tools)) return true;
  if (anyBlockHasCacheControl(request.system)) return true;
  if (Array.isArray(request.messages)) {
    for (const message of request.messages) {
      if (isRecord(message) && anyBlockHasCacheControl(message.content)) return true;
    }
  }
  return false;
}

export function hasAnthropicDefaultTtlCacheControl(request: Record<string, unknown>): boolean {
  if (isDefaultTtlCacheControl(request)) return true;
  if (anyBlockHasDefaultTtlCacheControl(request.tools)) return true;
  if (anyBlockHasDefaultTtlCacheControl(request.system)) return true;
  if (Array.isArray(request.messages)) {
    for (const message of request.messages) {
      if (isRecord(message) && anyBlockHasDefaultTtlCacheControl(message.content)) return true;
    }
  }
  return false;
}

function anyBlockHasCacheControl(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => anyBlockHasCacheControl(item));
  if (!isRecord(value)) return false;
  if (value.cache_control !== undefined) return true;
  return Array.isArray(value.content) && anyBlockHasCacheControl(value.content);
}

function anyBlockHasDefaultTtlCacheControl(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => anyBlockHasDefaultTtlCacheControl(item));
  if (!isRecord(value)) return false;
  if (isDefaultTtlCacheControl(value)) return true;
  return Array.isArray(value.content) && anyBlockHasDefaultTtlCacheControl(value.content);
}

function isDefaultTtlCacheControl(block: Record<string, unknown>) {
  const cc = block.cache_control;
  return isRecord(cc) && cc.type === "ephemeral" && !cc.ttl;
}

export function isAnthropicMultiTurnRequest(request: Record<string, unknown>): boolean {
  return Array.isArray(request.messages) &&
    request.messages.some((message) => isRecord(message) && message.role === "assistant");
}

export function isAnthropicCacheTtlUpgradeEligible(request: Record<string, unknown>) {
  if (!Array.isArray(request.messages)) return false;
  if (!isAnthropicMultiTurnRequest(request)) return false;
  return roughTokenEstimate(largestCacheControlPrefixChars(request)) >= MIN_TTL_UPGRADE_CACHEABLE_TOKENS;
}

function largestCacheControlPrefixChars(request: Record<string, unknown>) {
  let max = request.cache_control === undefined ? 0 : cacheablePrefixChars(request);
  let prefix = accumulateCacheablePrefix(request.tools, 0, (chars) => {
    max = Math.max(max, chars);
  });
  prefix = accumulateCacheablePrefix(request.system, prefix, (chars) => {
    max = Math.max(max, chars);
  });
  if (Array.isArray(request.messages)) {
    for (const message of request.messages) {
      if (isRecord(message)) {
        prefix += contentChars(message.role);
        prefix = accumulateCacheablePrefix(message.content, prefix, (chars) => {
          max = Math.max(max, chars);
        });
      } else {
        prefix = accumulateCacheablePrefix(message, prefix, (chars) => {
          max = Math.max(max, chars);
        });
      }
    }
  }
  return max;
}

function cacheablePrefixChars(request: Record<string, unknown>) {
  let chars = 0;
  chars += request.tools === undefined ? 0 : stableJson(request.tools).length;
  chars += contentChars(request.system);
  if (Array.isArray(request.messages)) {
    for (const message of request.messages) {
      chars += isRecord(message) ? contentChars(message.content) : contentChars(message);
    }
  }
  return chars;
}

function accumulateCacheablePrefix(
  value: unknown,
  prefix: number,
  onBreakpoint: (chars: number) => void
): number {
  if (Array.isArray(value)) {
    let current = prefix;
    for (const item of value) {
      current = accumulateCacheablePrefix(item, current, onBreakpoint);
    }
    return current;
  }
  if (isRecord(value) && Array.isArray(value.content)) {
    const base = prefix + recordShellChars(value);
    const next = accumulateCacheablePrefix(value.content, base, onBreakpoint);
    if (value.cache_control !== undefined) onBreakpoint(next);
    return next;
  }
  const next = prefix + contentChars(value);
  if (isRecord(value) && value.cache_control !== undefined) onBreakpoint(next);
  return next;
}

function recordShellChars(value: Record<string, unknown>) {
  return Object.entries(value)
    .reduce((sum, [key, item]) => sum + key.length + (key === "content" ? 0 : contentChars(item)), 0);
}

function contentChars(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "string") return value.length;
  if (typeof value === "number" || typeof value === "boolean") return String(value).length;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + contentChars(item), 0);
  if (isRecord(value)) {
    return Object.entries(value)
      .reduce((sum, [key, item]) => sum + key.length + contentChars(item), 0);
  }
  return 0;
}
