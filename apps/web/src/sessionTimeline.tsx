import { Link } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, FileText, Layers, Shield, Sparkles, User, Wrench } from "lucide-react";
import { useState, type ReactNode } from "react";

import type { ArtifactRole } from "./artifactKinds";
import { formatCompact, formatDurationMs, formatMoney, formatTimeOfDay } from "./format";
import { CopyButton } from "./jsonView";
import {
  artifactRole,
  artifactHasStoredText,
  artifactNeedsDetailLink,
  artifactText,
  artifactToolNames,
  type ConversationTurn,
  type SessionArtifact
} from "./sessionsPageData";
import { GlassCard, RouteBadge, StatusIndicator } from "./ui";

function RequestBlock({ turn, spans }: { turn: ConversationTurn; spans: Map<string, number> }) {
  const { request, index, gapMs, artifacts, priorMessages, priorTokens } = turn;
  const logArtifactId = artifacts[0]?.artifactId;
  return (
    <section className="req-block">
      <div className="req-head">
        <span className="req-n">Request {String(index + 1).padStart(2, "0")}</span>
        <span className="req-meta">
          <span className="row gap-8"><span className="model-dot" />{request.selectedModel ?? "unknown"}</span>
          <span>{formatCompact(request.usage.inputTokens)} in → {formatCompact(request.usage.outputTokens)} out</span>
          <span>{formatMoney(request.selectedCost)}</span>
          {request.latencyMs != null ? <span>{formatDurationMs(request.latencyMs)}</span> : null}
          {request.createdAt ? <time dateTime={request.createdAt}>{formatTimeOfDay(request.createdAt)}</time> : null}
          {gapMs != null && gapMs >= 1000 ? <span>+{formatDurationMs(gapMs)} idle</span> : null}
        </span>
        <span className="req-side">
          {logArtifactId ? (
            <Link to="/logs/$artifactId" params={{ artifactId: logArtifactId }} className="req-log-link">Open log</Link>
          ) : null}
          <RouteBadge route={request.requestedLogicalModel ?? request.resolvedLogicalModelId} />
          <StatusIndicator status={request.terminalStatus} />
        </span>
      </div>
      <div className="tl">
        {priorMessages > 0 ? (
          <ContextStackItem count={priorMessages} tokens={priorTokens} cachedTokens={request.usage.cachedInputTokens} />
        ) : null}
        {artifacts.map((artifact, position) => (
          <MessageItem
            key={artifact.artifactId}
            artifact={artifact}
            identicalAcross={spans.get(artifact.artifactId)}
            last={position === artifacts.length - 1}
          />
        ))}
        {artifacts.length === 0 ? (
          <TimelineItem tone="context" icon={<Layers />} last>
            <div className="msg"><div className="msg-body msg-missing">No new content captured for this request.</div></div>
          </TimelineItem>
        ) : null}
      </div>
    </section>
  );
}

function TimelineItem({ tone, icon, dashed = false, last = false, children }: {
  tone: ArtifactRole;
  icon: ReactNode;
  dashed?: boolean;
  last?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`tl-item${last ? " last" : ""}`}>
      <div className="tl-rail"><span className={`tl-node${dashed ? " tl-node-ctx" : ""} msg-tone-${tone}`}>{icon}</span></div>
      {children}
    </div>
  );
}

function ContextStackItem({ count, tokens, cachedTokens }: { count: number; tokens: number; cachedTokens: number }) {
  return (
    <TimelineItem tone="context" icon={<Layers />} dashed>
      <div className="ctx-stack">
        <span>
          {formatCompact(count)} earlier {count === 1 ? "message" : "messages"}
          {tokens > 0 ? ` · ~${formatCompact(tokens)} tok` : ""} replayed from previous requests
        </span>
        {cachedTokens > 0 ? <span className="ctx-cached">{formatCompact(cachedTokens)} tok read from cache</span> : null}
      </div>
    </TimelineItem>
  );
}

const KIND_ICONS: Record<string, ReactNode> = {
  tool_use: <Wrench />,
  tool_result: <FileText />
};

const ROLE_ICONS: Record<ArtifactRole, ReactNode> = {
  system: <Shield />,
  user: <User />,
  assistant: <Sparkles />,
  tool: <Wrench />,
  context: <Layers />
};

