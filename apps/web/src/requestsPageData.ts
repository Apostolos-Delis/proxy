import { isListedPromptArtifact, promptArtifactRank } from "./artifactKinds";
import { displayUser } from "./consoleData";
import { formatCompact } from "./format";
import type { RequestsPageQuery } from "./gql/graphql";

type PromptSummary = RequestsPageQuery["prompts"]["data"][number];
type RequestSummary = RequestsPageQuery["requests"][number];

export type PromptLogRow = {
  prompt: PromptSummary;
  request?: RequestSummary;
  userName: string;
  userEmail?: string | null;
};

export function promptRows(prompts: PromptSummary[], requests: RequestSummary[], users: RequestsPageQuery["users"]): PromptLogRow[] {
  const requestsById = new Map(requests.map((request) => [request.requestId, request]));
  const usersById = new Map(users.map((user) => [user.userId, user]));
  const promptsByRequest = new Map<string, PromptSummary>();
  prompts.filter(isVisiblePromptArtifact).forEach((prompt) => {
    const existing = promptsByRequest.get(prompt.requestId);
    if (!existing || artifactRank(prompt) < artifactRank(existing)) {
      promptsByRequest.set(prompt.requestId, prompt);
    }
  });
  return [...promptsByRequest.values()].map((prompt) => {
    const user = prompt.userId ? usersById.get(prompt.userId) : undefined;
    return {
      prompt,
      request: requestsById.get(prompt.requestId),
      userName: user ? displayUser(user) : prompt.userId ?? "unknown",
      userEmail: user?.email
    };
  });
}

export function requestSearchValue(row: PromptLogRow) {
  const { prompt, request } = row;
  return [
    prompt.preview,
    prompt.requestId,
    row.userName,
    prompt.userId,
    selectedLogicalModel(row),
    selectedModel(row),
    prompt.deploymentId,
    request?.deploymentId,
    prompt.providerConnectionId,
    request?.providerConnectionId,
    terminalStatus(row),
    translationMode(row),
    prompt.surface
  ].filter((value): value is string => Boolean(value));
}

export function totalTokens(row: PromptLogRow) {
  return row.request?.usage.totalTokens ?? row.prompt.tokenEstimate ?? 0;
}

export function selectedCost(row: PromptLogRow) {
  return row.request?.selectedCost ?? row.prompt.cost.selected;
}

export function selectedModel(row: PromptLogRow) {
  return row.prompt.selectedModel ?? row.request?.selectedModel ?? "unknown";
}

export function selectedLogicalModel(row: PromptLogRow) {
  return row.prompt.requestedLogicalModel ?? row.request?.requestedLogicalModel ??
    row.prompt.resolvedLogicalModelId ?? row.request?.resolvedLogicalModelId ?? "unknown";
}

export function terminalStatus(row: PromptLogRow) {
  return row.request?.terminalStatus ?? "unknown";
}

export function translationMode(row: PromptLogRow) {
  return row.request?.translated ? "translated" : "native";
}

export function formatLatency(value?: number | null) {
  return value === undefined || value === null ? "unknown" : `${formatCompact(value)}ms`;
}

export function uniqueOptions(values: string[]) {
  return [...new Set(values)].filter(Boolean).sort();
}

function isVisiblePromptArtifact(prompt: PromptSummary) {
  return isListedPromptArtifact(prompt.kind);
}

function artifactRank(prompt: PromptSummary) {
  return promptArtifactRank(prompt.kind);
}
