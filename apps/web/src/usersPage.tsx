import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, MailPlus, X } from "lucide-react";
import { useState } from "react";

import { fetchMe } from "./session";
import { downloadJson } from "./dashboard";
import { graphql } from "./gql";
import type { MemberRole } from "./gql/graphql";
import { gqlFetch } from "./graphql";
import { InvitationsCard } from "./invitationsCard";
import { InviteUserPanel } from "./inviteUserPanel";
import { ConsoleTable } from "./table";
import { UserInspector } from "./userInspector";
import { userAdvancedFields, userColumns, userFilters } from "./usersColumns";
import { adjacentUserId, userSearchValue, userStatus } from "./usersPageData";
import { PageState, PageTitle } from "./ui";

const UsersListDocument = graphql(`
  query UsersList {
    users {
      userId
      email
      name
      externalId
      membership {
        role
        status
      }
      apiKeyCount
      requestCount
      sessionCount
      usage {
        totalTokens
      }
      cost {
        selected
      }
      usage30d {
        totalTokens
      }
      cost30d {
        selected
      }
      recentActivity
      createdAt
    }
  }
`);

const UpdateUserRoleDocument = graphql(`
  mutation UpdateUserRole($userId: ID!, $role: MemberRole!) {
    updateUserRole(userId: $userId, role: $role) {
      userId
      role
      previousRole
    }
  }
`);

export function UsersPage() {
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [openRoleUserId, setOpenRoleUserId] = useState<string | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  const queryClient = useQueryClient();
  const { isLoading: queryIsLoading, error: queryError, data: queryData } = useQuery({ queryKey: ["users"], queryFn: () => gqlFetch(UsersListDocument) });
  const { data: meQueryData } = useQuery({ queryKey: ["me"], queryFn: fetchMe });
  const roleMutation = useMutation({
    mutationFn: (input: { userId: string; role: MemberRole }) =>
      gqlFetch(UpdateUserRoleDocument, { userId: input.userId, role: input.role }),
    onSuccess: () => {
      setOpenRoleUserId(null);
      void queryClient.invalidateQueries({ queryKey: ["users"] });
    }
  });

  if (queryIsLoading) return <PageState title="Users" label="Loading users" />;
  if (queryError) return <PageState title="Users" label={queryError.message} />;

  const users = queryData?.users ?? [];
  const activeCount = users.filter((user) => userStatus(user) === "active").length;
  const selectedUser = users.find((user) => user.userId === selectedUserId);
  const currentUserId = meQueryData?.user.userId;
  return (
    <div className="page page-enter">
      <PageTitle
        title="Users"
        subtitle={`${users.length} members · ${activeCount} active`}
        actions={(
          <button className="btn btn-primary" type="button" onClick={() => setShowInvite((open) => !open)}>
            {showInvite ? <X /> : <MailPlus />}
            {showInvite ? "Close" : "Invite user"}
          </button>
        )}
      />
      {showInvite ? <InviteUserPanel /> : null}
      <ConsoleTable
        urlState
        data={users}
        columns={userColumns({
          openRoleUserId,
          pendingUserId: roleMutation.isPending ? roleMutation.variables?.userId : undefined,
          errorUserId: roleMutation.error ? roleMutation.variables?.userId : undefined,
          errorMessage: roleMutation.error?.message,
          onRoleMenuOpenChange: (userId, open) => setOpenRoleUserId(open ? userId : null),
          onRoleChange: (userId, role) => roleMutation.mutate({ userId, role })
        })}
        search={{ placeholder: "Search members...", getValue: userSearchValue }}
        filters={userFilters}
        advancedFields={userAdvancedFields}
        emptyLabel="No users match these filters."
        actions={({ visibleData }) => {
          const selectedIndex = selectedUser ? visibleData.findIndex((user) => user.userId === selectedUser.userId) : -1;
          return (
            <>
              <button className="btn" type="button" onClick={() => downloadJson("proxy-users.json", { users: visibleData, selectedUser })}>
                <Download />Export
              </button>
              {selectedUser ? (
                <UserInspector
                  user={selectedUser}
                  currentUserId={currentUserId}
                  position={selectedIndex}
                  total={visibleData.length}
                  onPrevious={() => setSelectedUserId(adjacentUserId(visibleData, selectedUser.userId, -1))}
                  onNext={() => setSelectedUserId(adjacentUserId(visibleData, selectedUser.userId, 1))}
                  onClose={() => setSelectedUserId(null)}
                />
              ) : null}
            </>
          );
        }}
        getRowProps={(user) => ({
          className: selectedUser?.userId === user.userId ? "selectable-row selected" : "selectable-row",
          tabIndex: 0,
          role: "button",
          onClick: () => setSelectedUserId(user.userId),
          onKeyDown: (event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            setSelectedUserId(user.userId);
          }
        })}
      />
      <InvitationsCard />
    </div>
  );
}
