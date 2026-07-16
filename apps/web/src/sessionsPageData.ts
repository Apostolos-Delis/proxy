import { ARTIFACT_KIND_ROLES, artifactPosition } from "./artifactKinds";
import { displayUser } from "./consoleData";
import { dominantKey, formatDateTimeSeconds } from "./format";
import type { SessionDetailViewQuery, SessionsPageQuery } from "./gql/graphql";

export type SessionSummary = SessionsPageQuery["sessions"][number];
export type SessionDetail = NonNullable<SessionDetailViewQuery["session"]>;
export type SessionRequest = SessionDetail["requests"][number];
export type SessionArtifact = SessionDetail["promptArtifacts"][number];

export type SessionLogRow = {
  session: SessionSummary;
  userName: string;
  userDetail?: string;
};

export type ConversationTurn = {
  index: number;
  gapMs: number | null;
  request: SessionRequest;
  artifacts: SessionArtifact[];
  priorMessages: number;
  priorTokens: number;
};

export function countRecord(value: unknown): Record<string, number> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, number>
    : {};
}

export function sortedCounts(counts: Record<string, number>) {
  return Object.entries(counts).sort((left, right) => right[1] - left[1]);
}

export function sessionModels(session: SessionSummary) {
  return Object.keys(countRecord(session.modelMix));
}

export function sessionStatuses(session: SessionSummary) {
  return Object.keys(countRecord(session.terminalStatusSummary));
}

export function sessionLogicalModel(session: SessionSummary) {
  return dominantKey(countRecord(session.logicalModelMix));
}

export function sessionStatus(session: SessionSummary) {
  return dominantKey(countRecord(session.terminalStatusSummary));
}

export function sessionDurationMs(session: SessionSummary) {
  const end = session.endedAt ?? session.recentActivity;
  if (!end) return null;
  const span = new Date(end).getTime() - new Date(session.startedAt).getTime();
  return span > 0 ? span : null;
}

export function sessionRows(sessions: SessionSummary[], users: SessionsPageQuery["users"]): SessionLogRow[] {
  const usersById = new Map(users.map((user) => [user.userId, user]));
  return sessions.map((session) => {
    const user = session.userId ? usersById.get(session.userId) : undefined;
    const userName = user ? displayUser(user) : session.userId ?? "unknown";
    const email = user?.email;
    return { session, userName, userDetail: email && email !== userName ? email : undefined };
  });
}

export function sessionSearchValue(row: SessionLogRow) {
  const session = row.session;
  return [
    session.sessionId,
    session.externalSessionId,
    row.userName,
    session.userId,
    session.surface,
    sessionLogicalModel(session),
    ...sessionModels(session),
    ...sessionStatuses(session)
  ].filter((value): value is string => Boolean(value));
}

