import { and, eq } from "drizzle-orm";

import {
  organizationSettings,
  routingConfigs,
  routingConfigVersions,
  workspaces,
  type PromptProxyDbSession
} from "@prompt-proxy/db";
import { routingConfigSchema, type RoutingConfig } from "@prompt-proxy/schema";
import type { RoutingConfigSelection, RoutingConfigSnapshot } from "../types.js";

export type ResolvedRoutingConfig = {
  organizationId: string;
  workspaceId: string;
  configId: string;
  configName: string;
  versionId: string;
  version: number;
  configHash: string;
  config: RoutingConfig;
  organizationSystemPrompt?: string;
  cacheTtlUpgrade: boolean;
  automaticCaching: boolean;
  toolResultCompression: boolean;
};

export class RoutingConfigResolutionError extends Error {
  statusCode = 500;
}

export class RoutingConfigResolver {
  constructor(private readonly db: PromptProxyDbSession) {}

  async resolve(input: {
    organizationId: string;
    workspaceId: string;
    routingConfigId?: string | null;
  }): Promise<ResolvedRoutingConfig> {
    const orgSettings = await this.organizationSettings(input.organizationId);
    const configId = input.routingConfigId
      ?? await this.defaultRoutingConfigId(input.workspaceId)
      ?? seededDefaultRoutingConfigId(input.organizationId);
    const [config] = await this.db
      .select()
      .from(routingConfigs)
      .where(and(
        eq(routingConfigs.organizationId, input.organizationId),
        eq(routingConfigs.workspaceId, input.workspaceId),
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
        eq(routingConfigVersions.workspaceId, input.workspaceId),
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
      workspaceId: input.workspaceId,
      configId: config.id,
      configName: config.name,
      versionId: version.id,
      version: version.version,
      configHash: version.configHash,
      config: parsed.data,
      organizationSystemPrompt: orgSettings?.systemPrompt ?? undefined,
      cacheTtlUpgrade: orgSettings?.settings?.cacheTtlUpgrade === true,
      automaticCaching: orgSettings?.settings?.automaticCaching === true,
      toolResultCompression: orgSettings?.settings?.toolResultCompression === true
    };
  }

  private async organizationSettings(organizationId: string) {
    const [settings] = await this.db
      .select({
        systemPrompt: organizationSettings.systemPrompt,
        settings: organizationSettings.settings
      })
      .from(organizationSettings)
      .where(eq(organizationSettings.organizationId, organizationId))
      .limit(1);
    return settings;
  }

  private async defaultRoutingConfigId(workspaceId: string) {
    const [workspace] = await this.db
      .select({ defaultRoutingConfigId: workspaces.defaultRoutingConfigId })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    return workspace?.defaultRoutingConfigId ?? undefined;
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
  input: { organizationId: string; workspaceId: string; routingConfigId?: string | null }
): Promise<{
  routingConfig?: RoutingConfigSelection;
  systemPrompt?: string;
  cacheTtlUpgrade: boolean;
  automaticCaching: boolean;
  toolResultCompression: boolean;
}> {
  const resolved = await resolver?.resolve(input);
  if (!resolved) return { cacheTtlUpgrade: false, automaticCaching: false, toolResultCompression: false };
  return {
    routingConfig: {
      snapshot: routingConfigSnapshot(resolved),
      config: resolved.config
    },
    systemPrompt: resolved.organizationSystemPrompt,
    cacheTtlUpgrade: resolved.cacheTtlUpgrade,
    automaticCaching: resolved.automaticCaching,
    toolResultCompression: resolved.toolResultCompression
  };
}

function seededDefaultRoutingConfigId(organizationId: string) {
  return `${organizationId}:routing-config:default`;
}

function resolutionError(message: string) {
  return new RoutingConfigResolutionError(message);
}
