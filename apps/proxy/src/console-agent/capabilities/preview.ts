import { z } from "zod";

import { routingConfigSchema, type RoutingConfig } from "@prompt-proxy/schema";

import type { AdminQueriesFactory } from "./index.js";
import { routingConfigHash } from "../../persistence/routingConfigAdmin.js";
import { isRecord } from "../../util.js";
import type { CapabilityRegistry } from "../registry.js";

export const PREVIEW_CAPABILITY_KEY = "routing_configs.preview.v1";

const MAX_DIFF_ENTRIES = 50;

const previewInput = z.object({
  configId: z
    .string()
    .optional()
    .describe("Existing config to diff against; omit when drafting a brand new config."),
  draft: z.record(z.string(), z.unknown()).describe("The full routing config document to validate.")
});

export function registerPreviewCapability(
  registry: CapabilityRegistry,
  deps: { adminQueries: AdminQueriesFactory }
) {
  return registry.register({
    key: PREVIEW_CAPABILITY_KEY,
    description:
      "Dry-run a routing config draft: validates against the config schema, diffs against the config's active version, and returns the normalized document plus the base-state fingerprint needed to propose a change. No writes.",
    input: previewInput,
    sideEffect: "none",
    handler: async (_context, input) => {
      const parsed = routingConfigSchema.safeParse(input.draft);
      if (!parsed.success) {
        return {
          valid: false,
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join(".") || "(root)",
            message: issue.message
          }))
        };
      }
      const normalized = parsed.data;
      const draftHash = routingConfigHash(normalized);

      if (!input.configId) {
        return {
          valid: true,
          normalized,
          draftHash,
          diff: null,
          baseState: { configId: null, activeVersionId: null, configHash: null }
        };
      }

      const detail = await deps.adminQueries().routingConfigDetail(input.configId);
      if (!detail) {
        return {
          valid: false,
          issues: [{ path: "configId", message: `Routing config ${input.configId} not found.` }]
        };
      }
      const activeVersion = detail.versions.find((version) => version.active);

      return {
        valid: true,
        normalized,
        draftHash,
        diff: activeVersion ? diffConfigs(activeVersion.config, normalized) : null,
        baseState: {
          configId: input.configId,
          activeVersionId: activeVersion?.id ?? null,
          configHash: activeVersion?.configHash ?? null
        }
      };
    }
  });
}

export function diffConfigs(before: RoutingConfig, after: RoutingConfig) {
  const entries: Array<{ path: string; before: unknown; after: unknown }> = [];
  walkDiff(before, after, "", entries);
  return {
    changes: entries.slice(0, MAX_DIFF_ENTRIES),
    truncated: entries.length > MAX_DIFF_ENTRIES
  };
}

function walkDiff(
  before: unknown,
  after: unknown,
  path: string,
  entries: Array<{ path: string; before: unknown; after: unknown }>
) {
  if (entries.length > MAX_DIFF_ENTRIES) return;
  if (Object.is(before, after)) return;
  if (isRecord(before) && isRecord(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      walkDiff(before[key], after[key], path ? `${path}.${key}` : key, entries);
    }
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index += 1) {
      walkDiff(before[index], after[index], path ? `${path}.${index}` : String(index), entries);
    }
    return;
  }
  entries.push({ path: path || "(root)", before, after });
}
