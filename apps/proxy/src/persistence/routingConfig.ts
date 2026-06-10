import { and, eq } from "drizzle-orm";

import {
  organizationSettings,
  routingConfigs,
  routingConfigVersions,
  type PromptProxyDbSession
} from "@prompt-proxy/db";
import { routingConfigSchema, type RoutingConfig } from "@prompt-proxy/schema";
import type { RoutingConfigSelection, RoutingConfigSnapshot } from "../types.js";

export type ResolvedRoutingConfig = {
  organizationId: string;
  configId: string;
  configName: string;
  versionId: string;
  version: number;
  configHash: string;
  config: RoutingConfig;
  organizationSystemPrompt?: string;
};

export class RoutingConfigResolutionError extends Error {
  statusCode = 500;
}

export class RoutingConfigResolver {
  constructor(private readonly db: PromptProxyDbSession) {}

  async resolve(input: {
    organizationId: string;
    routingConfigId?: string | null;
  }): Promise<ResolvedRoutingConfig> {
    const orgSettings = await this.organizationSettings(input.organizationId);
    const configId = input.routingConfigId
      ?? orgSettings?.defaultRoutingConfigId
      ?? seededDefaultRoutingConfigId(input.organizationId);
    const [config] = await this.db
      .select()
      .from(routingConfigs)
      .where(and(
        eq(routingConfigs.organizationId, input.organizationId),
        eq(routingConfigs.id, configId)
      ))
      .limit(1);

    if (!config) throw resolutionError("routing_config_not_found");
    if (config.status !== "active") throw resolutionError("routing_config_inactive");
    if (!config.activeVersionId) throw resolutionError("routing_config_active_version_missing");

    const [version] = await this.db
      .select()
      .from(routingConfigVersions)
      .where(and(
        eq(routingConfigVersions.organizationId, input.organizationId),
        eq(routingConfigVersions.routingConfigId, config.id),
        eq(routingConfigVersions.id, config.activeVersionId)
      ))
      .limit(1);

    if (!version) throw resolutionError("routing_config_active_version_not_found");
    if (version.status !== "active") throw resolutionError("routing_config_active_version_inactive");

    const parsed = routingConfigSchema.safeParse(version.config);
    if (!parsed.success) {
      const paths = parsed.error.issues
        .map((issue) => issue.path.join(".") || "config")
        .join(",");
      throw resolutionError(`routing_config_invalid:${paths}`);
    }

    return {
      organizationId: input.organizationId,
      configId: config.id,
      configName: config.name,
      versionId: version.id,
      version: version.version,
      configHash: version.configHash,
      config: parsed.data,
      organizationSystemPrompt: orgSettings?.systemPrompt ?? undefined
    };
  }

  private async organizationSettings(organizationId: string) {
    const [settings] = await this.db
      .select({
        defaultRoutingConfigId: organizationSettings.defaultRoutingConfigId,
        systemPrompt: organizationSettings.systemPrompt
      })
      .from(organizationSettings)
      .where(eq(organizationSettings.organizationId, organizationId))
      .limit(1);
    return settings;
  }
}

export function routingConfigSnapshot(resolved: ResolvedRoutingConfig): RoutingConfigSnapshot {
  return {
    configId: resolved.configId,
    configName: resolved.configName,
    versionId: resolved.versionId,
    version: resolved.version,
    configHash: resolved.configHash
  };
}

export async function resolveRoutingSelection(
  resolver: RoutingConfigResolver | undefined,
  input: { organizationId: string; routingConfigId?: string | null }
): Promise<{ routingConfig?: RoutingConfigSelection; systemPrompt?: string }> {
  const resolved = await resolver?.resolve(input);
  if (!resolved) return {};
  return {
    routingConfig: {
      snapshot: routingConfigSnapshot(resolved),
      config: resolved.config
    },
    systemPrompt: resolved.organizationSystemPrompt
  };
}

function seededDefaultRoutingConfigId(organizationId: string) {
  return `${organizationId}:routing-config:default`;
}

function resolutionError(message: string) {
  return new RoutingConfigResolutionError(message);
}
