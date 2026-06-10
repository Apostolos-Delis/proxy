import { z } from "zod";

import { REQUEST_STATUSES, ROUTE_NAMES, SURFACE_NAMES } from "@prompt-proxy/schema";

import { modelCatalogList, type ModelCatalog } from "../../catalog.js";
import type { AdminQueryService } from "../../persistence/adminQueries.js";
import type { AdminQueriesFactory } from "./index.js";
import type { PromptAccessAuditStore } from "../../persistence/promptAccessAudit.js";
import type { CapabilityRegistry } from "../registry.js";

export const PROMPT_GET_CAPABILITY_KEY = "prompts.get.v1";
export const CONSOLE_AGENT_PROMPT_ACCESS_PATH = `console-agent:${PROMPT_GET_CAPABILITY_KEY}`;

export type ReadCapabilityDeps = {
  adminQueries: AdminQueriesFactory;
  promptAccessAudit: PromptAccessAuditStore;
  catalog: ModelCatalog;
};

const requestSearchInput = z.object({
  status: z.enum(REQUEST_STATUSES).optional(),
  surface: z.enum(SURFACE_NAMES).optional(),
  route: z.enum(ROUTE_NAMES).optional().describe("Final route of the request's route decision."),
  sessionId: z.string().optional(),
  userId: z.string().optional(),
  routingConfigId: z.string().optional(),
  start: z.string().optional().describe("ISO timestamp lower bound on request creation."),
  end: z.string().optional().describe("ISO timestamp upper bound on request creation."),
  limit: z.number().int().min(1).max(200).optional().describe("Defaults to 50.")
});

const sessionSearchInput = z.object({
  userId: z.string().optional(),
  surface: z.enum(SURFACE_NAMES).optional(),
  start: z.string().optional().describe("ISO lower bound on when the session was last active."),
  end: z.string().optional().describe("ISO upper bound on when the session was last active."),
  limit: z.number().int().min(1).max(200).optional().describe("Defaults to 50.")
});

const promptSearchInput = z.object({
  userId: z.string().optional(),
  surface: z.enum(SURFACE_NAMES).optional(),
  route: z.enum(ROUTE_NAMES).optional(),
  model: z.string().optional(),
  start: z.string().optional().describe("ISO timestamp lower bound on artifact creation."),
  end: z.string().optional().describe("ISO timestamp upper bound on artifact creation."),
  limit: z.number().int().min(1).max(100).optional().describe("Defaults to 50.")
});

const usageInput = z.object({
  groupBy: z.enum(["user", "provider", "model", "route", "surface", "session"]).optional(),
  start: z.string().optional(),
  end: z.string().optional()
});

