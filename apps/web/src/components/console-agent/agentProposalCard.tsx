import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";

import { Badge } from "../../ui";
import {
  approveAgentProposal,
  consoleAgentKeys,
  proposalDisplayStatus,
  rejectAgentProposal,
  type ConsoleAgentProposal
} from "./consoleAgentData";

const RESOLUTION_QUERY_KEYS = [
  consoleAgentKeys.all,
  ["routing-configs"],
  ["routing-config"],
  ["api-keys"]
] as const;

// The card renders only the server-persisted proposal preview, never the
// assistant's prose, so the model cannot misrepresent the change it proposed.
export function AgentProposalCard({ proposal }: { proposal: ConsoleAgentProposal }) {
  const queryClient = useQueryClient();
  const resolveMutation = useMutation({
    mutationFn: async (action: "approve" | "reject") => {
      if (action === "approve") {
        await approveAgentProposal(proposal.id);
      } else {
        await rejectAgentProposal(proposal.id);
      }
    },
    onSettled: () => {
      for (const queryKey of RESOLUTION_QUERY_KEYS) {
        void queryClient.invalidateQueries({ queryKey });
      }
    }
  });

  const status = proposalDisplayStatus(proposal);
  const summary = summaryText(proposal.preview);
  const diff = previewDiff(proposal.preview);
  const configId = stringField(proposal.preview, "configId");

  return (
    <div className={`agent-proposal-card ${status}`}>
      <div className="agent-proposal-head">
        <span className="code-pill">{proposal.capabilityKey}</span>
        <ProposalStatusBadge status={status} />
      </div>
      {summary ? <p className="agent-proposal-summary">{summary}</p> : null}
      {diff && diff.changes.length > 0 ? (
        <ul className="agent-proposal-diff">
          {diff.changes.map((change) => (
            <li key={asText(change.path)}>
              <span className="agent-proposal-diff-path">{asText(change.path)}</span>
              <span className="agent-proposal-diff-values">
                {formatValue(change.before)} <span aria-hidden="true">&rarr;</span> {formatValue(change.after)}
              </span>
            </li>
          ))}
          {diff.truncated ? <li className="faint">Diff truncated; see the full payload below.</li> : null}
        </ul>
      ) : null}
      <details className="agent-proposal-payload">
        <summary>Full change payload</summary>
        <pre>{JSON.stringify(proposal.preview, null, 2)}</pre>
      </details>
      <div className="agent-proposal-meta">
        {proposal.proposedByUserId ? <span>Proposed by {proposal.proposedByUserId}</span> : null}
        {status === "pending" ? <span>Expires {new Date(proposal.expiresAt).toLocaleString()}</span> : null}
        {status !== "pending" && proposal.resolvedAt ? (
          <span>
            Resolved {new Date(proposal.resolvedAt).toLocaleString()}
            {proposal.resolvedByUserId ? ` by ${proposal.resolvedByUserId}` : ""}
          </span>
        ) : null}
      </div>
      {status === "pending" ? (
        <div className="agent-proposal-actions">
          <button
            className="btn btn-primary"
            type="button"
            disabled={resolveMutation.isPending}
            onClick={() => resolveMutation.mutate("approve")}
          >
            {resolveMutation.isPending && resolveMutation.variables === "approve" ? (
              <Loader2 className="spin" />
            ) : null}
            Approve
          </button>
          <button
            className="btn"
            type="button"
            disabled={resolveMutation.isPending}
            onClick={() => resolveMutation.mutate("reject")}
          >
            Reject
          </button>
        </div>
      ) : null}
      {status === "approved" && configId ? (
        <Link to="/routing-configs/$configId" params={{ configId }} className="agent-proposal-link">
          View routing config
        </Link>
      ) : null}
      {resolveMutation.isError ? (
        <div className="agent-error">{resolutionErrorText(resolveMutation.error)}</div>
      ) : null}
    </div>
  );
}

function ProposalStatusBadge({ status }: { status: ConsoleAgentProposal["status"] }) {
  if (status === "pending") return <Badge variant="accent" dot>Awaiting approval</Badge>;
  if (status === "approved") return <Badge variant="success" dot>Approved</Badge>;
  if (status === "rejected") return <Badge variant="danger" dot>Rejected</Badge>;
  if (status === "stale") return <Badge variant="warn" dot>Stale</Badge>;
  return <Badge dot>Expired</Badge>;
}

function summaryText(preview: Record<string, unknown>) {
  switch (preview.action) {
    case "create_config":
      return `Create routing config "${asText(preview.name)}" (slug ${asText(preview.slug)}).`;
    case "create_version":
      return `Add a new draft version to config ${asText(preview.configId)}.`;
    case "activate_version":
      return `Activate version ${asText(preview.versionId)} on config ${asText(preview.configId)}.`;
    case "archive_config":
      return `Archive routing config ${asText(preview.configId)}.`;
    case "assign_routing_config":
      return `Point API key "${asText(preview.apiKeyName)}" at ${
        preview.to === null ? "the organization default" : `config ${asText(preview.to)}`
      }.`;
    default:
      return null;
  }
}

function previewDiff(preview: Record<string, unknown>) {
  const diff = preview.diff;
  if (!diff || typeof diff !== "object") return null;
  const changes = (diff as { changes?: unknown }).changes;
  if (!Array.isArray(changes)) return null;
  return {
    changes: changes as { path?: unknown; before?: unknown; after?: unknown }[],
    truncated: (diff as { truncated?: unknown }).truncated === true
  };
}

function stringField(preview: Record<string, unknown>, key: string) {
  const value = preview[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asText(value: unknown) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function formatValue(value: unknown) {
  return value === undefined ? "(unset)" : JSON.stringify(value);
}

function resolutionErrorText(error: unknown) {
  const message = error instanceof Error ? error.message : "Failed to resolve the proposal.";
  if (message.includes("proposal_stale")) {
    return "The underlying data changed since this was proposed. Ask the agent to propose again.";
  }
  if (message.includes("proposal_expired")) return "This proposal expired before it was approved.";
  if (message.includes("proposal_already_resolved")) return "This proposal was already resolved.";
  if (message.includes("proposal_execution_failed")) {
    return "Applying the change failed. The proposal is still pending; check the server logs.";
  }
  return message;
}