const CLAMP_CHARS = 280;
const CLAMP_LINES = 5;
const INITIAL_VISIBLE_TURNS = 80;
const VISIBLE_TURN_STEP = 500;

export function SessionTimeline({ turns, spans }: { turns: ConversationTurn[]; spans: Map<string, number> }) {
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_TURNS);
  if (turns.length === 0) return <GlassCard><div className="empty">No requests recorded for this session.</div></GlassCard>;
  const visibleTurns = turns.slice(0, visibleCount);
  const hiddenCount = turns.length - visibleTurns.length;
  const nextCount = Math.min(VISIBLE_TURN_STEP, hiddenCount);
  return (
    <>
      {visibleTurns.map((turn) => <RequestBlock key={turn.request.requestId} turn={turn} spans={spans} />)}
      {hiddenCount > 0 ? (
        <button
          type="button"
          className="session-more"
          onClick={() => setVisibleCount((count) => Math.min(count + VISIBLE_TURN_STEP, turns.length))}
        >
          Show next {formatCompact(nextCount)} requests · {formatCompact(visibleTurns.length)} of {formatCompact(turns.length)} shown
        </button>
      ) : null}
    </>
  );
}

function MessageItem({ artifact, identicalAcross, last }: {
  artifact: SessionArtifact;
  identicalAcross?: number;
  last: boolean;
}) {
  const { role, label } = artifactRole(artifact);
  const text = artifactText(artifact);
  const lines = text ? text.split("\n").length : 0;
  const hasStoredText = artifactHasStoredText(artifact);
  const isLong = hasStoredText && text != null && (text.length > CLAMP_CHARS || lines > CLAMP_LINES);
  const needsDetailLink = artifactNeedsDetailLink(artifact);
  const [open, setOpen] = useState(false);
  const tools = artifactToolNames(artifact);
  const isCode = role === "tool" || role === "system" || role === "context";
  const tokens = artifact.tokenEstimate ?? 0;
  const detailLabel = artifact.chars != null
    ? `Open full ${label.toLowerCase()} · ${formatCompact(artifact.chars)} chars`
    : `Open full ${label.toLowerCase()}`;
  let messageAction: ReactNode = null;
  if (isLong) {
    messageAction = (
      <button type="button" className="expander" onClick={() => setOpen((value) => !value)}>
        {open ? <ChevronDown /> : <ChevronRight />}
        {open
          ? "Collapse"
          : `Expand full ${label.toLowerCase()} · ${formatCompact(lines)} lines${tokens > 0 ? ` · ~${formatCompact(tokens)} tokens` : ""}`}
      </button>
    );
  } else if (needsDetailLink) {
    messageAction = (
      <Link to="/logs/$artifactId" params={{ artifactId: artifact.artifactId }} className="expander">
        <FileText />
        {detailLabel}
      </Link>
    );
  }
  return (
    <TimelineItem tone={role} icon={KIND_ICONS[artifact.kind] ?? ROLE_ICONS[role]} last={last}>
      <div className="msg">
        <div className="msg-head">
          <span className={`role msg-tone-${role}`}>{label}</span>
          {tools.slice(0, 3).map((tool) => <span key={tool} className="code-pill msg-tool-pill">{tool}()</span>)}
          {tools.length > 3 ? <span className="msg-head-extra">+{tools.length - 3} more</span> : null}
          {identicalAcross != null && identicalAcross > 1 ? (
            <span className="badge badge-accent msg-cached">identical across {identicalAcross} requests</span>
          ) : null}
          <span className="msg-head-meta">
            {tokens > 0 ? `~${formatCompact(tokens)} tok` : null}
            {tokens > 0 && isLong ? " · " : null}
            {isLong ? `${formatCompact(lines)} lines` : null}
          </span>
          {text && hasStoredText ? <CopyButton text={text} /> : null}
        </div>
        {text
          ? <div className={`msg-body${isCode ? " code" : ""}${isLong && !open ? " clamp" : ""}`}>{text}</div>
          : <div className="msg-body msg-missing">Content not stored.</div>}
        {messageAction}
      </div>
    </TimelineItem>
  );
}
