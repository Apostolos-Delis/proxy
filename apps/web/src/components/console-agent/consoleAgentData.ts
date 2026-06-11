import { apiBase } from "../../graphql";

// The console agent is the one admin surface still on REST (SSE streaming),
// so it keeps its own fetch helper instead of gqlFetch.
async function fetchJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...init.headers
    }
  });
  if (!response.ok) {
    throw new Error(await responseErrorMessage(response));
  }
  return response.json() as Promise<T>;
}

async function responseErrorMessage(response: Response) {
  const fallback = `${response.status} ${response.statusText}`;
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : fallback;
}

export type ConsoleAgentConversation = {
  id: string;
  organizationId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ConsoleAgentMessage = {
  id: string;
  role: "user" | "assistant";
  content: Record<string, unknown>;
  pageScope: Record<string, unknown> | null;
  runId: string | null;
  createdAt: string;
};

export type ConsoleAgentRunSummary = {
  id: string;
  status: "running" | "finished" | "failed" | "cancelled" | "awaiting_input" | "awaiting_approval";
  error: string | null;
};

export type ConsoleAgentProposal = {
  id: string;
  conversationId: string;
  runId: string;
  capabilityKey: string;
  preview: Record<string, unknown>;
  status: "pending" | "approved" | "rejected" | "stale" | "expired";
  proposedByUserId: string | null;
  resolvedByUserId: string | null;
  resolvedAt: string | null;
  expiresAt: string;
  createdAt: string;
};

export type ConsoleAgentConversationDetail = {
  conversation: ConsoleAgentConversation;
  messages: ConsoleAgentMessage[];
  lastRun: ConsoleAgentRunSummary | null;
  proposals: ConsoleAgentProposal[];
};

export const consoleAgentKeys = {
  all: ["console-agent"] as const,
  conversations: ["console-agent", "conversations"] as const,
  conversation: (conversationId: string) => ["console-agent", "conversation", conversationId] as const
};

export async function fetchAgentConversations() {
  return fetchJson<{ data: ConsoleAgentConversation[] }>("/admin/console-agent/conversations");
}

export async function fetchAgentConversation(conversationId: string) {
  return fetchJson<ConsoleAgentConversationDetail>(
    `/admin/console-agent/conversations/${encodeURIComponent(conversationId)}`
  );
}

export async function createAgentConversation(title?: string) {
  return fetchJson<{ conversation: ConsoleAgentConversation }>("/admin/console-agent/conversations", {
    method: "POST",
    body: JSON.stringify(title ? { title } : {})
  });
}

export async function sendAgentMessage(
  conversationId: string,
  input: { text: string; pageScope?: Record<string, unknown> }
) {
  return fetchJson<{ runId: string; conversationId: string }>(
    `/admin/console-agent/conversations/${encodeURIComponent(conversationId)}/messages`,
    { method: "POST", body: JSON.stringify(input) }
  );
}

export async function approveAgentProposal(proposalId: string) {
  return fetchJson<{ outcome: "approved"; proposal: ConsoleAgentProposal; output: Record<string, unknown> }>(
    `/admin/console-agent/proposals/${encodeURIComponent(proposalId)}/approve`,
    { method: "POST", body: JSON.stringify({}) }
  );
}

export async function rejectAgentProposal(proposalId: string) {
  return fetchJson<{ outcome: "rejected"; proposal: ConsoleAgentProposal }>(
    `/admin/console-agent/proposals/${encodeURIComponent(proposalId)}/reject`,
    { method: "POST", body: JSON.stringify({}) }
  );
}

export async function cancelAgentRun(runId: string) {
  return fetchJson<{ cancelled: boolean }>(
    `/admin/console-agent/runs/${encodeURIComponent(runId)}/cancel`,
    { method: "POST", body: JSON.stringify({}) }
  );
}

export function messageText(content: Record<string, unknown>) {
  if (typeof content.text === "string" && content.text.length > 0) return content.text;
  return JSON.stringify(content);
}

export type ConsoleAgentQuestion = { question: string; options: string[] };

export function messageQuestions(content: Record<string, unknown>): ConsoleAgentQuestion[] | null {
  if (!Array.isArray(content.questions)) return null;
  const questions = content.questions.filter(
    (entry): entry is ConsoleAgentQuestion =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as { question?: unknown }).question === "string" &&
      Array.isArray((entry as { options?: unknown }).options) &&
      (entry as { options: unknown[] }).options.every((option) => typeof option === "string")
  );
  return questions.length > 0 ? questions : null;
}

export function runInProgress(lastRun: ConsoleAgentRunSummary | null) {
  return lastRun?.status === "running";
}

export function runFailureText(lastRun: ConsoleAgentRunSummary | null) {
  if (!lastRun) return null;
  if (lastRun.status === "failed") return lastRun.error ?? "The agent run failed.";
  if (lastRun.status === "cancelled") return "The run was cancelled.";
  return null;
}

export function proposalDisplayStatus(
  proposal: ConsoleAgentProposal,
  now = Date.now()
): ConsoleAgentProposal["status"] {
  if (proposal.status === "pending" && new Date(proposal.expiresAt).getTime() <= now) {
    return "expired";
  }
  return proposal.status;
}

export type TranscriptEntry =
  | { kind: "message"; at: string; message: ConsoleAgentMessage }
  | { kind: "proposal"; at: string; proposal: ConsoleAgentProposal };

export function transcriptTimeline(
  messages: ConsoleAgentMessage[],
  proposals: ConsoleAgentProposal[]
): TranscriptEntry[] {
  return [
    ...messages.map((message) => ({ kind: "message" as const, at: message.createdAt, message })),
    ...proposals.map((proposal) => ({ kind: "proposal" as const, at: proposal.createdAt, proposal }))
  ].sort((left, right) => left.at.localeCompare(right.at));
}
