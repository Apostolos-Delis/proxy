import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail, RotateCw, X } from "lucide-react";
import { useState } from "react";

import { formatDateTime } from "./format";
import { graphql } from "./gql";
import type { InvitationsListQuery } from "./gql/graphql";
import { gqlFetch } from "./graphql";
import { InviteLinkResult, type InvitationActionResult } from "./inviteUserPanel";
import { Badge, DataTable, GlassCard, StatusBadge } from "./ui";

const InvitationsListDocument = graphql(`
  query InvitationsList {
    invitations {
      id
      email
      name
      role
      status
      lastSentAt
      expiresAt
      invitedBy {
        userId
        name
        email
      }
    }
  }
`);

const ResendInvitationDocument = graphql(`
  mutation ResendInvitation($invitationId: ID!) {
    resendInvitation(invitationId: $invitationId) {
      inviteUrl
      emailDelivery {
        transport
        delivered
        error
      }
    }
  }
`);

const RevokeInvitationDocument = graphql(`
  mutation RevokeInvitation($invitationId: ID!) {
    revokeInvitation(invitationId: $invitationId) {
      id
      status
    }
  }
`);

type InvitationSummary = InvitationsListQuery["invitations"][number];

export function InvitationsCard() {
  const [resendResult, setResendResult] = useState<{ invitationId: string; result: InvitationActionResult } | null>(null);
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["invitations"], queryFn: () => gqlFetch(InvitationsListDocument) });
  const resendMutation = useMutation({
    mutationFn: async (invitationId: string) =>
      (await gqlFetch(ResendInvitationDocument, { invitationId })).resendInvitation,
    onSuccess: (result, invitationId) => {
      queryClient.invalidateQueries({ queryKey: ["invitations"] });
      setResendResult({ invitationId, result });
    }
  });
  const revokeMutation = useMutation({
    mutationFn: (invitationId: string) => gqlFetch(RevokeInvitationDocument, { invitationId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["invitations"] });
    }
  });

  const invitationList = query.data?.invitations ?? [];
  if (query.isLoading || invitationList.length === 0) return null;

  const actionError = resendMutation.error ?? revokeMutation.error;
  return (
    <GlassCard className="table-wrap invitations-card">
      <div className="card-head">
        <div className="card-title"><Mail />Invitations</div>
        <span className="faint">{invitationList.filter((invitation) => invitation.status === "pending").length} pending</span>
      </div>
      <DataTable>
        <thead>
          <tr><th>Email</th><th>Role</th><th>Status</th><th>Invited by</th><th>Last sent</th><th>Expires</th><th>Actions</th></tr>
        </thead>
        <tbody>
          {invitationList.map((invitation) => (
            <InvitationRow
              key={invitation.id}
              invitation={invitation}
              resendPending={resendMutation.isPending && resendMutation.variables === invitation.id}
              revokePending={revokeMutation.isPending && revokeMutation.variables === invitation.id}
              onResend={() => resendMutation.mutate(invitation.id)}
              onRevoke={() => revokeMutation.mutate(invitation.id)}
            />
          ))}
        </tbody>
      </DataTable>
      {actionError ? <div className="action-error">{actionError.message}</div> : null}
      {resendResult ? <InviteLinkResult result={resendResult.result} /> : null}
    </GlassCard>
  );
}

function InvitationRow({ invitation, resendPending, revokePending, onResend, onRevoke }: {
  invitation: InvitationSummary;
  resendPending: boolean;
  revokePending: boolean;
  onResend: () => void;
  onRevoke: () => void;
}) {
  const actionable = invitation.status === "pending" || invitation.status === "expired";
  return (
    <tr>
      <td>
        <strong>{invitation.email}</strong>
        {invitation.name ? <div className="faint">{invitation.name}</div> : null}
      </td>
      <td><Badge>{invitation.role}</Badge></td>
      <td><StatusBadge status={invitation.status} /></td>
      <td>{inviterLabel(invitation)}</td>
      <td>{invitation.lastSentAt ? formatDateTime(invitation.lastSentAt) : <span className="faint">never</span>}</td>
      <td>{formatDateTime(invitation.expiresAt)}</td>
      <td>
        {actionable ? (
          <div className="row gap-8">
            <button className="btn btn-sm" type="button" disabled={resendPending} onClick={onResend}>
              <RotateCw />{resendPending ? "Resending" : "Resend"}
            </button>
            <button className="btn btn-sm" type="button" disabled={revokePending} onClick={onRevoke}>
              <X />{revokePending ? "Revoking" : "Revoke"}
            </button>
          </div>
        ) : <span className="faint">—</span>}
      </td>
    </tr>
  );
}

function inviterLabel(invitation: InvitationSummary) {
  const inviter = invitation.invitedBy;
  if (!inviter) return <span className="faint">unknown</span>;
  return inviter.name ?? inviter.email ?? inviter.userId;
}
