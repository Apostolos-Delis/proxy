import { eq, sql } from "drizzle-orm";

import { organizationSettings, type ProxyDbSession } from "@proxy/db";
import {
  compressionPolicySchema,
  defaultCompressionPolicy,
  type CompressionPolicy
} from "@proxy/schema";

import { defaultCostBaseline, type CostBaseline } from "../pricing.js";

export async function orgCostBaseline(
  db: ProxyDbSession,
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
  const byDialect = recordSetting(settings?.costBaselineByDialect);
  return {
    "anthropic-messages": modelSetting(byDialect?.["anthropic-messages"]) ?? defaultCostBaseline["anthropic-messages"],
    "openai-responses": modelSetting(byDialect?.["openai-responses"]) ?? defaultCostBaseline["openai-responses"],
    "openai-chat": modelSetting(byDialect?.["openai-chat"]) ?? defaultCostBaseline["openai-chat"]
  };
}

function settingsCostBaseline(baseline: CostBaseline) {
  return {
    anthropicMessagesModel: baseline["anthropic-messages"],
    openaiResponsesModel: baseline["openai-responses"],
    openaiChatModel: baseline["openai-chat"]
  };
}

function recordSetting(value: unknown) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function modelSetting(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function compressionPolicyFromSettings(settings: Record<string, unknown> | undefined): CompressionPolicy {
  const parsed = compressionPolicySchema.safeParse(settings?.toolResultCompressionPolicy);
  return parsed.success ? normalizeCompressionPolicy(parsed.data) : defaultCompressionPolicy();
}

function normalizeCompressionPolicy(policy: CompressionPolicy): CompressionPolicy {
  return { ...defaultCompressionPolicy(), ...policy };
}

export class OrganizationSettingsStore {
  constructor(
    private readonly db: ProxyDbSession,
    private readonly onRoutingConfigsChanged: () => void = () => {}
  ) {}

  async setSystemPrompt(organizationId: string, systemPrompt: string | null) {
    const patch = { systemPrompt, updatedAt: new Date() };
    await this.db
      .insert(organizationSettings)
      .values({ organizationId, ...patch })
      .onConflictDoUpdate({ target: organizationSettings.organizationId, set: patch });
    this.onRoutingConfigsChanged();
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
    toolResultCompressionPolicy: CompressionPolicy;
    duplicateToolResultReferences: boolean;
    costBaseline: { anthropicMessagesModel: string; openaiResponsesModel: string; openaiChatModel: string };
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
      toolResultCompressionPolicy: compressionPolicyFromSettings(row?.settings),
      duplicateToolResultReferences: row?.settings?.duplicateToolResultReferences === true,
      costBaseline: settingsCostBaseline(costBaselineFromSettings(row?.settings))
    };
  }

  // Empty or whitespace-only values clear the override so reads fall back to
  // the default baseline models.
  async setCostBaseline(
    organizationId: string,
    baseline: { anthropicMessagesModel: string | null; openaiResponsesModel: string | null; openaiChatModel: string | null }
  ): Promise<{ anthropicMessagesModel: string; openaiResponsesModel: string; openaiChatModel: string }> {
    const anthropicMessagesModel = baseline.anthropicMessagesModel?.trim() || null;
    const openaiResponsesModel = baseline.openaiResponsesModel?.trim() || null;
    const openaiChatModel = baseline.openaiChatModel?.trim() || null;
    await this.db
      .insert(organizationSettings)
      .values({
        organizationId,
        settings: {
          costBaselineByDialect: {
            "anthropic-messages": anthropicMessagesModel,
            "openai-responses": openaiResponsesModel,
            "openai-chat": openaiChatModel
          }
        },
        updatedAt: new Date()
      })
      .onConflictDoUpdate({
        target: organizationSettings.organizationId,
        set: {
          settings: sql`(organization_settings.settings - 'costBaselineAnthropicModel' - 'costBaselineOpenaiModel') || jsonb_build_object('costBaselineByDialect', jsonb_build_object('anthropic-messages', ${anthropicMessagesModel}::text, 'openai-responses', ${openaiResponsesModel}::text, 'openai-chat', ${openaiChatModel}::text))`,
          updatedAt: new Date()
        }
      });
    return settingsCostBaseline({
      "anthropic-messages": anthropicMessagesModel ?? defaultCostBaseline["anthropic-messages"],
      "openai-responses": openaiResponsesModel ?? defaultCostBaseline["openai-responses"],
      "openai-chat": openaiChatModel ?? defaultCostBaseline["openai-chat"]
    });
  }

  async setToolResultCompressionPolicy(organizationId: string, policy: unknown): Promise<CompressionPolicy> {
    const normalized = normalizeCompressionPolicy(compressionPolicySchema.parse(policy));
    const serialized = JSON.stringify(normalized);
    await this.db
      .insert(organizationSettings)
      .values({
        organizationId,
        settings: { toolResultCompressionPolicy: normalized },
        updatedAt: new Date()
      })
      .onConflictDoUpdate({
        target: organizationSettings.organizationId,
        set: {
          settings: sql`(organization_settings.settings - 'toolResultCompression') || jsonb_build_object('toolResultCompressionPolicy', ${serialized}::jsonb)`,
          updatedAt: new Date()
        }
      });
    return normalized;
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
    this.onRoutingConfigsChanged();
    return enabled;
  }
}
