import { and, eq } from "drizzle-orm";
import { z } from "zod";

import {
  workspaces,
  type ProxyTransactionalDatabase
} from "@proxy/db";

import { createId } from "../util.js";
import { AdminMutationError } from "./adminErrors.js";
import { appendAdminAuditEvent } from "./adminAudit.js";
import { ensureWorkspaceDefaultRoutingConfig } from "./routingConfigProvisioning.js";

const createWorkspaceBodySchema = z.object({
  name: z.string().trim().min(1),
  slug: z.string().trim().min(1).optional(),
  description: z.string().trim().min(1).nullable().optional()
}).strict();

export class WorkspaceAdminError extends AdminMutationError {}

export class WorkspaceAdminService {
  constructor(
    private readonly db: ProxyTransactionalDatabase,
    private readonly onRoutingConfigsChanged: () => void = () => {}
  ) {}

  async createWorkspace(input: {
    organizationId: string;
    actorUserId: string;
    body: unknown;
  }) {
    const body = createWorkspaceBodySchema.safeParse(input.body);
    if (!body.success) throw validationError("invalid_workspace_request", body.error);
    const workspaceId = createId("workspace");
    const slug = slugValue(body.data.slug ?? body.data.name);
    const now = new Date();

    const result = await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(and(
          eq(workspaces.organizationId, input.organizationId),
          eq(workspaces.slug, slug)
        ))
        .limit(1);
      if (existing) throw new WorkspaceAdminError("workspace_slug_exists", 409);

      await tx.insert(workspaces).values({
        id: workspaceId,
        organizationId: input.organizationId,
        slug,
        name: body.data.name,
        description: body.data.description ?? null,
        createdAt: now,
        updatedAt: now
      });
      await appendAdminAuditEvent(tx, {
        organizationId: input.organizationId,
        workspaceId,
        scopeType: "workspace",
        scopeId: workspaceId,
        correlationId: workspaceId,
        actorUserId: input.actorUserId,
        producer: "proxy.admin.workspaces",
        eventType: "workspace.created",
        payload: {
          workspaceId,
          name: body.data.name,
          slug
        },
        createdAt: now
      });
      await ensureWorkspaceDefaultRoutingConfig(tx, {
        organizationId: input.organizationId,
        workspaceId,
        actorUserId: input.actorUserId
      });

      return { workspaceId, slug, name: body.data.name };
    });
    this.onRoutingConfigsChanged();
    return result;
  }
}

function validationError(message: string, error: z.ZodError) {
  return new WorkspaceAdminError(
    message,
    400,
    error.issues.map((issue) => ({
      path: issue.path.join(".") || "body",
      message: issue.message
    }))
  );
}

function slugValue(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workspace";
}
