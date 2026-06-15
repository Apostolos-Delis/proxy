import { useMutation, useQueryClient } from "@tanstack/react-query";
import { UserCheck, UserX } from "lucide-react";

import { displayUser } from "./consoleData";
import { InspectorPanel } from "./dashboard";
import { formatCompact, formatDateTime, formatMoney } from "./format";
import { graphql } from "./gql";
import { gqlFetch } from "./graphql";
import { labelForStatusAction, userRole, userStatus, type UserSummary } from "./usersPageData";

const DeactivateUserDocument = graphql(`
  mutation DeactivateUser($userId: ID!) {
    deactivateUser(userId: $userId) {
      userId
      status
    }
  }
`);

const ReactivateUserDocument = graphql(`
  mutation ReactivateUser($userId: ID!) {
    reactivateUser(userId: $userId) {
      userId
      status
    }
  }
`);

export function UserInspector({ user, currentUserId }: { user: UserSummary; currentUserId?: string }) {
  const queryClient = useQueryClient();
  const statusMutation = useMutation({
    mutationFn: async (input: { userId: string; deactivate: boolean }) => {
      if (input.deactivate) await gqlFetch(DeactivateUserDocument, { userId: input.userId });
      else await gqlFetch(ReactivateUserDocument, { userId: input.userId });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["users"] })
  });

  return (
    <InspectorPanel
      title={displayUser(user)}
      subtitle={user.email ?? user.externalId ?? user.userId}
      action={(
        <MemberStatusAction
          user={user}
          isSelf={currentUserId === user.userId}
          pending={statusMutation.isPending}
          error={statusMutation.error?.message}
          onToggle={(deactivate) => statusMutation.mutate({ userId: user.userId, deactivate })}
        />
      )}
      rows={[
        { label: "Role", value: userRole(user) },
        { label: "Status", value: userStatus(user) },
        { label: "Requests", value: user.requestCount },
        { label: "Sessions", value: user.sessionCount },
        { label: "Tokens", value: formatCompact(user.usage.totalTokens) },
        { label: "Spend", value: formatMoney(user.cost.selected) },
        { label: "Recent activity", value: user.recentActivity ? formatDateTime(user.recentActivity) : "none" }
      ]}
    />
  );
}

function MemberStatusAction({ user, isSelf, pending, error, onToggle }: {
  user: UserSummary;
  isSelf: boolean;
  pending: boolean;
  error?: string;
  onToggle: (deactivate: boolean) => void;
}) {
  if (!user.membership) return null;

  const deactivated = user.membership.status === "deactivated";
  const label = labelForStatusAction(deactivated, pending);
  return (
    <div className="member-status-action">
      <button
        className="btn btn-sm"
        type="button"
        disabled={pending || (isSelf && !deactivated)}
        title={isSelf && !deactivated ? "You cannot deactivate yourself." : undefined}
        onClick={() => onToggle(!deactivated)}
      >
        {deactivated ? <UserCheck /> : <UserX />}
        {label}
      </button>
      {error ? <div className="action-error">{error}</div> : null}
    </div>
  );
}
