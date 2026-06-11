import { ARTIFACT_KIND_ROLES, artifactPosition } from "./artifactKinds";
import { displayUser } from "./consoleData";
import { dominantKey, formatCompact, formatDateTimeSeconds } from "./format";
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

export function sessionRoute(session: SessionSummary) {
  return session.currentRoute ?? dominantKey(countRecord(session.routeMix));
}

export function sessionStatus(session: SessionSummary) {
  return dominantKey(countRecord(session.terminalStatusSummary));
}

export function lastActivity(session: SessionSummary) {
  return session.recentActivity ?? session.startedAt;
}

export function activityTime(session: SessionSummary) {
  return new Date(lastActivity(session)).getTime();
}

export function requestCountLabel(count: number) {
  return `${formatCompact(count)} ${count === 1 ? "request" : "requests"}`;
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
    sessionRoute(session),
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
  return ordered.map((request, index) => {
    const artifacts = [...(artifactsByRequest.get(request.requestId) ?? [])].sort(compareArtifacts);
    const previous = index > 0 ? ordered[index - 1] : null;
    // Idle time before this turn: previous turn's latency is not "waiting".
    const gapMs = request.createdAt && previous?.createdAt
      ? Math.max(0, new Date(request.createdAt).getTime() - new Date(previous.createdAt).getTime() - (previous.latencyMs ?? 0))
      : null;
    return { index, gapMs, request, artifacts };
  });
}

function compareArtifacts(left: SessionArtifact, right: SessionArtifact) {
  const byIndex = artifactPosition(left) - artifactPosition(right);
  if (byIndex !== 0) return byIndex;
  return new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
}

export function artifactRole(artifact: SessionArtifact) {
  return ARTIFACT_KIND_ROLES[artifact.kind] ?? { role: "user" as const, label: artifact.kind };
}

export function conversationSpan(turns: ConversationTurn[]) {
  if (turns.length < 2) return null;
  const first = turns[0].request.createdAt;
  const last = turns[turns.length - 1].request.createdAt;
  return first && last ? new Date(last).getTime() - new Date(first).getTime() : null;
}

export function artifactText(artifact?: SessionArtifact) {
  return artifact ? artifact.rawText ?? artifact.redactedText ?? artifact.preview : null;
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
