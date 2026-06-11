import { eq, sql } from "drizzle-orm";

import { organizationSettings, type PromptProxyDbSession } from "@prompt-proxy/db";

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
    toolResultCompression: boolean;
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
      toolResultCompression: row?.settings?.toolResultCompression === true
    };
  }

  async setToolResultCompression(organizationId: string, enabled: boolean): Promise<boolean> {
    await this.db
      .insert(organizationSettings)
      .values({
        organizationId,
        settings: { toolResultCompression: enabled },
        updatedAt: new Date()
      })
      .onConflictDoUpdate({
        target: organizationSettings.organizationId,
        set: {
          settings: sql`organization_settings.settings || jsonb_build_object('toolResultCompression', ${enabled}::boolean)`,
          updatedAt: new Date()
        }
      });
    return enabled;
  }

  async setCacheTtlUpgrade(organizationId: string, enabled: boolean): Promise<boolean> {
    // Merge the flag into the JSONB settings column without touching other keys.
    await this.db
      .insert(organizationSettings)
      .values({
        organizationId,
        settings: { cacheTtlUpgrade: enabled },
        updatedAt: new Date()
      })
      .onConflictDoUpdate({
        target: organizationSettings.organizationId,
        set: {
          settings: sql`organization_settings.settings || jsonb_build_object('cacheTtlUpgrade', ${enabled}::boolean)`,
          updatedAt: new Date()
        }
      });
    return enabled;
  }
}