export function registerReadCapabilities(registry: CapabilityRegistry, deps: ReadCapabilityDeps) {
  const { adminQueries, promptAccessAudit, catalog } = deps;

  return registry
    .register({
      key: "overview.get.v1",
      description:
        "Organization snapshot: request counts, token totals, cost and savings, route quality counters, and the active routing configs.",
      input: z.object({}),
      sideEffect: "none",
      handler: async () => adminQueries().overview()
    })
    .register({
      key: "requests.search.v1",
      description:
        "Search proxied LLM requests with filters. Returns compact request summaries ordered newest first.",
      input: requestSearchInput,
      sideEffect: "none",
      handler: async (_context, input) => {
        const result = await adminQueries().requestsFiltered({ ...input, limit: input.limit ?? 50 });
        return { count: result.data.length, requests: result.data.map(compactRequest) };
      }
    })
    .register({
      key: "requests.get.v1",
      description:
        "Full detail for one request: route decision with classifier rationale, provider attempts, usage, and its event timeline.",
      input: z.object({ requestId: z.string() }),
      sideEffect: "none",
      handler: async (_context, input) => {
        const detail = await adminQueries().requestDetail(input.requestId);
        if (!detail.request) return { found: false };
        return { found: true, request: detail.request, events: detail.events };
      }
    })
    .register({
      key: "usage.analytics.v1",
      description:
        "Aggregated usage and cost analytics grouped by user, provider, model, route, surface, or session. Returns the top 100 groups by selected cost plus totals.",
      input: usageInput,
      sideEffect: "none",
      handler: async (_context, input) => {
        const result = await adminQueries().usage(input);
        return { ...result, data: result.data.slice(0, 100) };
      }
    })
    .register({
      key: "sessions.search.v1",
      description:
        "List harness sessions (Codex / Claude Code traffic). The start/end window filters on when a session was last active.",
      input: sessionSearchInput,
      sideEffect: "none",
      handler: async (_context, input) => {
        const result = await adminQueries().sessionsFiltered({ ...input, limit: input.limit ?? 50 });
        return { count: result.data.length, sessions: result.data };
      }
    })
    .register({
      key: "sessions.get.v1",
      description:
        "Full detail for one harness session: requests, route decisions, provider attempts, usage, and prompt artifact metadata.",
      input: z.object({ sessionId: z.string() }),
      sideEffect: "none",
      handler: async (_context, input) => {
        const detail = await adminQueries().sessionDetail(input.sessionId);
        if (!detail) return { found: false };
        return {
          found: true,
          session: detail.session,
          user: detail.user,
          requests: detail.requests.map(compactRequest),
          promptArtifacts: detail.promptArtifacts.map(promptMetadataOnly),
          routeDecisions: detail.routeDecisions,
          providerAttempts: detail.providerAttempts
        };
      }
    })
    .register({
      key: "routing_configs.list.v1",
      description: "List routing configs with status, active version summary, route matrix, and assigned API key counts.",
      input: z.object({}),
      sideEffect: "none",
      handler: async () => adminQueries().routingConfigs()
    })
    .register({
      key: "routing_configs.get.v1",
      description: "Full detail for one routing config, including every version and the active config document.",
      input: z.object({ configId: z.string() }),
      sideEffect: "none",
      handler: async (_context, input) => {
        const detail = await adminQueries().routingConfigDetail(input.configId);
        return detail ? { found: true, ...detail } : { found: false };
      }
    })
    .register({
      key: "api_keys.list.v1",
      description:
        "List API keys with their routing config assignment and lifecycle timestamps. Returns at most 200 keys, newest first.",
      input: z.object({}),
      sideEffect: "none",
      handler: async () => {
        const result = await adminQueries().apiKeys();
        return { ...result, data: result.data.slice(0, 200) };
      }
    })
    .register({
      key: "api_keys.get.v1",
      description: "Detail for one API key.",
      input: z.object({ apiKeyId: z.string() }),
      sideEffect: "none",
      handler: async (_context, input) => {
        const detail = await adminQueries().apiKeyDetail(input.apiKeyId);
        return detail ? { found: true, ...detail } : { found: false };
      }
    })
    .register({
      key: "models.catalog.list.v1",
      description: "List the model catalog: route aliases, providers, upstream models, context windows, and per-Mtok costs.",
      input: z.object({}),
      sideEffect: "none",
      handler: async () => ({ models: modelCatalogList(catalog) })
    })
    .register({
      key: "prompts.search.v1",
      description: "List captured prompt artifacts (metadata only, no prompt text).",
      input: promptSearchInput,
      sideEffect: "none",
      handler: async (_context, input) => {
        const result = await adminQueries().prompts({ ...input, limit: input.limit ?? 50 });
        return {
          count: result.data.length,
          prompts: result.data.map(promptMetadataOnly)
        };
      }
    })
    .register({
      key: PROMPT_GET_CAPABILITY_KEY,
      description:
        "Read one prompt artifact including its raw text. Every call is recorded in the prompt access audit attributed to the console user.",
      input: z.object({ artifactId: z.string() }),
      sideEffect: "none",
      handler: async (context, input) => {
        const detail = await adminQueries().promptDetail(input.artifactId);
        if (!detail) return { found: false };
        await promptAccessAudit.append({
          organizationId: detail.artifact.organizationId,
          workspaceId: context.workspaceId,
          artifactId: detail.artifact.artifactId,
          requestId: detail.artifact.requestId,
          userId: context.userId,
          route: detail.request?.finalRoute,
          accessPath: `${CONSOLE_AGENT_PROMPT_ACCESS_PATH}#${context.runId}`
        });
        return {
          found: true,
          artifactId: detail.artifact.artifactId,
          requestId: detail.artifact.requestId,
          kind: detail.artifact.kind,
          storageMode: detail.artifact.storageMode,
          sourceRole: detail.artifact.sourceRole,
          rawText: detail.artifact.rawText,
          redactedText: detail.artifact.redactedText,
          tokenEstimate: detail.artifact.tokenEstimate,
          createdAt: detail.artifact.createdAt,
          request: detail.request ? compactRequest(detail.request) : null
        };
      }
    });
}

type RequestSummaryItem = Awaited<ReturnType<AdminQueryService["requests"]>>["data"][number];
type PromptSummaryItem = Awaited<ReturnType<AdminQueryService["prompts"]>>["data"][number];

function compactRequest(request: RequestSummaryItem) {
  const { classifier: _classifier, ...rest } = request;
  return rest;
}

// Allow-list projection: this is the metadata-only boundary for prompt
// artifacts, so new text-bearing fields stay unexposed by default.
function promptMetadataOnly(prompt: PromptSummaryItem) {
  return {
    artifactId: prompt.artifactId,
    requestId: prompt.requestId,
    sessionId: prompt.sessionId,
    userId: prompt.userId,
    surface: prompt.surface,
    kind: prompt.kind,
    storageMode: prompt.storageMode,
    contentHash: prompt.contentHash,
    sourceRole: prompt.sourceRole,
    sourceIndex: prompt.sourceIndex,
    chars: prompt.chars,
    tokenEstimate: prompt.tokenEstimate,
    finalRoute: prompt.finalRoute,
    provider: prompt.provider,
    selectedModel: prompt.selectedModel,
    routingConfig: prompt.routingConfig,
    cost: prompt.cost,
    createdAt: prompt.createdAt
  };
}
