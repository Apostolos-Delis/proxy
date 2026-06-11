import { displayUser } from "./consoleData";
import { graphql } from "./gql";
import type { UserDirectoryQuery } from "./gql/graphql";
import { gqlFetch } from "./graphql";
import { UserCell } from "./ui";

const UserDirectoryDocument = graphql(`
  query UserDirectory {
    users {
      userId
      name
      email
    }
  }
`);

export type UserDirectory = Map<string, UserDirectoryQuery["users"][number]>;

export async function fetchUserDirectory(): Promise<UserDirectory> {
  const { users } = await gqlFetch(UserDirectoryDocument);
  return new Map(users.map((user) => [user.userId, user]));
}

export function ownerLabel(users: UserDirectory, userId: string | null | undefined) {
  if (!userId) return "Organization";
  const user = users.get(userId);
  return user ? displayUser(user) : userId;
}

export function OwnerCell({ users, userId }: { users: UserDirectory; userId: string | null | undefined }) {
  if (!userId) return <span className="faint">Organization</span>;
  return <UserCell name={ownerLabel(users, userId)} size={24} />;
}
