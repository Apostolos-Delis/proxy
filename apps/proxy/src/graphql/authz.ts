import { ORGANIZATION_MEMBER_ROLES, type OrganizationMemberRole } from "@proxy/schema";

import type { GraphQLContext } from "./context.js";
import { adminGraphQLError } from "./errors.js";

const adminRoles = new Set<OrganizationMemberRole>([
  ORGANIZATION_MEMBER_ROLES.OWNER,
  ORGANIZATION_MEMBER_ROLES.ADMIN
]);

export function requireAdminRole(context: GraphQLContext) {
  const identity = context.identity();
  if (!adminRoles.has(identity.role)) {
    throw adminGraphQLError("admin_role_required", 403);
  }
  return identity;
}

export function hasAdminRole(context: GraphQLContext) {
  return adminRoles.has(context.identity().role);
}
