import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, KeyRound, ShieldCheck, UserCheck, UserX } from "lucide-react";

import { displayUser } from "./consoleData";
import { InspectorPanel } from "./dashboard";
import { Drawer } from "./drawer";
import { compactId, formatCompact, formatDateTime, formatMoney } from "./format";
import { graphql } from "./gql";
import { gqlFetch } from "./graphql";
import { Fact } from "./keyTraffic";
import { fetchApiKeys, type ApiKeySummary } from "./keys/data";
import { apiKeyStatus } from "./keys/apiKeyTableData";
import { labelForStatusAction, userRole, userStatus, type UserSummary } from "./usersPageData";
import { GlassCard, StatusIndicator } from "./ui";

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

export function UserInspector({ user, currentUserId, position, total, onPrevious, onNext, onClose }: {
  user: UserSummary;
  currentUserId?: string;
  position: number;
  total: number;
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const apiKeysQuery = useQuery({ queryKey: ["api-keys"], queryFn: fetchApiKeys });
  const statusMutation = useMutation({
    mutationFn: async (input: { userId: string; deactivate: boolean }) => {
      if (input.deactivate) await gqlFetch(DeactivateUserDocument, { userId: input.userId });
      else await gqlFetch(ReactivateUserDocument, { userId: input.userId });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["users"] })
  });
  const apiKeys = (apiKeysQuery.data ?? []).filter((apiKey) => apiKey.userId === user.userId);
  const mutationIsForUser = statusMutation.variables?.userId === user.userId;

  return (
    <Drawer
      label={`User ${displayUser(user)}`}
      title={displayUser(user)}
      subtitle={(
        <span className="row gap-8">
          <StatusIndicator status={userStatus(user)} />
          <span>{user.email ?? user.externalId ?? user.userId}</span>
        </span>
      )}
      storageKey="user-panel-width"
      onClose={onClose}
    >
      <div className="key-panel user-panel">
        <div className="user-panel-nav">
          <span className="faint" aria-live="polite">{position >= 0 ? `User ${position + 1} of ${total}` : "Not in current view"}</span>
          <div className="row gap-8" aria-label="User navigation">
            <button className="btn btn-ghost btn-icon" type="button" aria-label="Previous user" title="Previous user" disabled={position <= 0} onClick={onPrevious}>
              <ArrowUp />
            </button>
            <button className="btn btn-ghost btn-icon" type="button" aria-label="Next user" title="Next user" disabled={position < 0 || position >= total - 1} onClick={onNext}>
              <ArrowDown />
            </button>
          </div>
        </div>
        <InspectorPanel
          title="Usage"
          subtitle="30-day and lifetime totals"
          rows={[
            { label: "Tokens (30d)", value: formatCompact(user.usage30d.totalTokens) },
            { label: "Spend (30d)", value: formatMoney(user.cost30d.selected) },
            { label: "Tokens (lifetime)", value: formatCompact(user.usage.totalTokens) },
            { label: "Requests", value: user.requestCount },
            { label: "Sessions", value: user.sessionCount },
            { label: "Spend (lifetime)", value: formatMoney(user.cost.selected) }
          ]}
        />
        <UserApiKeys apiKeys={apiKeys} activeCount={user.apiKeyCount} loading={apiKeysQuery.isLoading} error={apiKeysQuery.error?.message} />
        <GlassCard className="user-account-card">
          <div className="card-head">
            <div className="card-title"><ShieldCheck />Account</div>
            <MemberStatusAction
              user={user}
              isSelf={currentUserId === user.userId}
              pending={mutationIsForUser && statusMutation.isPending}
              error={mutationIsForUser ? statusMutation.error?.message : undefined}
              onToggle={(deactivate) => statusMutation.mutate({ userId: user.userId, deactivate })}
            />
          </div>
          <div className="fact-grid key-panel-facts">
            <Fact label="Email">{user.email ?? "none"}</Fact>
            <Fact label="Role">{userRole(user) || "none"}</Fact>
            <Fact label="Joined">{formatDateTime(user.createdAt)}</Fact>
            <Fact label="Recent activity">{user.recentActivity ? formatDateTime(user.recentActivity) : "none"}</Fact>
            <Fact label="User ID"><span className="mono" title={user.userId}>{compactId(user.userId, 12)}</span></Fact>
            <Fact label="External ID">{user.externalId ?? "none"}</Fact>
          </div>
        </GlassCard>
      </div>
    </Drawer>
  );
}

function UserApiKeys({ apiKeys, activeCount, loading, error }: { apiKeys: ApiKeySummary[]; activeCount: number; loading: boolean; error?: string }) {
  return (
    <GlassCard className="user-api-keys-card">
      <div className="card-head">
        <div className="card-title"><KeyRound />API keys</div>
        <span className="badge">{activeCount} active</span>
      </div>
      {loading ? <div className="empty compact-empty">Loading API keys…</div> : null}
      {error ? <div className="action-error">{error}</div> : null}
      {!loading && !error && apiKeys.length === 0 ? <div className="empty compact-empty">No API keys assigned to this user.</div> : null}
      {apiKeys.length > 0 ? (
        <div className="user-api-key-list">
          {apiKeys.map((apiKey) => (
            <div key={apiKey.id} className="user-api-key-row">
              <div className="user-api-key-head">
                <div>
                  <strong>{apiKey.name}</strong>
                  <span className="mono faint" title={apiKey.id}>{compactId(apiKey.id, 12)}</span>
                </div>
                <StatusIndicator status={apiKeyStatus(apiKey)} />
              </div>
              <div className="user-api-key-meta">
                <span>{apiKey.accessProfile?.name ?? "Unassigned"}</span>
                <span>Last used {apiKey.lastUsedAt ? formatDateTime(apiKey.lastUsedAt) : "never"}</span>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </GlassCard>
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
