import { desc, eq } from "drizzle-orm";

import {
  promptAccessAudit,
  type PromptProxyDbSession
} from "@prompt-proxy/db";
import type { RouteName } from "@prompt-proxy/schema";

import { createId } from "../util.js";

export class PromptAccessAuditStore {
  constructor(private readonly db: PromptProxyDbSession) {}

  async append(input: {
    organizationId: string;
    artifactId: string;
    requestId: string;
    userId?: string;
    adminSessionId?: string;
    route?: RouteName;
    accessPath: string;
  }) {
    const [row] = await this.db
      .insert(promptAccessAudit)
      .values({
        id: createId("prompt_access"),
        organizationId: input.organizationId,
        artifactId: input.artifactId,
        requestId: input.requestId,
        userId: input.userId,
        adminSessionId: input.adminSessionId,
        route: input.route,
        accessPath: input.accessPath
      })
      .returning();
    return row;
  }

  async list(organizationId: string) {
    const rows = await this.db
      .select()
      .from(promptAccessAudit)
      .where(eq(promptAccessAudit.organizationId, organizationId))
      .orderBy(desc(promptAccessAudit.createdAt))
      .limit(200);
    return {
      data: rows.map((row) => ({
        id: row.id,
        organizationId: row.organizationId,
        artifactId: row.artifactId,
        requestId: row.requestId,
        userId: row.userId ?? undefined,
        adminSessionId: row.adminSessionId ?? undefined,
        route: row.route ?? undefined,
        accessPath: row.accessPath,
        createdAt: row.createdAt.toISOString()
      }))
    };
  }
}
