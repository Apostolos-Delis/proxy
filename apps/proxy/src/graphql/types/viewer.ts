import type { AdminSessionIdentity } from "../../persistence/adminSessions.js";
import { builder } from "../builder.js";
import type { viewerPayload } from "../context.js";
import type { OrganizationSummaryModel, WorkspaceSummaryModel } from "../models.js";

export type ViewerModel = Awaited<ReturnType<typeof viewerPayload>>;

export const AuthUser = builder.objectRef<AdminSessionIdentity>("AuthUser").implement({
  fields: (t) => ({
    sessionId: t.exposeString("sessionId"),
    organizationId: t.exposeString("organizationId"),
    workspaceId: t.exposeString("workspaceId"),
    userId: t.exposeString("userId"),
    email: t.exposeString("email", { nullable: true }),
    name: t.exposeString("name", { nullable: true }),
    role: t.exposeString("role")
  })
});

export const OrganizationSummary = builder
  .objectRef<OrganizationSummaryModel>("OrganizationSummary")
  .implement({
    fields: (t) => ({
      id: t.exposeString("id"),
      slug: t.exposeString("slug"),
      name: t.exposeString("name"),
      role: t.exposeString("role")
    })
  });

export const WorkspaceSummary = builder
  .objectRef<WorkspaceSummaryModel>("WorkspaceSummary")
  .implement({
    fields: (t) => ({
      id: t.exposeString("id"),
      slug: t.exposeString("slug"),
      name: t.exposeString("name")
    })
  });

export const Viewer = builder.objectRef<ViewerModel>("Viewer").implement({
  fields: (t) => ({
    user: t.expose("user", { type: AuthUser }),
    organizationId: t.exposeString("organizationId"),
    workspaceId: t.exposeString("workspaceId"),
    organizations: t.expose("organizations", { type: [OrganizationSummary] }),
    workspaces: t.expose("workspaces", { type: [WorkspaceSummary] })
  })
});
