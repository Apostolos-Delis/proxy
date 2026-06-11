import { ChevronDown, MessagesSquare } from "lucide-react";
import { useState } from "react";

import { ARTIFACT_KIND_ROLES, artifactPosition, type ArtifactRole } from "./artifactKinds";
import { formatCompact } from "./format";
import { CopyButton } from "./jsonView";
import { artifactToolNames, exchangeMeta, type PromptArtifactDetail, type RequestSummary } from "./promptDetailData";
import { Badge, GlassCard } from "./ui";

const LONG_CHARS = 600;
const LONG_LINES = 9;
const CODE_ROLES: ArtifactRole[] = ["system", "tool", "context"];

export function ExchangeCard({ artifacts, request, focusedArtifactId }: {
  artifacts: PromptArtifactDetail[];
  request: RequestSummary | null;
  focusedArtifactId: string;
}) {
  const visible = artifacts
    .filter((artifact) => ARTIFACT_KIND_ROLES[artifact.kind])
    .sort((left, right) => artifactPosition(left) - artifactPosition(right));
  const hasAssistant = visible.some((artifact) => artifact.kind === "assistant_response");
  // Cached tokens are reported per request, not per block; the shared prefix
  // (system prompt) is where the cache hit lives, so the badge goes there.
  const cachedArtifactId = (request?.usage.cachedInputTokens ?? 0) > 0
    ? visible.find((artifact) => ARTIFACT_KIND_ROLES[artifact.kind].role === "system")?.artifactId
    : undefined;
  return (
    <GlassCard className="exchange-card">
      <div className="card-head">
        <div className="card-title"><MessagesSquare />Exchange</div>
        <span className="faint mono">{visible.length} artifacts</span>
      </div>
      <div className="exchange-list">
        {visible.map((artifact) => (
          <ExchangeMessage
            key={artifact.artifactId}
            artifact={artifact}
            focused={artifact.artifactId === focusedArtifactId}
            cached={artifact.artifactId === cachedArtifactId}
          />
        ))}
        {visible.length === 0 ? <div className="empty compact-empty">No prompt content captured for this request.</div> : null}
        {!hasAssistant && visible.length > 0 ? <MissingResponse status={request?.terminalStatus} /> : null}
      </div>
    </GlassCard>
  );
}

function ExchangeMessage({ artifact, focused, cached }: {
  artifact: PromptArtifactDetail;
  focused: boolean;
  cached: boolean;
}) {
  const { role, label } = ARTIFACT_KIND_ROLES[artifact.kind];
  const text = artifact.rawText ?? artifact.redactedText;
  const lines = text ? text.split("\n").length : 0;
  const isLong = text != null && (text.length > LONG_CHARS || lines > LONG_LINES);
  const [open, setOpen] = useState(false);
  const meta = exchangeMeta(artifact.chars ?? text?.length, artifact.tokenEstimate);
  const tools = artifactToolNames(artifact.metadata);
  return (
    <div className={`xmsg xmsg-${role}${focused ? " xmsg-focused" : ""}`}>
      <div className="xmsg-head">
        <span className="xmsg-role">{label}</span>
        {tools.map((name) => <span key={name} className="code-pill">{name}()</span>)}
        {cached ? <Badge variant="accent">cached</Badge> : null}
        <span className="xmsg-head-actions">
          {meta ? <span className="xmsg-meta">{meta}</span> : null}
          {text ? <CopyButton text={text} /> : null}
        </span>
      </div>
      {text
        ? <div className={`xmsg-body${CODE_ROLES.includes(role) ? " code" : ""}${isLong && !open ? " clamp" : ""}`}>{text}</div>
        : <div className="xmsg-body xmsg-missing">Content not stored ({artifact.storageMode}).</div>}
      {isLong ? (
        <button type="button" className="xmsg-expander" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          <ChevronDown className={open ? "open" : ""} />
          {open
            ? "Collapse"
            : `Expand full ${label.toLowerCase()} · ${lines} ${lines === 1 ? "line" : "lines"}${artifact.tokenEstimate ? ` · ~${formatCompact(artifact.tokenEstimate)} tokens` : ""}`}
        </button>
      ) : null}
    </div>
  );
}

function MissingResponse({ status }: { status?: string | null }) {
  if (status === "failed") {
    return (
      <div className="xmsg xmsg-error">
        <div className="xmsg-head"><span className="xmsg-role">Error</span></div>
        <div className="xmsg-body xmsg-missing">Request failed — no assistant response was captured.</div>
      </div>
    );
  }
  return (
    <div className="xmsg xmsg-assistant">
      <div className="xmsg-head"><span className="xmsg-role">Assistant</span></div>
      <div className="xmsg-body xmsg-missing">Response not captured for this request.</div>
    </div>
  );
}