export function conversationTurns(detail: SessionDetail): ConversationTurn[] {
  const artifactsByRequest = new Map<string, SessionArtifact[]>();
  // Capture dedupes per session, but concurrent requests can race it;
  // drop any repeated (kind, content) pair so messages render once.
  const seen = new Set<string>();
  const chronological = [...detail.promptArtifacts]
    .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
  for (const artifact of chronological) {
    if (!ARTIFACT_KIND_ROLES[artifact.kind]) continue;
    const key = `${artifact.kind}:${artifact.contentHash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const list = artifactsByRequest.get(artifact.requestId) ?? [];
    list.push(artifact);
    artifactsByRequest.set(artifact.requestId, list);
  }
  const ordered = [...detail.requests].sort((left, right) => requestTime(left) - requestTime(right));
  let priorMessages = 0;
  let priorTokens = 0;
  return ordered.map((request, index) => {
    const artifacts = [...(artifactsByRequest.get(request.requestId) ?? [])].sort(compareArtifacts);
    const previous = index > 0 ? ordered[index - 1] : null;
    // Idle time before this turn: previous turn's latency is not "waiting".
    const gapMs = request.createdAt && previous?.createdAt
      ? Math.max(0, new Date(request.createdAt).getTime() - new Date(previous.createdAt).getTime() - (previous.latencyMs ?? 0))
      : null;
    const turn = { index, gapMs, request, artifacts, priorMessages, priorTokens };
    // Capture stores each message once per session; later requests replay the
    // earlier ones verbatim, so accumulate what came before each turn.
    priorMessages += artifacts.length;
    priorTokens += artifacts.reduce((total, artifact) => total + (artifact.tokenEstimate ?? 0), 0);
    return turn;
  });
}

// "Identical across N requests": a system/instructions artifact is captured on
// the first request that sent it and stays in effect until a later request
// carries a different one of the same kind (or the session ends). One request
// can hold several same-kind artifacts (OpenAI instructions + developer
// messages), so spans open and close per turn, not per artifact.
export function systemSpans(turns: ConversationTurn[]): Map<string, number> {
  const spans = new Map<string, number>();
  const open = new Map<string, { artifactIds: string[]; since: number }>();
  for (const turn of turns) {
    const byKind = new Map<string, string[]>();
    for (const artifact of turn.artifacts) {
      if (artifactRole(artifact).role !== "system") continue;
      byKind.set(artifact.kind, [...(byKind.get(artifact.kind) ?? []), artifact.artifactId]);
    }
    for (const [kind, artifactIds] of byKind) {
      const previous = open.get(kind);
      if (previous) for (const id of previous.artifactIds) spans.set(id, turn.index - previous.since);
      open.set(kind, { artifactIds, since: turn.index });
    }
  }
  for (const previous of open.values()) {
    for (const id of previous.artifactIds) spans.set(id, turns.length - previous.since);
  }
  return spans;
}

export function artifactToolNames(artifact: SessionArtifact): string[] {
  const metadata = artifact.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  const { toolName, toolNames } = metadata as { toolName?: unknown; toolNames?: unknown };
  if (typeof toolName === "string") return [toolName];
  if (Array.isArray(toolNames)) return [...new Set(toolNames.filter((name): name is string => typeof name === "string"))];
  return [];
}

export function dominantRequestStatus(requests: SessionRequest[]) {
  return dominantKey(countBy(requests, (request) => request.terminalStatus));
}

export function dominantRequestLogicalModel(requests: SessionRequest[]) {
  return dominantKey(countBy(requests, (request) => request.requestedLogicalModel ?? request.resolvedLogicalModelId ?? "unknown"));
}

function countBy(requests: SessionRequest[], pick: (request: SessionRequest) => string) {
  const counts: Record<string, number> = {};
  for (const request of requests) {
    const key = pick(request);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function compareArtifacts(left: SessionArtifact, right: SessionArtifact) {
  const byIndex = artifactPosition(left) - artifactPosition(right);
  if (byIndex !== 0) return byIndex;
  return new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
}

export function artifactRole(artifact: SessionArtifact) {
  return ARTIFACT_KIND_ROLES[artifact.kind] ?? { role: "user" as const, label: artifact.kind };
}

// Wall time from the first request landing to the last response finishing.
// Unlike sessionDurationMs (summary rows, endedAt-based), this follows the
// requests actually shown on the trace, so the two can differ slightly.
export function sessionWallMs(turns: ConversationTurn[]) {
  if (turns.length === 0) return null;
  const first = turns[0].request.createdAt;
  const last = turns[turns.length - 1].request;
  if (!first || !last.createdAt) return null;
  const span = new Date(last.createdAt).getTime() + (last.latencyMs ?? 0) - new Date(first).getTime();
  return span > 0 ? span : null;
}

export function artifactText(artifact?: SessionArtifact) {
  if (!artifact) return null;
  return artifactStoredText(artifact) ?? artifact.preview ?? null;
}

export function artifactHasStoredText(artifact: SessionArtifact) {
  return artifactStoredText(artifact) != null;
}

export function artifactNeedsDetailLink(artifact: SessionArtifact) {
  if (artifactHasStoredText(artifact)) return false;
  const text = artifactText(artifact);
  if (!text) return false;
  return text.endsWith("...") || (artifact.chars != null && artifact.chars > text.length);
}

function artifactStoredText(artifact: SessionArtifact) {
  const content = artifact as SessionArtifact & { rawText?: unknown; redactedText?: unknown };
  if (typeof content.rawText === "string") return content.rawText;
  if (typeof content.redactedText === "string") return content.redactedText;
  return null;
}

export function transcriptText(turns: ConversationTurn[]) {
  return turns
    .map((turn) => {
      const lines = turn.artifacts
        .map((artifact) => {
          const text = artifactText(artifact);
          if (!text) return null;
          const stamp = artifact.createdAt ?? turn.request.createdAt;
          return `${stamp ? `[${formatDateTimeSeconds(stamp)}] ` : ""}${artifactRole(artifact).label}: ${text}`;
        })
        .filter(Boolean);
      if (lines.length > 0) return lines.join("\n");
      const stamp = turn.request.createdAt ? `[${formatDateTimeSeconds(turn.request.createdAt)}] ` : "";
      return `${stamp}(turn ${turn.index + 1}: content not captured)`;
    })
    .join("\n\n");
}

function requestTime(request: SessionRequest) {
  return request.createdAt ? new Date(request.createdAt).getTime() : 0;
}

function sessionUser(value: unknown): { name?: string; email?: string } | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as { name?: string; email?: string }
    : null;
}

export function sessionUserName(detail: SessionDetail) {
  const user = sessionUser(detail.user);
  return user?.name ?? user?.email ?? detail.session.userId ?? "unknown";
}
