import { builder } from "../builder.js";
import type { MemberDirectoryEntryModel, UserDetailModel, UserMembershipModel, UserSummaryModel } from "../models.js";
import { CostTotals, TokenTotals } from "./core.js";
import { RequestSummary } from "./requests.js";
import { SessionSummary } from "./sessions.js";

export const UserMembership = builder
  .objectRef<UserMembershipModel>("UserMembership")
  .implement({
    fields: (t) => ({
      role: t.exposeString("role"),
      status: t.exposeString("status")
    })
  });

export const UserSummary = builder.objectRef<UserSummaryModel>("UserSummary").implement({
  fields: (t) => ({
    userId: t.exposeString("userId"),
    email: t.exposeString("email", { nullable: true }),
    name: t.exposeString("name", { nullable: true }),
    externalId: t.exposeString("externalId", { nullable: true }),
    membership: t.field({
      type: UserMembership,
      nullable: true,
      resolve: (user) => user.membership
    }),
    apiKeyCount: t.exposeInt("apiKeyCount"),
    requestCount: t.exposeFloat("requestCount"),
    sessionCount: t.exposeFloat("sessionCount"),
    usage: t.expose("usage", { type: TokenTotals }),
    cost: t.expose("cost", { type: CostTotals }),
    usage30d: t.expose("usage30d", { type: TokenTotals }),
    cost30d: t.expose("cost30d", { type: CostTotals }),
    recentActivity: t.exposeString("recentActivity", { nullable: true }),
    createdAt: t.exposeString("createdAt")
  })
});

export const UserDetail = builder.objectRef<UserDetailModel>("UserDetail").implement({
  fields: (t) => ({
    user: t.expose("user", { type: UserSummary }),
    usage: t.expose("usage", { type: TokenTotals }),
    cost: t.expose("cost", { type: CostTotals }),
    sessions: t.expose("sessions", { type: [SessionSummary] }),
    requests: t.expose("requests", { type: [RequestSummary] })
  })
});

// Cheap identity directory for label lookups (usage/cost dashboards); the
// users query keeps the full usage rollups.
export const OrgMember = builder.objectRef<MemberDirectoryEntryModel>("OrgMember").implement({
  fields: (t) => ({
    userId: t.exposeString("userId"),
    name: t.exposeString("name", { nullable: true }),
    email: t.exposeString("email", { nullable: true }),
    status: t.exposeString("status")
  })
});
