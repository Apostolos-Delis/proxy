import { eq } from "drizzle-orm";

import { organizationSettings, type PromptProxyDbSession } from "@prompt-proxy/db";

export class OrganizationSettingsStore {
  constructor(private readonly db: PromptProxyDbSession) {}

  async systemPrompt(organizationId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ systemPrompt: organizationSettings.systemPrompt })
      .from(organizationSettings)
      .where(eq(organizationSettings.organizationId, organizationId))
      .limit(1);
    return row?.systemPrompt ?? null;
  }

  async setSystemPrompt(organizationId: string, systemPrompt: string | null) {
    const settings = {
      systemPrompt,
      updatedAt: new Date()
    };
    await this.db
      .insert(organizationSettings)
      .values({
        organizationId,
        ...settings
      })
      .onConflictDoUpdate({
        target: organizationSettings.organizationId,
        set: settings
      });
    return systemPrompt;
  }
}
