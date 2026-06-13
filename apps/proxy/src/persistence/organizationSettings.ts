import { eq, sql } from "drizzle-orm";

import { organizationSettings, type PromptProxyDbSession } from "@prompt-proxy/db";

import { defaultCostBaseline, type CostBaseline } from "../pricing.js";

export async function orgCostBaseline(
  db: PromptProxyDbSession,
  organizationId: string
): Promise<CostBaseline> {
  const [row] = await db
    .select({ settings: organizationSettings.settings })
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, organizationId))
    .limit(1);
  return costBaselineFromSettings(row?.settings);
}

function costBaselineFromSettings(settings: Record<string, unknown> | undefined): CostBaseline {
  return {
    anthropicModel: modelSetting(settings?.costBaselineAnthropicModel) ?? defaultCostBaseline.anthropicModel,
    openaiModel: modelSetting(settings?.costBaselineOpenaiModel) ?? defaultCostBaseline.openaiModel
  };
}

function modelSetting(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export class OrganizationSettingsStore {
  constructor(private readonly db: PromptProxyDbSession) {}

  async setSystemPrompt(organizationId: string, systemPrompt: string | null) {
    const patch = { systemPrompt, updatedAt: new Date() };
    await this.db
      .insert(organizationSettings)
      .values({ organizationId, ...patch })
      .onConflictDoUpdate({ target: organizationSettings.organizationId, set: patch });
    return systemPrompt;
  }

  async cacheTtlUpgrade(organizationId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ settings: organizationSettings.settings })
      .from(organizationSettings)
      .where(eq(organizationSettings.organizationId, organizationId))
      .limit(1);
    return row?.settings?.cacheTtlUpgrade === true;
  }

  // Single read for the admin settings payload, which needs every editable
  // org-level field at once.
  async editable(organizationId: string): Promise<{
    systemPrompt: string | null;
    cacheTtlUpgrade: boolean;
    automaticCaching: boolean;
    toolResultCompression: boolean;
    duplicateToolResultReferences: boolean;
    costBaseline: CostBaseline;
  }> {
    const [row] = await this.db
      .select({
        systemPrompt: organizationSettings.systemPrompt,
        settings: organizationSettings.settings
      })
      .from(organizationSettings)
      .where(eq(organizationSettings.organizationId, organizationId))
      .limit(1);
    return {
      systemPrompt: row?.systemPrompt ?? null,
      cacheTtlUpgrade: row?.settings?.cacheTtlUpgrade === true,
      automaticCaching: row?.settings?.automaticCaching === true,
      toolResultCompression: row?.settings?.toolResultCompression === true,
      duplicateToolResultReferences: row?.settings?.duplicateToolResultReferences === true,
      costBaseline: costBaselineFromSettings(row?.settings)
    };
  }

  // Empty or whitespace-only values clear the override so reads fall back to
  // the default baseline models.
  async setCostBaseline(
    organizationId: string,
    baseline: { anthropicModel: string | null; openaiModel: string | null }
  ): Promise<CostBaseline> {
    const anthropicModel = baseline.anthropicModel?.trim() || null;
    const openaiModel = baseline.openaiModel?.trim() || null;
    await this.db
      .insert(organizationSettings)
      .values({
        organizationId,
        settings: {
          costBaselineAnthropicModel: anthropicModel,
          costBaselineOpenaiModel: openaiModel
        },
        updatedAt: new Date()
      })
      .onConflictDoUpdate({
        target: organizationSettings.organizationId,
        set: {
          settings: sql`organization_settings.settings || jsonb_build_object('costBaselineAnthropicModel', ${anthropicModel}::text, 'costBaselineOpenaiModel', ${openaiModel}::text)`,
          updatedAt: new Date()
        }
      });
    return {
      anthropicModel: anthropicModel ?? defaultCostBaseline.anthropicModel,
      openaiModel: openaiModel ?? defaultCostBaseline.openaiModel
    };
  }

  async setToolResultCompression(organizationId: string, enabled: boolean): Promise<boolean> {
    return this.setBooleanSetting(organizationId, "toolResultCompression", enabled);
  }

  async setDuplicateToolResultReferences(organizationId: string, enabled: boolean): Promise<boolean> {
    return this.setBooleanSetting(organizationId, "duplicateToolResultReferences", enabled);
  }

  async setAutomaticCaching(organizationId: string, enabled: boolean): Promise<boolean> {
    return this.setBooleanSetting(organizationId, "automaticCaching", enabled);
  }

  async setCacheTtlUpgrade(organizationId: string, enabled: boolean): Promise<boolean> {
    return this.setBooleanSetting(organizationId, "cacheTtlUpgrade", enabled);
  }

  // Merge one flag into the JSONB settings column without touching other keys.
  private async setBooleanSetting(organizationId: string, key: string, enabled: boolean): Promise<boolean> {
    await this.db
      .insert(organizationSettings)
      .values({
        organizationId,
        settings: { [key]: enabled },
        updatedAt: new Date()
      })
      .onConflictDoUpdate({
        target: organizationSettings.organizationId,
        set: {
          settings: sql`organization_settings.settings || jsonb_build_object(${key}::text, ${enabled}::boolean)`,
          updatedAt: new Date()
        }
      });
    return enabled;
  }
}
