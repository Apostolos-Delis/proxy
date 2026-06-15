import type { UsersListQuery } from "./gql/graphql";

export type UserSummary = UsersListQuery["users"][number];

export function userStatus(user: UserSummary) {
  return user.membership?.status ?? "unknown";
}

export function userRole(user: UserSummary) {
  return user.membership?.role ?? "";
}

export function userSearchValue(user: UserSummary) {
  return [user.userId, user.name, user.email, user.externalId, userRole(user), userStatus(user)]
    .filter((value): value is string => Boolean(value));
}

export function labelForStatusAction(deactivated: boolean, pending: boolean) {
  if (pending) return deactivated ? "Reactivating" : "Deactivating";
  return deactivated ? "Reactivate" : "Deactivate";
}
